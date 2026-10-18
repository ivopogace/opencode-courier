/**
 * The memory's pure rules, on plain data: the option, a record's shape, each part's status, the split line and its revisions,
 * its reads and pin, the retention and how a refresh keeps the parts the roster has forgotten. Imports nothing of the plugin's but `kernel/` and `platform/json.ts`.
 */
import { STATUSES, type Status } from "../kernel/protocol.js"
import { obj } from "../platform/json.js"

/** How many unpinned records a project keeps: those with a lesson first, then the newest by `movedAt`. */
export const MAX_RECORDS = 30

/** Unpinned records that last moved longer ago than this are dropped when the plugin loads. */
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

/**
 * How often other trees' courier_recall calls listed the record (`shown`) or gave it in full (`read`), and when one last
 * did (`at`). Kept per reader tree and summed when read; a listing to the tree's own sessions counts nothing.
 */
export interface Reads {
  readonly shown: number
  readonly read: number
  readonly at: number
}

/** What a courier_recall call did with a record: listed it, or gave it in full. */
export type ReadKind = "shown" | "read"

/** The person's pin, set in the memory view: when. A pinned record is listed first and never swept. */
export interface Pinned {
  readonly at: number
}

/** How many revisions of the split line a record keeps, the newest. */
export const MAX_REVISIONS = 3

/** A later split line the top stated, worded otherwise than the one before it: when, and how many parts the tree had then. */
export interface Revision {
  readonly text: string
  readonly at: number
  readonly parts: number
}

