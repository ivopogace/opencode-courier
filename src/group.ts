import type { Plugin } from "@opencode/plugin"
import { isNotFound, num, obj, str } from "./json.js"
import { envelope, groupNotice, isStatus, type Artifacts, type HeldReport, type LeftMember } from "./notices.js"
import { scanEntries, type Storage } from "./storage.js"

type Context = Plugin.Context

/**
 * Join groups: each member of a parent's group under `group/<parentID>/<name>/<sessionID>`, with its
 * held report or how it left; released and dropped once none is out. docs/reference.md, § Join groups.
 */
const PREFIX = "group/"

/** What a group may be called: short, and with no `/`, which separates the parts of its keys, or `"`, which closes an attribute. */
const NAME = /^[\w.-]{1,60}$/

export const isGroupName = (value: unknown): value is string => typeof value === "string" && NAME.test(value)

export const memberKey = (parentID: string, group: string, sessionID: string) => `${PREFIX}${parentID}/${group}/${sessionID}`

/** The key prefix of a parent's groups, and of one group's members. */
export const groupsPrefix = (parentID: string) => `${PREFIX}${parentID}/`
export const groupPrefix = (parentID: string, group: string) => `${groupsPrefix(parentID)}${group}/`

/** A member of a group, as stored: its title for the release notice, and its report or how it left. */
export interface Member {
  readonly title: string
  readonly joinedAt: number
  readonly report?: HeldReport
  readonly left?: { readonly at: number; readonly by: LeftMember["by"] }
}

/** A member with where it is kept. */
export interface Membership extends Member {
  readonly parentID: string
  readonly group: string
  readonly sessionID: string
}

/** What is known of a member's standing: its report is held, still out, or it left, or it is no longer in an open group. */
export type Standing = "held" | "out" | LeftMember["by"] | "released"

/** A member's standing from its stored value, or `released` when there is none. */
export function standingOf(member: Member | undefined): Standing {
  if (!member) return "released"
  if (member.report) return "held"
  return member.left?.by ?? "out"
}

function readMember(value: unknown): Member | undefined {
  const given = obj(value)
  const title = str(given.title)
  const joinedAt = num(given.joinedAt)
  if (title === undefined || joinedAt === undefined) return undefined
  const report = readReport(given.report)
  const left = obj(given.left)
  const by = str(left.by)
  return {
    title,
    joinedAt,
    ...(report ? { report } : {}),
    ...(by === "failed" || by === "interrupted" || by === "deleted" ? { left: { at: num(left.at) ?? 0, by } } : {}),
  }
}

function readReport(value: unknown): HeldReport | undefined {
  const given = obj(value)
  const status: unknown = given.status
  const message = str(given.message)
  const at = num(given.at)
  if (!isStatus(status) || message === undefined || at === undefined) return undefined
  return { at, status, message, ...(given.artifacts !== undefined ? { artifacts: given.artifacts as Artifacts } : {}) }
}

/** A member as the storage takes it, which asks for an index signature the interface lacks. */
const stored = (member: Member) => ({ ...member }) as unknown as Parameters<Storage["set"]>[1]

/** The members under `prefix`, a key prefix within `PREFIX`; a value that is not a member is left out. */
async function membersUnder(storage: Pick<Storage, "scan">, prefix: string): Promise<Membership[]> {
  const entries = await scanEntries<unknown>(storage, prefix)
  return entries.flatMap(({ key, value }) => {
    const parts = `${prefix.slice(PREFIX.length)}${key}`.split("/")
    const member = parts.length === 3 ? readMember(value) : undefined
    return member ? [{ ...member, parentID: parts[0]!, group: parts[1]!, sessionID: parts[2]! }] : []
  })
}

/** The member a session is in a parent's group, if the group is open and it is a member. */
export async function memberOf(storage: Pick<Storage, "get">, parentID: string, group: string, sessionID: string) {
  return readMember(await storage.get(memberKey(parentID, group, sessionID)))
}

/** Makes a spawned session a member of its parent's group, opening the group if it was not. */
export async function joinGroup(storage: Pick<Storage, "set">, parentID: string, group: string, sessionID: string, title: string, at: number) {
  await storage.set(memberKey(parentID, group, sessionID), stored({ title, joinedAt: at }))
}

/** Whether every member of a group has a held report or has left, so the group is released. */
const complete = (members: ReadonlyArray<Member>) => members.every((member) => member.report || member.left)

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

/** Whether a parent has a complete group with a report in it, whose message the scheduler is about to deliver. */
export async function hasCompleteGroup(storage: Pick<Storage, "scan">, parentID: string) {
  return [...byGroup(await membersUnder(storage, groupsPrefix(parentID))).values()].some(
    (members) => complete(members) && members.some((member) => member.report),
  )
}

/** Holds a member's report with its group, in place of an earlier one, or of how it had left. */
export async function holdReport(storage: Pick<Storage, "set">, membership: Membership, report: HeldReport) {
  const { parentID, group, sessionID, title, joinedAt } = membership
  await storage.set(memberKey(parentID, group, sessionID), stored({ title, joinedAt, report }))
}

/** How many members of a group have reported and how many have not left, and whether the group is complete. */
export async function groupStanding(storage: Pick<Storage, "scan">, parentID: string, group: string) {
  const members = await membersUnder(storage, groupPrefix(parentID, group))
  return {
    reported: members.filter((member) => member.report).length,
    members: members.filter((member) => !member.left).length,
    complete: complete(members),
  }
}

