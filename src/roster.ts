import { existsSync } from "node:fs"
import { scanAll, type Storage } from "./storage.js"

/**
 * Entries older than this are dropped when their parent's roster is read, and on plugin setup,
 * except isolated children whose worktree is still there: those stay until courier_cleanup.
 */
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
  /** For an isolated child, the directory its worktree was made from; for the record, nothing acts on it. */
  readonly source?: string
  /** For an isolated child, the project its worktree belongs to; courier_cleanup removes it from there. */
  readonly project?: string
  /** For an isolated child, the commit its worktree was made from; its own work is what came after. */
  readonly base?: string
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

/** Every parent's children. */
export async function allEntries(storage: RosterStorage) {
  return scanAll<RosterEntry>(storage, PREFIX)
}

/** A session's roster entries: one for the parent that started it, none if courier_spawn did not. */
export async function entriesOf(storage: RosterStorage, sessionID: string) {
  return (await scanAll<RosterEntry>(storage, PREFIX)).filter((entry) => entry.sessionID === sessionID)
}

/**
 * The roster entries from a session up to the top, its own first: the session's, its parent's, and
 * so on, ending with the entry whose parent courier_spawn did not start. Empty when courier_spawn
 * did not start the session.
 */
export async function lineage(storage: RosterStorage, sessionID: string) {
  return lineageIn(await allEntries(storage), sessionID)
}

/** `lineage` over roster entries already read. */
export function lineageIn(entries: ReadonlyArray<RosterEntry>, sessionID: string) {
  const bySession = new Map(entries.map((entry) => [entry.sessionID, entry]))
  const chain: RosterEntry[] = []
  for (let entry = bySession.get(sessionID); entry && !chain.includes(entry); entry = bySession.get(entry.parentID)) chain.push(entry)
  return chain
}

/**
 * The session at the top of a spawned session's lineage, where its permission requests and
 * questions go, since that is where the person is; only it may answer them. Throws when the
 * session was not started with courier_spawn or `callerID` is another session. `what` names
 * what is being answered.
 */
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

/** Whether a directory still exists; tests pass a fake. */
export type Exists = (directory: string) => boolean

/**
 * Removes the given entries that were recorded more than `RETENTION_MS` before `now`, and returns
 * the rest. An isolated child is kept while its worktree exists, so it can still be cleaned up.
 */
async function dropExpired(storage: RosterStorage, entries: RosterEntry[], now: number, exists: Exists) {
  const expired = new Set(
    entries.filter((entry) => now - entry.createdAt > RETENTION_MS && !(entry.isolated && exists(entry.directory))),
  )
  await Promise.all([...expired].map((entry) => storage.remove(rosterKey(entry.parentID, entry.sessionID))))
  return entries.filter((entry) => !expired.has(entry))
}

/** A parent's children, oldest first, after dropping the expired ones. */
export async function current(storage: RosterStorage, parentID: string, now: number, exists: Exists = existsSync) {
  return dropExpired(storage, await children(storage, parentID), now, exists)
}

/** Drops expired entries of every parent, so parents that never list their children don't keep them forever. */
export async function pruneExpired(storage: RosterStorage, now: number, exists: Exists = existsSync) {
  await dropExpired(storage, await scanAll<RosterEntry>(storage, PREFIX), now, exists)
}
