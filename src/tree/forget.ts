import { leave, markLeft, membershipOf } from "./group.js"
import type { CleanupPorts, GroupStore, Membership, ReportKeys, RosterEntry, RosterStorage, WatchPorts } from "./ports.js"
import { childStore, groupStore } from "./store.js"

/**
 * Forgetting, the one place tree state is removed. A child's roster entry and report state go together; its group is
 * another aggregate, left best effort, so a report held there outlives the entry and still reaches the parent.
 */

/** Drops a member from its group as its roster entry goes, unless its report is held: that still goes to the parent. True when dropped. */
export async function dropMember(groups: GroupStore, parentID: string, group: string, sessionID: string) {
  const member = await groups.member(parentID, group, sessionID)
  if (!member || member.report) return false
  await groups.remove(parentID, group, sessionID)
  return true
}

/** Drops every group of a parent, whose members' reports can no longer be delivered. */
export async function dropGroups(groups: GroupStore, parentID: string) {
  const members = await groups.ofParent(parentID)
  await Promise.all(members.map((member) => groups.remove(parentID, member.group, member.sessionID)))
}

/**
 * Forgets a child: its roster entry, its reverse key, its report state and, given its group, its membership. Only
 * the entry's removal can fail it: keys left behind lead nowhere, and the next load drops them.
 */
export async function forgetChild(storage: RosterStorage, parentID: string, sessionID: string, group?: string) {
  const [, dropped] = await Promise.all([
    childStore(storage).remove(parentID, sessionID),
    group ? dropMember(groupStore(storage), parentID, group, sessionID).catch(() => false) : false,
  ])
  return { droppedFromGroup: dropped }
}

/** Removes a child from its parent's roster; false when it was not there. */
export async function forget(storage: RosterStorage, parentID: string, sessionID: string) {
  const entry = await childStore(storage).entry(parentID, sessionID)
  if (entry === undefined) return false
  await forgetChild(storage, parentID, sessionID, entry.group)
  return true
}

/**
 * Drops a member still out from its group as `dropped`, so the group is released without it, then the roster entry
 * and report state. A held report stays with its group. Returns the group it was dropped from.
 */
export async function forgetDropped(ports: Pick<CleanupPorts, "storage" | "now" | "nudge">, entry: RosterEntry) {
  const groups = groupStore(ports.storage)
  const member = entry.group ? await membershipOf(groups, entry.parentID, entry.group, entry.sessionID) : undefined
  if (member?.out && (await markLeft(groups, member, "dropped", ports.now()))) ports.nudge()
  await forgetChild(ports.storage, entry.parentID, entry.sessionID)
  return member?.out ? member.group : undefined
}

/**
 * Forgets what a session OpenCode deleted leaves: the report state of `forgotten`, itself and the sessions it started,
 * and its groups; `member`, its place in its own group, it leaves at `created`, or now.
 */
export async function forgetDeleted(ports: WatchPorts, sessionID: string, forgotten: ReadonlyArray<string>, member: Membership | undefined, created?: number) {
  const children = childStore(ports.storage)
  // Its groups go whether or not it has children on the roster: a held report outlives the member's entry.
  const [completed] = await Promise.all([
    member ? leave(ports, member, "deleted", created ?? ports.now()) : Promise.resolve(false),
    ...forgotten.map((id) => children.forgetReport(id)),
    dropGroups(groupStore(ports.storage), sessionID),
  ])
  if (completed) ports.nudge()
}

/** Removes report keys of sessions with no roster entry; a key that will not go is left for the next load. */
export async function forgetReports(storage: RosterStorage, keys: ReportKeys, sessions: ReadonlyArray<string>) {
  await childStore(storage).dropReported(sessions.flatMap((sessionID) => keys.get(sessionID) ?? []))
}