/** What is remembered of one tree: its top session and each session started in it, never a report's body or artifacts. */
export interface TreeRecord {
  /** When the top session was created, epoch milliseconds. */
  readonly startedAt: number
  /** When a turn in the tree last ended, or the record was first written. */
  readonly movedAt: number
  readonly title: string
  /**
   * The top's first split line, as `e2e/real-model-recursive.mjs` reads it, or `not stated`; a stated line takes precedence over a
   * mention, which it replaces once, and is never replaced.
   */
  readonly split: string
  /** Absent until the top states a split line worded otherwise than `split`; newest last, at most `MAX_REVISIONS`. */
  readonly revisions?: ReadonlyArray<Revision>
  /** Whether, at the last refresh, no session in the tree ran and every part had settled: none was out or stalled. */
  readonly finished: boolean
  readonly recalled?: Recalled
  /** Absent until a session of the tree that is not a leaf wrote one; a second note replaces the first. */
  readonly lesson?: Lesson
  /** Absent until another tree's courier_recall listed or read the record; kept beside the record, never written with it. */
  readonly reads?: Reads
  /** Absent until the person pinned the record in the memory view; kept beside the record, never written with it. */
  readonly pinned?: Pinned
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

/** Whether a split line is stated, beginning with `split:` after any markdown, not a passing mention nor `not stated`. */
export const isStated = (line: string) => STARTS_SPLIT.test(line)

/** The record's `split` once `text` is read: kept once stated; a mention gives way to the first stated line; `not stated` to either. */
export function splitOf(recorded: string, text: string) {
  if (isStated(recorded)) return recorded
  const found = splitLineOf(text)
  return found !== undefined && (recorded === NOT_STATED || isStated(found)) ? found : recorded
}

/** Every line of a text that begins with `split:` after any markdown, trimmed: a passing mention of a split is none. */
export const splitLinesOf = (text: string) =>
  text
    .split("\n")
    .filter((line) => STARTS_SPLIT.test(line))
    .map((line) => line.trim())

/** A split line the top's replies state, with when its reply was created when the message says. */
export interface Stated {
  readonly text: string
  readonly at?: number
}

/**
 * The lines after the one recorded last: after its reply, else (compacted, or unread by an overlapping refresh) those stated since its
 * time; without a revision, after `split`'s first statement; all when neither is found.
 */
function statedSince(previous: Pick<TreeRecord, "split" | "revisions">, stated: ReadonlyArray<Stated>) {
  const last = previous.revisions?.at(-1)
  const words = (line: Stated) => splitProse(line.text)
  if (!last) return stated.slice(stated.findIndex((line) => words(line) === splitProse(previous.split)) + 1)
  const inReply = stated.findLastIndex((line) => words(line) === splitProse(last.text) && line.at === last.at)
  if (inReply >= 0) return stated.slice(inReply + 1)
  if (stated.some((line) => line.at !== undefined)) return stated.filter((line) => line.at !== undefined && line.at > last.at)
  return stated.slice(stated.findLastIndex((line) => words(line) === splitProse(last.text)) + 1)
}

/**
 * The revisions once the split lines `stated` are read at a refresh at `at` with `parts` parts: those `statedSince` the line recorded
 * last, each appended when its words differ from the line before, so a re-read appends nothing.
 */
export function revise(previous: Pick<TreeRecord, "split" | "revisions">, stated: ReadonlyArray<Stated>, at: number, parts: number) {
  const recorded = splitProse(previous.revisions?.at(-1)?.text ?? previous.split)
  const { added } = statedSince(previous, stated).reduce<{ last: string; added: Revision[] }>(
    ({ last, added }, line) => {
      const words = splitProse(line.text)
      return words === last ? { last, added } : { last: words, added: [...added, { text: line.text, at: line.at ?? at, parts }] }
    },
    { last: recorded, added: [] },
  )
  const revisions = [...(previous.revisions ?? []), ...added].slice(-MAX_REVISIONS)
  return revisions.length ? revisions : undefined
}

/**
 * The split and revisions once the stated line `found` replaces a mention: when `found` is among the revisions (recorded beside the
 * mention before #294), the first of them was stated first and is `split`, the rest stay; else `found` is, beside them all.
 */
export function replacingMention(found: string, revisions: ReadonlyArray<Revision> | undefined): Pick<TreeRecord, "split" | "revisions"> {
  const [first, ...rest] = revisions ?? []
  if (!first || !revisions!.some((one) => splitProse(one.text) === splitProse(found))) return { split: found, ...(first ? { revisions } : {}) }
  return { split: first.text, ...(rest.length ? { revisions: rest } : {}) }
}

/** Heading, quote and list marks before a line's words, each with the space markdown puts after it, unlike the `#` of `#282`. */
const BLOCK_MARKS = /^(?:\s|#+\s|>\s|[-+*]\s|\d+[.)]\s)*/
/** A bold or bold italic span within a line, opening at a word's start and closing at its end, unlike the asterisks of `2**3` or a `**` beside a slash. */
const BOLD = /(?<=^|[\s(["'])(\*\*\*?)([^\s*/][^*]*?)(?<![\s(/])\1(?=$|[\s.,;:!?)\]"'])/gu
/** An italic span opens only before a letter, digit, quote or code span, which tells it from the globs of `*.ts and *.md` or `src/*.ts`. */
const ITALIC = /(?<=^|[\s(["'])\*([\p{L}\p{N}\0"'][^*]*?)(?<![\s(/])\*(?=$|[\s.,;:!?)\]"'])/gu
/** A label the line opens with in underscores or a code span (`_split:_`, `` `split:` ``), which its colon tells from `__init__`. */
const LABEL = /^(__?|`)([^\s_`][^_`]*:)\1(?=\s)/
/** A code span, whose asterisks are its words', and the stand-in it is masked by while emphasis is taken off. */
const CODE_SPAN = /`[^`]*`/g
const MASKED = /\0(\d+)\0/g
/** Marks taken off a line they wrap whole, with what its words must open with; `*` may recur inside as a glob's, the others not at all. */
const STARS: ReadonlyArray<readonly [string, RegExp]> = [
  ["***", /[^\s*/]/],
  ["**", /[^\s*/]/],
  ["*", /[\p{L}\p{N}\0"']/u],
]
const WRAPS: ReadonlyArray<readonly [string, RegExp]> = [
  ["__", /[^\s_]/],
  ["_", /[^\s_]/],
  ["`", /[^\s`]/],
]

const unwrapped = (line: string, marks: ReadonlyArray<readonly [string, RegExp]>) => {
  const inner = (mark: string) => line.slice(mark.length, -mark.length)
  const wraps = ([mark, opens]: readonly [string, RegExp]) => {
    const words = inner(mark)
    const apart = mark === "*" ? !words.includes("* ") && !words.includes(" *") : !words.includes(mark)
    return line.length > 2 * mark.length && line.startsWith(mark) && line.endsWith(mark) && opens.test(words[0]!) && !/[\s(/]/.test(words.at(-1)!) && apart
  }
  const found = marks.find(wraps)
  return found ? inner(found[0]).trim() : line
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

/** One reader tree's `reads` after courier_recall listed the record or gave it in full at `at`. */
export function noteRead(reads: Reads | undefined, kind: ReadKind, at: number): Reads {
  return { shown: (reads?.shown ?? 0) + (kind === "shown" ? 1 : 0), read: (reads?.read ?? 0) + (kind === "read" ? 1 : 0), at: Math.max(reads?.at ?? 0, at) }
}

/** The reads of every reader tree as one: the counts summed, `at` the latest; none without a reader. */
export function sumReads(reads: ReadonlyArray<Reads>): Reads | undefined {
  if (!reads.length) return undefined
  return reads.reduce((sum, one) => ({ shown: sum.shown + one.shown, read: sum.read + one.read, at: Math.max(sum.at, one.at) }))
}

/**
 * The records a project keeps at `now`: every pinned one, whatever its age, and of the rest the first `MAX_RECORDS` by
 * whether each has a lesson, then by `movedAt`, none older than `RETENTION_MS`; the rest are dropped.
 */
export function keep<T extends Pick<StoredRecord, "movedAt" | "lesson" | "pinned">>(records: ReadonlyArray<T>, now: number) {
  const pinned = records.filter((record) => record.pinned)
  // Aged out first, so that a stale record takes no slot from a live one behind it in the order.
  const live = records.filter((record) => !record.pinned && now - record.movedAt <= RETENTION_MS)
  const ordered = live.toSorted((a, b) => Number(Boolean(b.lesson)) - Number(Boolean(a.lesson)) || b.movedAt - a.movedAt)
  const kept = [...pinned, ...ordered.slice(0, MAX_RECORDS)]
  return { kept, dropped: records.filter((record) => !kept.includes(record)) }
}

/** Records as courier_recall and the memory view list them: the pinned first, then by when each last moved, newest first. */
export const pinnedFirst = <T extends Pick<StoredRecord, "movedAt" | "pinned">>(records: ReadonlyArray<T>) =>
  records.toSorted((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.movedAt - a.movedAt)
