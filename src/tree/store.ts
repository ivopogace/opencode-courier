import { num, obj, str } from "../platform/json.js"
import type { Status } from "../kernel/protocol.js"
import { scanAll, scanEntries, type Storage } from "../platform/storage.js"
import { lineageIn, type RosterEntry } from "./domain.js"
import type { ChildStore, ReportField, ReportNote, Settled, Stored, Typed, Wake, WakeStore } from "./ports.js"

const ROSTER_PREFIX = "roster/"
const BY_CHILD = "roster-by-child/"

export interface ReverseEntry {
  readonly ancestors: ReadonlyArray<string>
}

export function rosterKey(parentID: string, sessionID: string) {
  return `${ROSTER_PREFIX}${parentID}/${sessionID}`
}

export function reverseKey(sessionID: string) {
  return `${BY_CHILD}${sessionID}`
}

const REPORT_PREFIX = "report/"

export const promptKey = (sessionID: string) => `${REPORT_PREFIX}${sessionID}/prompt`
export const settledKey = (sessionID: string) => `${REPORT_PREFIX}${sessionID}/settled`
export const progressKey = (sessionID: string) => `${REPORT_PREFIX}${sessionID}/progress`
export const toldKey = (sessionID: string) => `${REPORT_PREFIX}${sessionID}/told`
export const stoppedKey = (sessionID: string) => `${REPORT_PREFIX}${sessionID}/stopped`
export const nudgedKey = (sessionID: string) => `${REPORT_PREFIX}${sessionID}/nudged`

const REPORT_KEYS: Readonly<Record<ReportField, (sessionID: string) => string>> = {
  prompt: promptKey,
  settled: settledKey,
  progress: progressKey,
  told: toldKey,
  stopped: stoppedKey,
  nudged: nudgedKey,
}

const WAKE_PREFIX = "wake/"

export const wakeKey = (sessionID: string, inboxID: string) => `${WAKE_PREFIX}${sessionID}/${inboxID}`

const TYPED_PREFIX = "typed/"

export const typedKey = (sessionID: string, inboxID: string) => `${TYPED_PREFIX}${sessionID}/${inboxID}`

function readTyped(value: unknown): Typed | undefined {
  const at = num(obj(value).at)
  const text = str(obj(value).text)
  return at === undefined || text === undefined ? undefined : { at, text }
}

function isReverse(value: unknown): value is ReverseEntry {
  const ancestors = (value as { ancestors?: unknown } | undefined)?.ancestors
  return Array.isArray(ancestors) && ancestors.length > 0 && ancestors.every((id) => typeof id === "string")
}

function indexes(value: unknown, entry: RosterEntry) {
  return isReverse(value) && value.ancestors[0] === entry.parentID
}

const timeOf = (value: unknown) => {
  const at: unknown = obj(value).at
  return typeof at === "number" && Number.isFinite(at) ? at : undefined
}

const noteOf = (value: unknown): ReportNote => ({ at: timeOf(value), by: obj(value).by, status: obj(value).status, resumesAt: obj(value).resumesAt })

