import type { Plugin } from "@opencode/plugin"
import { num, obj, str } from "./json.js"
import { envelope, groupNotice, isStatus, type Artifacts, type HeldReport, type LeftMember } from "./notices.js"
import { scanEntries, type Storage } from "./storage.js"

type Context = Plugin.Context

/**
 * Join groups: the members of each group a parent named with courier_spawn, under
 * `group/<parentID>/<name>/<sessionID>`, each with its held report once it has one, or how it left
 * (its turn failed, or it was deleted). A group is released, delivered to the parent in one message
 * and dropped, once every member has a held report or has left; docs/reference.md, § Join groups.
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
    ...(by === "failed" || by === "deleted" ? { left: { at: num(left.at) ?? 0, by } } : {}),
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
    const parts = `${prefix}${key}`.slice(PREFIX.length).split("/")
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

/** The members of each open group of a parent, by group name, in the order they joined. */
export async function groupsOf(storage: Pick<Storage, "scan">, parentID: string) {
  const members = await membersUnder(storage, groupsPrefix(parentID))
  const groups = new Map<string, Membership[]>()
  for (const member of members.sort((a, b) => a.joinedAt - b.joinedAt)) groups.set(member.group, [...(groups.get(member.group) ?? []), member])
  return groups
}

/** Whether every member of a group has a held report or has left, so the group is released. */
const complete = (members: ReadonlyArray<Member>) => members.every((member) => member.report || member.left)

/**
 * Holds a member's report with its group: written over its earlier one, if any, or over how it had left. Returns
 * how many members have reported and how many there are, and whether the group is complete now.
 */
export async function holdReport(storage: Pick<Storage, "get" | "set" | "scan">, membership: Membership, report: HeldReport) {
  const { parentID, group, sessionID, title, joinedAt } = membership
  await storage.set(memberKey(parentID, group, sessionID), stored({ title, joinedAt, report }))
  const members = await membersUnder(storage, groupPrefix(parentID, group))
  return {
    reported: members.filter((other) => other.report).length,
    members: members.filter((other) => !other.left).length,
    complete: complete(members),
  }
}

/**
 * Notes that a member left its group without a report: its turn failed, or it was deleted. One whose report is
 * held keeps it. Returns the group's name, and whether the group is complete now; undefined when it was in none.
 */
export async function leaveGroup(storage: Pick<Storage, "get" | "set" | "scan">, parentID: string, group: string, sessionID: string, by: LeftMember["by"], at: number) {
  const member = await memberOf(storage, parentID, group, sessionID)
  if (!member) return undefined
  if (!member.report) await storage.set(memberKey(parentID, group, sessionID), stored({ title: member.title, joinedAt: member.joinedAt, left: { at, by } }))
  return { complete: complete(await membersUnder(storage, groupPrefix(parentID, group))) }
}

/** Drops a member from its group, with its roster entry; the group is released without it. */
export async function dropMember(storage: Pick<Storage, "remove">, parentID: string, group: string, sessionID: string) {
  await storage.remove(memberKey(parentID, group, sessionID))
}

/** Drops every group of a parent, whose members' reports can no longer be delivered. */
export async function dropGroups(storage: Pick<Storage, "scan" | "remove">, parentID: string) {
  const members = await membersUnder(storage, groupsPrefix(parentID))
  await Promise.all(members.map((member) => storage.remove(memberKey(parentID, member.group, member.sessionID))))
}

export interface GroupPorts {
  readonly storage: Storage
  readonly session: Pick<Context["session"], "synthetic">
  readonly log: (message: string) => void
}

/** The claim key of a group's release, in the hub's shared set of deliveries under way. */
const claimKey = (parentID: string, group: string) => `group:${parentID}/${group}`

/**
 * Delivers every released group once, from the scheduler's tick: claimed in the shared `claimed`, re-read,
 * delivered and only then dropped, so a delivery that fails is tried again at the next tick, and a crash
 * in between delivers it again after a restart, not never. A group whose every member left is dropped unsent.
 */
export async function deliverReleased(ports: GroupPorts, claimed: Set<string>) {
  const groups = new Map<string, Membership[]>()
  for (const member of await membersUnder(ports.storage, PREFIX)) {
    const key = claimKey(member.parentID, member.group)
    groups.set(key, [...(groups.get(key) ?? []), member])
  }
  for (const [key, members] of groups) {
    if (!complete(members) || claimed.has(key)) continue
    claimed.add(key)
    try {
      await release(ports, members[0]!.parentID, members[0]!.group)
    } finally {
      claimed.delete(key)
    }
  }
}

async function release(ports: GroupPorts, parentID: string, group: string) {
  // Re-read: another server may have delivered and dropped it since the scan.
  const members = (await membersUnder(ports.storage, groupPrefix(parentID, group))).sort((a, b) => a.joinedAt - b.joinedAt)
  if (!members.length || !complete(members)) return
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
        metadata: { source: "courier", from: reports.map((report) => report.sessionID), group, reports: reports.length },
        delivery: "steer",
      })
    } catch (error) {
      ports.log(`courier group ${group} of ${parentID} not delivered, held for another try: ${String(error)}`)
      return
    }
  }
  await Promise.all(members.map((member) => ports.storage.remove(memberKey(parentID, group, member.sessionID))))
}
