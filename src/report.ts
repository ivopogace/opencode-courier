import { obj } from "./json.js"
import type { Status } from "./notices.js"
import type { Storage } from "./storage.js"

/**
 * Whether a spawned session has reported since its last prompt, under `report/<sessionID>/`: `prompt`, `settled` (with
 * the report's status), `progress` (a message to its parent without a status) and `told`; docs/reference.md has each.
 */
const PREFIX = "report/"

export const promptKey = (sessionID: string) => `${PREFIX}${sessionID}/prompt`
export const settledKey = (sessionID: string) => `${PREFIX}${sessionID}/settled`
export const progressKey = (sessionID: string) => `${PREFIX}${sessionID}/progress`
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

/**
 * Notes that a spawned session reported to its parent, with `status` when its report carried one, or
 * its turn failed or was interrupted, at `at`, unless a later end is noted.
 */
export async function settled(storage: Pick<Storage, "get" | "set">, sessionID: string, by: Settled, at: number, status?: Status) {
  if ((timeOf(await storage.get(settledKey(sessionID))) ?? -Infinity) <= at)
    await storage.set(settledKey(sessionID), { at, by, ...(status ? { status } : {}) })
}

/** Notes that a spawned session messaged its parent without a status at `at`, which is progress, not its report. */
export async function progressed(storage: Pick<Storage, "get" | "set">, sessionID: string, at: number) {
  if ((timeOf(await storage.get(progressKey(sessionID))) ?? -Infinity) <= at) await storage.set(progressKey(sessionID), { at })
}

/** Notes that a spawned session's parent was told, at `at`, that a turn of it ended without a report, unless a later telling is noted. */
export async function told(storage: Pick<Storage, "get" | "set">, sessionID: string, at: number) {
  if ((timeOf(await storage.get(toldKey(sessionID))) ?? -Infinity) <= at) await storage.set(toldKey(sessionID), { at })
}

/** Takes back the note `told` made at `at`, whose notice did not go out; a later one stays, and one that cannot be read goes. */
export async function untold(storage: Pick<Storage, "get" | "remove">, sessionID: string, at: number) {
  const stored = await storage.get(toldKey(sessionID)).then(timeOf, () => at)
  if (stored === at) await storage.remove(toldKey(sessionID))
}

/** Whether `at` is known and no earlier than the prompt at `prompt`. */
const since = (at: number | undefined, prompt: number) => at !== undefined && at >= prompt

/**
 * What is known of a spawned session's report: when a prompt last reached it, and whether since then it owes one, has
 * messaged its parent without a status, or failed or was interrupted. Undefined for one spawned before this was kept.
 */
export async function reportOf(storage: Pick<Storage, "get">, sessionID: string) {
  const [prompt, settledValue, progress] = await Promise.all(
    [promptKey, settledKey, progressKey].map((key) => storage.get(key(sessionID))),
  )
  const promptAt = timeOf(prompt)
  if (promptAt === undefined) return undefined
  const done = since(timeOf(settledValue), promptAt)
  return { prompt: promptAt, owes: !done, progressed: since(timeOf(progress), promptAt), ended: done && obj(settledValue).by !== "report" }
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
  await Promise.all([promptKey, settledKey, progressKey, toldKey].map((key) => storage.remove(key(sessionID))))
}