export function childStore(storage: Storage): ChildStore {
  const entry = async (parentID: string, sessionID: string) =>
    (await storage.get(rosterKey(parentID, sessionID))) as unknown as RosterEntry | undefined

  const all = () => scanAll<RosterEntry>(storage, ROSTER_PREFIX)

  const indexedAncestors = async (sessionID: string) => {
    const indexed = await storage.get(reverseKey(sessionID))
    return isReverse(indexed) ? indexed.ancestors : []
  }
  const indexedParent = async (sessionID: string) => (await indexedAncestors(sessionID))[0]

  const walkIndex = async (sessionID: string, first: ReverseEntry) => {
    let indexed: ReverseEntry = first
    const chain: RosterEntry[] = []
    let below = sessionID
    for (;;) {
      const { ancestors }: ReverseEntry = indexed
      const top = ancestors.at(-1)!
      const [entries, above]: [unknown[], unknown] = await Promise.all([
        Promise.all(ancestors.map((parentID, level) => storage.get(rosterKey(parentID, level ? ancestors[level - 1]! : below)))),
        storage.get(reverseKey(top)),
      ])
      for (const found of entries as Array<RosterEntry | undefined>) {
        if (!found || chain.some((known) => known.sessionID === found.sessionID)) return chain
        chain.push(found)
      }
      if (!isReverse(above)) return chain
      below = top
      indexed = above
    }
  }

  const lineage = async (sessionID: string) => {
    const first = await storage.get(reverseKey(sessionID))
    if (!isReverse(first)) return lineageIn(await all(), sessionID)
    return walkIndex(sessionID, first)
  }

  const index = async (child: RosterEntry) => {
    const above = await storage.get(reverseKey(child.parentID))
    const ancestors = isReverse(above) ? above.ancestors : (await lineage(child.parentID)).map((parent) => parent.parentID)
    await storage.set(reverseKey(child.sessionID), { ancestors: [child.parentID, ...ancestors] })
  }

  const dropDangling = async (sessionID: string, value: unknown) => {
    if (isReverse(value) && (await storage.get(rosterKey(value.ancestors[0]!, sessionID))) !== undefined) return
    await storage.remove(reverseKey(sessionID))
  }

  const forgetTyped = async (sessionID: string, inboxID?: string) => {
    if (inboxID !== undefined) return storage.remove(typedKey(sessionID, inboxID))
    const rows = await scanEntries<unknown>(storage, `${TYPED_PREFIX}${sessionID}/`)
    await Promise.all(rows.map(({ key }) => storage.remove(typedKey(sessionID, key))))
  }

  const forgetReport = async (sessionID: string) => {
    await Promise.all([...Object.values(REPORT_KEYS).map((key) => storage.remove(key(sessionID))), forgetTyped(sessionID)])
  }

  return {
    async record(child) {
      await storage.set(rosterKey(child.parentID, child.sessionID), { ...child })
      await index(child).catch(() => undefined)
    },
    async remove(parentID, sessionID) {
      await Promise.all([
        storage.remove(rosterKey(parentID, sessionID)),
        storage.remove(reverseKey(sessionID)).catch(() => undefined),
        forgetReport(sessionID).catch(() => undefined),
      ])
    },
    entry,
    async children(parentID) {
      const entries = await scanAll<RosterEntry>(storage, `${ROSTER_PREFIX}${parentID}/`)
      return entries.sort((a, b) => a.createdAt - b.createdAt)
    },
    all,
    async entriesOf(sessionID) {
      const parentID = await indexedParent(sessionID)
      if (parentID === undefined) return (await all()).filter((found) => found.sessionID === sessionID)
      const found = await storage.get(rosterKey(parentID, sessionID))
      return found === undefined ? [] : [found as unknown as RosterEntry]
    },
    indexedParent,
    indexedAncestors,
    async indexedEntry(sessionID) {
      const parentID = await indexedParent(sessionID)
      return parentID === undefined ? undefined : entry(parentID, sessionID)
    },
    lineage,
    async indexedLineage(sessionID) {
      const first = await storage.get(reverseKey(sessionID))
      return isReverse(first) ? walkIndex(sessionID, first) : []
    },
    async backfill(entries) {
      const indexed = new Map((await scanEntries<unknown>(storage, BY_CHILD)).map(({ key, value }) => [key, value]))
      const sessions = new Set(entries.map((child) => child.sessionID))
      await Promise.all([
        ...entries
          .filter((child) => !indexes(indexed.get(child.sessionID), child))
          .map((child) =>
            storage.set(reverseKey(child.sessionID), { ancestors: lineageIn(entries, child.sessionID).map((above) => above.parentID) }),
          ),
        ...[...indexed]
          .filter(([sessionID]) => !sessions.has(sessionID))
          .map(([sessionID, value]) => dropDangling(sessionID, value)),
      ])
    },
    async notes<F extends ReportField>(sessionID: string, fields: ReadonlyArray<F>) {
      const values = await Promise.all(fields.map((field) => storage.get(REPORT_KEYS[field](sessionID))))
      return Object.fromEntries(fields.map((field, i) => [field, noteOf(values[i])])) as { readonly [K in F]: ReportNote }
    },
    async prompted(sessionID, at) {
      if ((timeOf(await storage.get(promptKey(sessionID))) ?? -Infinity) < at) await storage.set(promptKey(sessionID), { at })
    },
    async settled(sessionID: string, by: Settled, at: number, status?: Status, resumesAt?: number) {
      if ((timeOf(await storage.get(settledKey(sessionID))) ?? -Infinity) <= at)
        await storage.set(settledKey(sessionID), { at, by, ...(status ? { status } : {}), ...(resumesAt === undefined ? {} : { resumesAt }) })
    },
    async progressed(sessionID, at) {
      if ((timeOf(await storage.get(progressKey(sessionID))) ?? -Infinity) <= at) await storage.set(progressKey(sessionID), { at })
    },
    async told(sessionID, at) {
      if ((timeOf(await storage.get(toldKey(sessionID))) ?? -Infinity) <= at) await storage.set(toldKey(sessionID), { at })
    },
    async untold(sessionID, at) {
      const stored = await storage.get(toldKey(sessionID)).then(timeOf, () => at)
      if (stored === at) await storage.remove(toldKey(sessionID))
    },
    async stopped(sessionID, at) {
      await storage.set(stoppedKey(sessionID), { at })
    },
    async nudged(sessionID, at, inboxID) {
      await storage.set(nudgedKey(sessionID), { at, ...(inboxID === undefined ? {} : { inboxID }) })
    },
    async nudgeOf(sessionID) {
      const value = await storage.get(nudgedKey(sessionID))
      const inboxID = str(obj(value).inboxID)
      return { at: timeOf(value), ...(inboxID === undefined ? {} : { inboxID }) }
    },
    async peek(sessionID, field) {
      const value = await storage.get(REPORT_KEYS[field](sessionID))
      return value
    },
    async restore(sessionID, field, value) {
      const key = REPORT_KEYS[field](sessionID)
      await (value === undefined ? storage.remove(key) : storage.set(key, value))
    },
    forgetReport,
    async reported() {
      const keys = new Map<string, string[]>()
      for (const { key } of await scanEntries<unknown>(storage, REPORT_PREFIX)) {
        const slash = key.indexOf("/")
        const sessionID = key.slice(0, slash)
        if (slash > 0) keys.set(sessionID, [...(keys.get(sessionID) ?? []), `${REPORT_PREFIX}${key}`])
      }
      return keys
    },
    async dropReported(keys) {
      await Promise.all(keys.map((key) => storage.remove(key).catch(() => undefined)))
    },
    async typed(sessionID, inboxID, at, text) {
      await storage.set(typedKey(sessionID, inboxID), { at, text })
    },
    typedOf: async (sessionID, inboxID) => readTyped(await storage.get(typedKey(sessionID, inboxID))),
    forgetTyped,
    async typedSessions() {
      const rows = await scanEntries<unknown>(storage, TYPED_PREFIX)
      return new Set(rows.map(({ key }) => key.slice(0, key.indexOf("/"))))
    },
  }
}

