import { finite, num, obj, str } from "../platform/json.js"
import { scanEntries, type Storage } from "../platform/storage.js"
import {
  isPartStatus,
  type Lesson,
  lessonText,
  MAX_REVISIONS,
  NOT_STATED,
  noteRead,
  type PartRecord,
  type Pinned,
  type Reads,
  type Recalled,
  type Revision,
  type StoredRecord,
  sumReads,
  type TreeRecord,
} from "./domain.js"
import type { MemoryStore } from "./ports.js"


const PREFIX = "memory/"

type Stored = Parameters<Storage["set"]>[1]

export const recordKey = (projectID: string, sessionID: string) => `${PREFIX}${projectID}/${sessionID}`

export const projectPrefix = (projectID: string) => `${PREFIX}${projectID}/`

const besidePrefix = (projectID: string, sessionID: string) => `${recordKey(projectID, sessionID)}/`

export const pinKey = (projectID: string, sessionID: string) => `${besidePrefix(projectID, sessionID)}pin`

export const readsKey = (projectID: string, sessionID: string, by: string) => `${besidePrefix(projectID, sessionID)}reads/${by}`

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
    ...(given.subagent === true ? { subagent: true as const } : {}),
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

function readLesson(value: unknown, movedAt: number): Lesson | undefined {
  const given = typeof value === "string" ? { text: value } : obj(value)
  const { text } = lessonText(str(given.text) ?? "")
  if (!text) return undefined
  const depth = num(given.depth)
  return { text, at: num(given.at) ?? movedAt, ...(depth !== undefined && Number.isInteger(depth) && depth > 0 ? { depth } : {}) }
}

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

function readReads(value: unknown): Reads | undefined {
  const given = obj(value)
  const at = num(given.at)
  if (at === undefined) return undefined
  const count = (field: "shown" | "read") => Math.max(0, Math.floor(num(given[field]) ?? 0))
  return { shown: count("shown"), read: count("read"), at }
}

const readPinned = (value: unknown): Pinned => ({ at: num(obj(value).at) ?? 0 })

interface Beside {
  pinned?: Pinned
  reads: Reads[]
}

function beside(record: TreeRecord, { pinned, reads }: Beside): TreeRecord {
  const { parts, ...facts } = record
  const summed = sumReads(reads)
  return { ...facts, ...(summed ? { reads: summed } : {}), ...(pinned ? { pinned } : {}), parts }
}

const pathOf = (prefix: string, key: string) => `${prefix.slice(PREFIX.length)}${key}`.split("/")

function group(prefix: string, entries: ReadonlyArray<{ key: string; value: unknown }>) {
  const groups = new Map<string, { record?: unknown; beside: Beside }>()
  const of = (projectID: string, sessionID: string) => {
    const id = `${projectID}/${sessionID}`
    const found = groups.get(id) ?? { beside: { reads: [] } }
    groups.set(id, found)
    return found
  }
  for (const { key, value } of entries) {
    const [projectID, sessionID, kind, by] = pathOf(prefix, key)
    if (!projectID || !sessionID) continue
    if (kind === undefined) of(projectID, sessionID).record = value
    else if (kind === "pin" && by === undefined) of(projectID, sessionID).beside.pinned = readPinned(value)
    else if (kind === "reads" && by) {
      const reads = readReads(value)
      if (reads) of(projectID, sessionID).beside.reads.push(reads)
    }
  }
  return [...groups].map(([id, found]) => {
    const [projectID, sessionID] = id.split("/") as [string, string]
    return { projectID, sessionID, ...found }
  })
}

export function memoryStore(storage: Storage): MemoryStore {
  const scanned = async (prefix: string) => group(prefix, await scanEntries<unknown>(storage, prefix))
  const under = async (prefix: string): Promise<StoredRecord[]> =>
    (await scanned(prefix)).flatMap(({ projectID, sessionID, record: value, beside: others }) => {
      const record = readRecord(value)
      return record ? [{ ...beside(record, others), projectID, sessionID }] : []
    })
  return {
    async get(projectID, sessionID) {
      const [value, others] = await Promise.all([storage.get(recordKey(projectID, sessionID)), scanned(besidePrefix(projectID, sessionID))])
      const record = readRecord(value)
      return record && beside(record, others[0]?.beside ?? { reads: [] })
    },
    async put(projectID, sessionID, { reads: _reads, pinned: _pinned, ...record }) {
      await storage.set(recordKey(projectID, sessionID), { ...record, parts: record.parts.map((part) => ({ ...part })) } as unknown as Stored)
    },
    async remove(projectID, sessionID) {
      const others = await scanEntries<unknown>(storage, besidePrefix(projectID, sessionID))
      await Promise.all([storage.remove(recordKey(projectID, sessionID)), ...others.map(({ key }) => storage.remove(`${besidePrefix(projectID, sessionID)}${key}`))])
    },
    async noteRead(projectID, sessionID, by, kind, at) {
      const key = readsKey(projectID, sessionID, by)
      const reads = noteRead(readReads(await storage.get(key)), kind, at)
      await storage.set(key, { ...reads })
      return reads
    },
    async pin(projectID, sessionID, pinned) {
      if (pinned) await storage.set(pinKey(projectID, sessionID), { ...pinned })
      else await storage.remove(pinKey(projectID, sessionID))
    },
    ofProject: (projectID) => under(projectPrefix(projectID)),
    all: () => under(PREFIX),
    strays: async () => (await scanned(PREFIX)).filter(({ record }) => record === undefined).map(({ projectID, sessionID }) => ({ projectID, sessionID })),
  }
}
