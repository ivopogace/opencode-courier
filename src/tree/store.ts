import { num, obj, str } from "../platform/json.js"
import { isStatus, type Status } from "../kernel/protocol.js"
import { scanAll, scanEntries, type Storage } from "../platform/storage.js"
import { lineageIn, type Artifacts, type HeldReport, type Member, type RosterEntry } from "./domain.js"
import type { ChildStore, GroupStore, Membership, ReportField, ReportNote, Settled, Stored, Wake, WakeStore } from "./ports.js"

// The tree's storage: the only file that knows its keys and layouts. Older copies and a second server on the same data
// directory read and write the same keys, so a key or a stored value never changes shape.

const PREFIX = "roster/"
/**
 * The reverse index: a child's `ReverseEntry` under `roster-by-child/<sessionID>`, written with its
 * roster entry; only an index, so `roster/` is scanned for entries lacking one, and confirms a hit.
 */
const BY_CHILD = "roster-by-child/"

/**
 * What the reverse index holds for a child: the sessions above it, its parent first and the top
 * session, which courier_spawn did not start, last; each is the parent of the one before it.
 */
export interface ReverseEntry {
  readonly ancestors: ReadonlyArray<string>
}

export function rosterKey(parentID: string, sessionID: string) {
  return `${PREFIX}${parentID}/${sessionID}`
}

export function reverseKey(sessionID: string) {
  return `${BY_CHILD}${sessionID}`
}

/**
 * Whether a spawned session has reported since its last prompt, under `report/<sessionID>/`: `prompt`, `settled` (with
 * the report's status), `progress` (a message to its parent without a status) and `told`; docs/maintainers/architecture.md has each.
 */
const REPORT_PREFIX = "report/"

export const promptKey = (sessionID: string) => `${REPORT_PREFIX}${sessionID}/prompt`
export const settledKey = (sessionID: string) => `${REPORT_PREFIX}${sessionID}/settled`
export const progressKey = (sessionID: string) => `${REPORT_PREFIX}${sessionID}/progress`
export const toldKey = (sessionID: string) => `${REPORT_PREFIX}${sessionID}/told`
export const stoppedKey = (sessionID: string) => `${REPORT_PREFIX}${sessionID}/stopped`

const REPORT_KEYS: Readonly<Record<ReportField, (sessionID: string) => string>> = {
  prompt: promptKey,
  settled: settledKey,
  progress: progressKey,
  told: toldKey,
  stopped: stoppedKey,
}

/**
 * Join groups: each member of a parent's group under `group/<parentID>/<name>/<sessionID>`, with its
 * held report or how it left; released and dropped once none is out. docs/maintainers/architecture.md, § Storage.
 */
const GROUP_PREFIX = "group/"

export const memberKey = (parentID: string, group: string, sessionID: string) => `${GROUP_PREFIX}${parentID}/${group}/${sessionID}`

/** The key prefix of a parent's groups, and of one group's members. */
export const groupsPrefix = (parentID: string) => `${GROUP_PREFIX}${parentID}/`
export const groupPrefix = (parentID: string, group: string) => `${groupsPrefix(parentID)}${group}/`

/**
 * The courier messages waiting in a session's inbox, each under `wake/<sessionID>/<inboxID>` until it is delivered, for
 * the scheduler to wake a session whose wake was missed. docs/maintainers/architecture.md, § Storage.
 */
const WAKE_PREFIX = "wake/"

export const wakeKey = (sessionID: string, inboxID: string) => `${WAKE_PREFIX}${sessionID}/${inboxID}`

function isReverse(value: unknown): value is ReverseEntry {
  const ancestors = (value as { ancestors?: unknown } | undefined)?.ancestors
  return Array.isArray(ancestors) && ancestors.length > 0 && ancestors.every((id) => typeof id === "string")
}

/** Whether a reverse key's value leads to this entry. */
function indexes(value: unknown, entry: RosterEntry) {
  return isReverse(value) && value.ancestors[0] === entry.parentID
}

const timeOf = (value: unknown) => {
  const at: unknown = obj(value).at
  return typeof at === "number" && Number.isFinite(at) ? at : undefined
}

const noteOf = (value: unknown): ReportNote => ({ at: timeOf(value), by: obj(value).by, status: obj(value).status })

