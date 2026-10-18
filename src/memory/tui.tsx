import type { Plugin } from "@opencode/plugin/tui"
import { memoryRpc, PART_STATUSES, type Forgotten, type MemoryLesson, type MemoryPart, type MemoryRecord, type Records } from "./rpc.js"
import { duration } from "./text.js"

type Context = Plugin.Context
type Location = ReturnType<Context["data"]["location"]["default"]>

/** The command that opens the memory view: `/courier memory`, or the palette. */
export const MEMORY_COMMAND = "courier.memory"

/** The memory view's line of the `/courier` command's usage. */
export const MEMORY_USAGE = "/courier memory lists this project's tree records, to read or forget"

/** What the view says, in a toast, with the memory option off in the project asked. */
export const MEMORY_OFF = "Memory is off in this project: the plugin's memory option is false, so no record of a session tree is kept or listed here."

/** What the view says, in a toast, when the project has no record: when none was written yet, or the last was forgotten. */
export const NO_RECORDS = "No record of a session tree in this project: one is written as each turn in a tree ends, and kept 90 days."

/** The most characters of a lesson a list row's line under it shows; the record in full has it whole. */
export const LESSON_LINE_MAX = 160

/** The most characters of a title a list row shows, so that "(this session)" after it fits the host's 61. */
export const ROW_TITLE_MAX = 46

/** The group of the records moved on the current local day, over the others' local dates, as the host's Sessions dialog has it. */
export const TODAY = "Today"

/** The widest a row of the lesson in a record in full is; a longer lesson wraps over rows. */
export const LESSON_ROW = 90

