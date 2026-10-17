import { finite, num, obj, str } from "../platform/json.js"
import { scanEntries, type Storage } from "../platform/storage.js"
import { isPartStatus, NOT_STATED, type PartRecord, type Recalled, type StoredRecord, type TreeRecord } from "./domain.js"
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

/** A record as stored, or undefined for a value that is not one. */
export function readRecord(value: unknown): TreeRecord | undefined {
  const given = obj(value)
  if (!Array.isArray(given.parts)) return undefined
  const recalled = readRecalled(given.recalled)
  return {
    startedAt: num(given.startedAt) ?? 0,
    movedAt: num(given.movedAt) ?? num(given.startedAt) ?? 0,
    title: str(given.title) ?? "",
    split: str(given.split) ?? NOT_STATED,
    finished: given.finished === true,
    ...(recalled ? { recalled } : {}),
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
