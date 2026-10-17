/** The memory's model-facing texts: what courier_recall and courier_note say. */
import { clipText } from "../kernel/protocol.js"
import { type Lesson, LESSON_MAX, PART_STATUSES, type PartRecord, type StoredRecord } from "./domain.js"

/** The tool's name, which the skill and the role part name too. */
export const RECALL_TOOL = "courier_recall"

/** The lesson tool's name, which the skill's last step names. */
export const NOTE_TOOL = "courier_note"

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`

/** A duration in milliseconds as a model reads it: seconds under half a minute, else whole minutes, else hours and minutes. */
export function duration(ms: number) {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))} s`
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** How a listing counts the parts of a record: by status, in the order of `PART_STATUSES`, plus how many were isolated and how many spawns were refused. */
function partsLine(parts: ReadonlyArray<PartRecord>) {
  if (!parts.length) return "no parts"
  const statuses = PART_STATUSES.flatMap((status) => {
    const n = parts.filter((part) => part.status === status).length
    return n ? [`${n} ${status}`] : []
  }).join(", ")
  const isolated = parts.filter((part) => part.isolated).length
  const refused = parts.reduce((n, part) => n + (part.refused ?? 0), 0)
  const deepest = Math.max(...parts.map((part) => part.depth))
  return [
    `${count(parts.length, "part")}: ${statuses}`,
    ...(deepest > 1 ? [`${deepest} levels deep`] : []),
    ...(isolated ? [`${isolated} isolated`] : []),
    ...(refused ? [`${count(refused, "spawn")} refused`] : []),
  ].join(", ")
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

const day = (at: number) => new Date(at).toISOString().slice(0, 10)

/** A lesson as the listing and the note's result show it: dated, and from which depth when a session below the top wrote it. */
export const lessonLine = (lesson: Lesson) =>
  `lesson (${day(lesson.at)}${lesson.depth === undefined ? "" : `, from depth ${lesson.depth}`}): "${clipText(oneLine(lesson.text), LESSON_MAX)}"`

/** One record as the listing shows it: its top, when it started, its title, its split line, its parts, how long it ran and what it cost. */
export function recordLine(record: StoredRecord, top: string) {
  const cost = record.parts.reduce((sum, part) => sum + (part.cost ?? 0), 0)
  const costed = record.parts.some((part) => part.cost !== undefined)
  return [
    `- ${record.sessionID}${record.sessionID === top ? " (this tree)" : ""} ${day(record.startedAt)}: "${clipText(oneLine(record.title), 60)}"`,
    clipText(oneLine(record.split), 160),
    partsLine(record.parts),
    duration(record.movedAt - record.startedAt),
    ...(costed ? [`$${cost.toFixed(2)}`] : []),
    record.finished ? "finished" : "not finished",
    ...(record.recalled ? [`recalled${record.recalled.at === undefined ? " by a part" : ""}`] : []),
    ...(record.lesson ? [lessonLine(record.lesson)] : []),
  ].join(" · ")
}

/** What courier_recall says when the memory option is off. */
export const RECALL_OFF =
  "Memory is off: the plugin's memory option is false, so no record of a session tree is kept or listed in this project. Decide from the task alone."

/** The listing: every record of the project, newest first, the caller's own tree marked. */
export function recallListText(records: ReadonlyArray<StoredRecord>, top: string) {
  const others = records.filter((record) => record.sessionID !== top)
  const intro = others.length
    ? `${count(others.length, "earlier tree")} recorded in this project, newest first; weigh how they were split and how their parts went before you decide. ` +
      "A record holds what the plugin saw, not the work, and a lesson what its orchestrator concluded, next to the facts that bear it out: " +
      "courier_recall with a sessionID gives one in full, with each part's status, duration, cost and context use."
    : "No earlier tree is recorded in this project: a tree's record is written by a courier_recall call and as each turn in it ends, and kept 90 days. Decide from the task alone."
  return [intro, ...records.map((record) => recordLine(record, top))].join("\n")
}

/** One record in full, as JSON: durations in milliseconds, times in epoch milliseconds, context use as a share of the model's window. */
export function recallRecordText(record: StoredRecord) {
  return `Record of the tree under ${record.sessionID}, in project ${record.projectID} (durations in milliseconds, context use as a share of the model's window):\n${JSON.stringify(record, null, 2)}`
}

export const recallMissingText = (sessionID: string) =>
  `No record of a tree whose top session is ${sessionID} in this project. courier_recall without sessionID lists the records there are.`

/** What a lesson is for, which the tool's description and the note's result both say. */
const NOT_A_RULE = "A lesson that holds every time belongs in AGENTS.md or the skill, which only the person puts there: tell them instead of noting it."

/** What courier_note says once the lesson is written: where, what it replaced, and that it was clipped, when it was. */
export function noteText(top: string, lesson: Lesson, clipped: number | undefined, replaced: Lesson | undefined) {
  return [
    `Noted on the record of the tree under ${top} as its ${lessonLine(lesson)}.`,
    ...(clipped ? [`Clipped to ${LESSON_MAX} characters from ${clipped}: a lesson is one line.`] : []),
    ...(replaced ? [`It replaces the ${lessonLine(replaced)}.`] : []),
    `${RECALL_TOOL} lists it after the tree's facts; a second ${NOTE_TOOL} replaces it. ${NOT_A_RULE}`,
  ].join(" ")
}

/** What courier_note says when the memory option is off. */
export const NOTE_OFF = "Not noted: the plugin's memory option is false, so no record of a session tree is kept in this project to write a lesson on."

export const noteLeafRefusal = (depth: number, maxDepth: number) =>
  `Not noted: this session is a leaf, at depth ${depth} of a session tree that goes at most ${maxDepth} deep (maxDepth). A lesson is ` +
  "written by the session that verified the tree, the top or one that started sessions; put what you learned in your report instead."

export const NOTE_EMPTY = "Not noted: text is empty. Write one line, what the next tree in this project should know about splitting work here, or nothing."

export const noteUnrecordedRefusal = (top: string) =>
  `Not noted: the tree under ${top} has no record in this project to write a lesson on. A record is written by a ${RECALL_TOOL} call ` +
  "and as each turn in the tree ends, so call it once first, or note once a session you started has reported."
