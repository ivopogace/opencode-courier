import { existsSync } from "node:fs"
import { scanAll, scanEntries, type Storage } from "./storage.js"

/**
 * Entries older than this are dropped when their parent's roster is read, and on plugin setup,
 * except isolated children whose worktree is still there: those stay until courier_cleanup.
 */
export const RETENTION_MS = 14 * 24 * 60 * 60_000

const PREFIX = "roster/"
/**
 * The reverse index: a child's `ReverseEntry` under `roster-by-child/<sessionID>`, written with its
 * roster entry; only an index, so `roster/` is scanned for entries lacking one, and confirms a hit.
 */
const BY_CHILD = "roster-by-child/"

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

/**
 * What the reverse index holds for a child: the sessions above it, its parent first and the top
 * session, which courier_spawn did not start, last; each is the parent of the one before it.
 */
export interface ReverseEntry {
  readonly ancestors: ReadonlyArray<string>
}

export type RosterStorage = Storage

export function rosterKey(parentID: string, sessionID: string) {
  return `${PREFIX}${parentID}/${sessionID}`
}

export function reverseKey(sessionID: string) {
  return `${BY_CHILD}${sessionID}`
}

/**
 * Records a child under its parent, then indexes it. The entry is what counts: a failed index
 * write leaves it to be found by a scan, and to be indexed when the plugin is next loaded.
 */
export async function record(storage: RosterStorage, entry: RosterEntry) {
  await storage.set(rosterKey(entry.parentID, entry.sessionID), { ...entry })
  await index(storage, entry).catch(() => undefined)
}

async function index(storage: RosterStorage, entry: RosterEntry) {
  const above = await storage.get(reverseKey(entry.parentID))
  const ancestors = isReverse(above) ? above.ancestors : (await lineage(storage, entry.parentID)).map((parent) => parent.parentID)
  await storage.set(reverseKey(entry.sessionID), { ancestors: [entry.parentID, ...ancestors] })
}

function isReverse(value: unknown): value is ReverseEntry {
  const ancestors = (value as { ancestors?: unknown } | undefined)?.ancestors
  return Array.isArray(ancestors) && ancestors.length > 0 && ancestors.every((id) => typeof id === "string")
}

/**
 * Removes a child's roster entry and its reverse key. Only the entry's removal can fail it: a
 * reverse key left behind leads nowhere, and the next load drops it.
 */
export async function remove(storage: RosterStorage, parentID: string, sessionID: string) {
  await Promise.all([storage.remove(rosterKey(parentID, sessionID)), storage.remove(reverseKey(sessionID)).catch(() => undefined)])
}

/** Removes a child from its parent's roster; false when it was not there. */
export async function forget(storage: RosterStorage, parentID: string, sessionID: string) {
  if ((await storage.get(rosterKey(parentID, sessionID))) === undefined) return false
  await remove(storage, parentID, sessionID)
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
  const indexed = await storage.get(reverseKey(sessionID))
  if (!isReverse(indexed))
    return (await scanAll<RosterEntry>(storage, PREFIX)).filter((entry) => entry.sessionID === sessionID)
  const entry = await storage.get(rosterKey(indexed.ancestors[0]!, sessionID))
  return entry === undefined ? [] : [entry as unknown as RosterEntry]
}

/**
 * The roster entries from a session up to the top, its own first, ending with the entry whose parent
 * courier_spawn did not start; empty when courier_spawn did not start the session.
 */
export async function lineage(storage: RosterStorage, sessionID: string) {
  const first = await storage.get(reverseKey(sessionID))
  if (!isReverse(first)) return lineageIn(await allEntries(storage), sessionID)
  let indexed: ReverseEntry = first
  const chain: RosterEntry[] = []
  let below = sessionID
  // One read per level, all at once, and one more for the top's own reverse key, in case it was
  // recorded after the key that names it; the chain ends where an entry is gone, as a scan's would.
  for (;;) {
    const { ancestors }: ReverseEntry = indexed
    const top = ancestors.at(-1)!
    const [entries, above]: [unknown[], unknown] = await Promise.all([
      Promise.all(ancestors.map((parentID, level) => storage.get(rosterKey(parentID, level ? ancestors[level - 1]! : below)))),
      storage.get(reverseKey(top)),
    ])
    for (const entry of entries as Array<RosterEntry | undefined>) {
      if (!entry || chain.some((known) => known.sessionID === entry.sessionID)) return chain
      chain.push(entry)
    }
    if (!isReverse(above)) return chain
    below = top
    indexed = above
  }
}

/** `lineage` over roster entries already read. */
export function lineageIn(entries: ReadonlyArray<RosterEntry>, sessionID: string) {
  const bySession = new Map(entries.map((entry) => [entry.sessionID, entry]))
  const chain: RosterEntry[] = []
  for (let entry = bySession.get(sessionID); entry && !chain.includes(entry); entry = bySession.get(entry.parentID)) chain.push(entry)
  return chain
}

/**
 * The top of a spawned session's lineage, where its permission requests and questions go, since the
 * person is there. Throws unless the session was spawned and `callerID` is that top; `what` names it.
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
  await Promise.all([...expired].map((entry) => remove(storage, entry.parentID, entry.sessionID)))
  return entries.filter((entry) => !expired.has(entry))
}

/** A parent's children, oldest first, after dropping the expired ones. */
export async function current(storage: RosterStorage, parentID: string, now: number, exists: Exists = existsSync) {
  return dropExpired(storage, await children(storage, parentID), now, exists)
}

/**
 * On loading: drops expired entries of every parent, so parents that never list their children
 * don't keep them forever, then brings the reverse index in line with what is left (`backfill`).
 */
export async function pruneExpired(storage: RosterStorage, now: number, exists: Exists = existsSync) {
  await backfill(storage, await dropExpired(storage, await scanAll<RosterEntry>(storage, PREFIX), now, exists))
}

/** Whether a reverse key's value leads to this entry. */
function indexes(value: unknown, entry: RosterEntry) {
  return isReverse(value) && value.ancestors[0] === entry.parentID
}

/**
 * Writes the reverse keys missing or stale for the given entries, or the whole roster, and drops those
 * whose entry is gone, as an older copy's writes and removals leave them; a rerun changes nothing.
 */
export async function backfill(storage: RosterStorage, entries: ReadonlyArray<RosterEntry>) {
  const indexed = new Map((await scanEntries<unknown>(storage, BY_CHILD)).map(({ key, value }) => [key, value]))
  const sessions = new Set(entries.map((entry) => entry.sessionID))
  await Promise.all([
    ...entries
      .filter((entry) => !indexes(indexed.get(entry.sessionID), entry))
      .map((entry) =>
        storage.set(reverseKey(entry.sessionID), { ancestors: lineageIn(entries, entry.sessionID).map((above) => above.parentID) }),
      ),
    ...[...indexed]
      .filter(([sessionID]) => !sessions.has(sessionID))
      .map(([sessionID, value]) => dropDangling(storage, sessionID, value)),
  ])
}

/**
 * Drops a reverse key whose entry was not in the roster read, unless that entry is there now:
 * another instance may have recorded the child since, and it writes the entry before the key.
 */
async function dropDangling(storage: RosterStorage, sessionID: string, value: unknown) {
  if (isReverse(value) && (await storage.get(rosterKey(value.ancestors[0]!, sessionID))) !== undefined) return
  await storage.remove(reverseKey(sessionID))
}
