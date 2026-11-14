import { envelope, isStatus, STATUSES, type Status } from "../kernel/protocol.js"
import type { Artifacts, CourierPorts, Sent } from "./ports.js"
import { syncStanding } from "./standing.js"
import { childStore } from "./store.js"
import { reportBody } from "./text.js"
import { noteSent } from "./wake.js"

export interface SendInput {
  readonly sessionID: string
  readonly message: string
  readonly status?: Status
  readonly artifacts?: Artifacts
}

export async function send(ports: CourierPorts, from: string, input: SendInput): Promise<Sent> {
  const { status, dropped } = await statusFor(ports, from, input)
  const noted = await noteReport(ports, from, input.sessionID, status).catch(() => undefined)
  try {
    if (noted) await syncStanding(ports, input.sessionID)
    const delivered = await deliver(ports, from, input, status)
    return { ...delivered, ...(noted ? { report: noted.report } : {}), ...(dropped ? { dropped } : {}) }
  } catch (error) {
    await noted?.undo().catch(() => undefined)
    if (noted) await syncStanding(ports, input.sessionID)
    throw error
  }
}

async function deliver(ports: CourierPorts, from: string, input: SendInput, status: Status | undefined): Promise<Sent> {
  const text = envelope(from, reportBody(input.message, input.artifacts), status ? { status } : {})
  const description = `Message from ${from}`
  const delivered = await ports.session.synthetic({
    sessionID: input.sessionID,
    text,
    description,
    metadata: { source: "courier", from, ...(status ? { status } : {}) },
    delivery: "steer",
  })
  await noteSent(ports, { sessionID: input.sessionID, inboxID: delivered.id, text, description }).catch(() => undefined)
  return { messageID: delivered.id, ...(status ? { status } : {}) }
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
  return { report, undo }
}
