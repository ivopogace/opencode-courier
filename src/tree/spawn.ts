import { describeFailure } from "../kernel/protocol.js"
import { isGroupName, modelName } from "./domain.js"
import { joinGroup, leaveGroup } from "./group.js"
import { admit } from "./limits.js"
import { chooseModel } from "./model.js"
import type { CourierPorts, Entry, RosterEntry } from "./ports.js"
import { putEntries, syncStanding } from "./standing.js"
import { childStore, groupStore } from "./store.js"
import { childBrief, childBranch, nativeIsolateRefusal, ROLE_KEY, rolePart } from "./text.js"

export interface SpawnInput {
  readonly task: string
  readonly title?: string
  readonly agent?: string
  readonly isolate?: boolean
  readonly group?: string
  readonly model?: string
  readonly variant?: string
  readonly native?: boolean
}

// a schedule's wake-up is invisible to Waits (api-notes, OpenCode's schedules)
const CHILD_RULES = [{ action: "opencode_schedule_*", resource: "*", effect: "deny" }] as const

function titleOf(task: string) {
  const line = task.trim().split("\n")[0] ?? ""
  return line.length > 60 ? `${line.slice(0, 57)}...` : line
}

async function dropWorktree(ports: CourierPorts, directory: string) {
  try {
    await ports.worktree.remove({ projectID: ports.projectID, directory, force: false })
  } catch {}
}

export async function spawn(ports: CourierPorts, parentID: string, input: SpawnInput) {
  const group = typeof input.group === "string" ? input.group.trim() || undefined : (input.group ?? undefined)
  if (group !== undefined && !isGroupName(group))
    throw new Error(`group must be a name of 1 to 60 letters, digits, dots, dashes or underscores, not ${JSON.stringify(group)}.`)
  const native = typeof input.native === "boolean" ? input.native : undefined
  if (native && input.isolate) throw new Error(nativeIsolateRefusal())
  const admitted = await admit(ports, parentID)
  try {
    return await start(ports, parentID, { ...input, native }, admitted, group)
  } finally {
    admitted.release()
  }
}

async function start(ports: CourierPorts, parentID: string, input: SpawnInput, admitted: Awaited<ReturnType<typeof admit>>, group: string | undefined) {
  const { worktree, handedDown, model, ...child } = await create(ports, parentID, input)
  admitted.reservation.sessionID = child.sessionID
  const entry: RosterEntry = {
    ...child,
    parentID,
    isolated: worktree !== undefined,
    createdAt: ports.now(),
    reports: "status",
    ...(worktree ? { source: ports.directory, project: ports.projectID } : {}),
    ...(group ? { group } : {}),
    ...(model ? { model } : {}),
  }
  const { rosterError, groupError } = await enrol(ports, entry, group)
  await nameBoth(ports, parentID, entry.sessionID, admitted.depth)
  try {
    await handOver(ports, entry, admitted.depth, input.task, !rosterError, !rosterError && !groupError)
  } finally {
    await syncStanding(ports, parentID)
  }
  return {
    sessionID: entry.sessionID,
    directory: entry.directory,
    ...(group && !rosterError && !groupError ? { group } : {}),
    ...(rosterError ? { rosterError } : {}),
    ...(groupError ? { groupError } : {}),
    ...(handedDown?.from ? { fromParent: true } : {}),
    ...(handedDown?.uncommitted ? { uncommitted: true } : {}),
    ...(model ? { model } : {}),
    ...(entry.native ? { native: true } : {}),
    ...(admitted.depth > 1 ? { belowTop: true } : {}),
  }
}

async function create(ports: CourierPorts, parentID: string, input: SpawnInput) {
  const { model, parent } = await chooseModel(ports, parentID, input, input.agent)
  const handedDown = input.isolate ? await parentWork(ports, parentID) : undefined
  const worktree = input.isolate
    ? (await ports.worktree.create({ projectID: ports.projectID, ...(handedDown?.from ? { from: handedDown.from.directory, branch: handedDown.from.head } : {}) })).directory
    : undefined
  const base = worktree ? await ports.head(worktree) : undefined
  const title = input.title ?? titleOf(input.task)
  // OpenCode takes a location or a parentID, never both
  const native = (input.native ?? ports.nativeChildren === true) && !worktree
  const child = await ports.session
    .create({
      title,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(model ? { model } : {}),
      ...(worktree ? { location: { directory: worktree } } : {}),
      ...(native ? { parentID } : {}),
      permissions: [...CHILD_RULES],
      metadata: { courier: { parentID } },
    })
    .catch(async (error: unknown) => {
      if (worktree) await dropWorktree(ports, worktree)
      throw error
    })
  return {
    sessionID: child.id,
    title,
    directory: worktree ?? child.location.directory,
    worktree,
    handedDown,
    ...(base ? { base } : {}),
    ...(native ? { native: true as const } : {}),
    ...(model && (!parent || modelName(model) !== modelName(parent)) ? { model: modelName(model) } : {}),
  }
}