const pad = (n: number) => String(n).padStart(2, "0")
/** A local calendar day as the host's Sessions dialog groups by it: `Sat Oct 17 2026`. */
const localDay = (at: number) => new Date(at).toDateString()
/** A local day inline: `2026-10-17`. */
const day = (at: number) => {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
/** The zone's short name as the runtime names it in English, `CEST`, `EDT` or `GMT+2`; `UTC` with `TZ=UTC`. */
const zone = (date: Date) => new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? "local"
/** A local time to the minute, with the zone: `2026-10-17 12:12 CEST`. */
const minute = (at: number) => {
  const date = new Date(at)
  return `${day(at)} ${pad(date.getHours())}:${pad(date.getMinutes())} ${zone(date)}`
}
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`
const money = (cost: number) => `$${cost.toFixed(2)}`

/** A record's name, as its rows and confirms show it: its title on one line, else its top session. */
export const nameOf = (record: MemoryRecord) => clip(oneLine(record.title) || record.sessionID, 60)

/** A record's parts counted by status, in the order of `PART_STATUSES`: "3 parts: 2 done, 1 partial"; "no parts" with none. */
export function partsCounted(parts: ReadonlyArray<MemoryPart>) {
  if (!parts.length) return "no parts"
  const statuses = PART_STATUSES.flatMap((status) => {
    const n = parts.filter((part) => part.status === status).length
    return n ? [`${n} ${status}`] : []
  }).join(", ")
  return `${count(parts.length, "part")}: ${statuses}`
}

/** The parts' costs summed, when any is known. */
export function costOf(record: MemoryRecord) {
  return record.parts.some((part) => part.cost !== undefined) ? record.parts.reduce((sum, part) => sum + (part.cost ?? 0), 0) : undefined
}

/** A list row's title: the tree's title, its top session's id without one; the open session's own tree says so. */
export function recordTitle(record: MemoryRecord, open?: string) {
  return `${clip(oneLine(record.title) || record.sessionID, ROW_TITLE_MAX)}${record.sessionID === open ? " (this session)" : ""}`
}

/** A list row's group: `Today` for a tree last moved on the local day of `now`, else that local date; the RPC's order, by the last move, keeps the groups newest first. */
export function recordCategory(record: MemoryRecord, now = Date.now()) {
  const moved = localDay(record.movedAt)
  return moved === localDay(now) ? TODAY : moved
}

/** A lesson as the view shows it: dated on the local day, from which depth when a session below the top wrote it, and its text. */
export function lessonHeading(lesson: MemoryLesson) {
  const from = lesson.depth === undefined ? "" : `, from depth ${lesson.depth}`
  return `lesson (${day(lesson.at)}${from})`
}

/** A list row's description: its parts by status, how long the tree ran, what its parts cost, and that it is not finished when it is not. */
export function recordDescription(record: MemoryRecord) {
  const cost = costOf(record)
  return [partsCounted(record.parts), duration(record.movedAt - record.startedAt), cost === undefined ? "" : money(cost), record.finished ? "" : "not finished"]
    .filter(Boolean)
    .join(" · ")
}

/** The lines under a list row: the lesson, dated and from which depth, clipped; none without a lesson. */
export function recordDetails(record: MemoryRecord) {
  return record.lesson ? [clip(`${lessonHeading(record.lesson)}: "${oneLine(record.lesson.text)}"`, LESSON_LINE_MAX)] : []
}

/** One part as the record in full describes it: its status, depth, isolation, group, duration, cost, context use and spawns refused. */
export function partLine(part: MemoryPart) {
  return [
    part.status,
    `depth ${part.depth}`,
    part.isolated ? "isolated" : "",
    part.group ? `group ${part.group}` : "",
    part.duration === undefined ? "" : duration(part.duration),
    part.cost === undefined ? "" : money(part.cost),
    part.context === undefined ? "" : `ctx ${Math.round(part.context * 100)}%`,
    part.refused ? `${count(part.refused, "spawn")} refused` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

/** `text` in rows of at most `width` characters, broken at spaces where it can be. */
export function wrap(text: string, width: number) {
  const rows: string[] = []
  let row = ""
  for (const word of oneLine(text).split(" ").filter(Boolean)) {
    if (row && row.length + 1 + word.length <= width) {
      row = `${row} ${word}`
      continue
    }
    if (row) rows.push(row)
    row = word
    while (row.length > width) {
      rows.push(row.slice(0, width))
      row = row.slice(width)
    }
  }
  if (row) rows.push(row)
  return rows
}

/** A row of a record in full: a fact of the tree, one of its parts, or its lesson, which `x` forgets alone. */
export type Line = { readonly kind: "fact"; readonly key: string } | { readonly kind: "part"; readonly sessionID: string } | { readonly kind: "lesson" }

/** The rows of a record in full, in three categories: the tree's facts, its parts and its lesson. */
export function detailOptions(record: MemoryRecord): Array<{ title: string; value: Line; category: string; description?: string }> {
  const fact = (key: string, title: string, description?: string) => ({ title, value: { kind: "fact", key } as Line, category: "Tree", ...(description ? { description } : {}) })
  const cost = costOf(record)
  const recalled = record.recalled
    ? fact("recalled", `Recalled ${count(record.recalled.calls, "time")}`, record.recalled.at === undefined ? "by a part only" : `first by the top ${minute(record.recalled.at)}`)
    : fact("recalled", "Not recalled")
  const lesson = record.lesson
    ? [
        { title: lessonHeading(record.lesson), value: { kind: "lesson" } as Line, category: "Lesson" },
        ...wrap(record.lesson.text, LESSON_ROW).map((row) => ({ title: row, value: { kind: "lesson" } as Line, category: "Lesson" })),
      ]
    : [{ title: "No lesson", value: { kind: "fact", key: "lesson" } as Line, category: "Lesson", description: "courier_note writes one line per tree" }]
  return [
    fact("top", `Top session ${record.sessionID}`),
    fact("started", `Started ${minute(record.startedAt)}`, `last moved ${minute(record.movedAt)}, ran ${duration(record.movedAt - record.startedAt)}`),
    fact("split", clip(oneLine(record.split), 160)),
    fact("finished", record.finished ? "Finished" : "Not finished", cost === undefined ? undefined : `${money(cost)} in all`),
    recalled,
    ...(record.parts.length
      ? record.parts.map((part) => ({
          title: `${"  ".repeat(Math.max(0, part.depth - 1))}${clip(oneLine(part.title) || part.sessionID, 60)}`,
          value: { kind: "part", sessionID: part.sessionID } as Line,
          category: "Parts",
          description: partLine(part),
        }))
      : [{ title: "No parts", value: { kind: "fact", key: "parts" } as Line, category: "Parts", description: "no session was started in this tree" }]),
    ...lesson,
  ]
}

/** What the confirm asks before a forget: the record named, with the local day it last moved, and what goes and what stays. */
export function forgetMessage(record: MemoryRecord, lesson: boolean) {
  const name = `"${nameOf(record)}" (${day(record.movedAt)}, ${partsCounted(record.parts)})`
  if (lesson)
    return `Forget the lesson of ${name}? The record keeps its facts; courier_recall no longer lists the lesson: "${clip(oneLine(record.lesson?.text ?? ""), 120)}".`
  return `Forget the record of ${name}, top session ${record.sessionID}? It leaves this project's memory and courier_recall${record.lesson ? ", its lesson with it" : ""}; the sessions themselves are untouched.`
}

/** The toast after a forget, as the server reports it. */
export function forgottenLine(record: MemoryRecord, outcome: Forgotten["outcome"]) {
  const name = `"${nameOf(record)}"`
  if (outcome === "record") return `Forgot the record of ${name}`
  if (outcome === "lesson") return `Forgot the lesson of ${name}; its facts stay`
  return `Nothing to forget for ${name}: it was already gone`
}

/** What the person asked of the list or the record on screen. */
type Request =
  | { readonly kind: "open"; readonly record: MemoryRecord }
  | { readonly kind: "forget"; readonly record: MemoryRecord; readonly lesson: boolean }
  | { readonly kind: "back" }

/**
 * Adds the memory view: the project's records (the open session's location, else the TUI's, else the server's default) under
 * `Today` and the local days they last moved; `enter` shows one in full, `x` forgets one or its lesson after a confirm, `esc` goes back and closes.
 */
