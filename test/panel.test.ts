// The tree panel's RPC: its rows, read as courier_tree reads the tree, and its stop, courier_stop's path.
import { describe, expect, test } from "bun:test"
import { cancelScheduled, type LaterPorts } from "../src/scheduling/index.js"
import { DEFAULT_LIMITS, type RosterEntry } from "../src/tree/domain.js"
import { holdReport, joinGroup } from "../src/tree/group.js"
import { contextOf, lastTool, panel } from "../src/tree/panel.js"
import type { CleanupPorts, CourierPorts, Pending, ShownForm, StopPorts } from "../src/tree/ports.js"
import { registerTreeRpc } from "../src/tree/rpc-handlers.js"
import { treeRpc } from "../src/tree/rpc.js"
import { childStore, groupStore, wakeStore } from "../src/tree/store.js"

type Session = { updated: number; idle?: number; outcome?: string; cost?: number; title?: string; messages?: unknown[] }
type Window = { providerID: string; id: string; context: number }

/** Ports over an in-memory store, with each session as given; one not given is gone. */
function fakePorts(
  sessions: Record<string, Session>,
  pending: Record<string, Pending[]> = {},
  maxTotal = DEFAULT_LIMITS.maxTotal,
  forms: Record<string, ShownForm[]> = {},
  windows: Window[] = [],
) {
  const store = new Map<string, unknown>()
  const calls: { method: string; input: any }[] = []
  const storage = {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => void store.set(key, value),
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
    now: () => 1_000,
    log: () => {},
    nudge: () => {},
    storage,
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const { updated, idle, outcome, cost = 0, title = `title ${sessionID}` } = known(sessionID)
        return { id: sessionID, title, cost, ...(outcome ? { outcome } : {}), time: { created: 1, updated, ...(idle !== undefined ? { idle } : {}) } }
      },
      context: async ({ sessionID }: { sessionID: string }) => known(sessionID).messages ?? [],
      interrupt: async (input: { sessionID: string }) => {
        calls.push({ method: "interrupt", input })
        known(input.sessionID)
        return { interrupted: true }
      },
      synthetic: async (input: unknown) => {
        calls.push({ method: "synthetic", input })
        return { id: "msg" }
      },
    },
    pending: async (sessionID: string) => pending[sessionID] ?? [],
    forms: async (sessionID: string) => forms[sessionID] ?? [],
    windows: async () => windows,
    limits: { ...DEFAULT_LIMITS, maxTotal },
  } as unknown as CourierPorts
  return { ports, store, calls }
}

const entry = (sessionID: string, parentID: string, more: Partial<RosterEntry> = {}): RosterEntry => ({
  sessionID,
  parentID,
  title: `entry ${sessionID}`,
  directory: "/repo",
  isolated: false,
  createdAt: 900,
  reports: "status",
  ...more,
})

const tool = (name: string, created: number, ran?: number) => ({
  type: "tool",
  id: `call_${name}`,
  name,
  state: { status: "completed", input: {}, content: [{ type: "text", text: "" }] },
  time: { created, ...(ran ? { ran } : {}) },
})

const assistant = (...content: unknown[]) => ({ type: "assistant", id: "msg", time: { created: 1 }, content })

describe("lastTool", () => {
  test("is the last tool call of the last assistant message that made one, when it ran", () => {
    const messages = [
      assistant(tool("read", 10, 11), tool("shell", 20, 22)),
      assistant({ type: "text", text: "thinking" }),
      { type: "user", id: "u", time: { created: 30 } },
    ]
    expect(lastTool(messages as any)).toEqual({ name: "shell", at: 22 })
    expect(lastTool([assistant(tool("glob", 40))] as any)).toEqual({ name: "glob", at: 40 })
    expect(lastTool([assistant({ type: "text", text: "hi" })] as any)).toBeUndefined()
  })
})

const reply = (tokens: Record<string, any> | undefined, model = { providerID: "mock", id: "small" }) => ({
  type: "assistant",
  id: "msg",
  model,
  time: { created: 1 },
  content: [],
  ...(tokens ? { tokens } : {}),
})
const usage = (input: number, output = 0, read = 0, write = 0) => ({ input, output, reasoning: 0, cache: { read, write } })
const SMALL = { providerID: "mock", id: "small", context: 1_000 }

