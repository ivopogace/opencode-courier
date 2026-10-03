import { scanAll, type Storage } from "./storage.js"

/** Entries older than this are dropped when their parent's roster is read, and on plugin setup. */
export const RETENTION_MS = 14 * 24 * 60 * 60_000

const PREFIX = "roster/"

/** A session started with courier_spawn, recorded under the session that started it. */
export interface RosterEntry {
  readonly sessionID: string
  readonly parentID: string
  readonly title: string
  readonly directory: string
  readonly isolated: boolean
  readonly createdAt: number
}

export type RosterStorage = Storage

export function rosterKey(parentID: string, sessionID: string) {
  return `${PREFIX}${parentID}/${sessionID}`
}

export async function record(storage: RosterStorage, entry: RosterEntry) {
  await storage.set(rosterKey(entry.parentID, entry.sessionID), { ...entry })
}

/** Removes a child from its parent's roster; false when it was not there. */
export async function forget(storage: RosterStorage, parentID: string, sessionID: string) {
  const key = rosterKey(parentID, sessionID)
  if ((await storage.get(key)) === undefined) return false
  await storage.remove(key)
  return true
}

/** A parent's children, oldest first. */
export async function children(storage: RosterStorage, parentID: string) {
  const entries = await scanAll<RosterEntry>(storage, `${PREFIX}${parentID}/`)
  return entries.sort((a, b) => a.createdAt - b.createdAt)
}

/** Removes the given entries that were recorded more than `RETENTION_MS` before `now`, and returns the rest. */
async function dropExpired(storage: RosterStorage, entries: RosterEntry[], now: number) {
  const expired = entries.filter((entry) => now - entry.createdAt > RETENTION_MS)
  await Promise.all(expired.map((entry) => storage.remove(rosterKey(entry.parentID, entry.sessionID))))
  return entries.filter((entry) => !expired.includes(entry))
}

/** A parent's children, oldest first, after dropping the expired ones. */
export async function current(storage: RosterStorage, parentID: string, now: number) {
  return dropExpired(storage, await children(storage, parentID), now)
}

/** Drops expired entries of every parent, so parents that never list their children don't keep them forever. */
export async function pruneExpired(storage: RosterStorage, now: number) {
  await dropExpired(storage, await scanAll<RosterEntry>(storage, PREFIX), now)
}
