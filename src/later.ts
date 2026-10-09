import type { Plugin } from "@opencode/plugin"
import { envelope } from "./notices.js"
import { scanAll, type Storage } from "./storage.js"

type Context = Plugin.Context

/** How often the hub's scheduler looks for due messages; a delivery can be this late. */
export const TICK_MS = 15_000

const PREFIX = "later/"
/** The latest time a Date can hold; a message due after it could never be shown or delivered. */
const LATEST = 8.64e15
/**
 * A plain decimal number of minutes, the only string form of delayMinutes taken ("0x10" is not),
 * once trimmed of the whitespace `\s` matches.
 */
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
  readonly session: Pick<Context["session"], "synthetic">
  readonly now: () => number
  readonly newID: () => string
  readonly log: (message: string) => void
}

export interface LaterInput {
  readonly message: string
  /** A number, or a string holding one, which some models send instead. */
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

/** Stores a message for later delivery; the scheduler in `deliverDue` sends it once it is due. */
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

/** Drops a pending message; false when there was none, e.g. it was already delivered. */
export async function cancel(ports: LaterPorts, id: string) {
  if ((await ports.storage.get(PREFIX + id)) === undefined) return false
  await ports.storage.remove(PREFIX + id)
  return true
}

function pending(ports: LaterPorts) {
  return scanAll<LaterEntry>(ports.storage, PREFIX)
}

/**
 * Delivers every due message once: an id is claimed synchronously in the shared `claimed`, re-read,
 * delivered and only then removed; a crash in between delivers it again after a restart, not never.
 */
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
          metadata: { source: "courier", from: due.from, scheduled: due.id },
          delivery: "queue",
        })
        .catch((error: unknown) => ports.log(`courier_later ${due.id} to ${due.sessionID} not delivered: ${String(error)}`))
      await ports.storage.remove(PREFIX + due.id)
    } finally {
      claimed.delete(due.id)
    }
  }
}
