import { existsSync } from "node:fs"
import { isStatus, type Status } from "../kernel/protocol.js"
import { isExpired as expiredBy, type Exists } from "./domain.js"
import { forgetChild, forgetReports } from "./forget.js"
import type { ReportKeys, RosterEntry, RosterStorage } from "./ports.js"
import { stoppedSincePrompt } from "./report.js"
import { childStore } from "./store.js"

export { RETENTION_MS, type Exists } from "./domain.js"

/** Every parent's children. */
export async function allEntries(storage: RosterStorage) {
  return childStore(storage).all()
}

/**
 * The roster entries from a session up to the top, its own first, ending with the entry whose parent
 * courier_spawn did not start; empty when courier_spawn did not start the session.
 */
export async function lineage(storage: RosterStorage, sessionID: string) {
  return childStore(storage).lineage(sessionID)
}

/** `lineage` by the reverse index alone: empty, without scanning the roster, when it does not name the session. */
export async function indexedLineage(storage: RosterStorage, sessionID: string) {
  return childStore(storage).indexedLineage(sessionID)
}

/** The sessions a session started, oldest first, expired entries included. */
export async function childrenOf(storage: RosterStorage, parentID: string) {
  return childStore(storage).children(parentID)
}

/**
 * What another module reads of a spawned session's report: `known` once a prompt was noted, whether it `owes` one, how
 * its wait `ended` when not by a report, the `status` of its last report, and whether courier_stop `stopped` it since its last prompt.
 */
export interface ReportState {
  readonly known: boolean
  readonly owes: boolean
  readonly ended?: "failed" | "interrupted"
  readonly status?: Status
  readonly stopped: boolean
}

export async function reportState(storage: RosterStorage, sessionID: string): Promise<ReportState> {
  const children = childStore(storage)
  const [{ prompt, settled }, stopped] = await Promise.all([children.notes(sessionID, ["prompt", "settled"]), stoppedSincePrompt(children, sessionID)])
  const known = prompt.at !== undefined
  const done = known && settled.at !== undefined && settled.at >= prompt.at!
  const by = settled.by
  return {
    known,
    owes: known && !done,
    ...(done && (by === "failed" || by === "interrupted") ? { ended: by } : {}),
    ...(isStatus(settled.status) ? { status: settled.status } : {}),
    stopped,
  }
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

/** `domain.ts`'s `isExpired`, asking the file system whether an isolated child's worktree is still there unless a test passes a fake. */
export const isExpired = (entry: RosterEntry, now: number, exists: Exists = existsSync) => expiredBy(entry, now, exists)

/** Forgets the given entries that are expired at `now`, and returns the rest. */
async function dropExpired(storage: RosterStorage, entries: RosterEntry[], now: number, exists: Exists) {
  const expired = new Set(entries.filter((entry) => isExpired(entry, now, exists)))
  await Promise.all([...expired].map((entry) => forgetChild(storage, entry.parentID, entry.sessionID, entry.group)))
  return entries.filter((entry) => !expired.has(entry))
}

/** A parent's children, oldest first, after dropping the expired ones. */
export async function current(storage: RosterStorage, parentID: string, now: number, exists: Exists = existsSync) {
  return dropExpired(storage, await childStore(storage).children(parentID), now, exists)
}

/**
 * On loading: drops expired entries of every parent, then brings the reverse index in line with
 * what is left (`backfill`) and drops report state with no entry (`dropOrphanedReports`).
 */
export async function pruneExpired(storage: RosterStorage, now: number, exists: Exists = existsSync) {
  const children = childStore(storage)
  // Report keys are read before the roster: courier_spawn writes a child's entry before its first
  // report key, so a session seen here that spawns during the sweep has its entry in the read below.
  const reported = await children.reported().catch((): ReportKeys => new Map<string, string[]>())
  const entries = await dropExpired(storage, await children.all(), now, exists)
  await Promise.all([children.backfill(entries), dropOrphanedReports(storage, reported, entries)])
}

/** Removes the report keys read of sessions that have no roster entry. */
async function dropOrphanedReports(storage: RosterStorage, reported: ReportKeys, entries: ReadonlyArray<RosterEntry>) {
  const sessions = new Set(entries.map((entry) => entry.sessionID))
  await forgetReports(storage, reported, [...reported.keys()].filter((sessionID) => !sessions.has(sessionID)))
}
