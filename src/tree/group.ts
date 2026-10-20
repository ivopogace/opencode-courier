import { isNotFound, millis } from "../platform/json.js"
import { envelope } from "../kernel/protocol.js"
import { complete, standingOf, type HeldReport, type LeftMember, type Member, type RosterEntry } from "./domain.js"
import type { GroupPorts, GroupStore, Membership, WatchPorts } from "./ports.js"
import { groupStore } from "./store.js"
import { groupNotice } from "./text.js"

/** Makes a spawned session a member of its parent's group, opening the group if it was not. */
export async function joinGroup(groups: GroupStore, parentID: string, group: string, sessionID: string, title: string, at: number) {
  await groups.put(parentID, group, sessionID, { title, joinedAt: at })
}

/** The members of each group among `members`, by the claim key of the group. */
function byGroup(members: ReadonlyArray<Membership>) {
  const groups = new Map<string, Membership[]>()
  for (const member of members) {
    const key = claimKey(member.parentID, member.group)
    const group = groups.get(key)
    if (group) group.push(member)
    else groups.set(key, [member])
  }
  return groups
}

/** Whether a parent has a complete group with a report in it, which the scheduler delivers once the parent's turn has ended. */
export async function hasCompleteGroup(groups: GroupStore, parentID: string) {
  return [...byGroup(await groups.ofParent(parentID)).values()].some(
    (members) => complete(members) && members.some((member) => member.report),
  )
}

/** Holds a member's report with its group, in place of an earlier one, or of how it had left. */
export async function holdReport(groups: GroupStore, membership: Membership, report: HeldReport) {
  const { parentID, group, sessionID, title, joinedAt } = membership
  await groups.put(parentID, group, sessionID, { title, joinedAt, report })
}

/** How many of these members of a group have reported and how many have not left, and whether the group is complete. */
const tally = (members: ReadonlyArray<Member>) => ({
  reported: members.filter((member) => member.report).length,
  members: members.filter((member) => !member.left).length,
  complete: complete(members),
})

/** How many members of a group have reported and how many have not left, and whether the group is complete. */
export async function groupStanding(groups: GroupStore, parentID: string, group: string) {
  return tally(await groups.ofGroup(parentID, group))
}

/** `groupStanding` of each open group of a parent, by name, from one read of its members. */
export async function groupStandings(groups: Pick<GroupStore, "ofParent">, parentID: string) {
  const byName = new Map<string, Membership[]>()
  for (const member of await groups.ofParent(parentID)) byName.set(member.group, [...(byName.get(member.group) ?? []), member])
  return [...byName].map(([name, members]) => ({ name, ...tally(members) }))
}

/** A session's membership of a parent's group, if it is a member; `out` says whether the group still waits for its report. */
export async function membershipOf(groups: Pick<GroupStore, "member">, parentID: string, group: string, sessionID: string) {
  const member = await groups.member(parentID, group, sessionID)
  return member && { ...member, parentID, group, sessionID, out: standingOf(member) === "out" }
}

/** A child's membership of the group its roster entry names; none without one. A failed read is the caller's to handle. */
export async function membershipFor(groups: Pick<GroupStore, "member">, entry: RosterEntry) {
  return entry.group ? membershipOf(groups, entry.parentID, entry.group, entry.sessionID) : undefined
}

/**
 * Notes that a member left its group without a report: its turn failed or was interrupted, it was deleted or dropped. Read
 * again first: one whose report is held meanwhile keeps it, one that left keeps why. True when that completes the group.
 */
export async function markLeft(groups: GroupStore, membership: Membership, by: LeftMember["by"], at: number) {
  const { parentID, group, sessionID } = membership
  const current = await groups.member(parentID, group, sessionID)
  if (!current || standingOf(current) !== "out") return false
  await groups.put(parentID, group, sessionID, { title: current.title, joinedAt: current.joinedAt, left: { at, by } })
  return (await groupStanding(groups, parentID, group)).complete
}

/** `markLeft` for a member not read yet; undefined when it is in no open group. */
export async function leaveGroup(groups: GroupStore, parentID: string, group: string, sessionID: string, by: LeftMember["by"], at: number) {
  const membership = await membershipOf(groups, parentID, group, sessionID)
  return membership && (await markLeft(groups, membership, by, at))
}

/** A child's membership of an open group it is still out in: the group waits for it, and its end takes it out without a report. */
export async function outIn(ports: Pick<WatchPorts, "storage" | "log">, entry: RosterEntry) {
  try {
    const member = await membershipFor(groupStore(ports.storage), entry)
    return member?.out ? member : undefined
  } catch (error) {
    ports.log(`courier watch: could not read ${entry.sessionID}'s place in group ${entry.group}: ${String(error)}`)
    return undefined
  }
}

/** Takes a member out of its group without a report; true when that completes the group, for the caller to nudge the scheduler. */
export async function leave(ports: Pick<WatchPorts, "storage" | "log">, member: Membership, by: "failed" | "interrupted" | "deleted", at: number) {
  try {
    return await markLeft(groupStore(ports.storage), member, by, at)
  } catch (error) {
    ports.log(`courier watch: could not take ${member.sessionID} out of group ${member.group}: ${String(error)}`)
    return false
  }
}

