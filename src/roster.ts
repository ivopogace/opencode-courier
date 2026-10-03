import type { Plugin } from "@opencode-ai/plugin"

type Context = Plugin.Context

/** Entries older than this are dropped the next time their parent's roster is read. */
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

export type RosterStorage = Pick<Context["storage"], "get" | "set" | "remove" | "scan">

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
  const entries: RosterEntry[] = []
  let after: string | undefined
  do {
    const page = await storage.scan({ prefix: `${PREFIX}${parentID}/`, ...(after ? { after } : {}) })
    for (const entry of page.entries) entries.push(entry.value as unknown as RosterEntry)
    after = page.next
  } while (after)
  return entries.sort((a, b) => a.createdAt - b.createdAt)
}

/** A parent's children after dropping those recorded more than `RETENTION_MS` before `now`. */
export async function current(storage: RosterStorage, parentID: string, now: number) {
  const kept: RosterEntry[] = []
  for (const entry of await children(storage, parentID)) {
    if (now - entry.createdAt > RETENTION_MS) await storage.remove(rosterKey(parentID, entry.sessionID))
    else kept.push(entry)
  }
  return kept
}
