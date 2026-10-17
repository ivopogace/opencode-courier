/**
 * The memory's pure rules, on plain data: the option, a record's shape, each part's status, the split line, the
 * retention and how a refresh keeps the parts the roster has forgotten. Imports nothing of the plugin's but `kernel/` and `platform/json.ts`.
 */
import { STATUSES, type Status } from "../kernel/protocol.js"
import { obj } from "../platform/json.js"

/** How many records a project keeps, the newest by `movedAt`. */
export const MAX_RECORDS = 30

/** Records that last moved longer ago than this are dropped when the plugin loads. */
export const RETENTION_MS = 90 * 24 * 60 * 60_000

/** A record's `split` while its top has stated no split line. */
export const NOT_STATED = "not stated"

/**
 * How a part stands: its last report's status, how its wait ended without one (`failed`, `interrupted`), `stopped` by
 * courier_stop, `stalled` on a message it will not take, or `out`: it owes a report, running or not.
 */
export const PART_STATUSES = [...STATUSES, "interrupted", "stopped", "stalled", "out"] as const
export type PartStatus = (typeof PART_STATUSES)[number]

export const isPartStatus = (value: unknown): value is PartStatus => typeof value === "string" && (PART_STATUSES as readonly string[]).includes(value)

/** One session started in a tree, as its record keeps it; `duration` is in milliseconds, `context` a share of its model's window. */
export interface PartRecord {
  readonly sessionID: string
  readonly title: string
  /** 1 for a session the top started. */
  readonly depth: number
  readonly isolated: boolean
  readonly group?: string
  readonly status: PartStatus
  /** From its start to the end of its last turn, or to the refresh while it runs. */
  readonly duration?: number
  readonly cost?: number
  /** How full its context was at the end, 0 to 1, when its model's window is known. */
  readonly context?: number
  /** How many courier_spawn calls of its own failed, refused by a limit mostly. */
  readonly refused?: number
}

/** Whether and when the top called courier_recall (`at`, its first call), and how many calls the tree made in all. */
export interface Recalled {
  readonly at?: number
  readonly calls: number
}

/** What is remembered of one tree: its top session and each session started in it, never a report's body or artifacts. */
export interface TreeRecord {
  /** When the top session was created, epoch milliseconds. */
  readonly startedAt: number
  /** When a turn in the tree last ended, or the record was first written. */
  readonly movedAt: number
  readonly title: string
  /** The top's split line, as `e2e/real-model-recursive.mjs` reads it, or `not stated`. */
  readonly split: string
  /** Whether, at the last refresh, no session in the tree ran and every part had settled: none was out or stalled. */
  readonly finished: boolean
  readonly recalled?: Recalled
  readonly parts: ReadonlyArray<PartRecord>
}

/** A record with where it is kept: its project and its top session. */
export interface StoredRecord extends TreeRecord {
  readonly projectID: string
  readonly sessionID: string
}

/** The `memory` option: whether records are kept and listed; on unless `false`. */
export function readMemory(options: unknown) {
  const value: unknown = obj(options).memory
  if (value === undefined || typeof value === "boolean") return { memory: value !== false, problems: [] }
  return { memory: true, problems: [`memory must be true or false, not ${JSON.stringify(value)}; using true`] }
}

/** The split line a text states, as the real-model checker reads it: a line beginning with `split:` after any markdown, else one holding it. */
export function splitLineOf(text: string) {
  return (text.match(/^\s*(?:[*_#>`-]+\s*)*split:.*$/im) ?? text.match(/^.*\bsplit:.*$/im))?.[0].trim()
}

/** What a part's status is read from: whether courier_stop stopped it, whether it is stalled, and its report state. */
export interface Standing {
  readonly stopped: boolean
  readonly stalled: boolean
  readonly report?: { readonly known: boolean; readonly owes: boolean; readonly ended?: "failed" | "interrupted"; readonly status?: Status }
}

/** A part's status by `Standing`; one whose report state is not known is still out. */
export function partStatus({ stopped, stalled, report }: Standing): PartStatus {
  if (stopped) return "stopped"
  if (stalled) return "stalled"
  if (!report?.known || report.owes) return "out"
  if (report.ended) return report.ended
  return report.status ?? "done"
}

/**
 * The parts of a refreshed record: those recorded before, in their order, each as read now when the roster still has it,
 * else as last recorded, then those first seen now, in the order the tree is drawn.
 */
export function mergeParts(previous: ReadonlyArray<PartRecord>, current: ReadonlyArray<PartRecord>) {
  const now = new Map(current.map((part) => [part.sessionID, part]))
  const kept = previous.map((part) => now.get(part.sessionID) ?? part)
  const known = new Set(previous.map((part) => part.sessionID))
  return [...kept, ...current.filter((part) => !known.has(part.sessionID))]
}

/** `recalled` after one more call at `at`, the top's first call noted when `byTop`. */
export function noteRecall(recalled: Recalled | undefined, byTop: boolean, at: number): Recalled {
  const calls = (recalled?.calls ?? 0) + 1
  const first = recalled?.at ?? (byTop ? at : undefined)
  return first === undefined ? { calls } : { at: first, calls }
}

/** The records a project keeps at `now`: the newest `MAX_RECORDS` by `movedAt`, none older than `RETENTION_MS`; the rest are dropped. */
export function keep<T extends Pick<StoredRecord, "movedAt">>(records: ReadonlyArray<T>, now: number) {
  const newest = records.toSorted((a, b) => b.movedAt - a.movedAt)
  const kept = newest.filter((record, index) => index < MAX_RECORDS && now - record.movedAt <= RETENTION_MS)
  return { kept, dropped: newest.filter((record) => !kept.includes(record)) }
}

/** Records newest first, by when each last moved. */
export const newestFirst = <T extends Pick<StoredRecord, "movedAt">>(records: ReadonlyArray<T>) => records.toSorted((a, b) => b.movedAt - a.movedAt)
