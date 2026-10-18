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

/** The most characters a lesson holds: courier_note refuses what is longer, and a record written by hand is clipped when read. */
export const LESSON_MAX = 300

/**
 * How a part stands: its last report's status, how its wait ended without one (`failed`, `interrupted`), `stopped` by
 * courier_stop, `gone` before it settled, `stalled` on a message it will not take, or `out`: it owes a report.
 */
export const PART_STATUSES = [...STATUSES, "interrupted", "stopped", "gone", "stalled", "out"] as const
export type PartStatus = (typeof PART_STATUSES)[number]

export const isPartStatus = (value: unknown): value is PartStatus => typeof value === "string" && (PART_STATUSES as readonly string[]).includes(value)

/** Whether a part has settled, as every part of a finished tree has: it neither owes a report nor is stalled. */
export const isSettled = (status: PartStatus) => status !== "out" && status !== "stalled"

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

/**
 * The one line the tree's orchestrator wrote for the next one with courier_note: when, and from which depth when it was
 * not the top's own session (1 for a session the top started).
 */
export interface Lesson {
  readonly text: string
  readonly at: number
  readonly depth?: number
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
  /** Absent until a session of the tree that is not a leaf wrote one; a second note replaces the first. */
  readonly lesson?: Lesson
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

/** A line beginning with `split:` after any markdown (whitespace, emphasis, heading, quote and list marks). */
const STARTS_SPLIT = /^[\s*_#>`-]*split:/i
/** A line holding `split:` as a word. */
const HOLDS_SPLIT = /\bsplit:/i

/** The split line a text states, as the real-model checker reads it: a line beginning with `split:` after any markdown, else one holding it. */
export function splitLineOf(text: string) {
  const lines = text.split("\n")
  return (lines.find((line) => STARTS_SPLIT.test(line)) ?? lines.find((line) => HOLDS_SPLIT.test(line)))?.trim()
}

/** Heading and quote marks before a line's words, and list marks, a `-`, `+` or `*` only with the space a list puts after it. */
const BLOCK_MARKS = /^(?:[\s#>]|[-+*]\s|\d+[.)]\s)*/
/** A bold, then an italic, span within a line, opening after a space and closing before one, unlike the asterisks of `2**3`, `src/*.ts` or a `**` before a slash. */
const BOLD = /(?<=^|[\s(["'])(\*\*\*?)([^\s*/][^*]*?)(?<![\s(/])\1(?=$|[\s.,;:!?)\]"'])/gu
/** An italic span opens only before a letter, digit or quote, which tells it from the globs of `*.ts and *.md`. */
const ITALIC = /(?<=^|[\s(["'])\*([\p{L}\p{N}\0"'][^*]*?)(?<![\s(/])\*(?=$|[\s.,;:!?)\]"'])/gu
/** A label the line opens with in underscores or a code span (`_split:_`, `` `split:` ``), which its colon tells from `__init__`. */
const LABEL = /^(__?|`)([^\s_`][^_`]*:)\1(?=\s)/
/** A code span, whose asterisks are its words', and the stand-in it is masked by while emphasis is taken off. */
const CODE_SPAN = /`[^`]*`/g
const MASKED = /\0(\d+)\0/g
/** Marks taken off a line they wrap whole, unless the mark is inside too at a space, as two spans (`**a** and **b**`, `__init__ and __main__`). */
const STARS = ["***", "**", "*"]
const WRAPS = ["__", "_", "`"]

const unwrapped = (line: string, marks: ReadonlyArray<string>) => {
  const inner = (one: string) => line.slice(one.length, -one.length)
  const mark = marks.find(
    (one) => line.length > 2 * one.length && line.startsWith(one) && line.endsWith(one) && !inner(one).includes(`${one} `) && !inner(one).includes(` ${one}`),
  )
  return mark ? inner(mark).trim() : line
}

/** A split line as the listing shows it: one line, without its block marks, the asterisks wrapping it or a span in it, nor an underscore or code span wrapping it. */
export function splitProse(split: string) {
  const code: string[] = []
  const masked = oneLine(split.replaceAll("\0", ""))
    .replace(BLOCK_MARKS, "")
    .replace(LABEL, "$2")
    .replace(CODE_SPAN, (span) => `\0${code.push(span) - 1}\0`)
  const prose = unwrapped(masked, STARS).replace(BOLD, "$2").replace(ITALIC, "$1")
  return unwrapped(prose.replace(MASKED, (_, i: string) => code[Number(i)]!), WRAPS)
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
 * A part whose session could not be read, from what was read of it and its last record: its title, duration and cost as
 * last recorded; once OpenCode no longer knows it (`gone`), settled as read, else as last recorded, else `gone`.
 */
export function unreadPart(read: PartRecord, last: PartRecord | undefined, gone: boolean): PartRecord {
  const settledLast = last && isSettled(last.status) ? last.status : "gone"
  const status = !gone || isSettled(read.status) ? read.status : settledLast
  const { title, duration, cost } = last ?? read
  return { ...read, title, status, ...(duration !== undefined ? { duration } : {}), ...(cost !== undefined ? { cost } : {}) }
}

/**
 * The parts of a refreshed record: those recorded before, in their order, each as `current` has it (read now, or found
 * gone), else as last recorded, then those first seen now, in the order the tree is drawn.
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

/** A text as the one line a lesson is: whitespace and line breaks collapsed to spaces, trimmed. */
export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

/**
 * A hand-written lesson's text as one line, clipped at `LESSON_MAX`; `clipped` is the length it had when it was clipped.
 * courier_note does not clip: it refuses a line over `LESSON_MAX` (`note.ts`).
 */
export function lessonText(text: string) {
  const line = oneLine(text)
  if (line.length <= LESSON_MAX) return { text: line }
  return { text: line.slice(0, LESSON_MAX).trimEnd(), clipped: line.length }
}

/** The records a project keeps at `now`: the newest `MAX_RECORDS` by `movedAt`, none older than `RETENTION_MS`; the rest are dropped. */
export function keep<T extends Pick<StoredRecord, "movedAt">>(records: ReadonlyArray<T>, now: number) {
  const newest = records.toSorted((a, b) => b.movedAt - a.movedAt)
  const kept = newest.filter((record, index) => index < MAX_RECORDS && now - record.movedAt <= RETENTION_MS)
  return { kept, dropped: newest.filter((record) => !kept.includes(record)) }
}

/** Records newest first, by when each last moved. */
export const newestFirst = <T extends Pick<StoredRecord, "movedAt">>(records: ReadonlyArray<T>) => records.toSorted((a, b) => b.movedAt - a.movedAt)