describe("contextOf", () => {
  test("is the last message with usage over its model's window, as OpenCode's session view reads it", () => {
    const messages = [reply(usage(900)), reply(usage(100, 50, 200, 50))]
    expect(contextOf(messages as any, [SMALL])).toBe(0.4)
    expect(contextOf([...messages, reply(undefined)] as any, [SMALL])).toBe(0.4)
  })

  test("counts from the last completed compaction on", () => {
    const compaction = (status: string) => ({ type: "compaction", id: "c", status })
    expect(contextOf([reply(usage(900)), compaction("completed")] as any, [SMALL])).toBeUndefined()
    expect(contextOf([reply(usage(900)), compaction("completed"), reply(usage(100))] as any, [SMALL])).toBe(0.1)
    expect(contextOf([reply(usage(900)), compaction("running")] as any, [SMALL])).toBe(0.9)
  })

  test("is none without usage, with all-zero usage, or without a known window for the message's model", () => {
    expect(contextOf([] as any, [SMALL])).toBeUndefined()
    expect(contextOf([reply(usage(0))] as any, [SMALL])).toBeUndefined()
    expect(contextOf([reply(usage(100))] as any, [])).toBeUndefined()
    expect(contextOf([reply(usage(100))] as any, [{ ...SMALL, context: 0 }])).toBeUndefined()
    expect(contextOf([reply(usage(100), { providerID: "mock", id: "other" })] as any, [SMALL])).toBeUndefined()
  })
})

