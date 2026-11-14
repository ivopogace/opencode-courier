import { describeFailure } from "../kernel/protocol.js"
import { modelName } from "./domain.js"
import { admit } from "./limits.js"
import { chooseModel } from "./model.js"
import type { CourierPorts, RosterEntry } from "./ports.js"
import { syncStanding } from "./standing.js"
import { childStore } from "./store.js"
import { childBrief, childBranch, nativeIsolateRefusal, ROLE_KEY, rolePart } from "./text.js"

export interface SpawnInput {
  readonly task: string
  readonly title?: string
  readonly agent?: string
  readonly isolate?: boolean
  readonly model?: string
  readonly variant?: string
  readonly native?: boolean
}

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
  const native = typeof input.native === "boolean" ? input.native : undefined
  if (native && input.isolate) throw new Error(nativeIsolateRefusal())
  const admitted = await admit(ports, parentID)
  try {
    return await start(ports, parentID, { ...input, native }, admitted)
  } finally {
    admitted.release()
  }
}

async function start(ports: CourierPorts, parentID: string, input: SpawnInput, admitted: Awaited<ReturnType<typeof admit>>) {
  const { worktree, handedDown, model, ...child } = await create(ports, parentID, input)
  admitted.reservation.sessionID = child.sessionID
  const entry: RosterEntry = {
    ...child,
    parentID,
    isolated: worktree !== undefined,
    createdAt: ports.now(),
    reports: "status",
    ...(worktree ? { source: ports.directory, project: ports.projectID } : {}),
    ...(model ? { model } : {}),
  }
  const rosterError = await enrol(ports, entry)
  await nameBoth(ports, entry, admitted.depth)
  try {
    await handOver(ports, entry, admitted.depth, input.task, !rosterError)
  } finally {
    await syncStanding(ports, parentID)
  }
  return {
    sessionID: entry.sessionID,
    directory: entry.directory,
    ...(rosterError ? { rosterError } : {}),
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
  const native = input.native === true && !worktree
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

function enrol(ports: CourierPorts, entry: RosterEntry) {
  return childStore(ports.storage).record(entry).then(
    () => undefined,
    (error: unknown) => describeFailure("roster", error).message,
  )
}

async function handOver(ports: CourierPorts, entry: RosterEntry, depth: number, task: string, rostered: boolean) {
  const children = childStore(ports.storage)
  if (rostered) await children.prompted(entry.sessionID, ports.now()).catch(() => undefined)
  try {
    await ports.session.prompt({ sessionID: entry.sessionID, text: childBrief(entry.parentID, task, depth, ports.limits, entry.isolated ? childBranch(entry.sessionID) : undefined), metadata: { source: "courier", task: true } })
  } catch (error) {
    if (rostered) await children.settled(entry.sessionID, "failed", ports.now()).catch(() => undefined)
    throw error
  }
}

const naming = new Map<string, Promise<unknown>>()

function nameBoth(ports: CourierPorts, child: RosterEntry, depth: number) {
  const { parentID } = child
  const before = (naming.get(parentID) ?? Promise.resolve()).catch(() => undefined)
  const run = before.then(() => nameEach(ports, child, depth))
  const done: Promise<unknown> = run.then(
    () => naming.get(parentID) === done && naming.delete(parentID),
    () => naming.get(parentID) === done && naming.delete(parentID),
  )
  naming.set(parentID, done)
  return run
}

async function nameEach(ports: CourierPorts, child: RosterEntry, depth: number) {
  const { parentID } = child
  await nameRole(ports, child.sessionID, depth, false)
  const rootNamed = ports.roles.get(parentID)?.entry === true
  const fresh = depth === 1 && !rootNamed
  const renamed = fresh || child.native ? await nameRole(ports, parentID, depth - 1, await hostReportsReach(ports, child)) : false
  if (renamed || (depth === 1 && rootNamed)) ports.roles.set(parentID, { depth: depth - 1, entry: true })
  else ports.roles.delete(parentID)
}

async function hostReportsReach(ports: CourierPorts, child: RosterEntry) {
  if (child.native) return true
  const started = await childStore(ports.storage).children(child.parentID).catch(() => [])
  return started.some((entry) => entry.native)
}

async function nameRole(ports: CourierPorts, sessionID: string, depth: number, hostReports: boolean) {
  const entries = ports.session.instructions?.entry
  if (!entries) return false
  try {
    await entries.put({ sessionID, key: ROLE_KEY, value: rolePart(depth, ports.limits, hostReports) })
    return true
  } catch (error) {
    ports.log(`courier_spawn: the role entry of ${sessionID} could not be written, so its role goes in a system part: ${String(error)}`)
    return false
  }
}