function readWake(sessionID: string, inboxID: string, value: unknown): Wake | undefined {
  const given = obj(value)
  const at = num(given.at)
  const text = str(given.text)
  if (at === undefined || text === undefined || typeof given.running !== "boolean") return undefined
  const optional = (field: "idleAt" | "rewoken" | "stalled") => {
    const time = num(given[field])
    return time === undefined ? {} : { [field]: time }
  }
  const description = str(given.description)
  return {
    sessionID,
    inboxID,
    at,
    text,
    ...(description !== undefined ? { description } : {}),
    running: given.running,
    ...optional("idleAt"),
    ...optional("rewoken"),
    ...optional("stalled"),
  }
}

export function wakeStore(storage: Storage): WakeStore {
  const under = async (prefix: string) => {
    const entries = await scanEntries<unknown>(storage, prefix)
    return entries.flatMap(({ key, value }) => {
      const parts = `${prefix.slice(WAKE_PREFIX.length)}${key}`.split("/")
      const wake = parts.length === 2 ? readWake(parts[0]!, parts[1]!, value) : undefined
      return wake ? [wake] : []
    })
  }
  return {
    async put({ sessionID, inboxID, ...wake }) {
      await storage.set(wakeKey(sessionID, inboxID), { ...wake })
    },
    of: (sessionID) => under(`${WAKE_PREFIX}${sessionID}/`),
    all: () => under(WAKE_PREFIX),
    async remove(sessionID, inboxID) {
      await storage.remove(wakeKey(sessionID, inboxID))
    },
  }
}