describe("panel", () => {
  test("carries a row's context use, and leaves it out when the model's window is unknown", async () => {
    const sessions = { ses_a: { updated: 5, idle: 5, messages: [reply(usage(250))] } }
    const known = fakePorts(sessions, {}, undefined, {}, [SMALL])
    await childStore(known.ports.storage).record(entry("ses_a", "ses_root"))
    expect((await panel(known.ports, "ses_root")).rows[0]?.context).toBe(0.25)
    const unknown = fakePorts(sessions)
    await childStore(unknown.ports.storage).record(entry("ses_a", "ses_root"))
    const rows = (await panel(unknown.ports, "ses_root")).rows
    expect(rows).toHaveLength(1)
    expect("context" in rows[0]!).toBe(false)
  })

  test("reads each session under the root, in the order a tree is drawn, with what it does, its report and its last tool call", async () => {
    const { ports } = fakePorts(
      {
        ses_mid: { updated: 5, cost: 0.25, title: "Mid", messages: [assistant(tool("courier_spawn", 950, 951))] },
        ses_leaf: { updated: 5, idle: 5 },
        ses_ask: { updated: 5, idle: 5 },
      },
      {
        ses_ask: [
          { type: "permission", requestID: "per_1", action: "shell", resources: ["echo hi"] },
          { type: "question", requestID: "que_1", questions: [{ question: "Which?", header: "Pick", options: [] }] },
        ],
      },
    )
    const children = childStore(ports.storage)
    await children.record(entry("ses_mid", "ses_root"))
    await children.record(entry("ses_ask", "ses_root", { isolated: true }))
    await children.record(entry("ses_leaf", "ses_mid"))
    await children.prompted("ses_mid", 900)
    await children.prompted("ses_leaf", 900)
    await children.settled("ses_leaf", "report", 960, "done")

    expect(await panel(ports, "ses_root")).toEqual({
      rows: [
        {
          sessionID: "ses_mid",
          parentID: "ses_root",
          title: "Mid",
          depth: 1,
          state: "running",
          report: { state: "owed", progressed: false },
          isolated: false,
          created: 1,
          cost: 0.25,
          tool: { name: "courier_spawn", at: 951 },
          waits: [],
        },
        {
          sessionID: "ses_leaf",
          parentID: "ses_mid",
          title: "title ses_leaf",
          depth: 2,
          state: "idle",
          report: { state: "reported", status: "done", progressed: false },
          isolated: false,
          created: 1,
          idle: 5,
          cost: 0,
          waits: [],
        },
        {
          sessionID: "ses_ask",
          parentID: "ses_root",
          title: "title ses_ask",
          depth: 1,
          state: "waiting",
          isolated: true,
          created: 1,
          idle: 5,
          cost: 0,
          waits: [
            { type: "permission", action: "shell", resources: ["echo hi"] },
            { type: "question", question: "Which?" },
          ],
        },
      ],
    })
  })

  test("names a turn that ended without a report, a group member's standing, and a session OpenCode no longer knows", async () => {
    const { ports } = fakePorts({ ses_failed: { updated: 5, idle: 5, outcome: "failed" }, ses_held: { updated: 5, idle: 5 } })
    const children = childStore(ports.storage)
    const groups = groupStore(ports.storage)
    for (const sessionID of ["ses_failed", "ses_held", "ses_gone"]) {
      await children.record(entry(sessionID, "ses_root", { group: "pair" }))
      await joinGroup(groups, "ses_root", "pair", sessionID, sessionID, 900)
      await children.prompted(sessionID, 900)
    }
    await children.settled("ses_failed", "failed", 950)
    await children.settled("ses_held", "report", 950, "partial")
    await holdReport(groups, { parentID: "ses_root", group: "pair", sessionID: "ses_held", title: "ses_held", joinedAt: 900 }, { at: 950, status: "partial", message: "Half" })

    const { rows } = await panel(ports, "ses_root")
    expect(rows.map(({ sessionID, state, outcome, report, group }) => ({ sessionID, state, outcome, report, group }))).toEqual([
      { sessionID: "ses_failed", state: "idle", outcome: "failed", report: { state: "ended", progressed: false }, group: { name: "pair", standing: "out" } },
      { sessionID: "ses_held", state: "idle", outcome: undefined, report: { state: "reported", status: "partial", progressed: false }, group: { name: "pair", standing: "held" } },
      { sessionID: "ses_gone", state: "gone", outcome: undefined, report: { state: "owed", progressed: false }, group: { name: "pair", standing: "out" } },
    ])
    expect(rows[2]).not.toHaveProperty("cost")
    expect(rows[2]!.title).toBe("entry ses_gone")
  })

  test("marks a stalled session stalled, since its oldest message woken again in vain was enqueued, and the root's own stall", async () => {
    const { ports } = fakePorts({ ses_stalled: { updated: 9, idle: 5 }, ses_root: { updated: 9, idle: 5 } })
    await childStore(ports.storage).record(entry("ses_stalled", "ses_root"))
    const wakes = wakeStore(ports.storage)
    const stalled = { text: "report", running: false, rewoken: 7, stalled: 8 }
    await wakes.put({ sessionID: "ses_stalled", inboxID: "msg_2", at: 6, ...stalled })
    await wakes.put({ sessionID: "ses_stalled", inboxID: "msg_1", at: 4, ...stalled })

    const tree = await panel(ports, "ses_root")
    expect(tree.rows.map(({ state, stalled }) => ({ state, stalled }))).toEqual([{ state: "stalled", stalled: 4 }])
    expect(tree).not.toHaveProperty("stalled")
    await wakes.put({ sessionID: "ses_root", inboxID: "msg_3", at: 3, ...stalled })
    expect((await panel(ports, "ses_root")).stalled).toBe(3)
  })

  test("says a running session showing a form waits, one line per form after its requests, and not an idle one's form, whose withdrawal was missed", async () => {
    const { ports } = fakePorts(
      { ses_form: { updated: 5 }, ses_both: { updated: 5 }, ses_stale: { updated: 5, idle: 5 } },
      { ses_both: [{ type: "permission", requestID: "per_1", action: "websearch", resources: ["*"] }] },
      DEFAULT_LIMITS.maxTotal,
      {
        ses_form: [{ id: "frm_1", title: "Web Search" }, { id: "frm_2", title: "Choose a web search provider" }],
        ses_both: [{ id: "frm_3", title: "Web Search" }],
        ses_stale: [{ id: "frm_4", title: "Web Search" }],
      },
    )
    for (const sessionID of ["ses_form", "ses_both", "ses_stale"]) await childStore(ports.storage).record(entry(sessionID, "ses_root"))

    const { rows } = await panel(ports, "ses_root")
    expect(rows.map(({ sessionID, state, waits }) => ({ sessionID, state, waits }))).toEqual([
      {
        sessionID: "ses_form",
        state: "waiting",
        waits: [
          { type: "form", title: "Web Search" },
          { type: "form", title: "Choose a web search provider" },
        ],
      },
      {
        sessionID: "ses_both",
        state: "waiting",
        waits: [
          { type: "permission", action: "websearch", resources: ["*"] },
          { type: "form", title: "Web Search" },
        ],
      },
      { sessionID: "ses_stale", state: "idle", waits: [] },
    ])
  })

  test("marks a session courier_stop stopped since its last prompt, and not one prompted again", async () => {
    const { ports } = fakePorts({ ses_stopped: { updated: 5, idle: 5, outcome: "interrupted" }, ses_again: { updated: 5, idle: 5 }, ses_plain: { updated: 5, idle: 5 } })
    const children = childStore(ports.storage)
    for (const sessionID of ["ses_stopped", "ses_again", "ses_plain"]) {
      await children.record(entry(sessionID, "ses_root"))
      await children.prompted(sessionID, 900)
    }
    await children.stopped("ses_stopped", 950)
    await children.stopped("ses_again", 950)
    await children.prompted("ses_again", 960)

    const { rows } = await panel(ports, "ses_root")
    const stopped = (id: string) => rows.find((row) => row.sessionID === id)!.stopped
    expect([stopped("ses_stopped"), stopped("ses_again"), stopped("ses_plain")]).toEqual([true, undefined, undefined])
    expect(rows.find((row) => row.sessionID === "ses_again")).not.toHaveProperty("stopped")
  })

  test("is empty for a session that started none, and lists at most maxTotal sessions: the live ones first, then the newest, counting the rest", async () => {
    const { ports } = fakePorts(
      { ses_a: { updated: 5, idle: 5 }, ses_b: { updated: 5, idle: 5 }, ses_c: { updated: 5, idle: 5 }, ses_d: { updated: 9, idle: 5 } },
      { ses_d: [{ type: "permission", requestID: "per_1", action: "shell", resources: ["echo hi"] }] },
      2,
    )
    for (const [index, child] of ["ses_a", "ses_b", "ses_c", "ses_d"].entries())
      await childStore(ports.storage).record(entry(child, "ses_root", { createdAt: 900 + index }))

    expect(await panel(ports, "ses_none")).toEqual({ rows: [] })
    const read = await panel(ports, "ses_root")
    expect(read.rows.map((row) => [row.sessionID, row.state])).toEqual([["ses_c", "idle"], ["ses_d", "waiting"]])
    expect(read.truncated).toBe(2)
    ;(ports as any).limits = { ...DEFAULT_LIMITS, maxTotal: 1 }
    expect((await panel(ports, "ses_root")).rows.map((row) => row.sessionID)).toEqual(["ses_d"])
  })
})

