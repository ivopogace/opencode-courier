import { obj } from "./json.js"
import type { Storage } from "./storage.js"

/**
 * Whether a spawned session has reported since its last prompt, kept under `report/<sessionID>/`:
 * `prompt`, when a prompt or message last reached it; `settled`, when it last reported, failed or was interrupted.
 */
const PREFIX = "report/"

export const promptKey = (sessionID: string) => `${PREFIX}${sessionID}/prompt`
export const settledKey = (sessionID: string) => `${PREFIX}${sessionID}/settled`

/** How a session's wait for a report ended: it reported to its parent, or its turn failed or was interrupted. */
export type Settled = "report" | "failed" | "interrupted"

const timeOf = (value: unknown) => {
  const at: unknown = obj(value).at
  return typeof at === "number" && Number.isFinite(at) ? at : undefined
}

/** Notes that a prompt or message reached a spawned session at `at`, in epoch milliseconds. */
export async function prompted(storage: Pick<Storage, "set">, sessionID: string, at: number) {
  await storage.set(promptKey(sessionID), { at })
}

/** Notes that a spawned session reported to its parent, or its turn failed or was interrupted, at `at`. */
export async function settled(storage: Pick<Storage, "set">, sessionID: string, by: Settled, at: number) {
  await storage.set(settledKey(sessionID), { at, by })
}

/**
 * Whether a spawned session owes its parent a report: something reached it after it last reported,
 * failed or was interrupted. False when nothing is known, as for a session spawned before this was kept.
 */
export async function owesReport(storage: Pick<Storage, "get">, sessionID: string) {
  const [prompt, settledAt] = await Promise.all([storage.get(promptKey(sessionID)), storage.get(settledKey(sessionID))])
  const promptAt = timeOf(prompt)
  if (promptAt === undefined) return false
  const doneAt = timeOf(settledAt)
  return doneAt === undefined || doneAt < promptAt
}

/** Drops what is kept about a session, with its roster entry. */
export async function forgetReport(storage: Pick<Storage, "remove">, sessionID: string) {
  await Promise.all([storage.remove(promptKey(sessionID)), storage.remove(settledKey(sessionID))])
}
