// The memory view (#262), the memory module's TUI part: the project's tree records in a dialog, against a fake TUI
// context whose dialogs a test answers, and whose footer actions a test presses.
import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { Forgotten, MemoryRecord, Records } from "../src/memory/rpc.js"
import {
  addMemoryView,
  costOf,
  detailOptions,
  LESSON_LINE_MAX,
  forgetMessage,
  forgottenLine,
  LESSON_ROW,
  MEMORY_COMMAND,
  MEMORY_OFF,
  NO_RECORDS,
  partLine,
  partsCounted,
  recordDescription,
  recordDetails,
  recordTitle,
  wrap,
} from "../src/memory/tui.js"

const NOW = Date.UTC(2026, 9, 17, 10, 54)

const lesson = { text: "The docs part was ten lines; next time do it yourself.", at: Date.UTC(2026, 9, 17, 11, 30) }

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

type Dialog = { kind: "select" | "confirm" | "alert" | "prompt"; options: any }

/** An answer that presses a footer action and leaves the dialog open. */
const HOLD = Symbol("hold")

/**
 * A fake TUI context with the open session `ses_root`: the memory's RPC answers `state.records` and `state.forgotten`,
 * and each dialog is answered by the next of `answers`, which backs out once they run out.
 */
function fakeContext(records: ReadonlyArray<MemoryRecord>, { memory = true, location = { directory: "/workspace" } }: { memory?: boolean; location?: { directory: string } | null } = {}) {
  const state = { records: [...records] as MemoryRecord[], memory, forgotten: { outcome: "record" } as Forgotten, readError: undefined as unknown, forgetError: undefined as unknown }
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

  test("a row: the day the tree started and its title, the open session's own marked; its parts, duration and cost; its lesson on the line under it", () => {
    expect(recordTitle(newest, "ses_root")).toBe("2026-10-17  Add memory to courier (this session)")
    expect(recordTitle(newest, "ses_other")).toBe("2026-10-17  Add memory to courier")
    expect(recordTitle({ ...older, title: "" })).toBe("2026-10-16  ses_old")
    // Within the 61 characters the host's row keeps of a title, "(this session)" included.
    expect(recordTitle({ ...newest, title: "x".repeat(80) }, "ses_root")).toBe(`2026-10-17  ${"x".repeat(33)}… (this session)`)
    expect(recordTitle({ ...newest, title: "x".repeat(80) }, "ses_root")).toHaveLength(61)
    expect(recordDescription(newest)).toBe("3 parts: 1 done, 1 partial, 1 out · 42 min · $1.28")
    expect(recordDescription(older)).toBe("no parts · 42 min · not finished")
    expect(recordDetails(newest)).toEqual(['lesson (2026-10-17): "The docs part was ten lines; next time do it yourself."'])
    expect(recordDetails({ ...newest, lesson: { ...lesson, depth: 1, text: "y".repeat(300) } })[0]).toHaveLength(LESSON_LINE_MAX)
    expect(recordDetails({ ...newest, lesson: { ...lesson, depth: 1, text: "y".repeat(300) } })[0]).toStartWith('lesson (2026-10-17, from depth 1): "yyyy')
    expect(recordDetails(older)).toEqual([])
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

  test("a record in full: the tree's facts, its parts indented by depth, and its lesson, in three categories", () => {
    const options = detailOptions(newest)
    expect(options.map((option) => [option.category, option.title, option.description])).toEqual([
      ["Tree", "Top session ses_root", undefined],
      ["Tree", "Started 2026-10-17 10:12 UTC", "last moved 2026-10-17 10:54 UTC, ran 42 min"],
      ["Tree", "split: 2 parts: core, docs", undefined],
      ["Tree", "Finished", "$1.28 in all"],
      ["Tree", "Recalled 2 times", "first by the top 2026-10-17 10:14 UTC"],
      ["Parts", "Core", "done · depth 1 · isolated · group wave · 9 min · $0.42 · ctx 31%"],
      ["Parts", "Docs", "partial · depth 1 · 1 min · $0.86 · 1 spawn refused"],
      ["Parts", "  Review", "out · depth 2"],
      ["Lesson", "lesson (2026-10-17)", undefined],
      ["Lesson", "The docs part was ten lines; next time do it yourself.", undefined],
    ])
    expect(options.map((option) => option.value)).toEqual([
      { kind: "fact", key: "top" },
      { kind: "fact", key: "started" },
      { kind: "fact", key: "split" },
      { kind: "fact", key: "finished" },
      { kind: "fact", key: "recalled" },
      { kind: "part", sessionID: "ses_core" },
      { kind: "part", sessionID: "ses_docs" },
      { kind: "part", sessionID: "ses_review" },
      { kind: "lesson" },
      { kind: "lesson" },
    ])
  })

  test("a record without parts, lesson or recall says so, a part's recall is by a part only, and a long lesson takes several rows", () => {
    const options = detailOptions({ ...older, recalled: { calls: 1 }, lesson: { text: "x ".repeat(100), at: lesson.at, depth: 1 } })
    expect(options.filter((option) => option.category !== "Lesson").map((option) => [option.title, option.description])).toEqual([
      ["Top session ses_old", undefined],
      ["Started 2026-10-16 10:12 UTC", "last moved 2026-10-16 10:54 UTC, ran 42 min"],
      ["not stated", undefined],
      ["Not finished", undefined],
      ["Recalled 1 time", "by a part only"],
      ["No parts", "no session was started in this tree"],
    ])
    expect(options.filter((option) => option.category === "Lesson").map((option) => option.title)).toEqual(["lesson (2026-10-17, from depth 1)", ...wrap("x ".repeat(100), LESSON_ROW)])
    expect(detailOptions(older).filter((option) => option.category === "Lesson")).toEqual([{ title: "No lesson", value: { kind: "fact", key: "lesson" }, category: "Lesson", description: "courier_note writes one line per tree" }])
    expect(detailOptions({ ...older, recalled: undefined }).find((option) => option.value.kind === "fact" && option.value.key === "recalled")!.title).toBe("Not recalled")
  })

  test("the confirm names the record and says what goes, the toast what the server did", () => {
    expect(forgetMessage(newest, false)).toBe(
      'Forget the record of "Add memory to courier" (2026-10-17, 3 parts: 1 done, 1 partial, 1 out), top session ses_root? It leaves this project\'s memory and courier_recall, its lesson with it; the sessions themselves are untouched.',
    )
    expect(forgetMessage(older, false)).toBe(
      'Forget the record of "Fix the bug" (2026-10-16, no parts), top session ses_old? It leaves this project\'s memory and courier_recall; the sessions themselves are untouched.',
    )
    expect(forgetMessage(newest, true)).toBe(
      'Forget the lesson of "Add memory to courier" (2026-10-17, 3 parts: 1 done, 1 partial, 1 out)? The record keeps its facts; courier_recall no longer lists the lesson: "The docs part was ten lines; next time do it yourself.".',
    )
    expect(forgottenLine(newest, "record")).toBe('Forgot the record of "Add memory to courier"')
    expect(forgottenLine(newest, "lesson")).toBe('Forgot the lesson of "Add memory to courier"; its facts stay')
    expect(forgottenLine(newest, "none")).toBe('Nothing to forget for "Add memory to courier": it was already gone')
  })
})

describe("the memory view", () => {
  test("lists the project's records as the RPC orders them, read at the open session's location, the open session's own marked", async () => {
    const fake = fakeContext([newest, older])
    fake.answers.push(escape)
    await addMemoryView(fake.context).open()

    expect(fake.reads()).toEqual([{ method: "records", input: {}, options: { location: { directory: "/project" } } }])
    expect(fake.sizes).toEqual([{ size: "xlarge" }])
    const list = fake.selects()[0]!.options
    expect(list.title).toBe("Memory (2)")
    expect(list.placeholder).toBe("Search")
    expect(list.options.map((option: any) => [option.title, option.description, option.details])).toEqual([
      ["2026-10-17  Add memory to courier (this session)", "3 parts: 1 done, 1 partial, 1 out · 42 min · $1.28", ['lesson (2026-10-17): "The docs part was ten lines; next time do it yourself."']],
      ["2026-10-16  Fix the bug", "no parts · 42 min · not finished", []],
    ])
    // `x` alone, so every other letter, `q` among them, goes to the search.
    expect(list.actions.map((action: any) => [action.bind, action.title, action.selection])).toEqual([["x", "forget", undefined]])
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
    expect(home.selects()[0]!.options.options[0].title).toBe("2026-10-17  Add memory to courier")

    const bare = fakeContext([newest], { location: null })
    bare.goHome()
    bare.answers.push(escape)
    await addMemoryView(bare.context).open()
    expect(bare.reads()[0]!.options).toEqual({ location: { directory: "/default" } })
  })

  test("enter shows the record in full, in its categories; enter or esc there goes back to the list", async () => {
    const fake = fakeContext([newest, older])
    fake.answers.push(pick("2026-10-16"), pick("Top session"), pick("2026-10-17"), escape, escape)
    await addMemoryView(fake.context).open()

    const [list, detail, listAgain, detailAgain, listOnceMore] = fake.selects()
    expect(list!.options.title).toBe("Memory (2)")
    expect(detail!.options.title).toBe("2026-10-16  Fix the bug")
    expect(detail!.options.options.map((option: any) => option.category)).toEqual(["Tree", "Tree", "Tree", "Tree", "Tree", "Parts", "Lesson"])
    expect(listAgain!.options.title).toBe("Memory (2)")
    expect(detailAgain!.options.title).toBe("2026-10-17  Add memory to courier")
    expect(listOnceMore!.options.title).toBe("Memory (2)")
    expect(fake.dialogs).toHaveLength(5)
    // Each list and each record is read anew, so a record forgotten elsewhere meanwhile is gone.
    expect(fake.reads()).toHaveLength(5)
    expect(fake.sizes).toHaveLength(5)
  })

  test("x on a row asks to confirm, then forgets the record through the RPC and lists what is left; none left closes it", async () => {
    const fake = fakeContext([newest, older])
    fake.answers.push(press("x", "2026-10-16"), yes, press("x", "2026-10-17"), yes)
    await addMemoryView(fake.context).open()

    const [first, second] = fake.confirms()
    expect(first!.options).toEqual({ title: "Forget record", message: forgetMessage(older, false), label: { confirm: "Forget", cancel: "Keep" } })
    expect(second!.options.message).toBe(forgetMessage(newest, false))
    expect(fake.forgets()).toEqual([
      { method: "forget", input: { sessionID: "ses_old", lesson: false }, options: { location: { directory: "/project" } } },
      { method: "forget", input: { sessionID: "ses_root", lesson: false }, options: { location: { directory: "/project" } } },
    ])
    expect(fake.selects().map((one) => one.options.title)).toEqual(["Memory (2)", "Memory (1)"])
    expect(fake.selects()[1]!.options.options.map((option: any) => option.title)).toEqual(["2026-10-17  Add memory to courier (this session)"])
    expect(fake.toasts).toEqual([
      { title: "courier", message: 'Forgot the record of "Fix the bug"', variant: "success" },
      { title: "courier", message: 'Forgot the record of "Add memory to courier"', variant: "success" },
      { title: "courier", message: NO_RECORDS, variant: "info" },
    ])
    // The confirm closed itself, and the empty project shows no dialog of its own.
    expect(fake.dialogs.at(-1)!.kind).toBe("confirm")
  })

  test("keep on the confirm forgets nothing and shows the list again", async () => {
    const fake = fakeContext([newest, older])
    fake.answers.push(press("x", "2026-10-17"), no, press("x"), escape, escape)
    await addMemoryView(fake.context).open()

    expect(fake.forgets()).toEqual([])
    expect(fake.confirms()).toHaveLength(2)
    expect(fake.selects().map((one) => one.options.title)).toEqual(["Memory (2)", "Memory (2)", "Memory (2)"])
    expect(fake.toasts).toEqual([])
  })

  test("x on the lesson of a record in full forgets only the lesson, and shows the record again without it", async () => {
    const fake = fakeContext([newest, older])
    fake.state.forgotten = { outcome: "lesson" }
    fake.answers.push(pick("2026-10-17"), press("x", "The docs part"), yes, escape, escape)
    await addMemoryView(fake.context).open()

    expect(fake.confirms()[0]!.options).toEqual({ title: "Forget lesson", message: forgetMessage(newest, true), label: { confirm: "Forget", cancel: "Keep" } })
    expect(fake.forgets()).toEqual([{ method: "forget", input: { sessionID: "ses_root", lesson: true }, options: { location: { directory: "/project" } } }])
    const [, detail, detailAgain, list] = fake.selects()
    expect(detail!.options.options.map((option: any) => option.title)).toContain("lesson (2026-10-17)")
    expect(detailAgain!.options.title).toBe("2026-10-17  Add memory to courier")
    expect(detailAgain!.options.options.filter((option: any) => option.category === "Lesson").map((option: any) => option.title)).toEqual(["No lesson"])
    expect(list!.options.title).toBe("Memory (2)")
    expect(fake.toasts).toEqual([{ title: "courier", message: 'Forgot the lesson of "Add memory to courier"; its facts stay', variant: "success" }])
  })

  test("x on any other row of a record in full forgets the record, and goes back to the list", async () => {
    const fake = fakeContext([newest, older])
    fake.answers.push(pick("2026-10-17"), press("x", "Docs"), yes, escape)
    await addMemoryView(fake.context).open()

    expect(fake.confirms()[0]!.options.title).toBe("Forget record")
    expect(fake.forgets()).toEqual([{ method: "forget", input: { sessionID: "ses_root", lesson: false }, options: { location: { directory: "/project" } } }])
    expect(fake.selects().map((one) => one.options.title)).toEqual(["Memory (2)", "2026-10-17  Add memory to courier", "Memory (1)"])
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
    detail.answers.push(pick("2026-10-17"), escape, escape)
    await addMemoryView(detail.context).open()
    const [first, record, back] = detail.selects()
    expect([first, record, back].map((one) => one!.options.title)).toEqual(["Memory (1)", "2026-10-17  Add memory to courier", "Memory (1)"])
    expect(record!.options.actions.map((action: any) => action.bind)).toEqual(["x"])
    expect(detail.dialogs).toHaveLength(3)
    expect(detail.reads()).toHaveLength(3)
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
