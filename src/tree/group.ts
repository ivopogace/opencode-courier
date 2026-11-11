import { isNotFound, millis } from "../platform/json.js"
import { envelope } from "../kernel/protocol.js"
import { complete, endedAt, standingOf, turnEnd, type HeldReport, type LeftMember, type Member, type RosterEntry } from "./domain.js"
import type { GroupPorts, GroupStore, Membership, WatchPorts } from "./ports.js"
import { syncStanding } from "./standing.js"
import { groupStore } from "./store.js"
import { groupNotice } from "./text.js"

export async function joinGroup(groups: GroupStore, parentID: string, group: string, sessionID: string, title: string, at: number) {
  await groups.put(parentID, group, sessionID, { title, joinedAt: at })
}

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

export async function hasCompleteGroup(groups: GroupStore, parentID: string) {
  return [...byGroup(await groups.ofParent(parentID)).values()].some(
    (members) => complete(members) && members.some((member) => member.report),
  )
}

export async function holdReport(groups: GroupStore, membership: Membership, report: HeldReport) {
  const { parentID, group, sessionID, title, joinedAt } = membership
  await groups.put(parentID, group, sessionID, { title, joinedAt, report })
}

const tally = (members: ReadonlyArray<Member>) => ({
  reported: members.filter((member) => member.report).length,
  members: members.filter((member) => !member.left).length,
  complete: complete(members),
})

export async function groupStanding(groups: GroupStore, parentID: string, group: string) {
  return tally(await groups.ofGroup(parentID, group))
}

export async function groupStandings(groups: Pick<GroupStore, "ofParent">, parentID: string) {
  const byName = new Map<string, Membership[]>()
  for (const member of await groups.ofParent(parentID)) byName.set(member.group, [...(byName.get(member.group) ?? []), member])
  return [...byName].map(([name, members]) => ({ name, ...tally(members) }))
}

export async function membershipOf(groups: Pick<GroupStore, "member">, parentID: string, group: string, sessionID: string) {
  const member = await groups.member(parentID, group, sessionID)
  return member && { ...member, parentID, group, sessionID, out: standingOf(member) === "out" }
}

export async function membershipFor(groups: Pick<GroupStore, "member">, entry: RosterEntry) {
  return entry.group ? membershipOf(groups, entry.parentID, entry.group, entry.sessionID) : undefined
}

export async function markLeft(groups: GroupStore, membership: Membership, by: LeftMember["by"], at: number) {
  const { parentID, group, sessionID } = membership
  const current = await groups.member(parentID, group, sessionID)
  if (!current || standingOf(current) !== "out") return false
  await groups.put(parentID, group, sessionID, { title: current.title, joinedAt: current.joinedAt, left: { at, by } })
  return (await groupStanding(groups, parentID, group)).complete
}

export async function leaveGroup(groups: GroupStore, parentID: string, group: string, sessionID: string, by: LeftMember["by"], at: number) {
  const membership = await membershipOf(groups, parentID, group, sessionID)
  return membership && (await markLeft(groups, membership, by, at))
}

export async function outIn(ports: Pick<WatchPorts, "storage" | "log">, entry: RosterEntry) {
  try {
    const member = await membershipFor(groupStore(ports.storage), entry)
    return member?.out ? member : undefined
  } catch (error) {
    ports.log(`courier watch: could not read ${entry.sessionID}'s place in group ${entry.group}: ${String(error)}`)
    return undefined
  }
}

export async function leave(ports: Pick<WatchPorts, "storage" | "log">, member: Membership, by: "failed" | "interrupted" | "deleted", at: number) {
  try {
    return await markLeft(groupStore(ports.storage), member, by, at)
  } catch (error) {
    ports.log(`courier watch: could not take ${member.sessionID} out of group ${member.group}: ${String(error)}`)
    return false
  }
}

export async function unholdForBlocked(groups: GroupStore, membership: Membership) {
  const { parentID, group, sessionID, title, joinedAt } = membership
  if (!membership.report) return
  const current = await groups.member(parentID, group, sessionID)
  if (JSON.stringify(current?.report) !== JSON.stringify(membership.report)) return
  await groups.put(parentID, group, sessionID, { title, joinedAt })
}

const claimKey = (parentID: string, group: string) => `group:${parentID}/${group}`

export async function deliverReleased(ports: GroupPorts, claimed: Set<string>) {
  const groups = [...byGroup(await groupStore(ports.storage).all())].filter(([key, members]) => complete(members) && !claimed.has(key))
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

async function sealed(ports: GroupPorts, parentID: string, members: ReadonlyArray<Member>) {
  const joined = Math.max(...members.map((member) => member.joinedAt))
  try {
    const { time } = await ports.session.get({ sessionID: parentID })
    if (millis(time.idle) >= joined) return true
    const end = turnEnd(await ports.session.context({ sessionID: parentID }).catch(() => []))
    return end !== undefined && (endedAt(end, time) ?? Number.NEGATIVE_INFINITY) >= joined
  } catch (error) {
    if (isNotFound(error)) return "gone"
    throw error
  }
}

async function release(ports: GroupPorts, parentID: string, group: string) {
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
      if (!isNotFound(error)) {
        ports.log(`courier group ${group} of ${parentID} not delivered, held for another try: ${String(error)}`)
        return
      }
      return drop(ports, parentID, group, members, `the session is gone (${String(error)})`)
    }
  }
  await drop(ports, parentID, group, members)
  await syncStanding(ports, parentID)
}

async function drop(ports: GroupPorts, parentID: string, group: string, members: ReadonlyArray<Membership>, unsent?: string) {
  if (unsent) ports.log(`courier group ${group} of ${parentID} dropped: ${unsent}`)
  const groups = groupStore(ports.storage)
  const dropped = await Promise.allSettled(members.map((member) => dropDelivered(groups, member)))
  for (const [index, result] of dropped.entries())
    if (result.status === "rejected")
      ports.log(`courier group ${group} of ${parentID}: delivered, but ${members[index]!.sessionID} could not be dropped: ${String(result.reason)}`)
}

async function dropDelivered(groups: GroupStore, delivered: Membership) {
  const { parentID, group, sessionID, ...read } = delivered
  if (JSON.stringify(await groups.member(parentID, group, sessionID)) !== JSON.stringify(read)) return
  await groups.remove(parentID, group, sessionID)
}
