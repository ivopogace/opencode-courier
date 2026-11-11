import type { Plugin } from "@opencode/plugin/tui"
import { memoryRpc, PART_STATUSES, type Forgotten, type MemoryLesson, type MemoryPart, type MemoryReads, type MemoryRecord, type Pinned, type Records } from "./rpc.js"
import { duration } from "./text.js"

type Context = Plugin.Context
type Location = ReturnType<Context["data"]["location"]["default"]>

export const MEMORY_COMMAND = "courier.memory"

export const MEMORY_USAGE = "/courier memory lists this project's tree records, to read, pin or forget"

export const MEMORY_OFF = "Memory is off in this project: the plugin's memory option is false, so no record of a session tree is kept or listed here."

export const NO_RECORDS = "No record of a session tree in this project: one is written as each turn in a tree ends, and kept 90 days."

export const LESSON_LINE_MAX = 160

export const ROW_TITLE_MAX = 46

export const TODAY = "Today"

export const PINNED = "Pinned"

export const LESSON_ROW = 90

const pad = (n: number) => String(n).padStart(2, "0")
const localDay = (at: number) => new Date(at).toDateString()
const day = (at: number) => {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
const zone = (date: Date) => new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? "local"
const minute = (at: number) => {
  const date = new Date(at)
  return `${day(at)} ${pad(date.getHours())}:${pad(date.getMinutes())} ${zone(date)}`
}
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`
const times = (n: number) => (n === 1 ? "once" : `${n} times`)
const money = (cost: number) => `$${cost.toFixed(2)}`

export const nameOf = (record: MemoryRecord) => clip(oneLine(record.title) || record.sessionID, 60)

export function partsCounted(all: ReadonlyArray<MemoryPart>) {
  const parts = all.filter((part) => !part.subagent)
  const subagents = all.length - parts.length
  const statuses = PART_STATUSES.flatMap((status) => {
    const n = parts.filter((part) => part.status === status).length
    return n ? [`${n} ${status}`] : []
  }).join(", ")
  return [parts.length ? `${count(parts.length, "part")}: ${statuses}` : "no parts", ...(subagents ? [count(subagents, "subagent")] : [])].join(", ")
}

export function costOf(record: MemoryRecord) {
  return record.parts.some((part) => part.cost !== undefined) ? record.parts.reduce((sum, part) => sum + (part.cost ?? 0), 0) : undefined
}

export function recordTitle(record: MemoryRecord, open?: string) {
  return `${clip(oneLine(record.title) || record.sessionID, ROW_TITLE_MAX)}${record.sessionID === open ? " (this session)" : ""}`
}

export function recordCategory(record: MemoryRecord, now = Date.now()) {
  if (record.pinned) return PINNED
  const moved = localDay(record.movedAt)
  return moved === localDay(now) ? TODAY : moved
}

export function readsLine(reads: MemoryReads) {
  return [reads.shown ? `shown ${times(reads.shown)}` : "", reads.read ? `opened ${times(reads.read)}` : ""].filter(Boolean).join(", ")
}

export function lessonHeading(lesson: MemoryLesson) {
  const from = lesson.depth === undefined ? "" : `, from depth ${lesson.depth}`
  return `lesson (${day(lesson.at)}${from})`
}

export function recordDescription(record: MemoryRecord) {
  const cost = costOf(record)
  return [
    partsCounted(record.parts),
    duration(record.movedAt - record.startedAt),
    cost === undefined ? "" : money(cost),
    record.finished ? "" : "not finished",
    record.reads ? readsLine(record.reads) : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

export function recordDetails(record: MemoryRecord) {
  return record.lesson ? [clip(`${lessonHeading(record.lesson)}: "${oneLine(record.lesson.text)}"`, LESSON_LINE_MAX)] : []
}

export function partLine(part: MemoryPart) {
  return [
    part.status,
    `depth ${part.depth}`,
    part.isolated ? "isolated" : "",
    part.subagent ? "subagent" : "",
    part.group ? `group ${part.group}` : "",
    part.duration === undefined ? "" : duration(part.duration),
    part.cost === undefined ? "" : money(part.cost),
    part.context === undefined ? "" : `ctx ${Math.round(part.context * 100)}%`,
    part.refused ? `${count(part.refused, "spawn")} refused` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

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

export type Line = { readonly kind: "fact"; readonly key: string } | { readonly kind: "part"; readonly sessionID: string } | { readonly kind: "lesson"; readonly row: number }

export const lessonLine = (record: MemoryRecord): Line => (record.lesson ? { kind: "lesson", row: 0 } : { kind: "fact", key: "lesson" })

export function nearby(sessionIDs: ReadonlyArray<string>, sessionID: string, forgotten: boolean) {
  const at = sessionIDs.indexOf(sessionID)
  if (at < 0) return forgotten ? [] : [sessionID]
  return [...(forgotten ? [] : [sessionID]), ...sessionIDs.slice(at + 1), ...sessionIDs.slice(0, at).reverse()]
}

export function detailOptions(record: MemoryRecord): Array<{ title: string; value: Line; category: string; description?: string }> {
  const fact = (key: string, title: string, description?: string) => ({ title, value: { kind: "fact", key } as Line, category: "Tree", ...(description ? { description } : {}) })
  const cost = costOf(record)
  const recalled = record.recalled
    ? fact("recalled", `Recalled ${count(record.recalled.calls, "time")}`, record.recalled.at === undefined ? "by a part only" : `first by the top ${minute(record.recalled.at)}`)
    : fact("recalled", "Not recalled")
  const reads = record.reads
    ? fact("reads", `${readsLine(record.reads).replace(/^./, (first) => first.toUpperCase())}`, `by other trees' courier_recall, last ${minute(record.reads.at)}`)
    : fact("reads", "Never shown", "no other tree's courier_recall has listed it yet")
  const pinned = record.pinned
    ? fact("pinned", "Pinned", `since ${minute(record.pinned.at)}: listed first, never swept; p unpins`)
    : fact("pinned", "Not pinned", "p pins it: listed first, never swept")
  const lesson = record.lesson
    ? [
        { title: lessonHeading(record.lesson), value: { kind: "lesson", row: 0 } as Line, category: "Lesson" },
        ...wrap(record.lesson.text, LESSON_ROW).map((row, at) => ({ title: row, value: { kind: "lesson", row: at + 1 } as Line, category: "Lesson" })),
      ]
    : [{ title: "No lesson", value: { kind: "fact", key: "lesson" } as Line, category: "Lesson", description: "courier_note writes one line per tree" }]
  return [
    fact("top", `Top session ${record.sessionID}`),
    fact("started", `Started ${minute(record.startedAt)}`, `last moved ${minute(record.movedAt)}, ran ${duration(record.movedAt - record.startedAt)}`),
    fact("split", clip(oneLine(record.split), 160)),
    fact("finished", record.finished ? "Finished" : "Not finished", cost === undefined ? undefined : `${money(cost)} in all`),
    recalled,
    reads,
    pinned,
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

export function forgetMessage(record: MemoryRecord, lesson: boolean) {
  const name = `"${nameOf(record)}" (${day(record.movedAt)}, ${partsCounted(record.parts)})`
  if (lesson)
    return `Forget the lesson of ${name}? The record keeps its facts; courier_recall no longer lists the lesson: "${clip(oneLine(record.lesson?.text ?? ""), 120)}".`
  return `Forget the record of ${name}, top session ${record.sessionID}? It leaves this project's memory and courier_recall${record.lesson ? ", its lesson with it" : ""}; the sessions themselves are untouched.`
}

export function forgottenLine(record: MemoryRecord, outcome: Forgotten["outcome"]) {
  const name = `"${nameOf(record)}"`
  if (outcome === "record") return `Forgot the record of ${name}`
  if (outcome === "lesson") return `Forgot the lesson of ${name}; its facts stay`
  return `Nothing to forget for ${name}: it was already gone`
}

export function pinnedLine(record: MemoryRecord, outcome: Pinned["outcome"]) {
  const name = `"${nameOf(record)}"`
  if (outcome === "pinned") return `Pinned ${name}: listed first, never swept`
  if (outcome === "unpinned") return `Unpinned ${name}: kept as the others are`
  return `Nothing to pin for ${name}: it was already gone`
}

type Request =
  | { readonly kind: "open"; readonly record: MemoryRecord }
  | { readonly kind: "forget"; readonly record: MemoryRecord; readonly lesson: boolean; readonly line?: Line }
  | { readonly kind: "pin"; readonly record: MemoryRecord; readonly line?: Line }
  | { readonly kind: "back" }

export function addMemoryView(ctx: Context) {
  const memory = ctx.client.rpc(memoryRpc)
  const openSession = () => {
    const route = ctx.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }
  const where = (): Location => {
    const sessionID = openSession()
    return (sessionID ? ctx.data.session.get(sessionID)?.location : undefined) ?? ctx.location ?? ctx.data.location.default()
  }
  const reason = (error: unknown) => {
    if (error instanceof Error) return error.message
    return typeof error === "object" && error && "message" in error ? String(error.message) : String(error)
  }
  const fail = (what: string) => (error: unknown) => ctx.ui.toast.show({ title: "courier", message: `${what}: ${reason(error)}`, variant: "error" })
  const say = (message: string) => ctx.ui.toast.show({ title: "courier", message, variant: "info" })

  type Action<Value> = (value: Value) => Request

  function show<Value>(options: Parameters<typeof ctx.ui.dialog.select<Value>>[0], chosen: Action<Value>, forget: Action<Value>, pin: { title: string; ask: Action<Value> }) {
    let request: (one: Request) => void = () => undefined
    const requested = new Promise<Request>((resolve) => {
      request = resolve
    })
    const choosing = ctx.ui.dialog.select<Value>({
      ...options,
      actions: [
        { bind: "x", title: "forget", onTrigger: (value) => request(forget(value)) },
        { bind: "p", title: pin.title, onTrigger: (value) => request(pin.ask(value)) },
      ],
    })
    ctx.ui.dialog.set({ size: "xlarge" })
    return Promise.race([choosing.then((value): Request => (value === undefined ? { kind: "back" } : chosen(value))), requested])
  }

  const showList = (read: Records, current: MemoryRecord | undefined) => {
    const open = openSession()
    const now = Date.now()
    return show<MemoryRecord>(
      {
        title: `Memory (${read.records.length})`,
        placeholder: "Search",
        ...(current ? { current } : {}),
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
      { title: "pin", ask: (record) => ({ kind: "pin", record }) },
    )
  }

  const showRecord = (record: MemoryRecord, current: Line | undefined) =>
    show<Line>(
      { title: `${localDay(record.movedAt)}  ${nameOf(record)}`, placeholder: "Search", options: detailOptions(record), ...(current ? { current } : {}) },
      () => ({ kind: "back" }),
      (line) => ({ kind: "forget", record, lesson: line.kind === "lesson", line }),
      { title: record.pinned ? "unpin" : "pin", ask: (line) => ({ kind: "pin", record, line }) },
    )

  async function togglePin(record: MemoryRecord) {
    const pinned = !record.pinned
    try {
      const result = await memory.pin({ sessionID: record.sessionID, pinned }, { location: where() })
      ctx.ui.toast.show({ title: "courier", message: pinnedLine(record, result.outcome), variant: result.outcome === "none" ? "warning" : "success" })
    } catch (error) {
      fail(pinned ? "Not pinned" : "Not unpinned")(error)
    }
  }

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
      return true
    } catch (error) {
      fail("Not forgotten")(error)
      return false
    }
  }

  let opened = false
  async function open() {
    if (opened) return
    opened = true
    try {
      let viewing: string | undefined
      let near: string[] = []
      let line: Line | "lesson" | undefined
      for (;;) {
        const read = await memory.records({}, { location: where() }).catch(fail("The records could not be read"))
        if (!read) return
        if (!read.memory) return say(MEMORY_OFF)
        if (!read.records.length) return say(NO_RECORDS)
        const record = viewing === undefined ? undefined : read.records.find((one) => one.sessionID === viewing)
        viewing = record?.sessionID
        const listed = read.records.map((one) => one.sessionID)
        const current = near.map((sessionID) => read.records.find((one) => one.sessionID === sessionID)).find((one) => one !== undefined)
        const at = line === "lesson" ? record && lessonLine(record) : line
        const request = await (record ? showRecord(record, at) : showList(read, current))
        line = undefined
        if (request.kind === "back") {
          if (!record) return
          near = nearby(listed, record.sessionID, false)
          viewing = undefined
          continue
        }
        if (request.kind === "open") {
          viewing = request.record.sessionID
          continue
        }
        if (request.kind === "pin") {
          await togglePin(request.record)
          near = [request.record.sessionID]
          line = request.line
          continue
        }
        const forgotten = await confirmForget(request.record, request.lesson)
        near = nearby(listed, request.record.sessionID, forgotten && !request.lesson)
        if (record && !forgotten) line = request.line
        else if (request.lesson) line = "lesson"
        else viewing = undefined
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
        description: "The records of this project's session trees, pinned first, then newest first under the day each last moved: enter for one in full, p to pin or unpin one, x to forget one or its lesson",
        group: "Courier",
        palette: true,
        run: () => void open(),
      },
    ],
  }))

  return { open }
}
