import { clipText, clipWords, defuseBlock } from "../kernel/protocol.js"
import { type Lesson, LESSON_MAX, oneLine, PART_STATUSES, type PartRecord, splitProse, type StoredRecord } from "./domain.js"

export const RECALL_TOOL = "courier_recall"

export const NOTE_TOOL = "courier_note"

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`

const DAY_MS = 86_400_000

export function duration(ms: number) {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))} s`
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

export function age(ms: number) {
  const days = Math.floor(ms / DAY_MS)
  return days < 1 ? duration(ms) : count(days, "day")
}

function partsLine(all: ReadonlyArray<PartRecord>) {
  const parts = all.filter((part) => !part.subagent)
  const subagents = all.length - parts.length
  const statuses = PART_STATUSES.flatMap((status) => {
    const n = parts.filter((part) => part.status === status).length
    return n ? [`${n} ${status}`] : []
  }).join(", ")
  const isolated = parts.filter((part) => part.isolated).length
  const refused = parts.reduce((n, part) => n + (part.refused ?? 0), 0)
  const deepest = Math.max(0, ...all.map((part) => part.depth))
  return [
    parts.length ? `${count(parts.length, "part")}: ${statuses}` : "no parts",
    ...(deepest > 1 ? [`${deepest} levels deep`] : []),
    ...(isolated ? [`${isolated} isolated`] : []),
    ...(refused ? [`${count(refused, "spawn")} refused`] : []),
    ...(subagents ? [count(subagents, "subagent")] : []),
  ].join(", ")
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10)

export function lessonLine(lesson: Lesson) {
  const from = lesson.depth === undefined ? "" : `, from depth ${lesson.depth}`
  return `lesson (${day(lesson.at)}${from}): "${clipText(oneLine(lesson.text), LESSON_MAX)}"`
}

export function recordLine(record: StoredRecord, top: string, now: number) {
  const cost = record.parts.reduce((sum, part) => sum + (part.cost ?? 0), 0)
  const costed = record.parts.some((part) => part.cost !== undefined)
  const revised = record.revisions?.at(-1)
  return [
    `- ${record.sessionID}${record.sessionID === top ? " (this tree)" : ""} ${day(record.startedAt)}: "${clipText(oneLine(record.title), 60)}"`,
    clipWords(splitProse(record.split), 160),
    ...(revised ? [`then, after ${count(revised.parts, "part")}: ${clipWords(splitProse(revised.text), 160)}`] : []),
    partsLine(record.parts),
    `ran ${duration(record.movedAt - record.startedAt)}`,
    `last moved ${age(now - record.movedAt)} ago`,
    ...(costed ? [`$${cost.toFixed(2)}`] : []),
    record.finished ? "finished" : "not finished",
    ...(record.pinned ? ["pinned"] : []),
    ...(record.recalled ? [`recalled${record.recalled.at === undefined ? " by a part" : ""}`] : []),
    ...(record.lesson ? [lessonLine(record.lesson)] : []),
  ].join(" · ")
}

const PINNED = "A record marked \"pinned\" is one the person chose to keep and listed first: weigh it before the rest."

export const RECALL_OFF =
  "Memory is off: the plugin's memory option is false, so no record of a session tree is kept or listed in this project. Decide from the task alone."

export function recallListText(records: ReadonlyArray<StoredRecord>, top: string, now: number) {
  const others = records.filter((record) => record.sessionID !== top)
  const pinned = records.some((record) => record.pinned)
  const intro = others.length
    ? `${count(others.length, "earlier tree")} recorded in this project, ${pinned ? "pinned first, then newest first" : "newest first"}; weigh how they were split and how their parts went before you decide. ` +
      "A record holds what the plugin saw, not the work, and a lesson what its orchestrator concluded, next to the facts that bear it out. " +
      "The facts are as they stood when the tree last moved: \"not finished\" with an old \"last moved\" is a stale record, not a tree running now. " +
      "courier_recall with a sessionID gives one in full, with each part's status, duration, cost and context use." +
      (pinned ? ` ${PINNED}` : "")
    : "No earlier tree is recorded in this project: a tree's record is written by a courier_recall call and as each turn in it ends, and kept 90 days. Decide from the task alone."
  return [intro, ...records.map((record) => recordLine(record, top, now))].join("\n")
}

export function recallRecordText(record: StoredRecord) {
  return `Record of the tree under ${record.sessionID}, in project ${record.projectID} (durations in milliseconds, context use as a share of the model's window):\n${JSON.stringify(record, null, 2)}`
}

export const recallMissingText = (sessionID: string) =>
  `No record of a tree whose top session is ${sessionID} in this project. courier_recall without sessionID lists the records there are.`

const NOT_A_RULE = "A lesson that holds every time belongs in AGENTS.md or the skill, which only the person puts there: tell them instead of noting it."

export function noteText(top: string, lesson: Lesson, replaced: Lesson | undefined) {
  return [
    `Noted on the record of the tree under ${top} as its ${lessonLine(lesson)}.`,
    ...(replaced ? [`It replaces the ${lessonLine(replaced)}.`] : []),
    `${RECALL_TOOL} lists it after the tree's facts; a second ${NOTE_TOOL} replaces it. ${NOT_A_RULE}`,
  ].join(" ")
}

export const NOTE_OFF = "Not noted: the plugin's memory option is false, so no record of a session tree is kept in this project to write a lesson on."

export const noteBelowRefusal = (depth: number, top: string) =>
  `Not noted: this session is at depth ${depth} of the session tree under ${top}, and only that top session writes the tree's ` +
  "lesson, once the whole tree is verified. Put what you learned in your report instead: the top reads it and writes the tree's lesson."

const ONE_LINE = "what the next orchestrator in this project should know about running a tree like this one, with the job it comes from and the reason"

export const NOTE_EMPTY = `Not noted: text is empty. Write one line, ${ONE_LINE}, or nothing.`

export const noteLongRefusal = (length: number) =>
  `Not noted: the lesson is ${length} characters, at most ${LESSON_MAX}; write it shorter. Nothing was written, and the earlier lesson, ` +
  `if there was one, stays. Keep one line, ${ONE_LINE}, and leave out what the record's facts already say.`

export const noteUnrecordedRefusal = (top: string) =>
  `Not noted: the tree under ${top} has no record in this project to write a lesson on. A record is written by a ${RECALL_TOOL} call ` +
  "and as each turn in the tree ends, so call it once first, or note once a session you started has reported."


export const LESSONS_KEY = "lessons"

export const LESSONS_PREFIX = "opencode-courier lessons:"

export const LESSONS_MAX = 5

export function lessonsEntry(records: ReadonlyArray<StoredRecord>) {
  const lessons = records.filter((record) => record.lesson).slice(0, LESSONS_MAX)
  if (!lessons.length) return undefined
  return [
    `${LESSONS_PREFIX} what the orchestrators of earlier session trees in this project concluded, each with its tree's title; ` +
      `${RECALL_TOOL} has the records with the facts behind them.`,
    ...lessons.map((record) => `- ${record.sessionID} "${clipText(defuseBlock(oneLine(record.title)), 60)}": ${defuseBlock(lessonLine(record.lesson!))}`),
  ].join("\n")
}