export function addMemoryView(ctx: Context) {
  const memory = ctx.client.rpc(memoryRpc)
  const openSession = () => {
    const route = ctx.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }
  // Where the project is read: the open session's location, which has the plugin loaded, as the other RPCs choose it.
  const where = (): Location => {
    const sessionID = openSession()
    return (sessionID ? ctx.data.session.get(sessionID)?.location : undefined) ?? ctx.location ?? ctx.data.location.default()
  }
  /** The host's client throws an RPC error as a plain `{ type, message }` object, not an `Error`. */
  const reason = (error: unknown) => {
    if (error instanceof Error) return error.message
    return typeof error === "object" && error && "message" in error ? String(error.message) : String(error)
  }
  const fail = (what: string) => (error: unknown) => ctx.ui.toast.show({ title: "courier", message: `${what}: ${reason(error)}`, variant: "error" })
  const say = (message: string) => ctx.ui.toast.show({ title: "courier", message, variant: "info" })

  /** A select whose footer action, `x`, answers as the person's choice does; the race settles on the first of the two. */
  function show<Value>(options: Parameters<typeof ctx.ui.dialog.select<Value>>[0], chosen: (value: Value) => Request, forget: (value: Value) => Request) {
    let request: (one: Request) => void = () => undefined
    const requested = new Promise<Request>((resolve) => {
      request = resolve
    })
    const choosing = ctx.ui.dialog.select<Value>({
      ...options,
      // The host runs a footer action's key before the search sees it, so `x` is the one letter the search loses.
      actions: [{ bind: "x", title: "forget", onTrigger: (value) => request(forget(value)) }],
    })
    // The widest a dialog goes, for the parts beside each title and the lesson under it.
    ctx.ui.dialog.set({ size: "xlarge" })
    return Promise.race([choosing.then((value): Request => (value === undefined ? { kind: "back" } : chosen(value))), requested])
  }

  const showList = (read: Records) => {
    const open = openSession()
    const now = Date.now()
    return show<MemoryRecord>(
      {
        title: `Memory (${read.records.length})`,
        placeholder: "Search",
        // The lesson goes under the row as `details`, lines the host's select draws though the plugin API does not declare
        // them (docs/maintainers/plugin-api-notes.md); a host without them shows the row alone.
        options: read.records.map((record) => ({
          title: recordTitle(record, open),
          value: record,
          category: recordCategory(record, now),
          description: recordDescription(record),
          details: recordDetails(record),
        })),
      },
      (record) => ({ kind: "open", record }),
      (record) => ({ kind: "forget", record, lesson: false }),
    )
  }

  const showRecord = (record: MemoryRecord) =>
    show<Line>(
      { title: `${localDay(record.movedAt)}  ${nameOf(record)}`, placeholder: "Search", options: detailOptions(record) },
      // Enter on a row goes back to the list.
      () => ({ kind: "back" }),
      (line) => ({ kind: "forget", record, lesson: line.kind === "lesson" }),
    )

  /** Asks the person to confirm, then forgets the record, or only its lesson, through the RPC; false when they kept it. */
  async function confirmForget(record: MemoryRecord, lesson: boolean) {
    const confirmed = await ctx.ui.dialog.confirm({
      title: lesson ? "Forget lesson" : "Forget record",
      message: forgetMessage(record, lesson),
      label: { confirm: "Forget", cancel: "Keep" },
    })
    if (!confirmed) return false
    try {
      const result = await memory.forget({ sessionID: record.sessionID, lesson }, { location: where() })
      ctx.ui.toast.show({ title: "courier", message: forgottenLine(record, result.outcome), variant: result.outcome === "none" ? "warning" : "success" })
    } catch (error) {
      fail("Not forgotten")(error)
    }
    return true
  }

  let opened = false
  /**
   * Lists the project's records, and the one chosen in full, read again after each forget, until the person closes the
   * list or leaves it; the record on screen in full is shown again after its lesson is forgotten, the list after it is.
   */
  async function open() {
    if (opened) return
    opened = true
    try {
      let viewing: string | undefined
      for (;;) {
        const read = await memory.records({}, { location: where() }).catch(fail("The records could not be read"))
        if (!read) return
        if (!read.memory) return say(MEMORY_OFF)
        if (!read.records.length) return say(NO_RECORDS)
        const record = viewing === undefined ? undefined : read.records.find((one) => one.sessionID === viewing)
        viewing = record?.sessionID
        const request = await (record ? showRecord(record) : showList(read))
        if (request.kind === "back") {
          // The host closed the dialog on enter or esc: a record goes back to the list, the list is left.
          if (!record) return
          viewing = undefined
          continue
        }
        if (request.kind === "open") {
          viewing = request.record.sessionID
          continue
        }
        await confirmForget(request.record, request.lesson)
        if (!request.lesson) viewing = undefined
      }
    } finally {
      opened = false
    }
  }

  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: MEMORY_COMMAND,
        title: "Courier: memory",
        description: "The records of this project's session trees, newest first under the day each last moved: enter for one in full, x to forget one or its lesson",
        group: "Courier",
        palette: true,
        run: () => void open(),
      },
    ],
  }))

  return { open }
}
