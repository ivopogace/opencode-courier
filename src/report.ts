import { obj } from "./json.js"
import type { Storage } from "./storage.js"

/**
 * Whether a spawned session has reported since its last prompt, kept under `report/<sessionID>/`:
 * `prompt`, when a prompt or message last reached it; `settled`, when it last reported, failed or was
 * interrupted; `told`, when its parent was last told that a turn of it ended without a report.
 */
const PREFIX = "report/"

export const promptKey = (sessionID: string) => `${PREFIX}${sessionID}/prompt`
export const settledKey = (sessionID: string) => `${PREFIX}${sessionID}/settled`
export const toldKey = (sessionID: string) => `${PREFIX}${sessionID}/told`

/** How a session's wait for a report ended: it reported to its parent, or its turn failed or was interrupted. */
export type Settled = "report" | "failed" | "interrupted"

const timeOf = (value: unknown) => {
  const at: unknown = obj(value).at
  return typeof at === "number" && Number.isFinite(at) ? at : undefined
}

/**
 * Notes that a prompt or message reached a spawned session at `at`, in epoch milliseconds, unless a
 * later one is noted: both of the hub's subscriptions note each event, one of them maybe behind.
 */
export async function prompted(storage: Pick<Storage, "get" | "set">, sessionID: string, at: number) {
  if ((timeOf(await storage.get(promptKey(sessionID))) ?? -Infinity) < at) await storage.set(promptKey(sessionID), { at })
}

/** Notes that a spawned session reported to its parent, or its turn failed or was interrupted, at `at`, unless a later end is noted. */
export async function settled(storage: Pick<Storage, "get" | "set">, sessionID: string, by: Settled, at: number) {
  if ((timeOf(await storage.get(settledKey(sessionID))) ?? -Infinity) <= at) await storage.set(settledKey(sessionID), { at, by })
}

/** Notes that a spawned session's parent was told, at `at`, that a turn of it ended without a report. */
export async function told(storage: Pick<Storage, "set">, sessionID: string, at: number) {
  await storage.set(toldKey(sessionID), { at })
}

/** Whether `at` is known and no earlier than the prompt at `prompt`. */
const since = (at: number | undefined, prompt: number) => at !== undefined && at >= prompt

/**
 * What is known of a spawned session's report: when a prompt last reached it, whether it owes one,
 * and whether its turn failed or was interrupted since. Undefined for one spawned before this was kept.
 */
export async function reportOf(storage: Pick<Storage, "get">, sessionID: string) {
  const [prompt, settledValue] = await Promise.all([storage.get(promptKey(sessionID)), storage.get(settledKey(sessionID))])
  const promptAt = timeOf(prompt)
  if (promptAt === undefined) return undefined
  const done = since(timeOf(settledValue), promptAt)
  return { prompt: promptAt, owes: !done, ended: done && obj(settledValue).by !== "report" }
}

/**
 * Whether its parent still waits on a spawned session's report: it owes one, and the parent has not
 * been told since its last prompt that it ended a turn without one.
 */
export async function awaited(storage: Pick<Storage, "get">, sessionID: string) {
  const [prompt, settledAt, toldAt] = await Promise.all(
    [promptKey, settledKey, toldKey].map((key) => storage.get(key(sessionID)).then(timeOf)),
  )
  return prompt !== undefined && !since(settledAt, prompt) && !since(toldAt, prompt)
}

/** Drops what is kept about a session, with its roster entry. */
export async function forgetReport(storage: Pick<Storage, "remove">, sessionID: string) {
  await Promise.all([promptKey, settledKey, toldKey].map((key) => storage.remove(key(sessionID))))
}
