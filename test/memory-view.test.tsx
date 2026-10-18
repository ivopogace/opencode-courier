// The memory view (#262), the memory module's TUI part: the project's tree records in a dialog, against a fake TUI
// context whose dialogs a test answers, and whose footer actions a test presses. Its dates are local (#272): the file
// runs in Berlin's zone, two hours ahead of UTC in October, so a day differs from UTC's late in the evening.
import { afterAll, describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { Forgotten, MemoryRecord, Pinned, Records } from "../src/memory/rpc.js"
import {
  addMemoryView,
  costOf,
  detailOptions,
  LESSON_LINE_MAX,
  forgetMessage,
  forgottenLine,
  lessonHeading,
  lessonLine,
  LESSON_ROW,
  MEMORY_COMMAND,
  MEMORY_OFF,
  nearby,
  NO_RECORDS,
  partLine,
  partsCounted,
  PINNED,
  pinnedLine,
  readsLine,
  recordCategory,
  recordDescription,
  recordDetails,
  recordTitle,
  ROW_TITLE_MAX,
  TODAY,
  wrap,
} from "../src/memory/tui.js"

// Set before the records below are made, so that their local days and the view's agree whatever the hour.
const TZ = process.env.TZ
process.env.TZ = "Europe/Berlin"
afterAll(() => {
  if (TZ === undefined) delete process.env.TZ
  else process.env.TZ = TZ
})

/** 23:30 UTC on 2026-10-17: 01:30 on the 18th in Berlin. */
const NOW = Date.UTC(2026, 9, 17, 23, 30)

const lesson = { text: "The docs part was ten lines; next time do it yourself.", at: Date.UTC(2026, 9, 17, 22, 30) }

const record = (sessionID: string, title: string, movedAt: number, more: Partial<MemoryRecord> = {}): MemoryRecord => ({
  sessionID,
  startedAt: movedAt - 42 * 60_000,
  movedAt,
  title,
  split: "split: 2 parts: core, docs",
  finished: true,
  parts: [
    { sessionID: "ses_core", title: "Core", depth: 1, isolated: true, group: "wave", status: "done", duration: 540_000, cost: 0.42, context: 0.31 },
    { sessionID: "ses_docs", title: "Docs", depth: 1, isolated: false, status: "partial", duration: 60_000, cost: 0.86, refused: 1 },
    { sessionID: "ses_review", title: "Review", depth: 2, isolated: false, status: "out" },
  ],
  ...more,
})

const newest = record("ses_root", "Add memory to courier", NOW, { lesson, recalled: { at: NOW - 40 * 60_000, calls: 2 } })
const older = record("ses_old", "Fix the bug", NOW - 86_400_000, { parts: [], finished: false, split: "not stated" })
const oldest = record("ses_oldest", "Bump the pin", NOW - 2 * 86_400_000)
/** The same two trees, the first last moved now, so that the view lists it under "Today" on the real clock. */
const LIVE = Date.now()
const todays = record("ses_root", "Add memory to courier", LIVE, { lesson, recalled: { at: LIVE - 40 * 60_000, calls: 2 } })
// The same time a local calendar day earlier: 25 hours back on the day the clocks fall back, not 24.
const YESTERDAY = new Date(LIVE)
YESTERDAY.setDate(YESTERDAY.getDate() - 1)
const yesterdays = record("ses_old", "Fix the bug", YESTERDAY.getTime(), { parts: [], finished: false, split: "not stated" })
const yesterday = YESTERDAY.toDateString()

type Dialog = { kind: "select" | "confirm" | "alert" | "prompt"; options: any }

/** An answer that presses a footer action and leaves the dialog open. */
const HOLD = Symbol("hold")

/**
 * A fake TUI context with the open session `ses_root`: the memory's RPC answers `state.records` and `state.forgotten`,
 * and each dialog is answered by the next of `answers`, which backs out once they run out.
 */
function fakeContext(records: ReadonlyArray<MemoryRecord>, { memory = true, location = { directory: "/workspace" } }: { memory?: boolean; location?: { directory: string } | null } = {}) {
  const state = {
    records: [...records] as MemoryRecord[],
    memory,
    forgotten: { outcome: "record" } as Forgotten,
    pinned: undefined as Pinned | undefined,
    readError: undefined as unknown,
    forgetError: undefined as unknown,
    pinError: undefined as unknown,
  }
  const dialogs: Dialog[] = []
  const answers: ((dialog: Dialog) => unknown)[] = []
  const calls: { method: string; input: unknown; options?: unknown }[] = []
  const toasts: { title?: string; message: string; variant?: string }[] = []
  const layers: (() => any)[] = []
  const sizes: unknown[] = []
  let route: { type: string; sessionID?: string } = { type: "session", sessionID: "ses_root" }
  // As the host's: a dialog shown, or cleared, closes the one before, whose promise resolves with nothing.
  let close: (() => void) | undefined
  const dialog = (kind: Dialog["kind"]) => (options: any) => {
    close?.()
    const shown = { kind, options }
    dialogs.push(shown)
    return new Promise((resolve) => {
      let open = true
      const settle = (value: unknown) => {
        if (!open) return
        open = false
        if (close === closing) close = undefined
        resolve(value)
      }
      const closing = () => settle(undefined)
      close = closing
      void Promise.resolve(answers.shift()?.(shown)).then((value) => {
        if (value !== HOLD) settle(value)
      })
    })
  }
  const context = {
    // null stands for a TUI with no location of its own.
    location: location ?? undefined,
    data: {
      location: { default: () => ({ directory: "/default" }) },
      session: {
        get: (sessionID: string) => (sessionID === "ses_root" ? { id: sessionID, title: "Root", location: { directory: "/project" } } : undefined),
      },
    },
    client: {
      rpc: (definition: { id: string }) => {
        expect(definition.id).toBe("courier-memory")
        return {
          records: async (input: unknown, options: unknown): Promise<Records> => {
            calls.push({ method: "records", input, options })
            if (state.readError) throw state.readError
            return { memory: state.memory, projectID: "proj_1", records: state.memory ? [...state.records] : [] }
          },
          forget: async (input: { sessionID: string; lesson?: boolean }, options: unknown) => {
            calls.push({ method: "forget", input, options })
            if (state.forgetError) throw state.forgetError
            if (state.forgotten.outcome === "record") state.records = state.records.filter((one) => one.sessionID !== input.sessionID)
            if (state.forgotten.outcome === "lesson") state.records = state.records.map((one) => (one.sessionID === input.sessionID ? { ...one, lesson: undefined } : one))
            return state.forgotten
          },
          // As the server: the pin lies beside the record, and the listing puts the pinned first.
          pin: async (input: { sessionID: string; pinned: boolean }, options: unknown) => {
            calls.push({ method: "pin", input, options })
            if (state.pinError) throw state.pinError
            if (state.pinned) return state.pinned
            const found = state.records.find((one) => one.sessionID === input.sessionID)
            if (!found) return { outcome: "none" }
            const { pinned: _pin, ...rest } = found
            const changed: MemoryRecord = input.pinned ? { ...found, pinned: { at: NOW } } : rest
            state.records = state.records
              .map((one) => (one === found ? changed : one))
              .toSorted((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.movedAt - a.movedAt)
            return { outcome: input.pinned ? "pinned" : "unpinned" }
          },
        }
      },
    },
    ui: {
      router: { current: () => route },
      dialog: {
        select: dialog("select"),
        confirm: dialog("confirm"),
        alert: dialog("alert"),
        prompt: dialog("prompt"),
        set: (options: unknown) => void sizes.push(options),
        clear: () => close?.(),
      },
      toast: { show: (toast: { message: string; variant?: string }) => void toasts.push(toast) },
    },
    keymap: { layer: (factory: () => any) => void layers.push(factory) },
  } as unknown as Plugin.Context
  return {
    context,
    state,
    dialogs,
    answers,
    calls,
    toasts,
    layers,
    sizes,
    goHome: () => void (route = { type: "home" }),
    forgets: () => calls.filter(({ method }) => method === "forget"),
    pins: () => calls.filter(({ method }) => method === "pin"),
    reads: () => calls.filter(({ method }) => method === "records"),
    selects: () => dialogs.filter((one) => one.kind === "select"),
    confirms: () => dialogs.filter((one) => one.kind === "confirm"),
  }
}

/** The dialog's option whose title starts with `title`, chosen. */
const pick = (title: string) => (dialog: Dialog) => dialog.options.options.find((option: any) => option.title.startsWith(title))?.value
/** The footer action bound to `key` pressed on the option whose title starts with `title` (the first with none), the dialog left open. */
const press = (key: string, title?: string) => (dialog: Dialog) => {
  const action = dialog.options.actions.find((one: any) => one.bind === key)
  const option = title === undefined ? dialog.options.options[0] : dialog.options.options.find((one: any) => one.title.startsWith(title))
  action.onTrigger(option?.value)
  return HOLD
}
/** Esc: the dialog closes with nothing. */
const escape = () => undefined
const yes = () => true
const no = () => false

describe("the memory view's lines", () => {
  test("counts a record's parts by status, in the statuses' order, and sums their costs when any is known", () => {
    expect(partsCounted(newest.parts)).toBe("3 parts: 1 done, 1 partial, 1 out")
    expect(partsCounted([])).toBe("no parts")
    expect(costOf(newest)).toBeCloseTo(1.28)
    expect(costOf(older)).toBeUndefined()
  })

  test("a row: the tree's title, the open session's own marked; its parts, duration and cost; its lesson, dated on the local day, on the line under it", () => {
    expect(recordTitle(newest, "ses_root")).toBe("Add memory to courier (this session)")
    expect(recordTitle(newest, "ses_other")).toBe("Add memory to courier")
    expect(recordTitle({ ...older, title: "" })).toBe("ses_old")
    // Within the 61 characters the host's row keeps of a title, "(this session)" included.
    expect(recordTitle({ ...newest, title: "x".repeat(80) }, "ses_root")).toBe(`${"x".repeat(ROW_TITLE_MAX - 1)}… (this session)`)
    expect(recordTitle({ ...newest, title: "x".repeat(80) }, "ses_root")).toHaveLength(61)
    expect(recordDescription(newest)).toBe("3 parts: 1 done, 1 partial, 1 out · 42 min · $1.28")
    expect(recordDescription(older)).toBe("no parts · 42 min · not finished")
    // 22:30 UTC on the 17th is the 18th in Berlin.
    expect(lessonHeading(lesson)).toBe("lesson (2026-10-18)")
    expect(recordDetails(newest)).toEqual(['lesson (2026-10-18): "The docs part was ten lines; next time do it yourself."'])
    expect(recordDetails({ ...newest, lesson: { ...lesson, depth: 1, text: "y".repeat(300) } })[0]).toHaveLength(LESSON_LINE_MAX)
    expect(recordDetails({ ...newest, lesson: { ...lesson, depth: 1, text: "y".repeat(300) } })[0]).toStartWith('lesson (2026-10-18, from depth 1): "yyyy')
    expect(recordDetails(older)).toEqual([])
  })

  test("a row's group is Today for a tree last moved on the local day, else that local date as the host's Sessions dialog writes it", () => {
    // 23:30 UTC on the 17th: still the 17th in UTC, the 18th in Berlin, the local day of `now`.
    expect(recordCategory(newest, NOW)).toBe(TODAY)
    expect(recordCategory(older, NOW)).toBe("Sat Oct 17 2026")
    // A tree that started a day earlier and last moved today is under Today: the group follows the order, by the last move.
    expect(recordCategory({ ...newest, startedAt: NOW - 86_400_000 }, NOW)).toBe(TODAY)
    expect(recordCategory(newest, NOW + 86_400_000)).toBe("Sun Oct 18 2026")
    // Just before local midnight on the 17th, and just after it, are two days.
    expect(recordCategory({ ...newest, movedAt: Date.UTC(2026, 9, 17, 21, 59) }, NOW)).toBe("Sat Oct 17 2026")
    expect(recordCategory({ ...newest, movedAt: Date.UTC(2026, 9, 17, 22, 0) }, NOW)).toBe(TODAY)
    expect(recordCategory(todays)).toBe(TODAY)
    expect(recordCategory(yesterdays)).toBe(yesterday)
    // A pinned record is under Pinned whenever it last moved.
    expect(recordCategory({ ...older, pinned: { at: NOW } }, NOW)).toBe(PINNED)
  })

  test("a row says how often other trees' courier_recall showed and opened the record, as the record in full does with when last (#285)", () => {
    expect(readsLine({ shown: 7, read: 1, at: NOW })).toBe("shown 7 times, opened once")
    expect(readsLine({ shown: 1, read: 0, at: NOW })).toBe("shown once")
    expect(readsLine({ shown: 0, read: 2, at: NOW })).toBe("opened 2 times")
    expect(recordDescription({ ...newest, reads: { shown: 7, read: 1, at: NOW } })).toBe("3 parts: 1 done, 1 partial, 1 out · 42 min · $1.28 · shown 7 times, opened once")
    const facts = detailOptions({ ...older, reads: { shown: 7, read: 1, at: NOW }, pinned: { at: NOW - 60_000 } }).filter((option) => option.value.kind === "fact")
    expect(facts.map((option) => [option.title, option.description])).toEqual(
      expect.arrayContaining([
        ["Shown 7 times, opened once", "by other trees' courier_recall, last 2026-10-18 01:30 GMT+2"],
        ["Pinned", "since 2026-10-18 01:29 GMT+2: listed first, never swept; p unpins"],
      ]),
    )
    expect(pinnedLine(newest, "pinned")).toBe('Pinned "Add memory to courier": listed first, never swept')
    expect(pinnedLine(newest, "unpinned")).toBe('Unpinned "Add memory to courier": kept as the others are')
    expect(pinnedLine(newest, "none")).toBe('Nothing to pin for "Add memory to courier": it was already gone')
  })

  test("a part's line: its status, depth, isolation, group, duration, cost, context use and spawns refused", () => {
    expect(newest.parts.map(partLine)).toEqual(["done · depth 1 · isolated · group wave · 9 min · $0.42 · ctx 31%", "partial · depth 1 · 1 min · $0.86 · 1 spawn refused", "out · depth 2"])
  })

  test("wraps a lesson over rows at spaces, and breaks a word longer than a row", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"])
    expect(wrap("  spaced   out  ", 20)).toEqual(["spaced out"])
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"])
    expect(wrap("", 4)).toEqual([])
    expect(wrap(lesson.text, LESSON_ROW)).toEqual([lesson.text])
  })

  test("a record in full: the tree's facts, with its times local and the zone named, its parts indented by depth, and its lesson, in three categories", () => {
    const options = detailOptions(newest)
    expect(options.map((option) => [option.category, option.title, option.description])).toEqual([
      ["Tree", "Top session ses_root", undefined],
      ["Tree", "Started 2026-10-18 00:48 GMT+2", "last moved 2026-10-18 01:30 GMT+2, ran 42 min"],
      ["Tree", "split: 2 parts: core, docs", undefined],
      ["Tree", "Finished", "$1.28 in all"],
      ["Tree", "Recalled 2 times", "first by the top 2026-10-18 00:50 GMT+2"],
      ["Tree", "Never shown", "no other tree's courier_recall has listed it yet"],
      ["Tree", "Not pinned", "p pins it: listed first, never swept"],
      ["Parts", "Core", "done · depth 1 · isolated · group wave · 9 min · $0.42 · ctx 31%"],
      ["Parts", "Docs", "partial · depth 1 · 1 min · $0.86 · 1 spawn refused"],
      ["Parts", "  Review", "out · depth 2"],
      ["Lesson", "lesson (2026-10-18)", undefined],
      ["Lesson", "The docs part was ten lines; next time do it yourself.", undefined],
    ])
    expect(options.map((option) => option.value)).toEqual([
      { kind: "fact", key: "top" },
      { kind: "fact", key: "started" },
      { kind: "fact", key: "split" },
      { kind: "fact", key: "finished" },
      { kind: "fact", key: "recalled" },
      { kind: "fact", key: "reads" },
      { kind: "fact", key: "pinned" },
      { kind: "part", sessionID: "ses_core" },
      { kind: "part", sessionID: "ses_docs" },
      { kind: "part", sessionID: "ses_review" },
      { kind: "lesson", row: 0 },
      { kind: "lesson", row: 1 },
    ])
  })

  test("a record without parts, lesson or recall says so, a part's recall is by a part only, and a long lesson takes several rows", () => {
    const options = detailOptions({ ...older, recalled: { calls: 1 }, lesson: { text: "x ".repeat(100), at: lesson.at, depth: 1 } })
    expect(options.filter((option) => option.category !== "Lesson").map((option) => [option.title, option.description])).toEqual([
      ["Top session ses_old", undefined],
      ["Started 2026-10-17 00:48 GMT+2", "last moved 2026-10-17 01:30 GMT+2, ran 42 min"],
      ["not stated", undefined],
      ["Not finished", undefined],
      ["Recalled 1 time", "by a part only"],
      ["Never shown", "no other tree's courier_recall has listed it yet"],
      ["Not pinned", "p pins it: listed first, never swept"],
      ["No parts", "no session was started in this tree"],
    ])
    expect(options.filter((option) => option.category === "Lesson").map((option) => option.title)).toEqual(["lesson (2026-10-18, from depth 1)", ...wrap("x ".repeat(100), LESSON_ROW)])
    expect(detailOptions(older).filter((option) => option.category === "Lesson")).toEqual([{ title: "No lesson", value: { kind: "fact", key: "lesson" }, category: "Lesson", description: "courier_note writes one line per tree" }])
    expect(detailOptions({ ...older, recalled: undefined }).find((option) => option.value.kind === "fact" && option.value.key === "recalled")!.title).toBe("Not recalled")
  })

  test("the list's cursor after a forget tries the records after it, then those before it, nearest first; after a keep, the record first", () => {
    const ids = ["a", "b", "c", "d"]
    expect(nearby(ids, "b", true)).toEqual(["c", "d", "a"])
    expect(nearby(ids, "d", true)).toEqual(["c", "b", "a"])
    expect(nearby(ids, "b", false)).toEqual(["b", "c", "d", "a"])
    expect(nearby(["a"], "a", true)).toEqual([])
    expect(nearby(ids, "z", false)).toEqual(["z"])
    expect(lessonLine(newest)).toEqual({ kind: "lesson", row: 0 })
    expect(lessonLine(older)).toEqual({ kind: "fact", key: "lesson" })
  })

  test("the confirm names the record, with the local day it last moved, and says what goes, the toast what the server did", () => {
    expect(forgetMessage(newest, false)).toBe(
      'Forget the record of "Add memory to courier" (2026-10-18, 3 parts: 1 done, 1 partial, 1 out), top session ses_root? It leaves this project\'s memory and courier_recall, its lesson with it; the sessions themselves are untouched.',
    )
    expect(forgetMessage(older, false)).toBe(
      'Forget the record of "Fix the bug" (2026-10-17, no parts), top session ses_old? It leaves this project\'s memory and courier_recall; the sessions themselves are untouched.',
    )
    expect(forgetMessage(newest, true)).toBe(
      'Forget the lesson of "Add memory to courier" (2026-10-18, 3 parts: 1 done, 1 partial, 1 out)? The record keeps its facts; courier_recall no longer lists the lesson: "The docs part was ten lines; next time do it yourself.".',
    )
    expect(forgottenLine(newest, "record")).toBe('Forgot the record of "Add memory to courier"')
    expect(forgottenLine(newest, "lesson")).toBe('Forgot the lesson of "Add memory to courier"; its facts stay')
    expect(forgottenLine(newest, "none")).toBe('Nothing to forget for "Add memory to courier": it was already gone')
  })
})

describe("the memory view", () => {
  test("lists the project's records as the RPC orders them, grouped under Today and the local days they last moved, read at the open session's location, the open session's own marked", async () => {
    const fake = fakeContext([todays, yesterdays])
    fake.answers.push(escape)
    await addMemoryView(fake.context).open()

    expect(fake.reads()).toEqual([{ method: "records", input: {}, options: { location: { directory: "/project" } } }])
    expect(fake.sizes).toEqual([{ size: "xlarge" }])
    const list = fake.selects()[0]!.options
    expect(list.title).toBe("Memory (2)")
    expect(list.placeholder).toBe("Search")
    expect(list.options.map((option: any) => [option.category, option.title, option.description, option.details])).toEqual([
      [TODAY, "Add memory to courier (this session)", "3 parts: 1 done, 1 partial, 1 out · 42 min · $1.28", ['lesson (2026-10-18): "The docs part was ten lines; next time do it yourself."']],
      [yesterday, "Fix the bug", "no parts · 42 min · not finished", []],
    ])
    expect(yesterday).not.toBe(TODAY)
    // `x` and `p` alone, so every other letter, `q` among them, goes to the search.
    expect(list.actions.map((action: any) => [action.bind, action.title, action.selection])).toEqual([
      ["x", "forget", undefined],
      ["p", "pin", undefined],
    ])
    // Esc left it: nothing more is shown or read.
    expect(fake.dialogs).toHaveLength(1)
    expect(fake.toasts).toEqual([])
  })

  test("says memory is off in a toast, and shows no list, when the option is", async () => {
    const fake = fakeContext([newest], { memory: false })
    await addMemoryView(fake.context).open()

    expect(fake.dialogs).toEqual([])
    expect(fake.toasts).toEqual([{ title: "courier", message: MEMORY_OFF, variant: "info" }])
  })

  test("says when the project has no record, and when the records could not be read", async () => {
    const empty = fakeContext([])
    await addMemoryView(empty.context).open()
    expect(empty.dialogs).toEqual([])
    expect(empty.toasts).toEqual([{ title: "courier", message: NO_RECORDS, variant: "info" }])

    const failing = fakeContext([newest])
    failing.state.readError = { type: "rpc.method_not_found", message: "rpc.method_not_found" }
    await addMemoryView(failing.context).open()
    expect(failing.dialogs).toEqual([])
    expect(failing.toasts).toEqual([{ title: "courier", message: "The records could not be read: rpc.method_not_found", variant: "error" }])
  })

  test("asks at the TUI's location with no session open, and at the server's default with none", async () => {
    const home = fakeContext([newest])
    home.goHome()
    home.answers.push(escape)
    await addMemoryView(home.context).open()
    expect(home.reads()[0]!.options).toEqual({ location: { directory: "/workspace" } })
    expect(home.selects()[0]!.options.options[0].title).toBe("Add memory to courier")

    const bare = fakeContext([newest], { location: null })
    bare.goHome()
    bare.answers.push(escape)
    await addMemoryView(bare.context).open()
    expect(bare.reads()[0]!.options).toEqual({ location: { directory: "/default" } })
  })

  test("enter shows the record in full, titled with the local day it last moved, in its categories; enter or esc there goes back to the list", async () => {
    const fake = fakeContext([newest, older])
    fake.answers.push(pick("Fix the bug"), pick("Top session"), pick("Add memory"), escape, escape)
    await addMemoryView(fake.context).open()

    const [list, detail, listAgain, detailAgain, listOnceMore] = fake.selects()
    expect(list!.options.title).toBe("Memory (2)")
    expect(detail!.options.title).toBe("Sat Oct 17 2026  Fix the bug")
    expect(detail!.options.options.map((option: any) => option.category)).toEqual(["Tree", "Tree", "Tree", "Tree", "Tree", "Tree", "Tree", "Parts", "Lesson"])
    expect(listAgain!.options.title).toBe("Memory (2)")
    expect(detailAgain!.options.title).toBe("Sun Oct 18 2026  Add memory to courier")
    expect(listOnceMore!.options.title).toBe("Memory (2)")
    expect(fake.dialogs).toHaveLength(5)
    // Each list and each record is read anew, so a record forgotten elsewhere meanwhile is gone.
    expect(fake.reads()).toHaveLength(5)
    expect(fake.sizes).toHaveLength(5)
  })

  test("x on a row asks to confirm, then forgets the record through the RPC and lists what is left; none left closes it", async () => {
    const fake = fakeContext([newest, older])
    fake.answers.push(press("x", "Fix the bug"), yes, press("x", "Add memory"), yes)
    await addMemoryView(fake.context).open()

    const [first, second] = fake.confirms()
    expect(first!.options).toEqual({ title: "Forget record", message: forgetMessage(older, false), label: { confirm: "Forget", cancel: "Keep" } })
    expect(second!.options.message).toBe(forgetMessage(newest, false))
    expect(fake.forgets()).toEqual([
      { method: "forget", input: { sessionID: "ses_old", lesson: false }, options: { location: { directory: "/project" } } },
      { method: "forget", input: { sessionID: "ses_root", lesson: false }, options: { location: { directory: "/project" } } },
    ])
    expect(fake.selects().map((one) => one.options.title)).toEqual(["Memory (2)", "Memory (1)"])
    expect(fake.selects()[1]!.options.options.map((option: any) => option.title)).toEqual(["Add memory to courier (this session)"])
    expect(fake.toasts).toEqual([
      { title: "courier", message: 'Forgot the record of "Fix the bug"', variant: "success" },
      { title: "courier", message: 'Forgot the record of "Add memory to courier"', variant: "success" },
      { title: "courier", message: NO_RECORDS, variant: "info" },
    ])
    // The confirm closed itself, and the empty project shows no dialog of its own.
    expect(fake.dialogs.at(-1)!.kind).toBe("confirm")
  })

  test("after a forget the cursor is on the record that followed it, or the one before it for the last; the first list has none", async () => {
    const fake = fakeContext([newest, older, oldest])
    fake.answers.push(press("x", "Fix the bug"), yes, press("x", "Bump the pin"), yes, escape)
    await addMemoryView(fake.context).open()

    const [first, second, third] = fake.selects()
    expect("current" in first!.options).toBe(false)
    expect(second!.options.options.map((option: any) => option.value.sessionID)).toEqual(["ses_root", "ses_oldest"])
    expect(second!.options.current).toBe(oldest)
    expect(third!.options.current).toBe(newest)
  })

  test("after a forget, a neighbour gone meanwhile is passed over for the next nearest", async () => {
    const fake = fakeContext([newest, older, oldest])
    // Another TUI forgets the record after it while the confirm is open.
    fake.answers.push(press("x", "Fix the bug"), () => {
      fake.state.records = [newest, older]
      return true
    }, escape)
    await addMemoryView(fake.context).open()
    expect(fake.selects()[1]!.options.current).toBe(newest)
  })

  test("after a keep the cursor is on the record kept", async () => {
    const fake = fakeContext([newest, older, oldest])
    fake.answers.push(press("x", "Fix the bug"), no, escape)
    await addMemoryView(fake.context).open()
    expect(fake.selects()[1]!.options.current).toBe(older)
  })

  test("keep on the confirm forgets nothing and shows the list again", async () => {
    const fake = fakeContext([newest, older])
    fake.answers.push(press("x", "Add memory"), no, press("x"), escape, escape)
    await addMemoryView(fake.context).open()

    expect(fake.forgets()).toEqual([])
    expect(fake.confirms()).toHaveLength(2)
    expect(fake.selects().map((one) => one.options.title)).toEqual(["Memory (2)", "Memory (2)", "Memory (2)"])
    expect(fake.toasts).toEqual([])
  })

  test("x on the lesson of a record in full forgets only the lesson, and shows the record again without it", async () => {
    const fake = fakeContext([newest, older])
    fake.state.forgotten = { outcome: "lesson" }
    fake.answers.push(pick("Add memory"), press("x", "The docs part"), yes, escape, escape)
    await addMemoryView(fake.context).open()

    expect(fake.confirms()[0]!.options).toEqual({ title: "Forget lesson", message: forgetMessage(newest, true), label: { confirm: "Forget", cancel: "Keep" } })
    expect(fake.forgets()).toEqual([{ method: "forget", input: { sessionID: "ses_root", lesson: true }, options: { location: { directory: "/project" } } }])
    const [, detail, detailAgain, list] = fake.selects()
    expect(detail!.options.options.map((option: any) => option.title)).toContain("lesson (2026-10-18)")
    expect(detailAgain!.options.title).toBe("Sun Oct 18 2026  Add memory to courier")
    expect(detailAgain!.options.options.filter((option: any) => option.category === "Lesson").map((option: any) => option.title)).toEqual(["No lesson"])
    expect(list!.options.title).toBe("Memory (2)")
    expect(fake.toasts).toEqual([{ title: "courier", message: 'Forgot the lesson of "Add memory to courier"; its facts stay', variant: "success" }])
    // The record shown again is on the row that replaced the lesson, and back in the list on its own row.
    expect("current" in detail!.options).toBe(false)
    expect(detailAgain!.options.current).toEqual({ kind: "fact", key: "lesson" })
    expect(list!.options.current).toEqual({ ...newest, lesson: undefined })
  })

  test("keep on the lesson of a record in full shows the record again on the row under the cursor", async () => {
    const fake = fakeContext([newest, older])
    fake.answers.push(pick("Add memory"), press("x", "The docs part"), no, escape, escape)
    await addMemoryView(fake.context).open()

    expect(fake.forgets()).toEqual([])
    const [, detail, detailAgain, list] = fake.selects()
    expect(detailAgain!.options.title).toBe(detail!.options.title)
    expect(detailAgain!.options.current).toEqual({ kind: "lesson", row: 1 })
    expect(list!.options.current).toBe(newest)
  })

  test("x on any other row of a record in full forgets the record, and goes back to the list", async () => {
    const fake = fakeContext([newest, older])
    fake.answers.push(pick("Add memory"), press("x", "Docs"), yes, escape)
    await addMemoryView(fake.context).open()

    expect(fake.confirms()[0]!.options.title).toBe("Forget record")
    expect(fake.forgets()).toEqual([{ method: "forget", input: { sessionID: "ses_root", lesson: false }, options: { location: { directory: "/project" } } }])
    expect(fake.selects().map((one) => one.options.title)).toEqual(["Memory (2)", "Sun Oct 18 2026  Add memory to courier", "Memory (1)"])
    expect(fake.selects()[2]!.options.current).toBe(older)
  })

  test("keep on any other row of a record in full stays in the record, on that row", async () => {
    const fake = fakeContext([newest, older])
    fake.answers.push(pick("Add memory"), press("x", "Docs"), no, escape, escape)
    await addMemoryView(fake.context).open()

    expect(fake.forgets()).toEqual([])
    const [, , detailAgain] = fake.selects()
    expect(detailAgain!.options.title).toBe("Sun Oct 18 2026  Add memory to courier")
    expect(detailAgain!.options.current).toEqual({ kind: "part", sessionID: "ses_docs" })
  })

  test("a record already gone, or a forget the server refuses, is said in a toast, and the list goes on", async () => {
    const gone = fakeContext([newest])
    gone.state.forgotten = { outcome: "none" }
    gone.answers.push(press("x"), yes, escape)
    await addMemoryView(gone.context).open()
    expect(gone.toasts).toEqual([{ title: "courier", message: 'Nothing to forget for "Add memory to courier": it was already gone', variant: "warning" }])
    expect(gone.selects()).toHaveLength(2)

    const refused = fakeContext([newest])
    refused.state.forgetError = new Error("rpc.unavailable")
    refused.answers.push(press("x"), yes, escape)
    await addMemoryView(refused.context).open()
    expect(refused.toasts).toEqual([{ title: "courier", message: "Not forgotten: rpc.unavailable", variant: "error" }])
    expect(refused.selects()).toHaveLength(2)
  })

  test("esc on a record goes back to the list, and esc on the list closes it, reading nothing more", async () => {
    const list = fakeContext([newest])
    list.answers.push(escape)
    await addMemoryView(list.context).open()
    expect(list.selects()).toHaveLength(1)
    expect(list.reads()).toHaveLength(1)

    const detail = fakeContext([newest])
    detail.answers.push(pick("Add memory"), escape, escape)
    await addMemoryView(detail.context).open()
    const [first, record, back] = detail.selects()
    expect([first, record, back].map((one) => one!.options.title)).toEqual(["Memory (1)", "Sun Oct 18 2026  Add memory to courier", "Memory (1)"])
    expect(record!.options.actions.map((action: any) => action.bind)).toEqual(["x", "p"])
    expect(detail.dialogs).toHaveLength(3)
    expect(detail.reads()).toHaveLength(3)
  })

  test("p on a row pins the record through the RPC, without a confirm; the list is read again with it under Pinned and the cursor on it; p again unpins it (#285)", async () => {
    const fake = fakeContext([todays, yesterdays])
    fake.answers.push(press("p", "Fix the bug"), press("p", "Fix the bug"), escape)
    await addMemoryView(fake.context).open()

    expect(fake.confirms()).toEqual([])
    expect(fake.pins()).toEqual([
      { method: "pin", input: { sessionID: "ses_old", pinned: true }, options: { location: { directory: "/project" } } },
      { method: "pin", input: { sessionID: "ses_old", pinned: false }, options: { location: { directory: "/project" } } },
    ])
    const [first, second, third] = fake.selects()
    expect(first!.options.options.map((option: any) => [option.category, option.title])).toEqual([
      [TODAY, "Add memory to courier (this session)"],
      [yesterday, "Fix the bug"],
    ])
    expect(second!.options.options.map((option: any) => [option.category, option.title])).toEqual([
      [PINNED, "Fix the bug"],
      [TODAY, "Add memory to courier (this session)"],
    ])
    expect(second!.options.current).toEqual({ ...yesterdays, pinned: { at: NOW } })
    expect(third!.options.options.map((option: any) => option.category)).toEqual([TODAY, yesterday])
    expect(third!.options.current).toEqual(yesterdays)
    expect(fake.toasts).toEqual([
      { title: "courier", message: 'Pinned "Fix the bug": listed first, never swept', variant: "success" },
      { title: "courier", message: 'Unpinned "Fix the bug": kept as the others are', variant: "success" },
    ])
    expect(fake.reads()).toHaveLength(3)
  })

  test("p in a record in full pins it and shows the record again on the same row, its footer then offering unpin", async () => {
    const fake = fakeContext([newest, older])
    fake.answers.push(pick("Fix the bug"), press("p", "Top session"), escape, escape)
    await addMemoryView(fake.context).open()

    expect(fake.pins()).toEqual([{ method: "pin", input: { sessionID: "ses_old", pinned: true }, options: { location: { directory: "/project" } } }])
    const [, detail, detailAgain, list] = fake.selects()
    expect(detail!.options.actions.map((action: any) => [action.bind, action.title])).toEqual([
      ["x", "forget"],
      ["p", "pin"],
    ])
    expect(detailAgain!.options.title).toBe(detail!.options.title)
    expect(detailAgain!.options.current).toEqual({ kind: "fact", key: "top" })
    expect(detailAgain!.options.actions.map((action: any) => [action.bind, action.title])).toEqual([
      ["x", "forget"],
      ["p", "unpin"],
    ])
    expect(detailAgain!.options.options.find((option: any) => option.value.key === "pinned").title).toBe("Pinned")
    expect(list!.options.current).toEqual({ ...older, pinned: { at: NOW } })
  })

  test("a record already gone, or a pin the server refuses, is said in a toast, and the list goes on", async () => {
    const gone = fakeContext([newest])
    gone.state.pinned = { outcome: "none" }
    gone.answers.push(press("p"), escape)
    await addMemoryView(gone.context).open()
    expect(gone.toasts).toEqual([{ title: "courier", message: 'Nothing to pin for "Add memory to courier": it was already gone', variant: "warning" }])
    expect(gone.selects()).toHaveLength(2)

    const refused = fakeContext([{ ...newest, pinned: { at: NOW } }])
    refused.state.pinError = new Error("rpc.unavailable")
    refused.answers.push(press("p"), escape)
    await addMemoryView(refused.context).open()
    expect(refused.pins()[0]!.input).toEqual({ sessionID: "ses_root", pinned: false })
    expect(refused.toasts).toEqual([{ title: "courier", message: "Not unpinned: rpc.unavailable", variant: "error" }])
    expect(refused.selects()).toHaveLength(2)
  })

  test("is opened by its command, from the palette, once at a time", async () => {
    const fake = fakeContext([newest])
    const view = addMemoryView(fake.context)
    const command = fake.layers.flatMap((layer) => layer().commands).find((one: any) => one.id === MEMORY_COMMAND)
    expect(command).toMatchObject({ title: "Courier: memory", group: "Courier", palette: true })
    expect(fake.layers[0]!().mode).toBe("global")

    fake.answers.push(escape)
    command.run()
    await view.open()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fake.reads()).toHaveLength(1)
    expect(fake.selects()).toHaveLength(1)
  })
})