async function parentWork(ports: CourierPorts, parentID: string) {
  const parent = await childStore(ports.storage).indexedEntry(parentID)
  const directory = parent?.directory ?? ports.directory
  const head = parent?.isolated ? await ports.head(directory) : undefined
  if (parent?.isolated && !head)
    throw new Error(
      `the HEAD of your worktree ${directory} could not be read, so an isolated session cannot start from it; nothing was started. Start it without isolate, or fix the worktree.`,
    )
  const uncommitted = (await ports.dirty(directory).catch(() => undefined)) === true
  return { ...(head ? { from: { directory, head } } : {}), uncommitted }
}

async function enrol(ports: CourierPorts, entry: RosterEntry, group: string | undefined) {
  const rosterError = await childStore(ports.storage).record(entry).then(
    () => undefined,
    (error: unknown) => describeFailure("roster", error).message,
  )
  const groupError = group && !rosterError ? await join(ports, entry, group) : undefined
  return { rosterError, groupError }
}

async function handOver(ports: CourierPorts, entry: RosterEntry, depth: number, task: string, rostered: boolean, grouped: boolean) {
  // the prompt's inbox.delivered event moves this on; so written first
  const children = childStore(ports.storage)
  if (rostered) await children.prompted(entry.sessionID, ports.now()).catch(() => undefined)
  try {
    await ports.session.prompt({ sessionID: entry.sessionID, text: childBrief(entry.parentID, task, depth, ports.limits, entry.isolated ? childBranch(entry.sessionID) : undefined), metadata: { source: "courier", task: true } })
  } catch (error) {
    if (rostered) await children.settled(entry.sessionID, "failed", ports.now()).catch(() => undefined)
    if (grouped && entry.group)
      await leaveGroup(groupStore(ports.storage), entry.parentID, entry.group, entry.sessionID, "failed", ports.now()).then(
        (complete) => complete && ports.nudge(),
        (leaveError: unknown) => ports.log(`courier_spawn: ${entry.sessionID} could not leave group ${entry.group}: ${String(leaveError)}`),
      )
    throw error
  }
}

async function join(ports: CourierPorts, entry: RosterEntry, group: string) {
  const groups = groupStore(ports.storage)
  try {
    await joinGroup(groups, entry.parentID, group, entry.sessionID, entry.title, ports.now())
    return undefined
  } catch (error) {
    const { group: _, ...ungrouped } = entry
    await Promise.all([
      childStore(ports.storage).record(ungrouped).catch(() => undefined),
      groups.remove(entry.parentID, group, entry.sessionID).catch(() => undefined),
    ])
    return describeFailure("group", error).message
  }
}

// entries put before the first step are in its baseline (api-notes)
async function nameBoth(ports: CourierPorts, parentID: string, childID: string, depth: number) {
  const extra = await extraEntries(ports)
  await nameRole(ports, childID, depth)
  if (depth < ports.limits.maxDepth) await putEntries(ports, childID, extra)
  const rootNamed = ports.roles.get(parentID)?.entry === true
  const named = depth === 1 && (rootNamed || (await nameRole(ports, parentID, 0)))
  if (named && !rootNamed) await putEntries(ports, parentID, extra)
  if (named) ports.roles.set(parentID, { depth: 0, entry: true })
  else ports.roles.delete(parentID)
}

async function extraEntries(ports: CourierPorts): Promise<ReadonlyArray<Entry>> {
  if (!ports.entries || !ports.session.instructions) return []
  try {
    return await ports.entries()
  } catch (error) {
    ports.log(`courier_spawn: the entries of the other modules could not be read, so the session starts without them: ${String(error)}`)
    return []
  }
}

// a host before 2.2.0 has no entries; the context hook adds the part
async function nameRole(ports: CourierPorts, sessionID: string, depth: number) {
  const entries = ports.session.instructions?.entry
  if (!entries) return false
  try {
    await entries.put({ sessionID, key: ROLE_KEY, value: rolePart(depth, ports.limits) })
    return true
  } catch (error) {
    ports.log(`courier_spawn: the role entry of ${sessionID} could not be written, so its role goes in a system part: ${String(error)}`)
    return false
  }
}
