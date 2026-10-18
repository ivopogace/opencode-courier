import { finite, num, obj, str } from "../platform/json.js"
import { scanEntries, type Storage } from "../platform/storage.js"
import {
  isPartStatus,
  type Lesson,
  lessonText,
  MAX_REVISIONS,
  NOT_STATED,
  type PartRecord,
  type Recalled,
  type Revision,
  type StoredRecord,
  type TreeRecord,
} from "./domain.js"
import type { MemoryStore } from "./ports.js"

// The memory's storage: the only file that knows its key and layout. A record is read leniently, as one written by
// hand with `e2e/kv.ts set` is: what is missing takes a default, a part without a session id is left out.

const PREFIX = "memory/"

/** A record as the storage takes it, which asks for an index signature the interface lacks. */
type Stored = Parameters<Storage["set"]>[1]

export const recordKey = (projectID: string, sessionID: string) => `${PREFIX}${projectID}/${sessionID}`

/** The key prefix of a project's records. */
export const projectPrefix = (projectID: string) => `${PREFIX}${projectID}/`

function readPart(value: unknown): PartRecord | undefined {
  const given = obj(value)
  const sessionID = str(given.sessionID)
  if (sessionID === undefined) return undefined
  const optional = <K extends "duration" | "cost" | "context" | "refused">(field: K) => {
    const number = finite(given[field])
    return number === undefined ? {} : { [field]: number }
  }
  const group = str(given.group)
  return {
    sessionID,
    title: str(given.title) ?? "",
    depth: num(given.depth) ?? 1,
    isolated: given.isolated === true,
    ...(group ? { group } : {}),
    status: isPartStatus(given.status) ? given.status : "out",
    ...optional("duration"),
    ...optional("cost"),
    ...optional("context"),
    ...optional("refused"),
  }
}

function readRecalled(value: unknown): Recalled | undefined {
  const given = obj(value)
  const calls = num(given.calls)
  if (calls === undefined) return undefined
  const at = num(given.at)
  return at === undefined ? { calls } : { at, calls }
}

/** A lesson as `{ text, at, depth }`, or as a bare string written by hand, dated `movedAt`; none for an empty text. */
function readLesson(value: unknown, movedAt: number): Lesson | undefined {
  const given = typeof value === "string" ? { text: value } : obj(value)
  const { text } = lessonText(str(given.text) ?? "")
  if (!text) return undefined
  const depth = num(given.depth)
  return { text, at: num(given.at) ?? movedAt, ...(depth !== undefined && Number.isInteger(depth) && depth > 0 ? { depth } : {}) }
}

/** The revisions as `{ text, at, parts }`, the newest `MAX_REVISIONS`, leaving out an entry without a text, a time or a count of parts. */
function readRevisions(value: unknown): Revision[] {
  if (!Array.isArray(value)) return []
  const revisions = value.flatMap((entry: unknown): Revision[] => {
    const given = obj(entry)
    const text = str(given.text)?.trim()
    const at = num(given.at)
    const parts = num(given.parts)
    return text && at !== undefined && parts !== undefined && parts >= 0 ? [{ text, at, parts }] : []
  })
  return revisions.slice(-MAX_REVISIONS)
}

/** A record as stored, or undefined for a value that is not one. */
export function readRecord(value: unknown): TreeRecord | undefined {
  const given = obj(value)
  if (!Array.isArray(given.parts)) return undefined
  const recalled = readRecalled(given.recalled)
  const movedAt = num(given.movedAt) ?? num(given.startedAt) ?? 0
  const lesson = readLesson(given.lesson, movedAt)
  const revisions = readRevisions(given.revisions)
  return {
    startedAt: num(given.startedAt) ?? 0,
    movedAt,
    title: str(given.title) ?? "",
    split: str(given.split) ?? NOT_STATED,
    ...(revisions.length ? { revisions } : {}),
    finished: given.finished === true,
    ...(recalled ? { recalled } : {}),
    ...(lesson ? { lesson } : {}),
    parts: given.parts.map(readPart).filter((part: PartRecord | undefined): part is PartRecord => part !== undefined),
  }
}

/** The `MemoryStore` over the plugin's storage. */
export function memoryStore(storage: Storage): MemoryStore {
  const under = async (prefix: string): Promise<StoredRecord[]> => {
    const entries = await scanEntries<unknown>(storage, prefix)
    return entries.flatMap(({ key, value }) => {
      const parts = `${prefix.slice(PREFIX.length)}${key}`.split("/")
      const record = parts.length === 2 ? readRecord(value) : undefined
      return record ? [{ ...record, projectID: parts[0]!, sessionID: parts[1]! }] : []
    })
  }
  return {
    get: async (projectID, sessionID) => readRecord(await storage.get(recordKey(projectID, sessionID))),
    async put(projectID, sessionID, record) {
      await storage.set(recordKey(projectID, sessionID), { ...record, parts: record.parts.map((part) => ({ ...part })) } as unknown as Stored)
    },
    async remove(projectID, sessionID) {
      await storage.remove(recordKey(projectID, sessionID))
    },
    ofProject: (projectID) => under(projectPrefix(projectID)),
    all: () => under(PREFIX),
  }
}