/** The `ChildStore` over the plugin's storage. */
export function childStore(storage: Storage): ChildStore {
  const entry = async (parentID: string, sessionID: string) =>
    (await storage.get(rosterKey(parentID, sessionID))) as unknown as RosterEntry | undefined

  const all = () => scanAll<RosterEntry>(storage, PREFIX)

  const indexedParent = async (sessionID: string) => {
    const indexed = await storage.get(reverseKey(sessionID))
    return isReverse(indexed) ? indexed.ancestors[0] : undefined
  }

  const walkIndex = async (sessionID: string, first: ReverseEntry) => {
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

  /**
   * Drops a reverse key whose entry was not in the roster read, unless that entry is there now:
   * another instance may have recorded the child since, and it writes the entry before the key.
   */
  const dropDangling = async (sessionID: string, value: unknown) => {
    if (isReverse(value) && (await storage.get(rosterKey(value.ancestors[0]!, sessionID))) !== undefined) return
    await storage.remove(reverseKey(sessionID))
  }

  const forgetReport = async (sessionID: string) => {
    await Promise.all(Object.values(REPORT_KEYS).map((key) => storage.remove(key(sessionID))))
  }

  return {
    // The entry is what counts: written first, so a failed index write leaves it to be found by a scan.
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
      const entries = await scanAll<RosterEntry>(storage, `${PREFIX}${parentID}/`)
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
    // Both of the hub's subscriptions note each event, one of them maybe behind: an earlier note never replaces a later one.
    async prompted(sessionID, at) {
      if ((timeOf(await storage.get(promptKey(sessionID))) ?? -Infinity) < at) await storage.set(promptKey(sessionID), { at })
    },
    async settled(sessionID: string, by: Settled, at: number, status?: Status) {
      if ((timeOf(await storage.get(settledKey(sessionID))) ?? -Infinity) <= at)
        await storage.set(settledKey(sessionID), { at, by, ...(status ? { status } : {}) })
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
  }
}

function readMember(value: unknown): Member | undefined {
  const given = obj(value)
  const title = str(given.title)
  const joinedAt = num(given.joinedAt)
  if (title === undefined || joinedAt === undefined) return undefined
  const report = readReport(given.report)
  const left = obj(given.left)
  const by = str(left.by)
  return {
    title,
    joinedAt,
    ...(report ? { report } : {}),
    ...(by === "failed" || by === "interrupted" || by === "deleted" || by === "dropped" ? { left: { at: num(left.at) ?? 0, by } } : {}),
  }
}

function readReport(value: unknown): HeldReport | undefined {
  const given = obj(value)
  const status: unknown = given.status
  const message = str(given.message)
  const at = num(given.at)
  if (!isStatus(status) || message === undefined || at === undefined) return undefined
  return { at, status, message, ...(given.artifacts !== undefined ? { artifacts: given.artifacts as Artifacts } : {}) }
}

/** A member as the storage takes it, which asks for an index signature the interface lacks. */
const stored = (member: Member) => ({ ...member }) as unknown as Stored

/** The `GroupStore` over the plugin's storage. */
export function groupStore(storage: Storage): GroupStore {
  /** The members under `prefix`, a key prefix within `GROUP_PREFIX`; a value that is not a member is left out. */
  const membersUnder = async (prefix: string): Promise<Membership[]> => {
    const entries = await scanEntries<unknown>(storage, prefix)
    return entries.flatMap(({ key, value }) => {
      const parts = `${prefix.slice(GROUP_PREFIX.length)}${key}`.split("/")
      const member = parts.length === 3 ? readMember(value) : undefined
      return member ? [{ ...member, parentID: parts[0]!, group: parts[1]!, sessionID: parts[2]! }] : []
    })
  }

  return {
    member: async (parentID, group, sessionID) => readMember(await storage.get(memberKey(parentID, group, sessionID))),
    all: () => membersUnder(GROUP_PREFIX),
    ofParent: (parentID) => membersUnder(groupsPrefix(parentID)),
    ofGroup: (parentID, group) => membersUnder(groupPrefix(parentID, group)),
    async put(parentID, group, sessionID, member) {
      await storage.set(memberKey(parentID, group, sessionID), stored(member))
    },
    async remove(parentID, group, sessionID) {
      await storage.remove(memberKey(parentID, group, sessionID))
    },
  }
}

/** A watched message as stored under its key's session and inbox id; one that cannot be read is left out. */
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

/** The `WakeStore` over the plugin's storage. */
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
