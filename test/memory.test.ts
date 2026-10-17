// The memory (#260): a record per tree, built from the roster, each session's info and messages and its report state,
// kept current by the event module, read back and noted by courier_recall, bounded per project, off with one option.
import { describe, expect, test } from "bun:test"
import type { ToolEditor } from "../src/kernel/tool.js"
import {
  keep,
  MAX_RECORDS,
  mergeParts,
  noteRecall,
  partStatus,
  readMemory,
  RETENTION_MS,
  splitLineOf,
  type PartRecord,
  type StoredRecord,
  type TreeRecord,
} from "../src/memory/domain.js"
import { memoryEvents, noteTurnEnd, topOf } from "../src/memory/events.js"
import type { MemoryPorts, MemoryState, RefreshPorts } from "../src/memory/ports.js"
import { recall } from "../src/memory/recall.js"
import { refresh } from "../src/memory/record.js"
import { memoryStore, readRecord, recordKey } from "../src/memory/store.js"
import { sweepRecords } from "../src/memory/sweep.js"
import { duration, recallListText, recordLine } from "../src/memory/text.js"
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
      context: async ({ sessionID }: { sessionID: string }) => known(sessionID).messages ?? [],
      synthetic: async () => ({ id: "msg" }),
    },
    now: () => NOW,
    log: (message: string) => void logged.push(message),
    projectID: "proj_1",
    memory: true,
  }
  const state: MemoryState = {
    windows: new Map(windows.map((window) => [`${window.providerID}/${window.id}`, window])),
    off: new Set(),
    tops: new Set(),
    seen: new Set(),
  }
  return { ports: ports as unknown as MemoryPorts & RefreshPorts, store, logged, gets, state, sessions }
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
    expect(readRecord({ parts: [], recalled: { at: 5, calls: "two" } })).not.toHaveProperty("recalled")
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
        ses_top: { created: NOW - 400_000, updated: NOW - 50_000, idle: NOW - 50_000, title: "Add memory", messages: [text("Reading."), text("split: 2 parts: core, docs"), text("split: later line")] },
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
      finished: false,
      parts: [
        { sessionID: "ses_a", title: "Core", depth: 1, isolated: true, group: "pair", status: "done", duration: 190_000, cost: 0.25, context: 0.3 },
        { sessionID: "ses_b", title: "title ses_b", depth: 1, isolated: false, group: "pair", status: "out", duration: 280_000, cost: 0.5, refused: 2 },
      ],
    })
    expect(store.get(recordKey("proj_1", "ses_top"))).toEqual(record)
  })

  test("reads a session OpenCode no longer knows from its entry and notes, and a tree with nothing running and every part settled as finished", async () => {
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
      { sessionID: "ses_gone", title: "entry ses_gone", depth: 1, isolated: false, status: "interrupted", duration: 300_000 },
      { sessionID: "ses_deep", title: "entry ses_deep", depth: 2, isolated: false, status: "partial", duration: 200_000 },
    ])
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
      stored("ses_top", NOW - 1000, { title: "Old", split: "split: 2 parts: a, b", recalled: { at: 5, calls: 2 }, parts: [part("ses_a", "done", { cost: 0.1 }), part("ses_b", "out")] }),
    )
    const children = childStore(ports.storage)
    await children.record(entry("ses_b", "ses_top"))
    await children.prompted("ses_b", NOW - 290_000)
    await children.settled("ses_b", "report", NOW - 100_000, "done")

    const record = await refresh(ports, state, "ses_top", NOW)

    expect(record).toMatchObject({ title: "Renamed", split: "split: 2 parts: a, b", recalled: { at: 5, calls: 2 }, finished: true })
    expect(record!.parts.map((one) => [one.sessionID, one.status])).toEqual([["ses_a", "done"], ["ses_b", "done"]])
    expect(record!.parts[0]).toEqual(part("ses_a", "done", { cost: 0.1 }))
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

  test("logs a failure rather than throwing it", async () => {
    const { ports, state, logged } = fakePorts({ ses_top: { updated: 1, idle: 1 } })
    await tree(ports)
    ;(ports.storage as any).scan = async () => {
      throw new Error("db locked")
    }

    await memoryEvents(state).after!(ports as never, ended("ses_a"))

    expect(logged).toEqual(["courier memory: could not record the tree of ses_a: Error: db locked"])
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
    expect(recallListText(result.records, "ses_root")).toBe(
      [
        "2 earlier trees recorded in this project, newest first; weigh how they were split and how their parts went before you decide. " +
          "A record holds what the plugin saw, not the work: courier_recall with a sessionID gives one in full, with each part's status, duration, cost and context use.",
        `- ses_root (this tree) ${DAY}: "New task" · not stated · no parts · 1 min · not finished · recalled`,
        `- ses_old ${DAY}: "tree ses_old" · not stated · 2 parts: 1 done, 1 failed, 2 levels deep, 1 isolated, 1 spawn refused · 1 s · $0.50 · finished`,
        `- ses_older ${DAY}: "tree ses_older" · not stated · no parts · 1 s · finished`,
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
    expect(recordLine({ ...(await memoryStore(ports.storage).get("proj_1", "ses_top"))!, projectID: "proj_1", sessionID: "ses_top" }, "ses_other")).toEndWith(" · recalled")
    await store.set(recordKey("proj_1", "ses_part"), stored("ses_part", 1, { recalled: { calls: 1 } }))
    expect(recordLine((await memoryStore(ports.storage).ofProject("proj_1")).find((record) => record.sessionID === "ses_part")!, "ses_other")).toEndWith(" · recalled by a part")
  })

  test("gives one record in full by its top session, or says there is none, and takes an empty sessionID for none", async () => {
    const { ports, state, store } = fakePorts({ ses_root: { updated: 1, idle: 1 } })
    await store.set(recordKey("proj_1", "ses_old"), stored("ses_old", NOW - 100_000))

    const found = await recall(ports, state, "ses_root", { sessionID: "ses_old" })
    expect(found).toEqual({ kind: "record", projectID: "proj_1", record: { ...stored("ses_old", NOW - 100_000) } })
    expect(await recall(ports, state, "ses_root", { sessionID: "ses_none" })).toEqual({ kind: "missing", projectID: "proj_1", sessionID: "ses_none" })
    expect((await recall(ports, state, "ses_root", { sessionID: "  " })).kind).toBe("list")
    expect((await recall(ports, state, "ses_root", { sessionID: null as never })).kind).toBe("list")
  })

  test("with the memory option off, writes and reads nothing", async () => {
    const { ports, state, store } = fakePorts({ ses_root: { updated: 1, idle: 1 } })
    ;(ports as any).memory = false

    expect(await recall(ports, state, "ses_root", {})).toEqual({ kind: "off" })
    expect(store.size).toBe(0)
    expect(state.tops.size).toBe(0)
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
    expect((await store.ofProject("proj_1")).length).toBe(MAX_RECORDS)
    expect((await store.ofProject("proj_2")).map((record) => record.sessionID)).toEqual(["ses_recent"])
  })
})

describe("duration", () => {
  test("reads in seconds under a minute, minutes under an hour, hours and minutes past it", () => {
    expect(duration(12_000)).toBe("12 s")
    expect(duration(29_000)).toBe("29 s")
    expect(duration(31_000)).toBe("1 min")
    expect(duration(42 * 60_000)).toBe("42 min")
    expect(duration(125 * 60_000)).toBe("2 h 5 min")
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
    expect(one.metadata.record).toEqual({ ...seeded, projectID: "proj_1", sessionID: "ses_seed" })
  })
})