/** A session's membership of a parent's group, if it is a member; `out` says whether the group still waits for its report. */
export async function membershipOf(storage: Pick<Storage, "get">, parentID: string, group: string, sessionID: string) {
  const member = await memberOf(storage, parentID, group, sessionID)
  return member && { ...member, parentID, group, sessionID, out: standingOf(member) === "out" }
}

/**
 * Notes that a member left its group without a report: its turn failed or was interrupted, or it was deleted. Read
 * again first: one whose report is held meanwhile keeps it, one that left keeps why. True when that completes the group.
 */
export async function markLeft(storage: Pick<Storage, "get" | "set" | "scan">, membership: Membership, by: LeftMember["by"], at: number) {
  const { parentID, group, sessionID } = membership
  const current = await memberOf(storage, parentID, group, sessionID)
  if (!current || standingOf(current) !== "out") return false
  await storage.set(memberKey(parentID, group, sessionID), stored({ title: current.title, joinedAt: current.joinedAt, left: { at, by } }))
  return (await groupStanding(storage, parentID, group)).complete
}

/** `markLeft` for a member not read yet; undefined when it is in no open group. */
export async function leaveGroup(storage: Pick<Storage, "get" | "set" | "scan">, parentID: string, group: string, sessionID: string, by: LeftMember["by"], at: number) {
  const membership = await membershipOf(storage, parentID, group, sessionID)
  return membership && (await markLeft(storage, membership, by, at))
}

/**
 * Puts a member whose report is held back among those out: its latest word to the parent was a blocked report. Read
 * again first: a group released meanwhile is not opened again, and a report held since is kept.
 */
export async function unholdForBlocked(storage: Pick<Storage, "get" | "set">, membership: Membership) {
  const { parentID, group, sessionID, title, joinedAt } = membership
  if (!membership.report) return
  const current = await memberOf(storage, parentID, group, sessionID)
  if (JSON.stringify(current?.report) !== JSON.stringify(membership.report)) return
  await storage.set(memberKey(parentID, group, sessionID), stored({ title, joinedAt }))
}

/** Drops a member from its group as its roster entry goes, unless its report is held: that still goes to the parent. True when dropped. */
export async function dropMember(storage: Pick<Storage, "get" | "remove">, parentID: string, group: string, sessionID: string) {
  const member = await memberOf(storage, parentID, group, sessionID)
  if (!member || member.report) return false
  await storage.remove(memberKey(parentID, group, sessionID))
  return true
}

/** Drops a member from its group whatever it holds: its report could not be held after all, so it goes on its own. */
export async function unholdReport(storage: Pick<Storage, "remove">, membership: Membership) {
  await storage.remove(memberKey(membership.parentID, membership.group, membership.sessionID))
}

/** Drops every group of a parent, whose members' reports can no longer be delivered. */
export async function dropGroups(storage: Pick<Storage, "scan" | "remove">, parentID: string) {
  const members = await membersUnder(storage, groupsPrefix(parentID))
  await Promise.all(members.map((member) => storage.remove(memberKey(parentID, member.group, member.sessionID))))
}

export interface GroupPorts {
  readonly storage: Storage
  readonly session: Pick<Context["session"], "synthetic" | "get">
  readonly log: (message: string) => void
}

/** The claim key of a group's release, in the hub's shared set of deliveries under way. */
const claimKey = (parentID: string, group: string) => `group:${parentID}/${group}`

/**
 * Delivers every released group once, from the scheduler's tick: claimed in the shared `claimed`, re-read,
 * delivered and only then dropped, so a failed delivery is tried again at the next tick, and a crash in between delivers it again.
 */
export async function deliverReleased(ports: GroupPorts, claimed: Set<string>) {
  const groups = [...byGroup(await membersUnder(ports.storage, PREFIX))].filter(([key, members]) => complete(members) && !claimed.has(key))
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
 * Whether the parent's turn that started a group's last member has ended, so no more join it; `gone` when OpenCode no
 * longer knows the parent. A turn ending stamps the session's `time.idle`, which a shutdown does not.
 */
async function sealed(ports: GroupPorts, parentID: string, members: ReadonlyArray<Member>) {
  const joined = Math.max(...members.map((member) => member.joinedAt))
  try {
    const { time } = await ports.session.get({ sessionID: parentID })
    return (num(time.idle) ?? 0) >= joined
  } catch (error) {
    if (isNotFound(error)) return "gone"
    throw error
  }
}

async function release(ports: GroupPorts, parentID: string, group: string) {
  // Re-read: another server may have delivered and dropped it since the scan.
  const members = (await membersUnder(ports.storage, groupPrefix(parentID, group))).sort((a, b) => a.joinedAt - b.joinedAt)
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
  const dropped = await Promise.allSettled(members.map((member) => dropDelivered(ports.storage, member)))
  for (const [index, result] of dropped.entries())
    if (result.status === "rejected")
      ports.log(`courier group ${group} of ${parentID}: delivered, but ${members[index]!.sessionID} could not be dropped: ${String(result.reason)}`)
}

/** Drops a delivered member's key, unless it was written again since it was read: that report is still to deliver. */
async function dropDelivered(storage: Pick<Storage, "get" | "remove">, delivered: Membership) {
  const key = memberKey(delivered.parentID, delivered.group, delivered.sessionID)
  const { parentID, group, sessionID, ...read } = delivered
  if (JSON.stringify(readMember(await storage.get(key))) !== JSON.stringify(read)) return
  await storage.remove(key)
}
