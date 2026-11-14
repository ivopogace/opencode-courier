import { existsSync } from "node:fs"
import { isExpired as expiredBy, type Exists } from "./domain.js"
import { forgetChild, forgetReports } from "./forget.js"
import type { ReportKeys, RosterEntry, RosterStorage } from "./ports.js"
import { childStore } from "./store.js"

export { RETENTION_MS, type Exists } from "./domain.js"

export async function allEntries(storage: RosterStorage) {
  return childStore(storage).all()
}

export async function lineage(storage: RosterStorage, sessionID: string) {
  return childStore(storage).lineage(sessionID)
}

export async function answeringTop(storage: RosterStorage, sessionID: string, callerID: string, what: string) {
  const chain = await lineage(storage, sessionID)
  if (!chain.length) throw new Error(`${sessionID} was not started with courier_spawn, so courier_answer cannot answer for it.`)
  const top = chain.at(-1)!.parentID
  if (top !== callerID)
    throw new Error(
      `${sessionID}'s ${what} go to ${top}, the session at the top of the sessions started from it with courier_spawn; ${callerID} cannot answer them.`,
    )
  return top
}

export const isExpired = (entry: RosterEntry, now: number, exists: Exists = existsSync) => expiredBy(entry, now, exists)

async function dropExpired(storage: RosterStorage, entries: RosterEntry[], now: number, exists: Exists) {
  const expired = new Set(entries.filter((entry) => isExpired(entry, now, exists)))
  await Promise.all([...expired].map((entry) => forgetChild(storage, entry.parentID, entry.sessionID)))
  return entries.filter((entry) => !expired.has(entry))
}

export async function current(storage: RosterStorage, parentID: string, now: number, exists: Exists = existsSync) {
  return dropExpired(storage, await childStore(storage).children(parentID), now, exists)
}

export async function pruneExpired(storage: RosterStorage, now: number, exists: Exists = existsSync) {
  const children = childStore(storage)
  const [reported, typed] = await Promise.all([
    children.reported().catch((): ReportKeys => new Map<string, string[]>()),
    children.typedSessions().catch((): ReadonlySet<string> => new Set<string>()),
  ])
  const entries = await dropExpired(storage, await children.all(), now, exists)
  await Promise.all([children.backfill(entries), dropOrphanedReports(storage, reported, entries), dropOrphanedTyped(storage, typed, entries)])
}

async function dropOrphanedTyped(storage: RosterStorage, typed: ReadonlySet<string>, entries: ReadonlyArray<RosterEntry>) {
  const children = childStore(storage)
  const sessions = new Set(entries.map((entry) => entry.sessionID))
  await Promise.all([...typed].filter((sessionID) => !sessions.has(sessionID)).map((sessionID) => children.forgetTyped(sessionID).catch(() => undefined)))
}

async function dropOrphanedReports(storage: RosterStorage, reported: ReportKeys, entries: ReadonlyArray<RosterEntry>) {
  const sessions = new Set(entries.map((entry) => entry.sessionID))
  await forgetReports(storage, reported, [...reported.keys()].filter((sessionID) => !sessions.has(sessionID)))
}
