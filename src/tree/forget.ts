import { leave, markLeft, membershipFor } from "./group.js"
import type { CleanupPorts, GroupStore, Membership, ReportKeys, RosterEntry, RosterStorage, WatchPorts } from "./ports.js"
import { childStore, groupStore } from "./store.js"

export async function dropMember(groups: GroupStore, parentID: string, group: string, sessionID: string) {
  const member = await groups.member(parentID, group, sessionID)
  if (!member || member.report) return false
  await groups.remove(parentID, group, sessionID)
  return true
}

export async function dropGroups(groups: GroupStore, parentID: string) {
  const members = await groups.ofParent(parentID)
  await Promise.all(members.map((member) => groups.remove(parentID, member.group, member.sessionID)))
}

export async function forgetChild(storage: RosterStorage, parentID: string, sessionID: string, group?: string) {
  const [, dropped] = await Promise.all([
    childStore(storage).remove(parentID, sessionID),
    group ? dropMember(groupStore(storage), parentID, group, sessionID).catch(() => false) : false,
  ])
  return { droppedFromGroup: dropped }
}

export async function forgetDropped(ports: Pick<CleanupPorts, "storage" | "now" | "nudge">, entry: RosterEntry) {
  const groups = groupStore(ports.storage)
  const member = await membershipFor(groups, entry)
  if (member?.out && (await markLeft(groups, member, "dropped", ports.now()))) ports.nudge()
  await forgetChild(ports.storage, entry.parentID, entry.sessionID)
  return member?.out ? member.group : undefined
}

export async function forgetDeleted(ports: WatchPorts, sessionID: string, forgotten: ReadonlyArray<string>, member: Membership | undefined, created?: number) {
  const children = childStore(ports.storage)
  const [completed] = await Promise.all([
    member ? leave(ports, member, "deleted", created ?? ports.now()) : Promise.resolve(false),
    ...forgotten.map((id) => children.forgetReport(id)),
    dropGroups(groupStore(ports.storage), sessionID),
  ])
  if (completed) ports.nudge()
}

export async function forgetReports(storage: RosterStorage, keys: ReportKeys, sessions: ReadonlyArray<string>) {
  await childStore(storage).dropReported(sessions.flatMap((sessionID) => keys.get(sessionID) ?? []))
}
