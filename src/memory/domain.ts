import { STATUSES, type Status } from "../kernel/protocol.js"
import { obj } from "../platform/json.js"

export const MAX_RECORDS = 30

export const RETENTION_MS = 90 * 24 * 60 * 60_000

export const NOT_STATED = "not stated"

export const LESSON_MAX = 300

export const PART_STATUSES = [...STATUSES, "interrupted", "stopped", "gone", "stalled", "out"] as const
export type PartStatus = (typeof PART_STATUSES)[number]

export const isPartStatus = (value: unknown): value is PartStatus => typeof value === "string" && (PART_STATUSES as readonly string[]).includes(value)

export const isSettled = (status: PartStatus) => status !== "out" && status !== "stalled"

export interface PartRecord {
  readonly sessionID: string
  readonly title: string
  readonly depth: number
  readonly isolated: boolean
  readonly subagent?: true
  readonly group?: string
  readonly status: PartStatus
  readonly duration?: number
  readonly cost?: number
  readonly context?: number
  readonly refused?: number
}

export interface Recalled {
  readonly at?: number
  readonly calls: number
}

export interface Lesson {
  readonly text: string
  readonly at: number
  readonly depth?: number
}

export interface Reads {
  readonly shown: number
  readonly read: number
  readonly at: number
}

export type ReadKind = "shown" | "read"

export interface Pinned {
  readonly at: number
}

export const MAX_REVISIONS = 3

export interface Revision {
  readonly text: string
  readonly at: number
  readonly parts: number
}

export interface TreeRecord {
  readonly startedAt: number
  readonly movedAt: number
  readonly title: string
  readonly split: string
  readonly revisions?: ReadonlyArray<Revision>
  readonly finished: boolean
  readonly recalled?: Recalled
  readonly lesson?: Lesson
  readonly reads?: Reads
  readonly pinned?: Pinned
  readonly parts: ReadonlyArray<PartRecord>
}

export interface StoredRecord extends TreeRecord {
  readonly projectID: string
  readonly sessionID: string
}

export function readMemory(options: unknown) {
  const value: unknown = obj(options).memory
  if (value === undefined || typeof value === "boolean") return { memory: value !== false, problems: [] }
  return { memory: true, problems: [`memory must be true or false, not ${JSON.stringify(value)}; using true`] }
}

