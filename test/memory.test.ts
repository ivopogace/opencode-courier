// The memory (#260): a record per tree, built from the roster, each session's info and messages and its report state,
// kept current by the event module, read back and noted by courier_recall, bounded per project, off with one option;
// and its lesson (#261, #269): the one line courier_note writes on it from the top or a sub-orchestrator, never a leaf,
// refused over LESSON_MAX rather than clipped.
import { describe, expect, test } from "bun:test"
import type { ToolEditor } from "../src/kernel/tool.js"
import {
  isSettled,
  isStated,
  keep,
  LESSON_MAX,
  lessonText,
  MAX_RECORDS,
  MAX_REVISIONS,
  mergeParts,
  noteRead,
  noteRecall,
  NOT_STATED,
  oneLine,
  PART_STATUSES,
  partStatus,
  pinnedFirst,
  readMemory,
  RETENTION_MS,
  sumReads,
  replacingMention,
  revise,
  splitLineOf,
  splitLinesOf,
  splitOf,
  splitProse,
  unreadPart,
  type PartRecord,
  type StoredRecord,
  type TreeRecord,
} from "../src/memory/domain.js"
import { memoryEvents, noteTurnEnd, topOf } from "../src/memory/events.js"
import { note } from "../src/memory/note.js"
import type { MemoryPorts, MemoryState, RefreshPorts } from "../src/memory/ports.js"
import { recall } from "../src/memory/recall.js"
import { refresh } from "../src/memory/record.js"
import { memoryStore, pinKey, readRecord, readsKey, recordKey } from "../src/memory/store.js"
import { sweepRecords } from "../src/memory/sweep.js"
import { age, duration, lessonLine, recallListText, recordLine } from "../src/memory/text.js"
import { addMemoryTools } from "../src/memory/tools.js"
import type { RosterEntry } from "../src/tree/domain.js"
import { childStore, wakeStore } from "../src/tree/store.js"

type Session = { created?: number; updated: number; idle?: number; cost?: number; title?: string; messages?: unknown[]; projectID?: string; directory?: string }

const NOW = 1_700_000_000_000

/** Ports over an in-memory store, with each session as given; one not given is gone. */
function fakePorts(sessions: Record<string, Session>, windows: Array<{ providerID: string; id: string; context: number }> = []) {
  const store = new Map<string, unknown>()
  const logged: string[] = []
  const gets: string[] = []
  const contexts: string[] = []
  const storage = {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => void store.set(key, JSON.parse(JSON.stringify(value))),
    remove: async (key: string) => void store.delete(key),
    scan: async ({ prefix }: { prefix: string }) => ({
      entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    }),
  }
  const known = (sessionID: string) => {
    const session = sessions[sessionID]
    if (!session) throw { _tag: "Session.NotFoundError", sessionID }
    return session
  }
  const ports = {
    storage,
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        gets.push(sessionID)
        const { created = NOW - 600_000, updated, idle, cost = 0, title = `title ${sessionID}`, projectID = "proj_1", directory = "/repo" } = known(sessionID)
        return { id: sessionID, title, cost, projectID, location: { directory }, time: { created, updated, ...(idle !== undefined ? { idle } : {}) } }
      },
      context: async ({ sessionID }: { sessionID: string }) => {
        contexts.push(sessionID)
        return known(sessionID).messages ?? []
      },
      synthetic: async () => ({ id: "msg" }),
    },
    now: () => NOW,
    log: (message: string) => void logged.push(message),
    projectID: "proj_1",
    memory: true,
    maxDepth: 3,
  }
  const state: MemoryState = {
    windows: new Map(windows.map((window) => [`${window.providerID}/${window.id}`, window])),
    off: new Set(),
    tops: new Set(),
    seen: new Set(),
  }
  return { ports: ports as unknown as MemoryPorts & RefreshPorts, store, logged, gets, contexts, state, sessions }
}

const entry = (sessionID: string, parentID: string, more: Partial<RosterEntry> = {}): RosterEntry => ({
  sessionID,
  parentID,
  title: `entry ${sessionID}`,
  directory: "/repo",
  isolated: false,
  createdAt: NOW - 300_000,
  reports: "status",
  ...more,
})

