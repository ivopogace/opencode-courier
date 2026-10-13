import { envelope, isStatus, STATUSES, type Status } from "../kernel/protocol.js"
import { groupStanding, holdReport, memberKey, membershipOf, unholdForBlocked, unholdReport, type Membership } from "./group.js"
import type { Artifacts, CourierPorts, Held, HeldReport, RosterEntry, Sent } from "./ports.js"
import { progressed, progressKey, settled, settledKey } from "./report.js"
import { indexedEntry } from "./roster.js"
import { reportBody } from "./text.js"

export interface SendInput {
  readonly sessionID: string
  readonly message: string
  readonly status?: Status
  readonly artifacts?: Artifacts
  readonly queue?: boolean
}

/**
 * Drops a message into another session's inbox; OpenCode wakes that session if it is idle. From a spawned session
 * to the one that started it, it is its report or its progress (`noteReport`); a group member's final report is held (`hold`).
 */
export async function send(ports: CourierPorts, from: string, input: SendInput): Promise<Sent> {
  // Some models send null for an optional field they leave out.
  const status = input.status ?? undefined
  if (status !== undefined && !isStatus(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}, not ${JSON.stringify(status)}.`)
  // Noted first: the delivery may wake the parent, whose turn may end before a later note.
  const noted = await noteReport(ports, from, input.sessionID, status).catch(() => undefined)
  try {
    const held = noted?.member && status && status !== "blocked" ? await hold(ports, noted.member, { at: noted.at, status, message: input.message, ...(input.artifacts ? { artifacts: input.artifacts } : {}) }) : undefined
    if (held) return { status, report: true, held }
    const delivered = await ports.session.synthetic({
      sessionID: input.sessionID,
      text: envelope(from, reportBody(input.message, input.artifacts), status ? { status } : {}),
      description: `Message from ${from}`,
      metadata: { source: "courier", from, ...(status ? { status } : {}) },
      delivery: input.queue ? "queue" : "steer",
    })
    // A blocked report, once delivered, is the member's latest word: an earlier report held for it would be stale.
    if (noted?.member && status === "blocked") await unholdForBlocked(ports.storage, noted.member).catch(() => undefined)
    return { messageID: delivered.id, ...(status ? { status } : {}), ...(noted ? { report: noted.report } : {}) }
  } catch (error) {
    await noted?.undo().catch(() => undefined)
    throw error
  }
}

/**
 * Notes `from`'s message to `to` when `to` started it: as its report when it carries a status, or when an earlier
 * release briefed `from`, else as progress. Returns which, when, how to take the note back, and `from`'s group membership.
 */
async function noteReport(ports: CourierPorts, from: string, to: string, status: Status | undefined) {
  const entry = await indexedEntry(ports.storage, from)
  if (entry?.parentID !== to) return undefined
  const report = status !== undefined || entry.reports !== "status"
  const key = report ? settledKey(from) : progressKey(from)
  const before = await ports.storage.get(key)
  const at = ports.now()
  await (report ? settled(ports.storage, from, "report", at, status) : progressed(ports.storage, from, at))
  // Only its own note: another courier_send of the session's may have noted its report since.
  const undo = async () => {
    const now = (await ports.storage.get(key)) as { at?: unknown; by?: unknown } | undefined
    if (now?.at !== at || (report && now.by !== "report")) return
    await (before === undefined ? ports.storage.remove(key) : ports.storage.set(key, before))
  }
  return { report, at, undo, member: status !== undefined ? await memberIn(ports, entry) : undefined }
}

/**
 * A child's membership of an open group of its parent's, by its roster entry; none once courier_cleanup dropped it. One that
 * cannot be read is dropped from the group, best effort, as the report then goes on its own and the group must not wait for it.
 */
async function memberIn(ports: CourierPorts, entry: RosterEntry): Promise<Membership | undefined> {
  if (!entry.group) return undefined
  try {
    const member = await membershipOf(ports.storage, entry.parentID, entry.group, entry.sessionID)
    return member?.left?.by === "dropped" ? undefined : member
  } catch (error) {
    ports.log(`courier_send: ${entry.sessionID}'s place in group ${entry.group} could not be read, so its report goes on its own: ${String(error)}`)
    await ports.storage.remove(memberKey(entry.parentID, entry.group, entry.sessionID)).then(() => ports.nudge(), () => undefined)
    return undefined
  }
}

/**
 * Holds a member's report with its group, and nudges the scheduler if that completes the group. Undefined
 * when it could not be held: the member is dropped from the group, which releases without it, and reports on its own.
 */
async function hold(ports: CourierPorts, member: Membership, report: HeldReport): Promise<Held | undefined> {
  try {
    await holdReport(ports.storage, member, report)
  } catch (error) {
    // Neither held nor dropped, the group would wait for ever: the call fails, and the sender sends it again.
    await unholdReport(ports.storage, member).catch((dropError: unknown) => {
      throw new Error(`the report could not be held with group ${member.group} (${String(error)}), nor the member dropped from it (${String(dropError)}); send it again.`)
    })
    ports.nudge()
    return undefined
  }
  // Held whatever the count gives; a count that cannot be read gets the nudge, as a tick that finds nothing due is cheap.
  const standing = await groupStanding(ports.storage, member.parentID, member.group).catch(() => undefined)
  if (standing?.complete !== false) ports.nudge()
  return { group: member.group, ...(standing ? { reported: standing.reported, members: standing.members } : {}) }
}
