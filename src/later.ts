import type { Plugin } from "@opencode-ai/plugin"
import { envelope } from "./courier.js"

type Context = Plugin.Context

/** How often each plugin instance looks for due messages; a delivery can be this late. */
export const TICK_MS = 15_000

const PREFIX = "later/"

export interface LaterEntry {
  readonly id: string
  readonly sessionID: string
  readonly from: string
  readonly message: string
  readonly fireAt: number
  readonly createdAt: number
}

export interface LaterPorts {
  readonly storage: Pick<Context["storage"], "get" | "set" | "remove" | "scan">
  readonly session: Pick<Context["session"], "synthetic">
  readonly now: () => number
  readonly newID: () => string
  readonly log: (message: string) => void
}

export interface LaterInput {
  readonly message: string
  readonly delayMinutes?: number
  readonly at?: string
  readonly sessionID?: string
}

function fireTime(now: number, input: LaterInput) {
  if ((input.delayMinutes === undefined) === (input.at === undefined))
    throw new Error("Give exactly one of delayMinutes or at.")
  if (input.delayMinutes !== undefined) {
    if (!Number.isFinite(input.delayMinutes) || input.delayMinutes < 0)
      throw new Error("delayMinutes must be a number of minutes, zero or more.")
    return now + Math.round(input.delayMinutes * 60_000)
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

async function pending(ports: LaterPorts) {
  const entries: LaterEntry[] = []
  let after: string | undefined
  do {
    const page = await ports.storage.scan({ prefix: PREFIX, ...(after ? { after } : {}) })
    for (const entry of page.entries) entries.push(entry.value as unknown as LaterEntry)
    after = page.next
  } while (after)
  return entries
}

/**
 * Delivers every due message once. OpenCode sets the plugin up once per project location, all in
 * one process and over one storage, so the instances share `claimed`: an id is claimed
 * synchronously, re-read after the claim (another instance may have just delivered it), delivered,
 * and only then removed. A crash between delivery and removal delivers it again after a restart,
 * which a check-in survives better than being lost.
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
