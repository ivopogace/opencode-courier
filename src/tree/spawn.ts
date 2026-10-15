import { describeFailure } from "../kernel/protocol.js"
import { isGroupName } from "./domain.js"
import { joinGroup, leaveGroup } from "./group.js"
import { admit } from "./limits.js"
import type { CourierPorts, RosterEntry } from "./ports.js"
import { childStore, groupStore } from "./store.js"
import { expectWake } from "./wake.js"
import { childBrief, childBranch } from "./text.js"

export interface SpawnInput {
  readonly task: string
  readonly title?: string
  readonly agent?: string
  readonly isolate?: boolean
  readonly group?: string
}

function titleOf(task: string) {
  const line = task.trim().split("\n")[0] ?? ""
  return line.length > 60 ? `${line.slice(0, 57)}...` : line
}

/**
 * The model a child runs on: its parent's, so it does not fall back to OpenCode's default, which
 * the parent may have been moved off for a reason. An agent that names its own model keeps it.
 */
async function inheritedModel(ports: CourierPorts, parentID: string, agent: string | undefined) {
  const parent = await ports.session.get({ sessionID: parentID })
  if (!parent.model || !agent) return parent.model
  const named = await ports.agent.get({ agentID: agent, location: { directory: ports.directory } })
  return named.data.model ? undefined : parent.model
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
  const admitted = await admit(ports, parentID)
  try {
    return await start(ports, parentID, input, admitted, group)
  } finally {
    admitted.release()
  }
}

async function start(ports: CourierPorts, parentID: string, input: SpawnInput, admitted: Awaited<ReturnType<typeof admit>>, group: string | undefined) {
  const { worktree, handedDown, ...child } = await create(ports, parentID, input)
  admitted.reservation.sessionID = child.sessionID
  const entry: RosterEntry = {
    ...child,
    parentID,
    isolated: worktree !== undefined,
    createdAt: ports.now(),
    reports: "status",
    ...(worktree ? { source: ports.directory, project: ports.projectID } : {}),
    ...(group ? { group } : {}),
  }
  const { rosterError, groupError } = await enrol(ports, entry, group)
  ports.roles.delete(parentID)
  await handOver(ports, entry, admitted.depth, input.task, !rosterError, !rosterError && !groupError)
  return {
    sessionID: entry.sessionID,
    directory: entry.directory,
    ...(group && !rosterError && !groupError ? { group } : {}),
    ...(rosterError ? { rosterError } : {}),
    ...(groupError ? { groupError } : {}),
    ...(handedDown ? { fromParent: true } : {}),
    ...(handedDown?.uncommitted ? { uncommitted: true } : {}),
  }
}

/** Creates the child's session, in a worktree of its own if asked, which goes again if the session cannot be created. */
async function create(ports: CourierPorts, parentID: string, input: SpawnInput) {
  // A failed lookup must not keep the child from starting; it then runs on OpenCode's default.
  const model = await inheritedModel(ports, parentID, input.agent).catch(() => undefined)
  const handedDown = input.isolate ? await parentWork(ports, parentID) : undefined
  const worktree = input.isolate
    ? (await ports.worktree.create({ projectID: ports.projectID, ...(handedDown ? { from: handedDown.directory, branch: handedDown.head } : {}) })).directory
    : undefined
  const base = worktree ? await ports.head(worktree) : undefined
  const title = input.title ?? titleOf(input.task)
  // OpenCode takes a location or a parentID, never both, so an isolated child cannot be a native one.
  const native = ports.nativeChildren === true && !worktree
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
  const text = childBrief(entry.parentID, task, depth, ports.limits, entry.isolated ? childBranch(entry.sessionID) : undefined)
  try {
    await ports.session.prompt({ sessionID: entry.sessionID, text })
  } catch (error) {
    if (rostered) await children.settled(entry.sessionID, "failed", ports.now()).catch(() => undefined)
    if (grouped && entry.group)
      await leaveGroup(groupStore(ports.storage), entry.parentID, entry.group, entry.sessionID, "failed", ports.now()).then(
        (complete) => complete && ports.nudge(),
        (leaveError: unknown) => ports.log(`courier_spawn: ${entry.sessionID} could not leave group ${entry.group}: ${String(leaveError)}`),
      )
    throw error
  }
  // The prompt reached the child, which owes a turn; if its wake is missed, the scheduler re-wakes it.
  if (rostered) await expectWake(ports.storage, ports.now, entry.sessionID, text).catch(() => undefined)
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