/** The tree's RPC registered over fake ports with courier_stop's and courier_cleanup's, whose worktrees are clean: its handlers. */
async function registered(sessions: Record<string, Session>) {
  const { ports, calls } = fakePorts(sessions)
  const later = { storage: ports.storage, session: ports.session, now: () => 1_000, newID: () => "later_1", log: () => {} } as unknown as LaterPorts
  const cleanup: CleanupPorts = {
    storage: ports.storage,
    worktree: { remove: async (input: unknown) => void calls.push({ method: "remove", input }) } as unknown as CleanupPorts["worktree"],
    projectID: "prj",
    inspect: async () => ({ changes: [], commits: [] }),
    now: () => 1_000,
    nudge: () => {},
  }
  const stopPorts = { courier: ports, cancelScheduled: (sessionID: string) => cancelScheduled(later, sessionID), cleanup } as unknown as StopPorts
  let handlers: any
  await registerTreeRpc({ register: async (_definition: unknown, given: unknown) => ((handlers = given), {} as any) } as any, stopPorts)
  return { ports, calls, handlers }
}

describe("the tree's RPC", () => {
  test("tree serves the panel's rows", async () => {
    const { ports, handlers } = await registered({ ses_a: { updated: 5, idle: 5 } })
    await childStore(ports.storage).record(entry("ses_a", "ses_root"))
    expect((await handlers.tree({ sessionID: "ses_root" })).rows.map((row: any) => row.sessionID)).toEqual(["ses_a"])
  })

  test("stop stops a session and those under it as courier_stop called from `by`, deepest first", async () => {
    const { ports, calls, handlers } = await registered({ ses_mid: { updated: 5 }, ses_leaf: { updated: 5 } })
    await childStore(ports.storage).record(entry("ses_mid", "ses_root"))
    await childStore(ports.storage).record(entry("ses_leaf", "ses_mid"))

    expect(await handlers.stop({ sessionID: "ses_mid", by: "ses_root" }, { error: (_type: string, message: string) => Promise.reject(new Error(message)) })).toEqual({
      stopped: [
        { sessionID: "ses_leaf", title: "entry ses_leaf", outcome: "interrupted" },
        { sessionID: "ses_mid", title: "entry ses_mid", outcome: "interrupted" },
      ],
      cancelled: 0,
    })
    expect(calls.filter((call) => call.method === "interrupt").map((call) => call.input.sessionID)).toEqual(["ses_leaf", "ses_mid"])
    // The caller stopped its own child: no one else to tell.
    expect(calls.filter((call) => call.method === "synthetic")).toEqual([])
  })

  test("stop refuses, as its declared error, what courier_stop would refuse", async () => {
    const { ports, handlers } = await registered({ ses_a: { updated: 5 } })
    await childStore(ports.storage).record(entry("ses_a", "ses_root"))
    const error = (type: string, message: string, data: unknown) => ({ type, message, data })

    expect(await handlers.stop({ sessionID: "ses_a", by: "ses_other" }, { error })).toEqual({
      type: "refused",
      message: expect.stringContaining("ses_other is not above ses_a"),
      data: {},
    })
    expect(await handlers.stop({ sessionID: "ses_unknown", by: "ses_root" }, { error })).toMatchObject({ type: "refused" })
  })

  test("cleanup forgets a session as courier_cleanup called from its own parent, when `by` is above it", async () => {
    const { ports, calls, handlers } = await registered({})
    await childStore(ports.storage).record(entry("ses_mid", "ses_root"))
    await childStore(ports.storage).record(entry("ses_leaf", "ses_mid", { isolated: true, directory: "/wt/leaf" }))
    const error = (type: string, message: string, data: unknown) => ({ type, message, data })

    expect(await handlers.cleanup({ sessionID: "ses_leaf", by: "ses_root" }, { error })).toEqual({ outcome: "removed" })
    expect(calls.filter((call) => call.method === "remove").map((call) => call.input.directory)).toEqual(["/wt/leaf"])
    expect(await childStore(ports.storage).entry("ses_mid", "ses_leaf")).toBeUndefined()
    expect(await handlers.cleanup({ sessionID: "ses_mid", by: "ses_root" }, { error })).toEqual({ outcome: "forgotten" })
    expect(await childStore(ports.storage).entry("ses_root", "ses_mid")).toBeUndefined()
  })

  test("cleanup refuses a `by` that is not above the target, and a session not on the roster, and forgets nothing", async () => {
    const { ports, calls, handlers } = await registered({})
    await childStore(ports.storage).record(entry("ses_mid", "ses_root"))
    await childStore(ports.storage).record(entry("ses_leaf", "ses_mid", { isolated: true, directory: "/wt/leaf" }))
    const error = (type: string, message: string, data: unknown) => ({ type, message, data })

    for (const by of ["ses_other", "ses_leaf"])
      expect(await handlers.cleanup({ sessionID: "ses_leaf", by }, { error })).toEqual({
        type: "refused",
        message: expect.stringContaining(`${by} is not above ses_leaf`),
        data: {},
      })
    expect(await handlers.cleanup({ sessionID: "ses_unknown", by: "ses_root" }, { error })).toMatchObject({ type: "refused" })
    expect(calls.filter((call) => call.method === "remove")).toEqual([])
    expect(await childStore(ports.storage).entry("ses_mid", "ses_leaf")).toBeDefined()
  })

  test("cleanup refuses a session OpenCode still has, or cannot say it lost, and forgets nothing", async () => {
    const { ports, calls, handlers } = await registered({ ses_leaf: { updated: 5 } })
    await childStore(ports.storage).record(entry("ses_leaf", "ses_root", { isolated: true, directory: "/wt/leaf" }))
    const error = (type: string, message: string, data: unknown) => ({ type, message, data })

    expect(await handlers.cleanup({ sessionID: "ses_leaf", by: "ses_root" }, { error })).toEqual({
      type: "refused",
      message: "ses_leaf is still known to OpenCode: only a gone session is forgotten here.",
      data: {},
    })
    ;(ports.session as any).get = async () => Promise.reject(new Error("connection reset"))
    expect(await handlers.cleanup({ sessionID: "ses_leaf", by: "ses_root" }, { error })).toMatchObject({ type: "refused", message: expect.stringContaining("connection reset") })
    expect(calls.filter((call) => call.method === "remove")).toEqual([])
    expect(await childStore(ports.storage).entry("ses_root", "ses_leaf")).toBeDefined()
  })
})

test("the tree, stop and cleanup methods' schemas take a session, stop a caller too, and a kept worktree its reason", async () => {
  const { tree, stop, cleanup } = treeRpc.methods
  expect((await tree.input["~standard"].validate({ sessionID: "ses_root" })).issues).toBeUndefined()
  expect((await tree.output["~standard"].validate({ rows: [] })).issues).toBeUndefined()
  expect((await stop.input["~standard"].validate({ sessionID: "ses_a" })).issues).toBeDefined()
  expect((await stop.input["~standard"].validate({ sessionID: "ses_a", by: "ses_root" })).issues).toBeUndefined()
  expect((await stop.output["~standard"].validate({ stopped: [], cancelled: -1 })).issues).toBeDefined()
  expect((await cleanup.output["~standard"].validate({ outcome: "kept" })).issues).toBeDefined()
  expect((await cleanup.output["~standard"].validate({ outcome: "kept", reason: "1 uncommitted change (a)" })).issues).toBeUndefined()
  expect((await cleanup.output["~standard"].validate({ outcome: "removed" })).issues).toBeUndefined()
})
