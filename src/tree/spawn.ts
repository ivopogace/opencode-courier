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
  /** `provider/model` to run on; left out, the agent's own model, else the caller's. */
  readonly model?: string
  /** The variant of that model, its reasoning effort; left out, the chosen model's own. */
  readonly variant?: string
  /** Whether the child is OpenCode's subagent of the caller; left out, the `nativeChildren` option decides. */
  readonly native?: boolean
}

function titleOf(task: string) {
  const line = task.trim().split("\n")[0] ?? ""
  return line.length > 60 ? `${line.slice(0, 57)}...` : line
}

/** Removes a worktree made for a child that was never created; one that cannot be removed stays. */
async function dropWorktree(ports: CourierPorts, directory: string) {
  try {
    await ports.worktree.remove({ projectID: ports.projectID, directory, force: false })
  } catch {
    // The spawn's own failure is the one to report.
  }
}

/**
 * Creates a child session, hands it the task and returns at once; the child reports back with
 * courier_send. Refused past a limit, whether or not the `context` hook hid the tool.
 */
export async function spawn(ports: CourierPorts, parentID: string, input: SpawnInput) {
  // Some models send null, or an empty string, for an optional field they leave out.
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
  // The child's role and the other modules' entries before its prompt, so its first request carries them; a root's own at its first spawn.
  const extra = await extraEntries(ports)
  await nameRole(ports, entry.sessionID, admitted.depth)
  if (admitted.depth < ports.limits.maxDepth) await putEntries(ports, entry.sessionID, extra)
  const rootNamed = ports.roles.get(parentID)?.entry === true
  const named = admitted.depth === 1 && (rootNamed || (await nameRole(ports, parentID, 0)))
  if (named && !rootNamed) await putEntries(ports, parentID, extra)
  if (named) ports.roles.set(parentID, { depth: 0, entry: true })
  else ports.roles.delete(parentID)
  try {
    await handOver(ports, entry, admitted.depth, input.task, !rosterError, !rosterError && !groupError)
  } finally {
    // The parent's standing with the child on it, prompted or failed, announced at its next step.
    await syncStanding(ports, parentID)
  }
  return {
    sessionID: entry.sessionID,
    directory: entry.directory,
    ...(group && !rosterError && !groupError ? { group } : {}),
    ...(rosterError ? { rosterError } : {}),
    ...(groupError ? { groupError } : {}),
    ...(handedDown ? { fromParent: true } : {}),
    ...(handedDown?.uncommitted ? { uncommitted: true } : {}),
    ...(model ? { model } : {}),
    ...(entry.native ? { native: true } : {}),
  }
}

/**
 * Creates the child's session, in a worktree of its own if asked, which goes again if the session cannot be created.
 * `model` names the child's model when it is not its parent's, for the roster and the result.
 */
async function create(ports: CourierPorts, parentID: string, input: SpawnInput) {
  const { model, parent } = await chooseModel(ports, parentID, input, input.agent)
  const handedDown = input.isolate ? await parentWork(ports, parentID) : undefined
  const worktree = input.isolate
    ? (await ports.worktree.create({ projectID: ports.projectID, ...(handedDown ? { from: handedDown.directory, branch: handedDown.head } : {}) })).directory
    : undefined
  const base = worktree ? await ports.head(worktree) : undefined
  const title = input.title ?? titleOf(input.task)
  // OpenCode takes a location or a parentID, never both, so an isolated child cannot be a native one.
  const native = (input.native ?? ports.nativeChildren === true) && !worktree
  const child = await ports.session
    .create({
      title,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(model ? { model } : {}),
      ...(worktree ? { location: { directory: worktree } } : {}),
      // An empty ruleset, not none: a native child would otherwise run on its parent's session rules.
      ...(native ? { parentID, permissions: [] } : {}),
      metadata: { courier: { parentID } },
    })
    .catch(async (error: unknown) => {
      // No session will ever use the fresh worktree, and nothing records it, so it goes now.
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

/**
 * The worktree and HEAD an isolated parent hands its isolated child, by the reverse index alone; undefined for any
 * other parent. An unreadable HEAD fails the spawn rather than start the child without the parent's work.
 */
async function parentWork(ports: CourierPorts, parentID: string) {
  const parent = await childStore(ports.storage).indexedEntry(parentID)
  if (!parent?.isolated) return undefined
  const head = await ports.head(parent.directory)
  if (!head)
    throw new Error(
      `the HEAD of your worktree ${parent.directory} could not be read, so an isolated session cannot start from it; nothing was started. Start it without isolate, or fix the worktree.`,
    )
  const uncommitted = (await ports.dirty(parent.directory).catch(() => undefined)) === true
  return { directory: parent.directory, head, uncommitted }
}

/**
 * Records the child on the roster, before the prompt, so a child that exists is on the roster even if prompting
 * fails, then in its group. A failed write must not keep the child from its task: each is reported, not thrown.
 */
async function enrol(ports: CourierPorts, entry: RosterEntry, group: string | undefined) {
  const rosterError = await childStore(ports.storage).record(entry).then(
    () => undefined,
    (error: unknown) => describeFailure("roster", error).message,
  )
  const groupError = group && !rosterError ? await join(ports, entry, group) : undefined
  return { rosterError, groupError }
}

/**
 * Hands the child its task. `rostered` says whether its report state is kept, which a child off the roster has none
 * of, and `grouped` whether it is in its group; a child that never got its task leaves both, as it will never report.
 */
async function handOver(ports: CourierPorts, entry: RosterEntry, depth: number, task: string, rostered: boolean, grouped: boolean) {
  // A baseline, until OpenCode's event for the prompt's delivery moves it on; written first, so it never overtakes that.
  const children = childStore(ports.storage)
  if (rostered) await children.prompted(entry.sessionID, ports.now()).catch(() => undefined)
  try {
    await ports.session.prompt({ sessionID: entry.sessionID, text: childBrief(entry.parentID, task, depth, ports.limits, entry.isolated ? childBranch(entry.sessionID) : undefined) })
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

/**
 * Joins a child to its group; one that cannot be joined is recorded in no group, so it reports on its own,
 * and the result says so. Returns the error's message, if any.
 */
async function join(ports: CourierPorts, entry: RosterEntry, group: string) {
  const groups = groupStore(ports.storage)
  try {
    await joinGroup(groups, entry.parentID, group, entry.sessionID, entry.title, ports.now())
    return undefined
  } catch (error) {
    const { group: _, ...ungrouped } = entry
    // A write that failed may have landed all the same: a member left there would hold its group up for good.
    await Promise.all([
      childStore(ports.storage).record(ungrouped).catch(() => undefined),
      groups.remove(entry.parentID, group, entry.sessionID).catch(() => undefined),
    ])
    return describeFailure("group", error).message
  }
}

/** The entries the other modules give a spawned session, the memory's lessons; none when they cannot be read, logged. */
async function extraEntries(ports: CourierPorts): Promise<ReadonlyArray<Entry>> {
  if (!ports.entries || !ports.session.instructions) return []
  try {
    return await ports.entries()
  } catch (error) {
    ports.log(`courier_spawn: the entries of the other modules could not be read, so the session starts without them: ${String(error)}`)
    return []
  }
}

/**
 * Writes a session's role part to its `role` entry: a child's system prompt carries it from its first request, a root's
 * transcript as an update. False on a host without entries, or when the put failed, logged: the `context` hook adds the part.
 */
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
