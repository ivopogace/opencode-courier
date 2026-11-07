import type { Plugin } from "@opencode/plugin"
import { envelope } from "../kernel/protocol.js"
import { scanAll, type Storage } from "../platform/storage.js"

type Context = Plugin.Context

const PREFIX = "later/"
const LATEST = 8.64e15
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/

export interface LaterEntry {
  readonly id: string
  readonly sessionID: string
  readonly from: string
  readonly message: string
  readonly fireAt: number
  readonly createdAt: number
}

export interface LaterPorts {
  readonly storage: Storage
  readonly session: Pick<Context["session"], "synthetic" | "get" | "context">
  readonly now: () => number
  readonly newID: () => string
  readonly log: (message: string) => void
}

export interface LaterInput {
  readonly message: string
  readonly delayMinutes?: number | string
  readonly at?: string
  readonly sessionID?: string
}

function minutesOf(given: number | string) {
  if (typeof given !== "string") return given
  const trimmed = given.trim()
  return DECIMAL.test(trimmed) ? Number(trimmed) : Number.NaN
}

function fireTime(now: number, input: LaterInput) {
  if ((input.delayMinutes === undefined) === (input.at === undefined))
    throw new Error("Give exactly one of delayMinutes or at.")
  if (input.delayMinutes !== undefined) {
    const given = input.delayMinutes
    const minutes = minutesOf(given)
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error("delayMinutes must be a number of minutes, zero or more.")
    const fireAt = now + Math.round(minutes * 60_000)
    if (fireAt > LATEST) throw new Error(`delayMinutes is too far away: ${given}`)
    return fireAt
  }
  const at = Date.parse(input.at!)
  if (Number.isNaN(at)) throw new Error(`at is not a date: ${input.at}`)
  if (at < now) throw new Error(`at is in the past: ${input.at}`)
  return at
}

export async function schedule(ports: LaterPorts, from: string, input: LaterInput): Promise<LaterEntry> {
  const now = ports.now()
  const entry: LaterEntry = {
    id: ports.newID(),
    sessionID: input.sessionID ?? from,
    from,
    message: input.message,
    fireAt: fireTime(now, input),
    createdAt: now,
  }
  await ports.storage.set(PREFIX + entry.id, { ...entry })
  return entry
}

export async function cancel(ports: LaterPorts, id: string) {
  if ((await ports.storage.get(PREFIX + id)) === undefined) return false
  await ports.storage.remove(PREFIX + id)
  return true
}

function pending(ports: Pick<LaterPorts, "storage">) {
  return scanAll<LaterEntry>(ports.storage, PREFIX)
}

export async function scheduledFor(storage: Pick<Storage, "scan">, sessionID: string) {
  return (await pending({ storage: storage as Storage })).filter((entry) => entry.sessionID === sessionID)
}

export async function cancelScheduled(ports: LaterPorts, sessionID: string) {
  const scheduled = await scheduledFor(ports.storage, sessionID)
  const dropped = await Promise.all(scheduled.map(async (later) => ((await cancel(ports, later.id)) ? later.id : undefined)))
  return dropped.filter((id) => id !== undefined)
}

export async function isScheduled(ports: { readonly storage: Pick<Storage, "scan"> }, sessionID: string) {
  return (await scheduledFor(ports.storage, sessionID)).length > 0
}

export async function deliverDue(ports: LaterPorts, claimed: Set<string>) {
  const now = ports.now()
  for (const due of (await pending(ports)).filter((entry) => entry.fireAt <= now)) {
    if (claimed.has(due.id)) continue
    claimed.add(due.id)
    try {
      if ((await ports.storage.get(PREFIX + due.id)) === undefined) continue
      await ports.session
        .synthetic({
          sessionID: due.sessionID,
          text: envelope(due.from, due.message, { scheduled: new Date(due.createdAt).toISOString() }),
          description: `Scheduled message from ${due.from}`,
          metadata: { source: "courier", from: due.from, scheduled: due.id, scheduledAt: due.createdAt },
          delivery: "queue",
        })
        .catch((error: unknown) => ports.log(`courier_later ${due.id} to ${due.sessionID} not delivered: ${String(error)}`))
      await ports.storage.remove(PREFIX + due.id)
    } finally {
      claimed.delete(due.id)
    }
  }
}