const text = (text: string) => ({ type: "assistant", id: "msg", time: { created: 1 }, content: [{ type: "text", text }] })
/** A reply OpenCode has finished, which another session's turn end reads too. */
const done = (line: string, created = 1) => ({ ...text(line), time: { created, completed: created + 1 } })
const spawnCall = (status: "completed" | "error") => ({
  type: "assistant",
  id: "msg",
  time: { created: 1 },
  content: [{ type: "tool", id: "call", name: "courier_spawn", state: { status, input: {}, ...(status === "error" ? { error: { type: "unknown", message: "Not started" } } : { content: [{ type: "text", text: "" }] }) }, time: { created: 1 } }],
})
const usage = (input: number, model = { providerID: "mock", id: "small" }) => ({
  type: "assistant",
  id: "msg",
  model,
  time: { created: 1 },
  content: [],
  tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
const SMALL = { providerID: "mock", id: "small", context: 1_000 }

/** The clock's date, as the listing shows it. */
const DAY = new Date(NOW).toISOString().slice(0, 10)

describe("readMemory", () => {
  test("is on unless false, and names a value it cannot use", () => {
    expect(readMemory(undefined)).toEqual({ memory: true, problems: [] })
    expect(readMemory({ memory: true })).toEqual({ memory: true, problems: [] })
    expect(readMemory({ memory: false })).toEqual({ memory: false, problems: [] })
    expect(readMemory({ memory: "no" })).toEqual({ memory: true, problems: ['memory must be true or false, not "no"; using true'] })
  })
})

describe("splitLineOf", () => {
  test("reads the split line as the real-model checker does: a line beginning with it after any markdown, else one holding it", () => {
    expect(splitLineOf("Looking.\n**split: 2 parts: core, docs**\nStarting.")).toBe("**split: 2 parts: core, docs**")
    expect(splitLineOf("I decided to split: no, because it is small; considered: tests, docs")).toBe("I decided to split: no, because it is small; considered: tests, docs")
    expect(splitLineOf("Nothing here.")).toBeUndefined()
    expect(splitLineOf("# split: 3 parts: a, b, c\nsplit: later")).toBe("# split: 3 parts: a, b, c")
    expect(splitLineOf("- **split: no, because small; considered: docs**")).toBe("- **split: no, because small; considered: docs**")
  })

  // #294: a stated line outranks a mention, once; only a stated line is never replaced.
  test("splitOf keeps a stated line, gives a mention up for the first stated line only, and takes either while none is recorded", () => {
    const mention = "I'll decide the split: after reading the code"
    expect([isStated("**split: 1 part: core**"), isStated(mention), isStated(NOT_STATED)]).toEqual([true, false, false])
    expect(splitOf(NOT_STATED, `${mention}\nsplit: 1 part: core`)).toBe("split: 1 part: core")
    expect(splitOf(NOT_STATED, mention)).toBe(mention)
    expect(splitOf(NOT_STATED, "Reading.")).toBe(NOT_STATED)
    expect(splitOf(mention, "I decided to split: no\n- split: 1 part: core\nsplit: 2 parts")).toBe("- split: 1 part: core")
    expect(splitOf(mention, "I decided to split: no")).toBe(mention)
    expect(splitOf(mention, "")).toBe(mention)
    expect(splitOf("split: 1 part: core", "split: 2 parts\nI decided to split: no")).toBe("split: 1 part: core")
  })
})

// #282: the stored line keeps its markdown; only the listing reads it as prose.
describe("splitProse", () => {
  test("splitProse drops the block marks, the bold and italic asterisks, and a code or underscore span wrapping the whole line", () => {
    expect(splitProse("**split: 2 parts: core, docs**")).toBe("split: 2 parts: core, docs")
    expect(splitProse("- **split: no, because small; considered: docs**")).toBe("split: no, because small; considered: docs")
    expect(splitProse("* **split:** no, because small")).toBe("split: no, because small")
    expect(splitProse("**Decision:** split: no, because *small*")).toBe("Decision: split: no, because small")
    expect(splitProse("**split: no**.")).toBe("split: no.")
    expect(splitProse("split: 2 parts (**core**, *docs*): `a`")).toBe("split: 2 parts (core, docs): `a`")
    expect(splitProse("**split: no, because `src/**/text.ts` and `a*b` are one file**")).toBe("split: no, because `src/**/text.ts` and `a*b` are one file")
    expect(splitProse("1. **split:** no, because small")).toBe("split: no, because small")
    expect(splitProse("**split: no, because src/*.ts are one**")).toBe("split: no, because src/*.ts are one")
    expect(splitProse("***split: no***")).toBe("split: no")
    expect(splitProse("**split: no, because *small***")).toBe("split: no, because small")
    expect(splitProse("**a** and **b**: split: 2 parts")).toBe("a and b: split: 2 parts")
    expect(splitProse("__split: no, because snake_case__")).toBe("split: no, because snake_case")
    expect(splitProse("*Split: src/*.ts and test/*.ts*")).toBe("Split: src/*.ts and test/*.ts")
    expect(splitProse("split: 3 parts: **(core)**, **--flag**, **.github/workflows**")).toBe("split: 3 parts: (core), --flag, .github/workflows")
    expect(splitProse("_split:_ no, because small")).toBe("split: no, because small")
    expect(splitProse("__split:__ no, because small")).toBe("split: no, because small")
    expect(splitProse("`split:` no, because small")).toBe("split: no, because small")
    expect(splitProse("_split: no_")).toBe("split: no")
    expect(splitProse("Split: *one child per src/*.ts file* and more")).toBe("Split: *one child per src/*.ts file* and more")
    expect(splitProse("split: no, because\0 1\0 `x`")).toBe("split: no, because 1 `x`")
    expect(splitProse("> # `split: 3 parts: a, b, c`")).toBe("split: 3 parts: a, b, c")
    expect(splitProse("__split:\n  no, because small__ ")).toBe("split: no, because small")
    expect(splitProse("I decided to split: no, because it is small")).toBe("I decided to split: no, because it is small")
    expect(splitProse("not stated")).toBe("not stated")
  })

  test("splitProse keeps the marks that are part of the words", () => {
    for (const line of [
      "split: 2 parts: a-b, c_d",
      "split: 2 parts: src/*",
      "split: no, because only __init__",
      "split: 2 parts: `a`, `b`",
      "split: no, because it only touches `src/**/text.ts`",
      "split: 2 parts: 2 * 3 tests",
      "split: 2 parts: src/*.ts, lib/*.ts",
      "split: no, because src/**/a.ts and src/**/b.ts are untouched",
      "split: no, because `*.ts` and `*.md` are one change",
      "split: no, because a*b*c and 2**3 and 4**5 are one formula",
      "split: no, because *.ts and *.md are one change",
      "split: 2 parts: (*.ts) and (*.md)",
      "split: no, because __init__ and __main__ are one module",
      "-5 parts: split: no",
      "split: 2 parts: **/*.md and **/*.ts",
      "__init__ split: no, because one module",
      "#282 split: no, because small",
      ">5 files: split: 2 parts",
      "*.ts and src/*: split: no",
      "`a.ts`/`b.ts`",
      "**a**-**b** split: no",
      "_split: no, because snake_case_",
      "**split: 2 parts: lib/*, test/*",
      "`split: 2 parts: src/*.ts`,`lib/*.ts`",
    ])
      expect(splitProse(line)).toBe(line)
  })

  test("the listing shows a long markdown split line as prose, cut at a word, while the record keeps it as written", () => {
    const split =
      "**split: no, because the stances are a timed sequence that only my own turns can stage and hold; considered: one child per stance (but the flashes are short), a separate orchestrator session (it would only add a hop).**"
    const record = { ...stored("ses_md", NOW - 1000, { split }), projectID: "proj_1", sessionID: "ses_md" }
    expect(recordLine(record, "ses_other", NOW).split(" · ")[1]).toBe(
      "split: no, because the stances are a timed sequence that only my own turns can stage and hold; considered: one child per stance (but the flashes are short), a… [57 more characters]",
    )
    expect(record.split).toBe(split)
  })

  test("the listing shows the latest revision after the split line, as prose, with how many parts the tree had then", () => {
    const revisions = [
      { text: "split: 2 parts: a, b", at: NOW - 3000, parts: 0 },
      { text: "**split: 2 parts: its tests, its docs**", at: NOW - 2000, parts: 1 },
    ]
    const record = { ...stored("ses_staged", NOW - 1000, { split: "split: 1 part: the core", revisions }), projectID: "proj_1", sessionID: "ses_staged" }
    expect(recordLine(record, "ses_other", NOW).split(" · ").slice(1, 3)).toEqual(["split: 1 part: the core", "then, after 1 part: split: 2 parts: its tests, its docs"])
    const later = { ...record, revisions: [{ text: "split: 3 parts", at: NOW, parts: 2 }] }
    expect(recordLine(later, "ses_other", NOW)).toContain(" · split: 1 part: the core · then, after 2 parts: split: 3 parts · no parts · ")
  })
})

describe("revise", () => {
  const line = (text: string, at?: number) => (at === undefined ? { text } : { text, at })

  test("splitLinesOf takes every line beginning with split: after markdown, not one that only holds it", () => {
    expect(splitLinesOf("Looking.\n**split: 1 part: core**\nI decided to split: no\n  - split: 2 parts: a, b  ")).toEqual(["**split: 1 part: core**", "- split: 2 parts: a, b"])
  })

  test("appends each line after the last one recorded whose words differ from the line before it, with its time or the refresh's", () => {
    const previous = { split: "split: 1 part: core" }
    expect(revise(previous, [line("split: 1 part: core", 1)], 50, 0)).toBeUndefined()
    expect(revise(previous, [line("split: 1 part: core", 1), line("split: 2 parts: a, b", 2), line("**split: 2 parts: a, b**", 3), line("split: 3 parts", 4)], 50, 1)).toEqual([
      { text: "split: 2 parts: a, b", at: 2, parts: 1 },
      { text: "split: 3 parts", at: 4, parts: 1 },
    ])
    expect(revise(previous, [line("split: 2 parts: a, b")], 50, 2)).toEqual([{ text: "split: 2 parts: a, b", at: 50, parts: 2 }])
  })

  test("a re-read appends nothing, a return to an earlier line is appended, and lines no longer in the replies are kept", () => {
    const stated = [line("split: 1 part: core", 1), line("split: 2 parts: a, b", 2)]
    const once = revise({ split: "split: 1 part: core" }, stated, 50, 1)
    expect(revise({ split: "split: 1 part: core", revisions: once }, stated, 60, 2)).toEqual(once)
    const back = revise({ split: "split: 1 part: core", revisions: once }, [...stated, line("split: 1 part: core", 3)], 70, 2)
    expect(back).toEqual([...once!, { text: "split: 1 part: core", at: 3, parts: 2 }])
    expect(revise({ split: "split: 1 part: core", revisions: once }, [], 80, 2)).toEqual(once)
  })

  test("a line restated later in the replies one refresh reads does not hide the lines stated before it", () => {
    const [a, b] = ["split: 1 part: core", "split: 2 parts: a, b"]
    expect(revise({ split: a }, [line(a, 1), line(b, 2), line(a, 3)], 50, 1)).toEqual([
      { text: b, at: 2, parts: 1 },
      { text: a, at: 3, parts: 1 },
    ])
    const revisions = [{ text: b, at: 2, parts: 1 }]
    expect(revise({ split: a, revisions }, [line(a, 1), line(b, 2), line("split: 3 parts", 4), line(b, 5)], 60, 2)).toEqual([
      ...revisions,
      { text: "split: 3 parts", at: 4, parts: 2 },
      { text: b, at: 5, parts: 2 },
    ])
    // Replies read before an overlapping refresh wrote a later revision append nothing; newer ones after a compaction do.
    expect(revise({ split: a, revisions }, [line(a, 1)], 60, 2)).toEqual(revisions)
    expect(revise({ split: a, revisions }, [line(a, 1), line("split: 3 parts", 4)], 60, 2)).toEqual([...revisions, { text: "split: 3 parts", at: 4, parts: 2 }])
    expect(revise({ split: a, revisions }, [line("split: 3 parts", 4), line(b, 5)], 60, 2)).toEqual([
      ...revisions,
      { text: "split: 3 parts", at: 4, parts: 2 },
      { text: b, at: 5, parts: 2 },
    ])
    // Dated by the refresh, the line recorded last is found by its words alone.
    expect(revise({ split: a, revisions: [{ text: b, at: 50, parts: 1 }] }, [line(a), line(b)], 60, 2)).toEqual([{ text: b, at: 50, parts: 1 }])
  })

  test("keeps the newest MAX_REVISIONS, the first line untouched", () => {
    const stated = Array.from({ length: MAX_REVISIONS + 2 }, (_, i) => line(`split: ${i + 2} parts`, i))
    const revisions = revise({ split: "split: 1 part" }, stated, 50, 1)
    expect(revisions).toHaveLength(MAX_REVISIONS)
    expect(revisions!.map((one) => one.text)).toEqual(stated.slice(-MAX_REVISIONS).map((one) => one.text))
  })
})

describe("partStatus", () => {
  const known = { known: true, owes: false }
  test("is the last report's status once settled by one, how the wait ended otherwise, and out while a report is owed or nothing is known", () => {
    expect(partStatus({ stopped: false, stalled: false, report: { ...known, status: "partial" } })).toBe("partial")
    expect(partStatus({ stopped: false, stalled: false, report: known })).toBe("done")
    expect(partStatus({ stopped: false, stalled: false, report: { ...known, ended: "failed" } })).toBe("failed")
    expect(partStatus({ stopped: false, stalled: false, report: { ...known, ended: "interrupted", status: "done" } })).toBe("interrupted")
    expect(partStatus({ stopped: false, stalled: false, report: { known: true, owes: true, status: "done" } })).toBe("out")
    expect(partStatus({ stopped: false, stalled: false, report: { known: false, owes: false } })).toBe("out")
    expect(partStatus({ stopped: false, stalled: false })).toBe("out")
  })
  test("stopped comes before stalled, which comes before the report", () => {
    expect(partStatus({ stopped: true, stalled: true, report: { ...known, status: "done" } })).toBe("stopped")
    expect(partStatus({ stopped: false, stalled: true, report: { ...known, status: "done" } })).toBe("stalled")
  })
})

const part = (sessionID: string, status: PartRecord["status"] = "done", more: Partial<PartRecord> = {}): PartRecord => ({
  sessionID,
  title: `part ${sessionID}`,
  depth: 1,
  isolated: false,
  status,
  ...more,
})

describe("mergeParts", () => {
  test("keeps the parts recorded before in their order, as read now or as last recorded, then adds the new ones", () => {
    const previous = [part("a", "out"), part("b", "done"), part("c", "out")]
    const current = [part("a", "done"), part("c", "partial"), part("d", "out")]
    expect(mergeParts(previous, current).map((one) => [one.sessionID, one.status])).toEqual([["a", "done"], ["b", "done"], ["c", "partial"], ["d", "out"]])
    expect(mergeParts([], current)).toEqual(current)
  })
})

describe("unreadPart", () => {
  test("keeps the last title, duration and cost; settles a gone part as read, else as last recorded, else as gone", () => {
    const read = part("a", "out", { title: "entry a" })
    const last = part("a", "done", { duration: 30_000, cost: 0.1 })
    expect(unreadPart(read, last, true)).toEqual(last)
    expect(unreadPart(part("a", "interrupted"), last, true)).toEqual({ ...last, status: "interrupted" })
    expect(unreadPart(read, { ...last, status: "stalled" }, true)).toEqual({ ...last, status: "gone" })
    expect(unreadPart(read, undefined, true)).toEqual({ ...read, status: "gone" })
    expect(unreadPart(read, last, false)).toEqual({ ...last, status: "out" })
    expect(PART_STATUSES.filter((status) => !isSettled(status))).toEqual(["stalled", "out"])
  })
})

describe("noteRecall", () => {
  test("counts every call, and keeps the top's first as when", () => {
    expect(noteRecall(undefined, false, 10)).toEqual({ calls: 1 })
    expect(noteRecall({ calls: 1 }, true, 20)).toEqual({ at: 20, calls: 2 })
    expect(noteRecall({ at: 20, calls: 2 }, true, 30)).toEqual({ at: 20, calls: 3 })
    expect(noteRecall({ at: 20, calls: 3 }, false, 40)).toEqual({ at: 20, calls: 4 })
  })
})

const stored = (sessionID: string, movedAt: number, more: Partial<StoredRecord> = {}): StoredRecord => ({
  projectID: "proj_1",
  sessionID,
  startedAt: movedAt - 1000,
  movedAt,
  title: `tree ${sessionID}`,
  split: "not stated",
  finished: true,
  parts: [],
  ...more,
})

describe("keep", () => {
  test("keeps the newest MAX_RECORDS by when each last moved, none older than RETENTION_MS", () => {
    const records = Array.from({ length: MAX_RECORDS + 2 }, (_, i) => stored(`ses_${i}`, NOW - i * 1000))
    const { kept, dropped } = keep(records, NOW)
    expect(kept).toHaveLength(MAX_RECORDS)
    expect(kept[0]!.sessionID).toBe("ses_0")
    expect(dropped.map((record) => record.sessionID)).toEqual([`ses_${MAX_RECORDS}`, `ses_${MAX_RECORDS + 1}`])
    const old = [stored("ses_new", NOW - RETENTION_MS), stored("ses_old", NOW - RETENTION_MS - 1)]
    expect(keep(old, NOW).kept.map((record) => record.sessionID)).toEqual(["ses_new"])
  })

  test("keeps a pinned record whatever its age and outside the cap, and within the cap a record with a lesson before one without (#285)", () => {
    const lesson = { text: "Give the docs to one session", at: NOW }
    const pinned = stored("ses_pinned", NOW - RETENTION_MS - 86_400_000, { pinned: { at: NOW } })
    const lessoned = stored("ses_lesson", NOW - MAX_RECORDS * 2000, { lesson })
    const plain = Array.from({ length: MAX_RECORDS }, (_, i) => stored(`ses_${i}`, NOW - i * 1000))
    const { kept, dropped } = keep([...plain, lessoned, pinned], NOW)
    expect(kept).toHaveLength(MAX_RECORDS + 1)
    expect(kept.map((record) => record.sessionID)).toContain("ses_pinned")
    expect(kept.map((record) => record.sessionID)).toContain("ses_lesson")
    expect(dropped.map((record) => record.sessionID)).toEqual([`ses_${MAX_RECORDS - 1}`])
    // A lesson does not keep a record past RETENTION_MS: that is what the pin is for.
    expect(keep([stored("ses_stale", NOW - RETENTION_MS - 1, { lesson })], NOW).dropped).toHaveLength(1)
    // Stale records with a lesson take no slot from a live record without one.
    const stale = Array.from({ length: MAX_RECORDS }, (_, i) => stored(`ses_stale_${i}`, NOW - RETENTION_MS - 1 - i, { lesson }))
    expect(keep([...stale, stored("ses_live", NOW)], NOW).kept.map((record) => record.sessionID)).toEqual(["ses_live"])
  })
})

describe("reads", () => {
  test("noteRead counts a listing or a full read on one reader's reads, keeping the latest time", () => {
    expect(noteRead(undefined, "shown", 10)).toEqual({ shown: 1, read: 0, at: 10 })
    expect(noteRead({ shown: 1, read: 0, at: 10 }, "shown", 20)).toEqual({ shown: 2, read: 0, at: 20 })
    expect(noteRead({ shown: 2, read: 0, at: 20 }, "read", 15)).toEqual({ shown: 2, read: 1, at: 20 })
  })

  test("sumReads adds every reader's counts, the latest time theirs; none without a reader", () => {
    expect(sumReads([])).toBeUndefined()
    expect(sumReads([{ shown: 3, read: 1, at: 10 }, { shown: 4, read: 0, at: 30 }, { shown: 0, read: 2, at: 20 }])).toEqual({ shown: 7, read: 3, at: 30 })
  })

  test("pinnedFirst lists the pinned records first, each group newest first", () => {
    const records = [stored("ses_a", 10), stored("ses_b", 30, { pinned: { at: 1 } }), stored("ses_c", 20), stored("ses_d", 5, { pinned: { at: 2 } })]
    expect(pinnedFirst(records).map((record) => record.sessionID)).toEqual(["ses_b", "ses_d", "ses_c", "ses_a"])
  })
})

describe("the store", () => {
  test("reads a record written by hand leniently: defaults for what is missing, a part without a session id left out", () => {
    const record = readRecord({ title: "By hand", parts: [{ sessionID: "ses_a", status: "done", cost: 0.5, context: 0.31 }, { title: "no id" }, { sessionID: "ses_b", status: "nonsense", depth: 2.5 }] })
    expect(record).toEqual({
      startedAt: 0,
      movedAt: 0,
      title: "By hand",
      split: "not stated",
      finished: false,
      parts: [
        { sessionID: "ses_a", title: "", depth: 1, isolated: false, status: "done", cost: 0.5, context: 0.31 },
        { sessionID: "ses_b", title: "", depth: 1, isolated: false, status: "out" },
      ],
    })
    expect(readRecord({ parts: [], recalled: { calls: 2 } })).toMatchObject({ recalled: { calls: 2 } })
    expect(readRecord({ parts: [], movedAt: 7, lesson: { text: "Give the docs to one session", at: 5, depth: 2 } })).toMatchObject({ lesson: { text: "Give the docs to one session", at: 5, depth: 2 } })
    expect(readRecord({ parts: [], movedAt: 7, lesson: "  Do the docs\nyourself " })).toMatchObject({ lesson: { text: "Do the docs yourself", at: 7 } })
    expect(readRecord({ parts: [], lesson: { text: "x", at: 5, depth: 0 } })?.lesson).toEqual({ text: "x", at: 5 })
    expect(readRecord({ parts: [], lesson: { text: "x", at: 5, depth: 1.5 } })?.lesson).toEqual({ text: "x", at: 5 })
    // A hand-written lesson is clipped, as a refusal cannot reach a file; courier_note refuses one this long.
    expect(readRecord({ parts: [], lesson: { text: "y".repeat(LESSON_MAX + 1), at: 5 } })?.lesson?.text).toBe("y".repeat(LESSON_MAX))
    expect(readRecord({ parts: [], lesson: "   " })).not.toHaveProperty("lesson")
    expect(readRecord({ parts: [], lesson: { at: 5 } })).not.toHaveProperty("lesson")
    expect(readRecord({ parts: [], lesson: 7 })).not.toHaveProperty("lesson")
    expect(readRecord({ parts: [], recalled: { at: 5, calls: "two" } })).not.toHaveProperty("recalled")
    // The split line's revisions: an entry without a text, a time or a count of parts is left out, and the newest MAX_REVISIONS kept.
    const revisions = [
      { text: " split: 2 parts: a, b ", at: 5, parts: 1 },
      { text: "", at: 6, parts: 1 },
      { text: "split: x", parts: 1 },
      { text: "split: y", at: 7, parts: -1 },
      "split: z",
      { text: "split: 3 parts", at: 8, parts: 2 },
    ]
    expect(readRecord({ parts: [], revisions })?.revisions).toEqual([
      { text: "split: 2 parts: a, b", at: 5, parts: 1 },
      { text: "split: 3 parts", at: 8, parts: 2 },
    ])
    const many = Array.from({ length: MAX_REVISIONS + 1 }, (_, i) => ({ text: `split: ${i}`, at: i, parts: i }))
    expect(readRecord({ parts: [], revisions: many })?.revisions).toEqual(many.slice(1))
    expect(readRecord({ parts: [], revisions: [{ text: 7 }] })).not.toHaveProperty("revisions")
    expect(readRecord({ parts: [], revisions: "split: x" })).not.toHaveProperty("revisions")
    expect(readRecord({ title: "no parts" })).toBeUndefined()
    expect(readRecord("x")).toBeUndefined()
  })

  test("lists a project's records with their keys' ids, leaving out a value that is not a record", async () => {
    const { ports } = fakePorts({})
    const store = memoryStore(ports.storage)
    await store.put("proj_1", "ses_a", stored("ses_a", 10))
    await store.put("proj_1", "ses_b", stored("ses_b", 20))
    await store.put("proj_2", "ses_c", stored("ses_c", 30))
    await ports.storage.set(recordKey("proj_1", "ses_x"), { nothing: true })
    expect((await store.ofProject("proj_1")).map((record) => [record.projectID, record.sessionID])).toEqual([["proj_1", "ses_a"], ["proj_1", "ses_b"]])
    expect((await store.all()).map((record) => record.sessionID)).toEqual(["ses_a", "ses_b", "ses_c"])
    expect((await store.get("proj_1", "ses_a"))?.title).toBe("tree ses_a")
    expect(await store.get("proj_1", "ses_x")).toBeUndefined()
    await store.remove("proj_1", "ses_a")
    expect(await store.get("proj_1", "ses_a")).toBeUndefined()
  })

  test("reads a record with the pin and the reads beside it, summed; writes neither with the record; removes them with it (#285)", async () => {
    const { ports } = fakePorts({})
    const store = memoryStore(ports.storage)
    await store.put("proj_1", "ses_a", stored("ses_a", 10, { reads: { shown: 99, read: 99, at: 99 }, pinned: { at: 99 } }))
    expect(await ports.storage.get(recordKey("proj_1", "ses_a"))).not.toHaveProperty("reads")
    expect(await ports.storage.get(recordKey("proj_1", "ses_a"))).not.toHaveProperty("pinned")
    expect(await store.get("proj_1", "ses_a")).not.toHaveProperty("reads")

    expect(await store.noteRead("proj_1", "ses_a", "ses_r1", "shown", 20)).toEqual({ shown: 1, read: 0, at: 20 })
    expect(await store.noteRead("proj_1", "ses_a", "ses_r1", "read", 25)).toEqual({ shown: 1, read: 1, at: 25 })
    expect(await store.noteRead("proj_1", "ses_a", "ses_r2", "shown", 22)).toEqual({ shown: 1, read: 0, at: 22 })
    await store.pin("proj_1", "ses_a", { at: 30 })
    expect(await ports.storage.get(readsKey("proj_1", "ses_a", "ses_r1"))).toEqual({ shown: 1, read: 1, at: 25 })
    expect(await ports.storage.get(pinKey("proj_1", "ses_a"))).toEqual({ at: 30 })
    const read = await store.get("proj_1", "ses_a")
    expect(read).toMatchObject({ title: "tree ses_a", reads: { shown: 2, read: 1, at: 25 }, pinned: { at: 30 } })
    // The record's fields keep their order, the reads and the pin before the parts.
    expect(Object.keys(read!)).toEqual(["startedAt", "movedAt", "title", "split", "finished", "reads", "pinned", "parts"])
    expect((await store.ofProject("proj_1")).map((record): unknown[] => [record.sessionID, record.reads, record.pinned])).toEqual([["ses_a", { shown: 2, read: 1, at: 25 }, { at: 30 }]])
    // A refresh or a note writes the record it read, reads and pin included: neither reaches the storage.
    await store.put("proj_1", "ses_a", { ...read!, title: "written again" })
    expect(await store.get("proj_1", "ses_a")).toMatchObject({ title: "written again", reads: { shown: 2, read: 1, at: 25 }, pinned: { at: 30 } })
    // Any value under the pin key pins, dated 0 without a time; reads without a time, or malformed, count nothing.
    await ports.storage.set(pinKey("proj_1", "ses_a"), true as never)
    await ports.storage.set(readsKey("proj_1", "ses_a", "ses_r3"), { shown: 5 } as never)
    await ports.storage.set(readsKey("proj_1", "ses_a", "ses_r4"), { shown: -1, read: "x", at: 40 } as never)
    expect(await store.get("proj_1", "ses_a")).toMatchObject({ reads: { shown: 2, read: 1, at: 40 }, pinned: { at: 0 } })
    await store.pin("proj_1", "ses_a", undefined)
    expect(await store.get("proj_1", "ses_a")).not.toHaveProperty("pinned")

    await store.remove("proj_1", "ses_a")
    expect((await ports.storage.scan({ prefix: "memory/" })).entries).toEqual([])
  })

  test("names the trees with reads or a pin but no record, which a sweep removes", async () => {
    const { ports } = fakePorts({})
    const store = memoryStore(ports.storage)
    await store.put("proj_1", "ses_a", stored("ses_a", 10))
    await store.noteRead("proj_1", "ses_a", "ses_r", "shown", 20)
    await store.noteRead("proj_1", "ses_gone", "ses_r", "shown", 20)
    await store.pin("proj_2", "ses_gone_too", { at: 1 })
    expect(await store.strays()).toEqual([
      { projectID: "proj_1", sessionID: "ses_gone" },
      { projectID: "proj_2", sessionID: "ses_gone_too" },
    ])
    expect((await store.all()).map((record) => record.sessionID)).toEqual(["ses_a"])
  })
})

/** A tree of two children under ses_top, one reported done and idle, one still out and running, with report notes. */
async function tree(ports: RefreshPorts) {
  const children = childStore(ports.storage)
  await children.record(entry("ses_a", "ses_top", { isolated: true, group: "pair" }))
  await children.record(entry("ses_b", "ses_top", { group: "pair" }))
  await children.prompted("ses_a", NOW - 290_000)
  await children.settled("ses_a", "report", NOW - 100_000, "done")
  await children.prompted("ses_b", NOW - 290_000)
}

describe("refresh", () => {
  test("writes the record of a tree from the roster, each session's info and messages and its report state", async () => {
    const { ports, state, store } = fakePorts(
      {
        ses_top: { created: NOW - 400_000, updated: NOW - 50_000, idle: NOW - 50_000, title: "Add memory", messages: [done("Reading."), done("split: 2 parts: core, docs"), done("split: later line")] },
        ses_a: { created: NOW - 290_000, updated: NOW - 100_000, idle: NOW - 100_000, cost: 0.25, title: "Core", messages: [usage(300)] },
        ses_b: { created: NOW - 280_000, updated: NOW - 10_000, idle: NOW - 200_000, cost: 0.5, messages: [spawnCall("error"), spawnCall("completed"), spawnCall("error")] },
      },
      [SMALL],
    )
    await tree(ports)

    const record = await refresh(ports, state, "ses_top", NOW)

    expect(record).toEqual({
      startedAt: NOW - 400_000,
      movedAt: NOW,
      title: "Add memory",
      split: "split: 2 parts: core, docs",
      revisions: [{ text: "split: later line", at: 1, parts: 2 }],
      finished: false,
      parts: [
        { sessionID: "ses_a", title: "Core", depth: 1, isolated: true, group: "pair", status: "done", duration: 190_000, cost: 0.25, context: 0.3 },
        { sessionID: "ses_b", title: "title ses_b", depth: 1, isolated: false, group: "pair", status: "out", duration: 280_000, cost: 0.5, refused: 2 },
      ],
    })
    expect(store.get(recordKey("proj_1", "ses_top"))).toEqual(record)
  })

  test("reads a session OpenCode no longer knows from its entry and notes, with no duration, and a tree with nothing running and every part settled as finished", async () => {
    const { ports, state } = fakePorts({ ses_top: { updated: NOW - 50_000, idle: NOW - 50_000 } })
    const children = childStore(ports.storage)
    await children.record(entry("ses_gone", "ses_top"))
    await children.prompted("ses_gone", NOW - 290_000)
    await children.settled("ses_gone", "interrupted", NOW - 100_000)
    await children.record(entry("ses_deep", "ses_gone", { createdAt: NOW - 200_000 }))
    await children.prompted("ses_deep", NOW - 200_000)
    await children.settled("ses_deep", "report", NOW - 150_000, "partial")

    const record = await refresh(ports, state, "ses_top", NOW)

    expect(record).toMatchObject({ finished: true, split: "not stated", title: "title ses_top" })
    expect(record!.parts).toEqual([
      { sessionID: "ses_gone", title: "entry ses_gone", depth: 1, isolated: false, status: "interrupted" },
      { sessionID: "ses_deep", title: "entry ses_deep", depth: 2, isolated: false, status: "partial" },
    ])
  })

  test("keeps the last status and duration of a part whose session OpenCode deleted, so the tree reads finished (#283)", async () => {
    const { ports, state, sessions } = fakePorts({
      ses_top: { updated: NOW - 50_000, idle: NOW - 50_000 },
      ses_goner: { created: NOW - 290_000, updated: NOW - 260_000, idle: NOW - 260_000, cost: 0.1, title: "Goner" },
    })
    const children = childStore(ports.storage)
    await children.record(entry("ses_goner", "ses_top", { isolated: true }))
    await children.prompted("ses_goner", NOW - 290_000)
    await children.settled("ses_goner", "report", NOW - 260_000, "done")
    const before = (await refresh(ports, state, "ses_top", NOW))!.parts[0]
    expect(before).toEqual({ sessionID: "ses_goner", title: "Goner", depth: 1, isolated: true, status: "done", duration: 30_000, cost: 0.1 })
    // As noteDeleted leaves an isolated child: its report state forgotten, its entry kept for its worktree.
    delete sessions.ses_goner
    await children.forgetReport("ses_goner")

    const after = await refresh(ports, state, "ses_top", NOW + 60_000)
    const later = await refresh(ports, state, "ses_top", NOW + 600_000)

    expect(after).toMatchObject({ finished: true, parts: [before] })
    expect(later).toMatchObject({ finished: true, parts: [before] })
  })

  test("reads a part gone while it owed a report or stalled as gone, settled, with its last duration, on the roster or forgotten by it", async () => {
    const { ports, state, store, sessions } = fakePorts({ ses_top: { updated: NOW - 50_000, idle: NOW - 50_000 }, ses_known: { updated: NOW - 100_000, idle: NOW - 100_000 } })
    await store.set(
      recordKey("proj_1", "ses_top"),
      stored("ses_top", NOW - 1000, { finished: false, parts: [part("ses_listed", "out", { duration: 40_000 }), part("ses_dropped", "stalled", { duration: 50_000 }), part("ses_known", "out")] }),
    )
    const children = childStore(ports.storage)
    await children.record(entry("ses_listed", "ses_top", { isolated: true }))
    await children.record(entry("ses_new", "ses_top"))

    const record = await refresh(ports, state, "ses_top", NOW)

    expect(record!.parts).toEqual([
      part("ses_listed", "gone", { duration: 40_000, isolated: true }),
      part("ses_dropped", "gone", { duration: 50_000 }),
      part("ses_known", "out"),
      { sessionID: "ses_new", title: "entry ses_new", depth: 1, isolated: false, status: "gone" },
    ])
    // ses_known is forgotten by the roster but OpenCode still knows it: out as last recorded, until it is gone too.
    expect(record!.finished).toBe(false)
    delete sessions.ses_known
    expect(await refresh(ports, state, "ses_top", NOW + 1000)).toMatchObject({ finished: true, parts: [{}, {}, part("ses_known", "gone"), {}] })
  })

  test("keeps the last record of a part whose session cannot be read for another reason, without settling it", async () => {
    const { ports, state, store } = fakePorts({ ses_top: { updated: NOW - 50_000, idle: NOW - 50_000 }, ses_a: { updated: 1, idle: 1 } })
    await store.set(recordKey("proj_1", "ses_top"), stored("ses_top", NOW - 1000, { parts: [part("ses_a", "out", { duration: 40_000, cost: 0.2 })] }))
    await childStore(ports.storage).record(entry("ses_a", "ses_top"))
    const get = ports.session.get
    ;(ports.session as any).get = async (input: { sessionID: string }) => {
      if (input.sessionID === "ses_a") throw new Error("db locked")
      return get(input)
    }

    const record = await refresh(ports, state, "ses_top", NOW)

    expect(record).toMatchObject({ finished: false, parts: [part("ses_a", "out", { duration: 40_000, cost: 0.2 })] })
  })

  test("names a stopped part, a stalled one and a failed turn; a stalled part keeps the tree from reading as finished", async () => {
    const { ports, state } = fakePorts({
      ses_top: { updated: NOW - 50_000, idle: NOW - 50_000 },
      ses_stopped: { updated: NOW - 50_000, idle: NOW - 50_000 },
      ses_stalled: { updated: NOW - 50_000, idle: NOW - 50_000 },
      ses_failed: { updated: NOW - 50_000, idle: NOW - 50_000 },
    })
    const children = childStore(ports.storage)
    for (const id of ["ses_stopped", "ses_stalled", "ses_failed"]) {
      await children.record(entry(id, "ses_top"))
      await children.prompted(id, NOW - 290_000)
    }
    await children.stopped("ses_stopped", NOW - 100_000)
    await children.settled("ses_stopped", "interrupted", NOW - 100_000)
    await wakeStore(ports.storage).put({ sessionID: "ses_stalled", inboxID: "msg_1", at: NOW - 200_000, text: "t", running: false, stalled: NOW - 100_000 })
    await children.settled("ses_failed", "failed", NOW - 100_000)

    const record = await refresh(ports, state, "ses_top", NOW)

    expect(record!.parts.map((one) => one.status)).toEqual(["stopped", "stalled", "failed"])
    expect(record!.finished).toBe(false)
  })

  test("keeps a part the roster has forgotten as last recorded, its recalled note and its earlier split line, and reads the title again", async () => {
    const { ports, state, store } = fakePorts({
      ses_top: { updated: NOW - 50_000, idle: NOW - 50_000, title: "Renamed" },
      ses_b: { updated: NOW - 100_000, idle: NOW - 100_000 },
    })
    await store.set(
      recordKey("proj_1", "ses_top"),
      stored("ses_top", NOW - 1000, { title: "Old", split: "split: 2 parts: a, b", recalled: { at: 5, calls: 2 }, lesson: { text: "Keep it", at: 6 }, parts: [part("ses_a", "done", { cost: 0.1 }), part("ses_b", "out")] }),
    )
    const children = childStore(ports.storage)
    await children.record(entry("ses_b", "ses_top"))
    await children.prompted("ses_b", NOW - 290_000)
    await children.settled("ses_b", "report", NOW - 100_000, "done")

    const record = await refresh(ports, state, "ses_top", NOW)

    expect(record).toMatchObject({ title: "Renamed", split: "split: 2 parts: a, b", recalled: { at: 5, calls: 2 }, lesson: { text: "Keep it", at: 6 }, finished: true })
    expect(record!.parts.map((one) => [one.sessionID, one.status])).toEqual([["ses_a", "done"], ["ses_b", "done"]])
    expect(record!.parts[0]).toEqual(part("ses_a", "done", { cost: 0.1 }))
  })

  test("reads the messages of the part whose turn ended and of a part first seen, keeping the others' context use and refused spawns", async () => {
    const { ports, state, contexts, sessions } = fakePorts(
      {
        ses_top: { updated: NOW - 50_000, idle: NOW - 50_000, messages: [done("split: 2 parts: core, docs")] },
        ses_a: { updated: NOW - 100_000, idle: NOW - 100_000, messages: [usage(300)] },
        ses_b: { updated: NOW - 100_000, idle: NOW - 100_000, messages: [usage(400), spawnCall("error")] },
      },
      [SMALL],
    )
    await tree(ports)
    const first = await refresh(ports, state, "ses_top", NOW - 5000, "ses_a")
    expect(contexts.toSorted()).toEqual(["ses_a", "ses_b", "ses_top"])
    sessions.ses_a!.messages = [usage(600), spawnCall("error")]
    sessions.ses_b!.messages = [usage(900), spawnCall("error"), spawnCall("error")]
    await childStore(ports.storage).record(entry("ses_c", "ses_a"))
    sessions.ses_c = { updated: NOW - 100_000, messages: [usage(100)] }

    contexts.length = 0
    const record = await refresh(ports, state, "ses_top", NOW, "ses_a")

    expect(contexts.toSorted()).toEqual(["ses_a", "ses_c"])
    expect(record!.parts.map(({ sessionID, context, refused }) => [sessionID, context, refused])).toEqual([
      ["ses_a", 0.6, 1],
      ["ses_b", 0.4, 1],
      ["ses_c", 0.1, undefined],
    ])
    expect(record!.parts[1]).toEqual(first!.parts[1]!)
    expect(record!.split).toBe("split: 2 parts: core, docs")
  })

  test("reads the top's messages on its own turn end, or while its record states no split line yet, and keeps the first line once stated", async () => {
    const { ports, state, contexts, sessions } = fakePorts({
      ses_top: { updated: NOW - 50_000, idle: NOW - 50_000, messages: [text("Reading.")] },
      ses_a: { updated: NOW - 100_000, idle: NOW - 100_000 },
      ses_b: { updated: NOW - 100_000, idle: NOW - 100_000 },
    })
    await tree(ports)
    await refresh(ports, state, "ses_top", NOW - 5000, "ses_a")
    sessions.ses_top!.messages = [done("split: no, because it is small; considered: docs")]

    contexts.length = 0
    expect((await refresh(ports, state, "ses_top", NOW - 4000, "ses_a"))!.split).toBe("split: no, because it is small; considered: docs")
    expect(contexts).toEqual(["ses_top", "ses_a"])
    sessions.ses_top!.messages = [text("split: 2 parts: a, b")]

    contexts.length = 0
    expect((await refresh(ports, state, "ses_top", NOW - 3000, "ses_b"))!.split).toBe("split: no, because it is small; considered: docs")
    expect(contexts).toEqual(["ses_b"])

    // Its first reply compacted away, the top's later line is a revision beside the first, not in its place.
    contexts.length = 0
    expect(await refresh(ports, state, "ses_top", NOW, "ses_top")).toMatchObject({
      split: "split: no, because it is small; considered: docs",
      revisions: [{ text: "split: 2 parts: a, b", at: 1, parts: 2 }],
    })
    expect(contexts).toEqual(["ses_top"])
  })

  test("keeps a split line stated in the first turn and appends a different one stated after the core reported", async () => {
    const { ports, state, sessions } = fakePorts({ ses_top: { updated: NOW - 50_000, idle: NOW - 50_000, messages: [text("split: 1 part: the core")] } })
    const first = await refresh(ports, state, "ses_top", NOW - 9000, "ses_top")
    expect(first).toMatchObject({ split: "split: 1 part: the core", parts: [] })
    expect(first).not.toHaveProperty("revisions")

    const children = childStore(ports.storage)
    await children.record(entry("ses_core", "ses_top"))
    await children.prompted("ses_core", NOW - 8000)
    await children.settled("ses_core", "report", NOW - 6000, "done")
    sessions.ses_core = { updated: NOW - 6000, idle: NOW - 6000 }
    const later = { ...text("Merged.\n## split: 2 parts: its tests, its docs\nStarting."), time: { created: NOW - 5000 } }
    sessions.ses_top!.messages = [text("split: 1 part: the core"), later]
    const stage = { text: "## split: 2 parts: its tests, its docs", at: NOW - 5000, parts: 1 }

    expect(await refresh(ports, state, "ses_top", NOW - 4000, "ses_top")).toMatchObject({ split: "split: 1 part: the core", revisions: [stage] })
    // Re-reading the same replies appends nothing, and neither does a rewording of the markdown alone.
    expect((await refresh(ports, state, "ses_top", NOW - 3000, "ses_top"))!.revisions).toEqual([stage])
    sessions.ses_top!.messages = [text("split: 1 part: the core"), later, text("**split:  2 parts: its tests, its docs**"), text("I decided to split: no, after all")]
    expect((await refresh(ports, state, "ses_top", NOW - 2000, "ses_top"))!.revisions).toEqual([stage])
    // Both replies compacted away, the record keeps both lines; one more is appended, dated by the refresh without a reply time.
    sessions.ses_top!.messages = [{ type: "assistant", id: "msg", content: [{ type: "text", text: "split: 3 parts: tests, docs, e2e" }] }]
    expect(await refresh(ports, state, "ses_top", NOW, "ses_top")).toMatchObject({
      split: "split: 1 part: the core",
      revisions: [stage, { text: "split: 3 parts: tests, docs, e2e", at: NOW, parts: 1 }],
    })
  })

  // #294: a stated line outranks a mention, once, and another session's turn end reads only the top's finished replies.
  const mention = "I'll decide the split: after reading the code"

  test("a stated line replaces a mention, which is no revision; a re-read or a later mention then changes nothing", async () => {
    const { ports, state, sessions } = fakePorts({ ses_top: { updated: 1, idle: 1, messages: [text(mention)] } })
    expect(await refresh(ports, state, "ses_top", NOW - 5000, "ses_top")).toMatchObject({ split: mention })
    sessions.ses_top!.messages = [text(mention), text("split: 2 parts: core, docs")]

    const stated = await refresh(ports, state, "ses_top", NOW - 4000, "ses_top")

    expect(stated).toMatchObject({ split: "split: 2 parts: core, docs" })
    expect(stated).not.toHaveProperty("revisions")
    expect(await refresh(ports, state, "ses_top", NOW - 3000, "ses_top")).toEqual({ ...stated!, movedAt: NOW - 3000 })
    sessions.ses_top!.messages = [text(mention), text("split: 2 parts: core, docs"), text("I decided to split: no, after all")]
    expect(await refresh(ports, state, "ses_top", NOW - 2000, "ses_top")).toEqual({ ...stated!, movedAt: NOW - 2000 })
    // Its reply compacted away, the stated line stays, and a mention is not taken for it.
    sessions.ses_top!.messages = [text(mention)]
    expect(await refresh(ports, state, "ses_top", NOW, "ses_top")).toEqual({ ...stated!, movedAt: NOW })
  })

  test("of a mention and two stated lines in one read, the first stated line replaces the mention and the second is a revision", async () => {
    const { ports, state, sessions } = fakePorts({ ses_top: { updated: 1, idle: 1, messages: [text(mention)] } })
    await refresh(ports, state, "ses_top", NOW - 5000, "ses_top")
    sessions.ses_top!.messages = [text(mention), done("split: 1 part: core", 2), done("split: 2 parts: core, docs", 3)]

    expect(await refresh(ports, state, "ses_top", NOW, "ses_top")).toMatchObject({
      split: "split: 1 part: core",
      revisions: [{ text: "split: 2 parts: core, docs", at: 3, parts: 0 }],
    })
  })

  test("a mention replaced on a record written by hand keeps its revisions, and the line replacing it is not one of them", async () => {
    const { ports, state, store, sessions } = fakePorts({ ses_top: { updated: 1, idle: 1 } })
    const revisions = [{ text: "split: 3 parts", at: 5, parts: 1 }]
    await store.set(recordKey("proj_1", "ses_top"), stored("ses_top", NOW - 9000, { split: mention, revisions }))
    sessions.ses_top!.messages = [text(mention), done("split: 1 part: core", 10), done("split: 2 parts: core, docs", 11)]

    expect(await refresh(ports, state, "ses_top", NOW, "ses_top")).toMatchObject({
      split: "split: 1 part: core",
      revisions: [...revisions, { text: "split: 2 parts: core, docs", at: 11, parts: 0 }],
    })
  })

  test("a mention recorded with the stated lines as its revisions, as before #294, has the first of them as split and keeps the rest", async () => {
    const { ports, state, store, sessions } = fakePorts({ ses_top: { updated: 1, idle: 1 } })
    const [a, b] = [{ text: "split: 1 part: core", at: 2, parts: 0 }, { text: "split: 2 parts: core, docs", at: 3, parts: 1 }]
    await store.set(recordKey("proj_1", "ses_top"), stored("ses_top", NOW - 9000, { split: mention, revisions: [a] }))
    sessions.ses_top!.messages = [text(mention), done(a.text, 2)]
    const once = await refresh(ports, state, "ses_top", NOW - 5000, "ses_top")
    expect(once).toMatchObject({ split: a.text })
    expect(once).not.toHaveProperty("revisions")

    await store.set(recordKey("proj_1", "ses_top"), stored("ses_top", NOW - 9000, { split: mention, revisions: [a, b] }))
    sessions.ses_top!.messages = [text(mention), done(a.text, 2), done(b.text, 3)]
    expect(await refresh(ports, state, "ses_top", NOW - 4000, "ses_top")).toMatchObject({ split: a.text, revisions: [b] })

    // The first line's reply compacted away, the second is still among the revisions: the first is split all the same.
    await store.set(recordKey("proj_1", "ses_top"), stored("ses_top", NOW - 9000, { split: mention, revisions: [a, b] }))
    sessions.ses_top!.messages = [done(b.text, 3), done("split: 3 parts", 4)]
    expect(await refresh(ports, state, "ses_top", NOW, "ses_top")).toMatchObject({ split: a.text, revisions: [b, { text: "split: 3 parts", at: 4, parts: 0 }] })
    expect(replacingMention(`**${a.text}**`, [a, b, a])).toEqual({ split: a.text, revisions: [b, a] })
    expect(replacingMention(b.text, [a])).toEqual({ split: b.text, revisions: [a] })
    expect(replacingMention(b.text, undefined)).toEqual({ split: b.text })
  })

  test("another session's turn end reads only the top's finished replies, while its record states no split line; the top's own reads all", async () => {
    const { ports, state, sessions, contexts } = fakePorts({
      ses_top: { updated: NOW - 50_000, idle: NOW - 50_000, messages: [text("split: 2 parts: a, b")] },
      ses_a: { updated: NOW - 100_000, idle: NOW - 100_000 },
      ses_b: { updated: NOW - 100_000, idle: NOW - 100_000 },
    })
    await tree(ports)
    expect((await refresh(ports, state, "ses_top", NOW - 5000, "ses_a"))!.split).toBe(NOT_STATED)
    sessions.ses_top!.messages = [done(mention), text("split: 2 parts: a, b")]
    expect((await refresh(ports, state, "ses_top", NOW - 4000, "ses_a"))!.split).toBe(mention)

    // A mention is no stated line, so the top's replies are still read; its unfinished one waits for its own turn end.
    contexts.length = 0
    const record = await refresh(ports, state, "ses_top", NOW - 3000, "ses_b")
    expect(contexts).toContain("ses_top")
    expect(record!.split).toBe(mention)
    const own = await refresh(ports, state, "ses_top", NOW, "ses_top")
    expect(own).toMatchObject({ split: "split: 2 parts: a, b" })
    expect(own).not.toHaveProperty("revisions")
  })

  test("keeps the use another turn end's refresh wrote while this one was reading", async () => {
    const { ports, state, sessions } = fakePorts(
      { ses_top: { updated: 1, idle: 1 }, ses_a: { updated: 1, idle: 1, messages: [usage(300)] }, ses_b: { updated: 1, idle: 1, messages: [usage(400)] } },
      [SMALL],
    )
    await tree(ports)
    await refresh(ports, state, "ses_top", NOW - 5000, "ses_a")
    sessions.ses_a!.messages = [usage(600)]
    sessions.ses_b!.messages = [usage(900)]
    const get = ports.storage.get
    let reads = 0
    ;(ports.storage as any).get = async (key: string) => {
      // ses_b's refresh runs whole between ses_a's first read of the record and its read just before the write.
      if (key === recordKey("proj_1", "ses_top") && ++reads === 2) await refresh(ports, state, "ses_top", NOW - 1000, "ses_b")
      return get(key)
    }

    const record = await refresh(ports, state, "ses_top", NOW, "ses_a")

    expect(record!.parts.map(({ sessionID, context }) => [sessionID, context])).toEqual([
      ["ses_a", 0.6],
      ["ses_b", 0.9],
    ])
  })

  test("reads the top's messages before the record it writes over, so a part's refresh meanwhile is kept", async () => {
    const { ports, state, sessions } = fakePorts(
      { ses_top: { updated: 1, idle: 1, messages: [done("split: 2 parts: a, b")] }, ses_a: { updated: 1, idle: 1, messages: [usage(300)] }, ses_b: { updated: 1, idle: 1 } },
      [SMALL],
    )
    await tree(ports)
    await refresh(ports, state, "ses_top", NOW - 5000, "ses_a")
    sessions.ses_a!.messages = [usage(600)]
    const context = ports.session.context
    ;(ports.session as any).context = async (input: { sessionID: string }) => {
      // ses_a's refresh runs whole while the top's own refresh reads its messages.
      if (input.sessionID === "ses_top") await refresh(ports, state, "ses_top", NOW - 1000, "ses_a")
      return context(input)
    }

    const record = await refresh(ports, state, "ses_top", NOW, "ses_top")

    expect(record!.parts[0]).toMatchObject({ sessionID: "ses_a", context: 0.6 })
  })

  test("keeps a part's last recorded use when its messages cannot be read", async () => {
    const { ports, state } = fakePorts({ ses_top: { updated: 1, idle: 1 }, ses_a: { updated: 1, idle: 1, messages: [usage(300), spawnCall("error")] }, ses_b: { updated: 1, idle: 1 } }, [SMALL])
    await tree(ports)
    await refresh(ports, state, "ses_top", NOW - 5000, "ses_a")
    ;(ports.session as any).context = async () => {
      throw new Error("db locked")
    }

    const record = await refresh(ports, state, "ses_top", NOW, "ses_a")

    expect(record!.parts[0]).toMatchObject({ sessionID: "ses_a", context: 0.3, refused: 1 })
  })

  test("writes nothing for a top OpenCode no longer knows, or whose location has memory off, and throws another failure", async () => {
    const { ports, state, store } = fakePorts({ ses_off: { updated: 1, idle: 1, directory: "/off" } })
    state.off.add("/off")
    expect(await refresh(ports, state, "ses_gone", NOW)).toBeUndefined()
    expect(await refresh(ports, state, "ses_off", NOW)).toBeUndefined()
    expect(store.size).toBe(0)
    ;(ports.session as any).get = async () => {
      throw new Error("db locked")
    }
    await expect(refresh(ports, state, "ses_off", NOW)).rejects.toThrow("db locked")
  })
})

const ended = (sessionID: string, id = `evt_${sessionID}`, type = "session.execution.succeeded", reason?: string) => ({
  id,
  type,
  created: NOW,
  data: { sessionID, ...(reason ? { reason } : {}) },
})

describe("the event module", () => {
  test("finds the top of a spawned session by the reverse index, a session that recalled or has started sessions as its own, and none for the rest", async () => {
    const { ports, state } = fakePorts({})
    await tree(ports)
    state.tops.add("ses_recalled")
    expect(await topOf(ports, state, "ses_a")).toBe("ses_top")
    expect(await topOf(ports, state, "ses_top")).toBe("ses_top")
    expect(await topOf(ports, state, "ses_recalled")).toBe("ses_recalled")
    expect(await topOf(ports, state, "ses_other")).toBeUndefined()
  })

  test("after a turn ends in a tree, writes its record once, however many subscriptions see the event", async () => {
    const { ports, state, store } = fakePorts({
      ses_top: { updated: NOW - 50_000, idle: NOW - 50_000 },
      ses_a: { updated: NOW - 100_000, idle: NOW - 100_000 },
      ses_b: { updated: NOW - 10_000, idle: NOW - 200_000 },
    })
    await tree(ports)
    const module = memoryEvents(state)

    expect(module.handle).toBeUndefined()
    await Promise.all([module.after!(ports as never, ended("ses_a")), module.after!(ports as never, ended("ses_a"))])

    const record = readRecord(store.get(recordKey("proj_1", "ses_top")))
    expect(record?.parts.map((one) => [one.sessionID, one.status])).toEqual([["ses_a", "done"], ["ses_b", "out"]])
    expect(state.seen.has("evt_ses_a")).toBe(true)
  })

  test("reads the messages of the session whose turn ended only, once the tree's record is written", async () => {
    const { ports, state, contexts } = fakePorts({
      ses_top: { updated: NOW - 50_000, idle: NOW - 50_000, messages: [done("split: 2 parts: a, b")] },
      ses_a: { updated: NOW - 100_000, idle: NOW - 100_000 },
      ses_b: { updated: NOW - 10_000, idle: NOW - 200_000 },
    })
    await tree(ports)
    await noteTurnEnd(ports, state, ended("ses_a", "evt_1"))

    contexts.length = 0
    await noteTurnEnd(ports, state, ended("ses_b", "evt_2"))
    expect(contexts).toEqual(["ses_b"])
  })

  test("records the top's own turn ends too, and leaves a shutdown's interruption, another event and a session in no tree alone", async () => {
    const { ports, state, store, gets } = fakePorts({ ses_top: { updated: NOW, idle: NOW }, ses_a: { updated: 1, idle: 1 }, ses_b: { updated: 1, idle: 1 } })
    await tree(ports)
    const module = memoryEvents(state)

    expect(await noteTurnEnd(ports, state, ended("ses_top", "evt_1", "session.execution.interrupted", "shutdown"))).toBeUndefined()
    expect(await noteTurnEnd(ports, state, ended("ses_other", "evt_2"))).toBeUndefined()
    expect(module.after!(ports as never, { type: "session.inbox.delivered", data: { sessionID: "ses_top" } })).toBeUndefined()
    expect(store.size).toBe(7)
    expect(gets).toEqual([])

    expect(await noteTurnEnd(ports, state, ended("ses_top", "evt_3", "session.execution.interrupted", "user"))).toBe("ses_top")
    expect(readRecord(store.get(recordKey("proj_1", "ses_top")))?.movedAt).toBe(NOW)
  })

  test("logs a failure rather than throwing it, and gives the event back for the other subscription to record", async () => {
    const { ports, state, logged } = fakePorts({ ses_top: { updated: 1, idle: 1 } })
    await tree(ports)
    ;(ports.storage as any).scan = async () => {
      throw new Error("db locked")
    }

    await memoryEvents(state).after!(ports as never, ended("ses_a"))

    expect(logged).toEqual(["courier memory: could not record the tree of ses_a: Error: db locked"])
    expect(state.seen.has("evt_ses_a")).toBe(false)
  })

  test("keeps a recall noted, and a lesson written, while the refresh was reading", async () => {
    const { ports, state, store } = fakePorts({ ses_top: { updated: 1, idle: 1 }, ses_a: { updated: 1, idle: 1 }, ses_b: { updated: 1, idle: 1 } })
    await tree(ports)
    const get = ports.storage.get
    let noted = false
    ;(ports.storage as any).get = async (key: string) => {
      // The call lands once the refresh has read the record and before it writes it back.
      if (!noted && key === recordKey("proj_1", "ses_top")) {
        noted = true
        const value = await get(key)
        await recall(ports, state, "ses_top", {})
        await note(ports, "ses_top", { text: "Written meanwhile" })
        return value
      }
      return get(key)
    }

    await refresh(ports, state, "ses_top", NOW)

    expect(readRecord(store.get(recordKey("proj_1", "ses_top")))).toMatchObject({ recalled: { at: NOW, calls: 1 }, lesson: { text: "Written meanwhile", at: NOW }, movedAt: NOW })
    expect(readRecord(store.get(recordKey("proj_1", "ses_top")))?.parts).toHaveLength(2)
  })
})

describe("recall", () => {
  test("notes the top's call on its tree's record, writing one with no parts for a tree not yet started, and lists the project's records newest first", async () => {
    const { ports, state, store } = fakePorts({ ses_root: { created: NOW - 60_000, updated: NOW - 1000, title: "New task" } })
    await store.set(recordKey("proj_1", "ses_old"), stored("ses_old", NOW - 100_000, { parts: [part("ses_x", "done", { cost: 0.5, isolated: true }), part("ses_y", "failed", { refused: 1, depth: 2 })] }))
    await store.set(recordKey("proj_1", "ses_older"), stored("ses_older", NOW - 200_000))
    await store.set(recordKey("proj_2", "ses_elsewhere"), stored("ses_elsewhere", NOW))

    const result = await recall(ports, state, "ses_root", {})

    expect(result.kind).toBe("list")
    if (result.kind !== "list") throw new Error()
    expect(result.top).toBe("ses_root")
    expect(result.records.map((record) => record.sessionID)).toEqual(["ses_root", "ses_old", "ses_older"])
    expect(result.records[0]).toEqual({
      projectID: "proj_1",
      sessionID: "ses_root",
      startedAt: NOW - 60_000,
      movedAt: NOW,
      title: "New task",
      split: "not stated",
      finished: false,
      recalled: { at: NOW, calls: 1 },
      parts: [],
    })
    expect(state.tops.has("ses_root")).toBe(true)
    expect(recallListText(result.records, "ses_root", NOW)).toBe(
      [
        "2 earlier trees recorded in this project, newest first; weigh how they were split and how their parts went before you decide. " +
          "A record holds what the plugin saw, not the work, and a lesson what its orchestrator concluded, next to the facts that bear it out. " +
          "The facts are as they stood when the tree last moved: \"not finished\" with an old \"last moved\" is a stale record, not a tree running now. " +
          "courier_recall with a sessionID gives one in full, with each part's status, duration, cost and context use.",
        `- ses_root (this tree) ${DAY}: "New task" · not stated · no parts · ran 1 min · last moved 0 s ago · not finished · recalled`,
        `- ses_old ${DAY}: "tree ses_old" · not stated · 2 parts: 1 done, 1 failed, 2 levels deep, 1 isolated, 1 spawn refused · ran 1 s · last moved 2 min ago · $0.50 · finished`,
        `- ses_older ${DAY}: "tree ses_older" · not stated · no parts · ran 1 s · last moved 3 min ago · finished`,
      ].join("\n"),
    )
  })

  test("a part's call counts for its tree without marking the top as having recalled, and the second call of the top keeps its first", async () => {
    const { ports, state, store } = fakePorts({ ses_top: { updated: 1, idle: 1 }, ses_a: { updated: 1, idle: 1 }, ses_b: { updated: 1, idle: 1 } })
    await tree(ports)
    await refresh(ports, state, "ses_top", NOW - 5000)

    await recall(ports, state, "ses_a", {})
    expect(readRecord(store.get(recordKey("proj_1", "ses_top")))).toMatchObject({ recalled: { calls: 1 }, movedAt: NOW - 5000 })
    expect(readRecord(store.get(recordKey("proj_1", "ses_top")))?.recalled).not.toHaveProperty("at")

    await recall(ports, state, "ses_top", {})
    ;(ports as any).now = () => NOW + 1000
    await recall(ports, state, "ses_top", {})
    expect(readRecord(store.get(recordKey("proj_1", "ses_top")))?.recalled).toEqual({ at: NOW, calls: 3 })
    expect(recordLine({ ...(await memoryStore(ports.storage).get("proj_1", "ses_top"))!, projectID: "proj_1", sessionID: "ses_top" }, "ses_other", NOW)).toEndWith(" · recalled")
    await store.set(recordKey("proj_1", "ses_part"), stored("ses_part", 1, { recalled: { calls: 1 } }))
    expect(recordLine((await memoryStore(ports.storage).ofProject("proj_1")).find((record) => record.sessionID === "ses_part")!, "ses_other", NOW)).toEndWith(" · recalled by a part")
  })

  test("gives one record in full by its top session, or says there is none, and takes an empty sessionID for none", async () => {
    const { ports, state, store } = fakePorts({ ses_root: { updated: 1, idle: 1 } })
    await store.set(recordKey("proj_1", "ses_old"), stored("ses_old", NOW - 100_000))

    const found = await recall(ports, state, "ses_root", { sessionID: "ses_old" })
    // The read is counted on the record, and given with it.
    expect(found).toEqual({ kind: "record", projectID: "proj_1", record: { ...stored("ses_old", NOW - 100_000), reads: { shown: 0, read: 1, at: NOW } } })
    expect(await recall(ports, state, "ses_root", { sessionID: "ses_none" })).toEqual({ kind: "missing", projectID: "proj_1", sessionID: "ses_none" })
    expect((await recall(ports, state, "ses_root", { sessionID: "  " })).kind).toBe("list")
    expect((await recall(ports, state, "ses_root", { sessionID: null as never })).kind).toBe("list")
  })

  test("counts a listing on each other tree's record and a full read on the one given, under the reader's top, never on the caller's own tree (#285)", async () => {
    const { ports, state, store, logged } = fakePorts({ ses_top: { updated: 1, idle: 1 }, ses_a: { updated: 1, idle: 1 }, ses_b: { updated: 1, idle: 1 } })
    await tree(ports)
    await refresh(ports, state, "ses_top", NOW - 5000)
    await store.set(recordKey("proj_1", "ses_old"), stored("ses_old", NOW - 100_000, { pinned: { at: 1 } } as never))
    await store.set(pinKey("proj_1", "ses_old"), { at: NOW - 50_000 })
    await store.set(recordKey("proj_1", "ses_older"), stored("ses_older", NOW - 200_000))
    const memory = memoryStore(ports.storage)

    // A part's call counts under its tree's top, as the top's own does, on the other trees' records only.
    const listed = await recall(ports, state, "ses_a", {})
    if (listed.kind !== "list") throw new Error()
    expect(listed.records.map((record) => record.sessionID)).toEqual(["ses_old", "ses_top", "ses_older"])
    expect(store.get(readsKey("proj_1", "ses_old", "ses_top"))).toEqual({ shown: 1, read: 0, at: NOW })
    expect(store.get(readsKey("proj_1", "ses_older", "ses_top"))).toEqual({ shown: 1, read: 0, at: NOW })
    expect(store.has(readsKey("proj_1", "ses_top", "ses_top"))).toBe(false)
    await recall(ports, state, "ses_top", {})
    expect(store.get(readsKey("proj_1", "ses_old", "ses_top"))).toEqual({ shown: 2, read: 0, at: NOW })
    expect((await memory.get("proj_1", "ses_old"))?.reads).toEqual({ shown: 2, read: 0, at: NOW })

    // A full read counts apart, and the record is given with it; the caller's own record is given uncounted.
    const full = await recall(ports, state, "ses_top", { sessionID: "ses_old" })
    if (full.kind !== "record") throw new Error()
    expect(full.record.reads).toEqual({ shown: 2, read: 1, at: NOW })
    expect(full.record.pinned).toEqual({ at: NOW - 50_000 })
    const own = await recall(ports, state, "ses_top", { sessionID: "ses_top" })
    if (own.kind !== "record") throw new Error()
    expect(own.record).not.toHaveProperty("reads")
    expect(store.has(readsKey("proj_1", "ses_top", "ses_top"))).toBe(false)
    // Another tree's reads add to the sum; the record's own key was never written by a count.
    await recall(ports, state, "ses_b", { sessionID: "ses_old" })
    expect(store.get(readsKey("proj_1", "ses_old", "ses_top"))).toEqual({ shown: 2, read: 2, at: NOW })
    expect(readRecord(store.get(recordKey("proj_1", "ses_old")))).not.toHaveProperty("reads")
    expect(logged).toEqual([])
  })

  test("a count that cannot be written is logged, and the call still answers", async () => {
    const { ports, state, store, logged } = fakePorts({ ses_root: { updated: 1, idle: 1 } })
    await store.set(recordKey("proj_1", "ses_old"), stored("ses_old", NOW - 100_000))
    const set = ports.storage.set
    ;(ports.storage as any).set = async (key: string, value: Parameters<typeof set>[1]) => {
      if (key.includes("/reads/")) throw new Error("disk full")
      return set(key, value)
    }

    const listed = await recall(ports, state, "ses_root", {})
    expect(listed.kind).toBe("list")
    expect(logged).toEqual(["courier memory: could not count the listing of the record under ses_old: Error: disk full"])
    const full = await recall(ports, state, "ses_root", { sessionID: "ses_old" })
    if (full.kind !== "record") throw new Error()
    expect(full.record).not.toHaveProperty("reads")
    expect(logged[1]).toBe("courier memory: could not count the read of the record under ses_old: Error: disk full")
  })

  test("with the memory option off, writes and reads nothing", async () => {
    const { ports, state, store } = fakePorts({ ses_root: { updated: 1, idle: 1 } })
    ;(ports as any).memory = false

    expect(await recall(ports, state, "ses_root", {})).toEqual({ kind: "off" })
    expect(store.size).toBe(0)
    expect(state.tops.size).toBe(0)
  })
})

describe("lessonText", () => {
  test("is one line, trimmed, clipped at LESSON_MAX with the length it had, for a record written by hand", () => {
    expect(oneLine("  Give the docs\n  to one session.  ")).toBe("Give the docs to one session.")
    expect(lessonText("  Give the docs\n  to one session.  ")).toEqual({ text: "Give the docs to one session." })
    expect(lessonText("x".repeat(LESSON_MAX))).toEqual({ text: "x".repeat(LESSON_MAX) })
    expect(lessonText(`${"x".repeat(LESSON_MAX - 1)} yz`)).toEqual({ text: "x".repeat(LESSON_MAX - 1), clipped: LESSON_MAX + 2 })
    expect(lessonText(" \n ")).toEqual({ text: "" })
  })
})

describe("note", () => {
  /** A tree whose top started ses_mid, which started ses_leaf, with a record, at maxDepth 2. */
  async function recorded() {
    const made = fakePorts({ ses_top: { updated: 1, idle: 1 }, ses_mid: { updated: 1, idle: 1 }, ses_leaf: { updated: 1, idle: 1 } })
    ;(made.ports as any).maxDepth = 2
    const children = childStore(made.ports.storage)
    await children.record(entry("ses_mid", "ses_top"))
    await children.record(entry("ses_leaf", "ses_mid"))
    await refresh(made.ports, made.state, "ses_top", NOW - 5000)
    return made
  }
  const lessonOf = async (store: Map<string, unknown>) => readRecord(store.get(recordKey("proj_1", "ses_top")))?.lesson

  test("writes the top's line on its own tree's record, dated, and a second note replaces the first", async () => {
    const { ports, store } = await recorded()

    const first = await note(ports, "ses_top", { text: "  The docs part was\nten lines; do it yourself.  " })
    expect(first).toEqual({ kind: "noted", projectID: "proj_1", top: "ses_top", lesson: { text: "The docs part was ten lines; do it yourself.", at: NOW } })
    expect(await lessonOf(store)).toEqual({ text: "The docs part was ten lines; do it yourself.", at: NOW })
    expect(readRecord(store.get(recordKey("proj_1", "ses_top")))).toMatchObject({ movedAt: NOW - 5000, parts: [{ sessionID: "ses_mid" }, { sessionID: "ses_leaf" }] })
    ;(ports as any).now = () => NOW + 1000

    const second = await note(ports, "ses_top", { text: "The person chose to squash-merge." })
    expect(second).toEqual({
      kind: "noted",
      projectID: "proj_1",
      top: "ses_top",
      lesson: { text: "The person chose to squash-merge.", at: NOW + 1000 },
      replaced: { text: "The docs part was ten lines; do it yourself.", at: NOW },
    })
    expect(await lessonOf(store)).toEqual({ text: "The person chose to squash-merge.", at: NOW + 1000 })
  })

  test("writes a line at LESSON_MAX, and refuses a longer one as one line, writing nothing and keeping the earlier lesson", async () => {
    const { ports, store } = await recorded()
    await note(ports, "ses_top", { text: "The earlier lesson." })
    const before = JSON.stringify([...store])

    expect(await note(ports, "ses_top", { text: "x".repeat(LESSON_MAX + 20) })).toEqual({ kind: "long", length: LESSON_MAX + 20 })
    expect(await note(ports, "ses_top", { text: `  ${"x".repeat(LESSON_MAX - 1)}\n yz ` })).toEqual({ kind: "long", length: LESSON_MAX + 2 })
    expect(JSON.stringify([...store])).toBe(before)
    expect(await lessonOf(store)).toEqual({ text: "The earlier lesson.", at: NOW })

    const atMost = `${"x".repeat(LESSON_MAX - 2)}\n\ny`
    expect(await note(ports, "ses_top", { text: atMost })).toMatchObject({ kind: "noted", lesson: { text: `${"x".repeat(LESSON_MAX - 2)} y`, at: NOW } })
    expect((await lessonOf(store))?.text).toHaveLength(LESSON_MAX)
  })

  test("a sub-orchestrator's note goes on the same record, marked with its depth", async () => {
    const { ports, store } = await recorded()

    const result = await note(ports, "ses_mid", { text: "Seen from the middle." })
    expect(result).toEqual({ kind: "noted", projectID: "proj_1", top: "ses_top", lesson: { text: "Seen from the middle.", at: NOW, depth: 1 } })
    expect(await lessonOf(store)).toEqual({ text: "Seen from the middle.", at: NOW, depth: 1 })
    expect(lessonLine((await lessonOf(store))!)).toBe(`lesson (${DAY}, from depth 1): "Seen from the middle."`)

    expect(await note(ports, "ses_top", { text: "The top's own." })).toMatchObject({ lesson: { text: "The top's own.", at: NOW }, replaced: { depth: 1 } })
    expect(await lessonOf(store)).not.toHaveProperty("depth")
  })

  test("is refused from a leaf, with an empty text, from a tree with no record and with the option off, writing nothing", async () => {
    const { ports, store } = await recorded()
    const before = JSON.stringify([...store])

    expect(await note(ports, "ses_leaf", { text: "From the leaf" })).toEqual({ kind: "leaf", depth: 2, maxDepth: 2 })
    expect(await note(ports, "ses_top", { text: " \n " })).toEqual({ kind: "empty" })
    expect(await note(ports, "ses_top", { text: null as never })).toEqual({ kind: "empty" })
    expect(await note(ports, "ses_alone", { text: "Nowhere to put it" })).toEqual({ kind: "unrecorded", top: "ses_alone" })
    ;(ports as any).memory = false
    expect(await note(ports, "ses_top", { text: "Off" })).toEqual({ kind: "off" })
    expect(JSON.stringify([...store])).toBe(before)
  })

  test("is listed by courier_recall after the tree's facts, dated, and read back in full", async () => {
    const { ports, state, store } = await recorded()
    await note(ports, "ses_top", { text: "Give the docs to one session." })

    const listed = await recall(ports, state, "ses_other", {})
    if (listed.kind !== "list") throw new Error()
    expect(recordLine(listed.records.find((record) => record.sessionID === "ses_top")!, "ses_other", NOW)).toEndWith(
      ` · not finished · lesson (${DAY}): "Give the docs to one session."`,
    )
    const full = await recall(ports, state, "ses_other", { sessionID: "ses_top" })
    if (full.kind !== "record") throw new Error()
    expect(full.record.lesson).toEqual({ text: "Give the docs to one session.", at: NOW })
    expect(store.has(recordKey("proj_1", "ses_other"))).toBe(true)
  })
})

describe("courier_note", () => {
  function tool(ports: MemoryPorts, state: MemoryState) {
    const registered: any[] = []
    addMemoryTools({ add: (tool: unknown) => registered.push(tool) } as unknown as ToolEditor, { memory: ports, state })
    return registered.find((one) => one.name === "courier_note")
  }
  async function recorded() {
    const made = fakePorts({ ses_top: { updated: 1, idle: 1 }, ses_a: { updated: 1, idle: 1 }, ses_b: { updated: 1, idle: 1 } })
    ;(made.ports as any).maxDepth = 1
    await tree(made.ports)
    await refresh(made.ports, made.state, "ses_top", NOW - 5000)
    return made
  }

  test("says what it noted and what it replaced, with metadata holding no undefined", async () => {
    const { ports, state } = await recorded()
    const noteTool = tool(ports, state)
    const holdsNoUndefined = (value: unknown) => expect(JSON.parse(JSON.stringify(value))).toEqual(value)

    const first = await noteTool.execute({ text: "The docs part was ten lines." }, { sessionID: "ses_top" })
    expect(first.content).toStartWith(`Noted on the record of the tree under ses_top as its lesson (${DAY}): "The docs part was ten lines.". courier_recall lists it`)
    expect(first.content).toContain("AGENTS.md")
    expect(first.metadata).toEqual({ projectID: "proj_1", top: "ses_top", lesson: { text: "The docs part was ten lines.", at: NOW } })
    holdsNoUndefined(first.metadata)

    const second = await noteTool.execute({ text: "y".repeat(LESSON_MAX) }, { sessionID: "ses_top" })
    expect(second.content).toContain(`It replaces the lesson (${DAY}): "The docs part was ten lines.".`)
    expect(second.metadata).toEqual({
      projectID: "proj_1",
      top: "ses_top",
      lesson: { text: "y".repeat(LESSON_MAX), at: NOW },
      replaced: { text: "The docs part was ten lines.", at: NOW },
    })
    holdsNoUndefined(second.metadata)
  })

  test("refuses a lesson over LESSON_MAX as an error the model reads, naming its length, and keeps the earlier one", async () => {
    const { ports, state, store } = await recorded()
    const noteTool = tool(ports, state)
    await noteTool.execute({ text: "The docs part was ten lines." }, { sessionID: "ses_top" })

    await expect(noteTool.execute({ text: `${"y".repeat(LESSON_MAX)} and more` }, { sessionID: "ses_top" })).rejects.toThrow(
      `courier_note failed: Not noted: the lesson is ${LESSON_MAX + 9} characters, at most ${LESSON_MAX}; write it shorter.`,
    )
    expect(readRecord(store.get(recordKey("proj_1", "ses_top")))?.lesson).toEqual({ text: "The docs part was ten lines.", at: NOW })
  })

  test("refuses a leaf, an empty text, a tree with no record and the option off as errors the model reads", async () => {
    const { ports, state } = await recorded()
    const noteTool = tool(ports, state)

    await expect(noteTool.execute({ text: "From a leaf" }, { sessionID: "ses_a" })).rejects.toThrow(
      "courier_note failed: Not noted: this session is a leaf, at depth 1 of a session tree that goes at most 1 deep (maxDepth).",
    )
    await expect(noteTool.execute({ text: "" }, { sessionID: "ses_top" })).rejects.toThrow("courier_note failed: Not noted: text is empty.")
    await expect(noteTool.execute({ text: "x" }, { sessionID: "ses_new" })).rejects.toThrow(
      "courier_note failed: Not noted: the tree under ses_new has no record in this project to write a lesson on.",
    )
    ;(ports as any).memory = false
    await expect(noteTool.execute({ text: "x" }, { sessionID: "ses_top" })).rejects.toThrow("courier_note failed: Not noted: the plugin's memory option is false")
  })

  test("rethrows a failure as the model reads it", async () => {
    const { ports, state } = fakePorts({})
    ;(ports.storage as any).get = async () => {
      throw { _tag: "StorageError" }
    }
    await expect(tool(ports, state).execute({ text: "x" }, { sessionID: "ses_root" })).rejects.toThrow("courier_note failed: StorageError")
  })
})

describe("sweepRecords", () => {
  test("drops, per project, the records past the newest 30 and those that last moved over 90 days ago", async () => {
    const { ports } = fakePorts({})
    const store = memoryStore(ports.storage)
    for (let i = 0; i < MAX_RECORDS + 1; i++) await store.put("proj_1", `ses_${i}`, stored(`ses_${i}`, NOW - i * 1000))
    await store.put("proj_2", "ses_recent", stored("ses_recent", NOW - RETENTION_MS))
    await store.put("proj_2", "ses_stale", stored("ses_stale", NOW - RETENTION_MS - 1))

    const dropped = await sweepRecords(ports.storage, NOW)

    expect(dropped.map((record) => record.sessionID).toSorted()).toEqual([`ses_${MAX_RECORDS}`, "ses_stale"])
    expect(await store.ofProject("proj_1")).toHaveLength(MAX_RECORDS)
    expect((await store.ofProject("proj_2")).map((record) => record.sessionID)).toEqual(["ses_recent"])
  })

  test("keeps a pinned record past both bounds, drops a record's reads and pin with it, and the reads or pin of a record gone (#285)", async () => {
    const { ports } = fakePorts({})
    const store = memoryStore(ports.storage)
    await store.put("proj_1", "ses_pinned", stored("ses_pinned", NOW - RETENTION_MS - 1))
    await store.pin("proj_1", "ses_pinned", { at: NOW })
    await store.put("proj_1", "ses_stale", stored("ses_stale", NOW - RETENTION_MS - 1))
    await store.noteRead("proj_1", "ses_stale", "ses_reader", "shown", NOW)
    await store.noteRead("proj_1", "ses_forgotten", "ses_reader", "shown", NOW)
    await store.pin("proj_2", "ses_forgotten_too", { at: NOW })

    const dropped = await sweepRecords(ports.storage, NOW)

    expect(dropped.map((record) => record.sessionID)).toEqual(["ses_stale"])
    expect((await ports.storage.scan({ prefix: "memory/" })).entries.map((entry) => entry.key).toSorted()).toEqual(["memory/proj_1/ses_pinned", "memory/proj_1/ses_pinned/pin"])
  })
})

describe("duration", () => {
  test("reads in seconds under half a minute, whole minutes under an hour, hours and minutes past it", () => {
    expect(duration(12_000)).toBe("12 s")
    expect(duration(29_000)).toBe("29 s")
    expect(duration(31_000)).toBe("1 min")
    expect(duration(42 * 60_000)).toBe("42 min")
    expect(duration(125 * 60_000)).toBe("2 h 5 min")
  })
})

describe("age", () => {
  const record = (movedAt: number) => ({ projectID: "proj_1", sessionID: "ses_a", startedAt: movedAt - 32 * 60_000, movedAt, title: "T", split: "not stated", finished: false, parts: [] })

  test("reads as a duration under a day and in whole days past it", () => {
    expect(age(3 * 60_000)).toBe("3 min")
    expect(age(23 * 3_600_000 + 59 * 60_000)).toBe("23 h 59 min")
    expect(age(24 * 3_600_000)).toBe("1 day")
    expect(age(5 * 86_400_000 + 3_600_000)).toBe("5 days")
    expect(age(-5000)).toBe("0 s")
  })

  test("a listed line says how long the tree ran and, apart from it, how long ago it last moved", () => {
    expect(recordLine(record(NOW - 3 * 60_000), "ses_b", NOW)).toContain(" · ran 32 min · last moved 3 min ago · not finished")
    expect(recordLine(record(NOW - 5 * 86_400_000), "ses_b", NOW)).toContain(" · ran 32 min · last moved 5 days ago · not finished")
  })
})

describe("courier_recall", () => {
  function tool(ports: MemoryPorts, state: MemoryState) {
    const registered: any[] = []
    addMemoryTools({ add: (tool: unknown) => registered.push(tool) } as unknown as ToolEditor, { memory: ports, state })
    return registered[0]
  }

  test("returns the listing, a record, a miss or the option's state, each with metadata holding no undefined", async () => {
    const { ports, state, store } = fakePorts({ ses_root: { updated: 1, idle: 1 } })
    await store.set(recordKey("proj_1", "ses_old"), stored("ses_old", NOW - 100_000))
    const recallTool = tool(ports, state)
    const holdsNoUndefined = (value: unknown) => expect(JSON.parse(JSON.stringify(value))).toEqual(value)

    const listed = await recallTool.execute({}, { sessionID: "ses_root" })
    expect(listed.content).toContain("- ses_old ")
    expect(listed.content).toContain("- ses_root (this tree) ")
    expect(listed.content).toContain(" · last moved 2 min ago · ")
    expect(listed.content).toContain(" · last moved 0 s ago · ")
    expect(listed.metadata).toMatchObject({ projectID: "proj_1", top: "ses_root" })
    expect(listed.metadata.records.map((record: StoredRecord) => record.sessionID)).toEqual(["ses_root", "ses_old"])
    holdsNoUndefined(listed.metadata)

    const one = await recallTool.execute({ sessionID: "ses_old" }, { sessionID: "ses_root" })
    expect(one.content).toStartWith("Record of the tree under ses_old, in project proj_1")
    expect(one.content).toContain('"title": "tree ses_old"')
    expect(one.metadata.record.sessionID).toBe("ses_old")
    holdsNoUndefined(one.metadata)

    const none = await recallTool.execute({ sessionID: "ses_none" }, { sessionID: "ses_root" })
    expect(none.content).toBe("No record of a tree whose top session is ses_none in this project. courier_recall without sessionID lists the records there are.")
    expect(none.metadata).toEqual({ projectID: "proj_1", sessionID: "ses_none", found: false })

    ;(ports as any).memory = false
    const off = await recallTool.execute({}, { sessionID: "ses_root" })
    expect(off.content).toStartWith("Memory is off")
    expect(off.metadata).toEqual({ memory: false })
  })

  test("rethrows a failure as the model reads it", async () => {
    const { ports, state } = fakePorts({})
    ;(ports.storage as any).get = async () => {
      throw { _tag: "StorageError" }
    }
    await expect(tool(ports, state).execute({}, { sessionID: "ses_root" })).rejects.toThrow("courier_recall failed: StorageError")
  })

  test("the record a hand-written value gives is what the model is shown", async () => {
    const { ports, state, store } = fakePorts({ ses_root: { updated: 1, idle: 1 } })
    const seeded: TreeRecord = {
      startedAt: NOW - 3_600_000,
      movedAt: NOW - 60_000,
      title: "Seeded",
      split: "split: 3 parts: core, e2e, docs",
      finished: true,
      parts: [part("ses_core", "done", { isolated: true, group: "wave", duration: 540_000, cost: 0.42, context: 0.31 })],
    }
    await store.set(recordKey("proj_1", "ses_seed"), seeded)

    const one = await tool(ports, state).execute({ sessionID: "ses_seed" }, { sessionID: "ses_root" })
    expect(one.metadata.record).toEqual({ ...seeded, reads: { shown: 0, read: 1, at: NOW }, projectID: "proj_1", sessionID: "ses_seed" })
    expect(one.content).toContain('"reads": {')
  })

  test("the listing marks a pinned record, listed first, and says what a pin means (#285)", async () => {
    const { ports, state, store } = fakePorts({ ses_root: { updated: 1, idle: 1 } })
    await store.set(recordKey("proj_1", "ses_new"), stored("ses_new", NOW - 1000))
    await store.set(recordKey("proj_1", "ses_old"), stored("ses_old", NOW - 100_000))
    await store.set(pinKey("proj_1", "ses_old"), { at: NOW - 500 })

    const listed = await tool(ports, state).execute({}, { sessionID: "ses_root" })
    const lines: string[] = listed.content.split("\n")
    expect(lines[0]).toEndWith('A record marked "pinned" is one the person chose to keep and listed first: weigh it before the rest.')
    expect(lines.slice(1).map((line) => line.split(" ")[1])).toEqual(["ses_old", "ses_root", "ses_new"])
    expect(lines[1]).toContain(" · finished · pinned")
    expect(lines[3]).not.toContain("pinned")
    // A listing without a pinned record among the others says nothing of pins.
    await store.delete(pinKey("proj_1", "ses_old"))
    expect((await tool(ports, state).execute({}, { sessionID: "ses_root" })).content).not.toContain("pinned")
  })
})
