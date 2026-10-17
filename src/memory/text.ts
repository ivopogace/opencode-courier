/** The memory's model-facing texts: what courier_recall says. */
import { clipText } from "../kernel/protocol.js"
import { PART_STATUSES, type PartRecord, type StoredRecord } from "./domain.js"

/** The tool's name, which the skill and the role part name too. */
export const RECALL_TOOL = "courier_recall"

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`

/** A duration in milliseconds as a model reads it: seconds under a minute, else minutes, else hours and minutes. */
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

/** One record as the listing shows it: its top, when it started, its title, its split line, its parts, how long it ran and what it cost. */
export function recordLine(record: StoredRecord, top: string) {
  const cost = record.parts.reduce((sum, part) => sum + (part.cost ?? 0), 0)
  const costed = record.parts.some((part) => part.cost !== undefined)
  return [
    `- ${record.sessionID}${record.sessionID === top ? " (this tree)" : ""} ${new Date(record.startedAt).toISOString().slice(0, 10)}: "${clipText(oneLine(record.title), 60)}"`,
    clipText(oneLine(record.split), 160),
    partsLine(record.parts),
    duration(record.movedAt - record.startedAt),
    ...(costed ? [`$${cost.toFixed(2)}`] : []),
    record.finished ? "finished" : "not finished",
    ...(record.recalled ? [`recalled${record.recalled.at === undefined ? " by a part" : ""}`] : []),
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
      "A record holds what the plugin saw, not the work: courier_recall with a sessionID gives one in full, with each part's status, duration, cost and context use."
    : "No earlier tree is recorded in this project: a record is written as a session started with courier_spawn ends a turn, and kept 90 days. Decide from the task alone."
  return [intro, ...records.map((record) => recordLine(record, top))].join("\n")
}

/** One record in full, as JSON: durations in milliseconds, times in epoch milliseconds, context use as a share of the model's window. */
export function recallRecordText(record: StoredRecord) {
  return `Record of the tree under ${record.sessionID}, in project ${record.projectID} (durations in milliseconds, context use as a share of the model's window):\n${JSON.stringify(record, null, 2)}`
}

export const recallMissingText = (sessionID: string) =>
  `No record of a tree whose top session is ${sessionID} in this project. courier_recall without sessionID lists the records there are.`
