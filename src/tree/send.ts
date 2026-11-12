import { envelope, isStatus, STATUSES, type Status } from "../kernel/protocol.js"
import { groupStanding, heldByOthers, holdReport, membershipFor, unholdForBlocked } from "./group.js"
import type { Artifacts, CourierPorts, Held, HeldReport, Membership, RosterEntry, Sent } from "./ports.js"
import { syncStanding } from "./standing.js"
import { childStore, groupStore } from "./store.js"
import { findingAhead, heldSoFar, reportBody } from "./text.js"
import { noteSent } from "./wake.js"

export interface SendInput {
  readonly sessionID: string
  readonly message: string
  readonly status?: Status
  readonly artifacts?: Artifacts
  readonly queue?: boolean
  readonly finding?: string
}

export async function send(ports: CourierPorts, from: string, input: SendInput): Promise<Sent> {
  const { status, dropped } = await statusFor(ports, from, input)
  const finding = input.finding?.trim() || undefined
  const noted = await noteReport(ports, from, input.sessionID, status).catch(() => undefined)
  try {
    const kept = await keep(ports, noted, input, status, finding)
    if (noted) await syncStanding(ports, input.sessionID)
    if (kept) return await heldSent(ports, from, input.sessionID, kept)
    const delivered = await deliver(ports, from, input, status, noted, finding)
    return { ...delivered, ...(noted ? { report: noted.report } : {}), ...(dropped ? { dropped } : {}) }
  } catch (error) {
    await noted?.undo().catch(() => undefined)
    if (noted) await syncStanding(ports, input.sessionID)
    throw error
  }
}

async function keep(ports: CourierPorts, noted: Awaited<ReturnType<typeof noteReport>>, input: SendInput, status: Status | undefined, finding: string | undefined) {
  if (!noted?.member || !status || status === "blocked") return undefined
  const report: HeldReport = { at: noted.at, status, message: input.message, ...(input.artifacts ? { artifacts: input.artifacts } : {}), ...(finding ? { finding } : {}) }
  const kept = await hold(ports, noted.member, report)
  return kept && { ...kept, report }
}

async function heldSent(ports: CourierPorts, from: string, to: string, { held, report, due }: { readonly held: Held; readonly report: HeldReport; readonly due: boolean }): Promise<Sent> {
  const finding = report.finding ? await ahead(ports, from, to, held.group, report.status, report.finding) : undefined
  if (due) ports.nudge()
  return { status: report.status, report: true, held, ...(finding ? { finding } : {}) }
}

async function deliver(ports: CourierPorts, from: string, input: SendInput, status: Status | undefined, noted: Awaited<ReturnType<typeof noteReport>>, finding: string | undefined): Promise<Sent> {
  const held = noted?.member && status === "blocked" ? await heldWith(ports, noted.member) : ""
  const text = envelope(from, reportBody(input.message, input.artifacts, finding) + held, status ? { status } : {})
  const description = `Message from ${from}`
  const delivered = await ports.session.synthetic({
    sessionID: input.sessionID,
    text,
    description,
    metadata: { source: "courier", from, ...(status ? { status } : {}) },
    delivery: input.queue ? "queue" : "steer",
  })
  await noteSent(ports, { sessionID: input.sessionID, inboxID: delivered.id, text, description }).catch(() => undefined)
  if (noted?.member && status === "blocked") await unholdForBlocked(groupStore(ports.storage), noted.member).catch(() => undefined)
  return { messageID: delivered.id, ...(status ? { status } : {}) }
}

async function ahead(ports: CourierPorts, from: string, to: string, group: string, status: Status, finding: string) {
  const text = envelope(from, findingAhead(group, status, finding), { finding: "ahead" })
  const description = `Finding from ${from}`
  try {
    const delivered = await ports.session.synthetic({ sessionID: to, text, description, metadata: { source: "courier", from, finding: "ahead" }, delivery: "steer" })
    await noteSent(ports, { sessionID: to, inboxID: delivered.id, text, description }).catch(() => undefined)
    return "ahead" as const
  } catch (error) {
    ports.log(`courier_send: the finding of ${from}'s report, held with group ${group}, could not be delivered to ${to}: ${String(error)}`)
    return "unsent" as const
  }
}

async function heldWith(ports: CourierPorts, member: Membership) {
  try {
    return heldSoFar(member.group, await heldByOthers(groupStore(ports.storage), member))
  } catch (error) {
    ports.log(`courier_send: the reports held with group ${member.group} could not be read for ${member.sessionID}'s blocked report: ${String(error)}`)
    return ""
  }
}

async function statusFor(ports: CourierPorts, from: string, input: SendInput): Promise<{ status?: Status; dropped?: Status }> {
  const given = input.status ?? undefined
  if (given === undefined) return {}
  if (!isStatus(given)) throw new Error(`status must be one of ${STATUSES.join(", ")}, not ${JSON.stringify(given)}.`)
  return (await isBelow(ports, from, input.sessionID)) ? { dropped: given } : { status: given }
}

async function isBelow(ports: CourierPorts, from: string, to: string) {
  const above = await childStore(ports.storage).indexedAncestors(to).catch((): ReadonlyArray<string> => [])
  return above.includes(from)
}

async function noteReport(ports: CourierPorts, from: string, to: string, status: Status | undefined) {
  const children = childStore(ports.storage)
  const entry = await children.indexedEntry(from)
  if (entry?.parentID !== to) return undefined
  const report = status !== undefined || entry.reports !== "status"
  const field = report ? "settled" : "progress"
  const before = await children.peek(from, field)
  const at = ports.now()
  await (report ? children.settled(from, "report", at, status) : children.progressed(from, at))
  const undo = async () => {
    const now = (await children.peek(from, field)) as { at?: unknown; by?: unknown } | undefined
    if (now?.at !== at || (report && now.by !== "report")) return
    await children.restore(from, field, before)
  }
  return { report, at, undo, member: status !== undefined ? await memberIn(ports, entry) : undefined }
}

async function memberIn(ports: CourierPorts, entry: RosterEntry): Promise<Membership | undefined> {
  const groups = groupStore(ports.storage)
  try {
    const member = await membershipFor(groups, entry)
    return member?.left?.by === "dropped" ? undefined : member
  } catch (error) {
    ports.log(`courier_send: ${entry.sessionID}'s place in group ${entry.group} could not be read, so its report goes on its own: ${String(error)}`)
    if (entry.group) await groups.remove(entry.parentID, entry.group, entry.sessionID).then(() => ports.nudge(), () => undefined)
    return undefined
  }
}

async function hold(ports: CourierPorts, member: Membership, report: HeldReport): Promise<{ readonly held: Held; readonly due: boolean } | undefined> {
  const groups = groupStore(ports.storage)
  try {
    await holdReport(groups, member, report)
  } catch (error) {
    await groups.remove(member.parentID, member.group, member.sessionID).catch((dropError: unknown) => {
      throw new Error(`the report could not be held with group ${member.group} (${String(error)}), nor the member dropped from it (${String(dropError)}); send it again.`)
    })
    ports.nudge()
    return undefined
  }
  const standing = await groupStanding(groups, member.parentID, member.group).catch(() => undefined)
  return { held: { group: member.group, ...(standing ? { reported: standing.reported, members: standing.members } : {}) }, due: standing?.complete !== false }
}