/**
 * Puts a member whose report is held back among those out: its latest word to the parent was a blocked report. Read
 * again first: a group released meanwhile is not opened again, and a report held since is kept.
 */
export async function unholdForBlocked(groups: GroupStore, membership: Membership) {
  const { parentID, group, sessionID, title, joinedAt } = membership
  if (!membership.report) return
  const current = await groups.member(parentID, group, sessionID)
  if (JSON.stringify(current?.report) !== JSON.stringify(membership.report)) return
  await groups.put(parentID, group, sessionID, { title, joinedAt })
}

/** The claim key of a group's release, in the hub's shared set of deliveries under way. */
const claimKey = (parentID: string, group: string) => `group:${parentID}/${group}`

/**
 * Delivers every released group once, from the scheduler's tick: claimed in the shared `claimed`, re-read,
 * delivered and only then dropped, so a failed delivery is tried again at the next tick, and a crash in between delivers it again.
 */
export async function deliverReleased(ports: GroupPorts, claimed: Set<string>) {
  const groups = [...byGroup(await groupStore(ports.storage).all())].filter(([key, members]) => complete(members) && !claimed.has(key))
  // Claimed all at once, before any delivery, so a tick alongside claims none of these.
  for (const [key] of groups) claimed.add(key)
  await Promise.all(groups.map(([key, members]) => releaseClaimed(ports, claimed, key, members[0]!)))
}

async function releaseClaimed(ports: GroupPorts, claimed: Set<string>, key: string, { parentID, group }: Membership) {
  try {
    await release(ports, parentID, group)
  } catch (error) {
    ports.log(`courier group ${group} of ${parentID}: ${String(error)}`)
  } finally {
    claimed.delete(key)
  }
}

/**
 * Whether the parent's turn that started a group's last member has ended, so no more join it; `gone` when OpenCode no longer knows the
 * parent. Only a turn ending stamps `time.idle`: a shutdown, or a plain permission decline reported as one, holds it until the next ends.
 */
async function sealed(ports: GroupPorts, parentID: string, members: ReadonlyArray<Member>) {
  const joined = Math.max(...members.map((member) => member.joinedAt))
  try {
    const { time } = await ports.session.get({ sessionID: parentID })
    // NaN, for a parent that has ended no turn yet, holds it.
    return millis(time.idle) >= joined
  } catch (error) {
    if (isNotFound(error)) return "gone"
    throw error
  }
}

async function release(ports: GroupPorts, parentID: string, group: string) {
  // Re-read: another server may have delivered and dropped it since the scan.
  const members = (await groupStore(ports.storage).ofGroup(parentID, group)).sort((a, b) => a.joinedAt - b.joinedAt)
  if (!members.length || !complete(members)) return
  const seal = await sealed(ports, parentID, members)
  if (!seal) return
  if (seal === "gone") return drop(ports, parentID, group, members, "the session is gone")
  const reports = members.flatMap((member) => (member.report ? [{ sessionID: member.sessionID, title: member.title, ...member.report }] : []))
  const left = members.flatMap((member) => (member.left ? [{ sessionID: member.sessionID, title: member.title, by: member.left.by }] : []))
  if (reports.length) {
    try {
      await ports.session.synthetic({
        sessionID: parentID,
        text: envelope(reports.map((report) => report.sessionID).join(","), groupNotice(group, reports, left), {
          group,
          reports: String(reports.length),
        }),
        description: `Reports of group ${group}`,
        metadata: { source: "courier", from: reports.map((report) => report.sessionID).join(","), group, reports: reports.length },
        delivery: "steer",
      })
    } catch (error) {
      // A parent OpenCode no longer knows will never take it: dropped, like the children of a deleted session.
      if (!isNotFound(error)) {
        ports.log(`courier group ${group} of ${parentID} not delivered, held for another try: ${String(error)}`)
        return
      }
      return drop(ports, parentID, group, members, `the session is gone (${String(error)})`)
    }
  }
  await drop(ports, parentID, group, members)
}

/** Drops a group's members once delivered, or unsent, saying why. */
async function drop(ports: GroupPorts, parentID: string, group: string, members: ReadonlyArray<Membership>, unsent?: string) {
  if (unsent) ports.log(`courier group ${group} of ${parentID} dropped: ${unsent}`)
  // A member left behind here is delivered again at the next tick, as after a crash: logged, so it can be seen.
  const groups = groupStore(ports.storage)
  const dropped = await Promise.allSettled(members.map((member) => dropDelivered(groups, member)))
  for (const [index, result] of dropped.entries())
    if (result.status === "rejected")
      ports.log(`courier group ${group} of ${parentID}: delivered, but ${members[index]!.sessionID} could not be dropped: ${String(result.reason)}`)
}

/** Drops a delivered member's key, unless it was written again since it was read: that report is still to deliver. */
async function dropDelivered(groups: GroupStore, delivered: Membership) {
  const { parentID, group, sessionID, ...read } = delivered
  if (JSON.stringify(await groups.member(parentID, group, sessionID)) !== JSON.stringify(read)) return
  await groups.remove(parentID, group, sessionID)
}