const STARTS_SPLIT = /^[\s*_#>`-]*split:/i
const HOLDS_SPLIT = /\bsplit:/i

export function splitLineOf(text: string) {
  const lines = text.split("\n")
  return (lines.find((line) => STARTS_SPLIT.test(line)) ?? lines.find((line) => HOLDS_SPLIT.test(line)))?.trim()
}

export const isStated = (line: string) => STARTS_SPLIT.test(line)

export function splitOf(recorded: string, text: string) {
  if (isStated(recorded)) return recorded
  const found = splitLineOf(text)
  return found !== undefined && (recorded === NOT_STATED || isStated(found)) ? found : recorded
}

export const splitLinesOf = (text: string) =>
  text
    .split("\n")
    .filter((line) => STARTS_SPLIT.test(line))
    .map((line) => line.trim())

export interface Stated {
  readonly text: string
  readonly at?: number
}

function statedSince(previous: Pick<TreeRecord, "split" | "revisions">, stated: ReadonlyArray<Stated>) {
  const last = previous.revisions?.at(-1)
  const words = (line: Stated) => splitProse(line.text)
  if (!last) return stated.slice(stated.findIndex((line) => words(line) === splitProse(previous.split)) + 1)
  const inReply = stated.findLastIndex((line) => words(line) === splitProse(last.text) && line.at === last.at)
  if (inReply >= 0) return stated.slice(inReply + 1)
  if (stated.some((line) => line.at !== undefined)) return stated.filter((line) => line.at !== undefined && line.at > last.at)
  return stated.slice(stated.findLastIndex((line) => words(line) === splitProse(last.text)) + 1)
}

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

export function replacingMention(found: string, revisions: ReadonlyArray<Revision> | undefined): Pick<TreeRecord, "split" | "revisions"> {
  const [first, ...rest] = revisions ?? []
  if (!first || !revisions!.some((one) => splitProse(one.text) === splitProse(found))) return { split: found, ...(first ? { revisions } : {}) }
  return { split: first.text, ...(rest.length ? { revisions: rest } : {}) }
}

const BLOCK_MARKS = /^(?:\s|#+\s|>\s|[-+*]\s|\d+[.)]\s)*/
const BOLD = /(?<=^|[\s(["'])(\*\*\*?)([^\s*/][^*]*?)(?<![\s(/])\1(?=$|[\s.,;:!?)\]"'])/gu
const ITALIC = /(?<=^|[\s(["'])\*([\p{L}\p{N}\0"'][^*]*?)(?<![\s(/])\*(?=$|[\s.,;:!?)\]"'])/gu
const LABEL = /^(__?|`)([^\s_`][^_`]*:)\1(?=\s)/
const CODE_SPAN = /`[^`]*`/g
const MASKED = /\0(\d+)\0/g
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

export function splitProse(split: string) {
  const code: string[] = []
  const masked = oneLine(split.replaceAll("\0", ""))
    .replace(BLOCK_MARKS, "")
    .replace(LABEL, "$2")
    .replace(CODE_SPAN, (span) => `\0${code.push(span) - 1}\0`)
  const prose = unwrapped(masked, STARS).replace(BOLD, "$2").replace(ITALIC, "$1")
  return unwrapped(prose.replace(MASKED, (_, i: string) => code[Number(i)]!), WRAPS)
}

export interface Standing {
  readonly stopped: boolean
  readonly stalled: boolean
  readonly report?: { readonly known: boolean; readonly owes: boolean; readonly ended?: "failed" | "interrupted"; readonly status?: Status }
}

export function partStatus({ stopped, stalled, report }: Standing): PartStatus {
  if (stopped) return "stopped"
  if (stalled) return "stalled"
  if (!report?.known || report.owes) return "out"
  if (report.ended) return report.ended
  return report.status ?? "done"
}

export function subagentStatus({ running, stalled, outcome }: { readonly running: boolean; readonly stalled: boolean; readonly outcome?: string }): PartStatus {
  if (stalled) return "stalled"
  if (running) return "out"
  return outcome === "failed" || outcome === "interrupted" ? outcome : "done"
}

export function unreadPart(read: PartRecord, last: PartRecord | undefined, gone: boolean): PartRecord {
  const settledLast = last && isSettled(last.status) ? last.status : "gone"
  const status = !gone || isSettled(read.status) ? read.status : settledLast
  const { title, duration, cost } = last ?? read
  return { ...read, title, status, ...(duration !== undefined ? { duration } : {}), ...(cost !== undefined ? { cost } : {}) }
}

export function mergeParts(previous: ReadonlyArray<PartRecord>, current: ReadonlyArray<PartRecord>) {
  const now = new Map(current.map((part) => [part.sessionID, part]))
  const kept = previous.map((part) => now.get(part.sessionID) ?? part)
  const known = new Set(previous.map((part) => part.sessionID))
  return [...kept, ...current.filter((part) => !known.has(part.sessionID))]
}

export function noteRecall(recalled: Recalled | undefined, byTop: boolean, at: number): Recalled {
  const calls = (recalled?.calls ?? 0) + 1
  const first = recalled?.at ?? (byTop ? at : undefined)
  return first === undefined ? { calls } : { at: first, calls }
}

export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

export function lessonText(text: string) {
  const line = oneLine(text)
  if (line.length <= LESSON_MAX) return { text: line }
  return { text: line.slice(0, LESSON_MAX).trimEnd(), clipped: line.length }
}

export function noteRead(reads: Reads | undefined, kind: ReadKind, at: number): Reads {
  return { shown: (reads?.shown ?? 0) + (kind === "shown" ? 1 : 0), read: (reads?.read ?? 0) + (kind === "read" ? 1 : 0), at: Math.max(reads?.at ?? 0, at) }
}

export function sumReads(reads: ReadonlyArray<Reads>): Reads | undefined {
  if (!reads.length) return undefined
  return reads.reduce((sum, one) => ({ shown: sum.shown + one.shown, read: sum.read + one.read, at: Math.max(sum.at, one.at) }))
}

export function keep<T extends Pick<StoredRecord, "movedAt" | "lesson" | "pinned">>(records: ReadonlyArray<T>, now: number) {
  const pinned = records.filter((record) => record.pinned)
  const live = records.filter((record) => !record.pinned && now - record.movedAt <= RETENTION_MS)
  const ordered = live.toSorted((a, b) => Number(Boolean(b.lesson)) - Number(Boolean(a.lesson)) || b.movedAt - a.movedAt)
  const kept = [...pinned, ...ordered.slice(0, MAX_RECORDS)]
  return { kept, dropped: records.filter((record) => !kept.includes(record)) }
}

export const pinnedFirst = <T extends Pick<StoredRecord, "movedAt" | "pinned">>(records: ReadonlyArray<T>) =>
  records.toSorted((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.movedAt - a.movedAt)
