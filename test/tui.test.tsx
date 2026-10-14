// The TUI part against a fake TUI context, rendered headless by OpenTUI's test renderer.
import { afterEach, describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { SlotClaim } from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { batch, createSignal } from "solid-js"
import type { Row, Stopped, Summary, Tree } from "../src/tree/rpc.js"
import { activityLine, addTreeStatus, bar, detailLines, duration, PANEL, PANEL_SETTLE_MS, parts, SETTLE_MS, statusLine, stoppedLine, summaryLine, USAGE } from "../src/tree/tui.js"
import tui from "../src/tui.js"
import hostNotifications from "./host-notifications.js"

const empty: Summary = { running: 0, waiting: 0, idle: 0, groups: [] }

type Listener = (event: { type: string; data?: unknown; details: { type: string } }) => void

/**
 * A fake TUI context whose RPC answers `answer` for each session's summary and `tree` for its tree, keeping what it is
 * asked and shown; its route and panel are signals, and a route to another session closes the panel, as the host's do.
 */
function fakeContext(
  answer: (sessionID: string) => Promise<Summary>,
  { location, sessions = {} }: { location?: { directory: string }; sessions?: Record<string, { directory?: string; title?: string }> } = {
    location: { directory: "/workspace" },
  },
) {
  const calls: unknown[] = []
  const listeners = new Set<Listener>()
  const typed = new Map<string, Set<Listener>>()
  type Route = { type: string; sessionID?: string }
  const [route, setRoute] = createSignal<Route>({ type: "session", sessionID: "ses_parent" })
  const [panel, setPanel] = createSignal<{ name: string; sessionID: string }>()
  const state = {
    claims: [] as SlotClaim[],
    width: 160,
    released: 0,
    layers: [] as (() => { commands?: readonly any[] })[],
    toasts: [] as { message: string; variant?: string }[],
    notified: [] as any[],
    navigated: [] as unknown[],
    opened: [] as string[],
    presentations: [] as (string | undefined)[],
    dispatched: [] as string[],
    get route(): Route {
      return route()
    },
    set route(value: Route) {
      batch(() => {
        setRoute(value)
        if (panel()?.sessionID !== value.sessionID) setPanel(undefined)
      })
    },
    confirms: [] as { title: string; message: string }[],
    confirm: true as boolean | undefined,
    select: undefined as string | undefined,
    selects: [] as any[],
    tree: async (_sessionID: string): Promise<Tree> => ({ rows: [] }),
    stop: async (_input: { sessionID: string; by: string }): Promise<Stopped> => ({ stopped: [], cancelled: 0 }),
  }
  const color = RGBA.fromInts(120, 120, 120)
  const context = {
    renderer: { get width() { return state.width } },
    location,
    data: {
      location: { default: () => ({ directory: "/default" }) },
      session: {
        get: (sessionID: string) => {
          const session = sessions[sessionID]
          return session ? { id: sessionID, title: session.title, ...(session.directory ? { location: { directory: session.directory } } : {}) } : undefined
        },
      },
      listen: (handler: Listener) => {
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
      on: (type: string, handler: Listener) => {
        const set = typed.get(type) ?? new Set()
        typed.set(type, set.add(handler))
        return () => set.delete(handler)
      },
    },
    theme: {
      text: { base: color, muted: color, feedback: { warning: { base: color }, error: { base: color } } },
      background: { raised: { high: color } },
    },
    client: {
      rpc: () => ({
        summary: async (input: { sessionID: string }, options: unknown) => {
          calls.push([input, options])
          return answer(input.sessionID)
        },
        tree: async (input: { sessionID: string }, options: unknown) => {
          calls.push(["tree", input, options])
          return state.tree(input.sessionID)
        },
        stop: async (input: { sessionID: string; by: string }, options: unknown) => {
          calls.push(["stop", input, options])
          return state.stop(input)
        },
      }),
    },
    attention: {
      notify: async (options: unknown) => {
        state.notified.push(options)
        return { ok: true, notification: true, sound: true }
      },
    },
    keymap: {
      layer: (factory: () => { commands?: readonly any[] }) => void state.layers.push(factory),
      dispatch: (id: string) => void state.dispatched.push(id),
    },
    ui: {
      slot: (value: SlotClaim) => {
        state.claims.push(value)
        return () => void state.released++
      },
      toast: { show: (options: { message: string; variant?: string }) => void state.toasts.push(options) },
      router: {
        current: () => state.route,
        navigate: (destination: unknown) => void state.navigated.push(destination),
      },
      panel: {
        open: (name: string, options?: { presentation?: string }) => {
          if (state.route.type !== "session") return false
          state.opened.push(name)
          state.presentations.push(options?.presentation)
          setPanel({ name, sessionID: state.route.sessionID! })
          return true
        },
        close: () => setPanel(undefined),
        current: panel,
      },
      dialog: {
        confirm: async (options: { title: string; message: string }) => {
          state.confirms.push(options)
          return state.confirm
        },
        select: async (options: unknown) => {
          state.selects.push(options)
          return state.select
        },
      },
    },
  } as unknown as Plugin.Context
  const emit = (type: string, data?: unknown) => {
    for (const listener of listeners) listener({ type, details: { type } })
    for (const listener of typed.get(type) ?? []) listener({ type, data, details: { type } })
  }
  const claim = (path: string) => state.claims.find((one) => one.append === path)
  /** The command of the layers registered so far bound to `bind`, or with the id `bind`. */
  const command = (bind: string) =>
    state.layers
      .flatMap((layer) => layer().commands ?? [])
      .findLast((one) => one.bind === bind || one.id === bind)
  return { context, calls, listeners, typed, state, emit, claim, command }
}

const renderers: { renderer: { destroy(): void } }[] = []
afterEach(() => {
  for (const app of renderers.splice(0)) app.renderer.destroy()
})

/** Renders the claimed footer slot for the session `sessionID()` gives, `width` columns wide (80 by default), in a row laid out like OpenCode's footer. */
async function renderFooter(claim: SlotClaim | undefined, sessionID: () => string | undefined, width = 80) {
  expect(claim?.append).toBe("prompt.footer.status")
  const render = claim!.render as (input: unknown) => any
  const app = await testRender(
    () => (
      <box flexDirection="row" justifyContent="space-between" gap={2} width={width}>
        <box flexGrow={1} flexShrink={1} minWidth={0}>
          {render({
            get sessionID() {
              return sessionID()
            },
            mode: "normal",
            showDetails: true,
          })}
        </box>
        <text flexShrink={0}>ctrl+p commands</text>
      </box>
    ),
    { width, height: 2 },
  )
  renderers.push(app)
  return app
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 50))

describe("summaryLine", () => {
  test("names what the sessions do and each group's standing, leaving out what is zero", () => {
    expect(summaryLine({ running: 2, waiting: 1, idle: 0, groups: [{ name: "pair", reported: 1, members: 2 }] })).toBe(
      "courier 1 waiting on you · 2 running · group pair 1/2",
    )
    expect(summaryLine({ ...empty, idle: 3 })).toBe("courier 3 idle")
  })

  test("keeps whole parts within the width, the groups it drops counted", () => {
    const summary = {
      running: 2,
      waiting: 1,
      idle: 3,
      groups: [
        { name: "tests", reported: 1, members: 3 },
        { name: "docs", reported: 0, members: 2 },
        { name: "api", reported: 2, members: 2 },
      ],
    }
    const full = "courier 1 waiting on you · 2 running · group tests 1/3 · group docs 0/2 · group api 2/2 · 3 idle"
    expect(summaryLine(summary)).toBe(full)
    expect(summaryLine(summary, full.length)).toBe(full)
    expect(summaryLine(summary, full.length - 1)).toBe("courier 1 waiting on you · 2 running · group tests 1/3 · group docs 0/2 · group api 2/2")
    expect(summaryLine(summary, 83)).toBe("courier 1 waiting on you · 2 running · group tests 1/3 · group docs 0/2 · +1 group")
    expect(summaryLine(summary, 60)).toBe("courier 1 waiting on you · 2 running · +3 groups")
    expect(summaryLine(summary, 40)).toBe("courier 1 waiting on you · +3 groups")
  })

  test("drops idle without a count, and keeps what waits even when it alone is too wide", () => {
    expect(summaryLine({ ...empty, waiting: 1, running: 2, idle: 9 }, 40)).toBe("courier 1 waiting on you · 2 running")
    expect(summaryLine({ ...empty, waiting: 1, running: 2, idle: 9 }, 10)).toBe("1 waiting on you")
  })

  test("is empty for a session that started none", () => {
    expect(summaryLine(empty)).toBe("")
  })
})

describe("the footer status entry", () => {
  test("shows the summary the server's RPC gives for the open session, asked at the TUI's location", async () => {
    const fake = fakeContext(async () => ({ running: 2, waiting: 1, idle: 0, groups: [{ name: "pair", reported: 1, members: 2 }] }))
    await tui.setup(fake.context)
    const app = await renderFooter(fake.claim("prompt.footer.status"), () => "ses_parent")

    await app.waitForFrame((frame) => frame.includes("group pair"))
    expect(app.captureCharFrame()).toContain("courier 1 waiting on you · 2 running · group pair 1/2")
    expect(fake.calls).toEqual([[{ sessionID: "ses_parent" }, { location: { directory: "/workspace" } }]])
  })

  test("asks at the open session's own location when the TUI knows it", async () => {
    const fake = fakeContext(async () => ({ ...empty, idle: 1 }), { location: { directory: "/workspace" }, sessions: { ses_parent: { directory: "/project" } } })
    await tui.setup(fake.context)
    const app = await renderFooter(fake.claim("prompt.footer.status"), () => "ses_parent")

    await app.waitForFrame((frame) => frame.includes("courier 1 idle"))
    expect(fake.calls).toEqual([[{ sessionID: "ses_parent" }, { location: { directory: "/project" } }]])
  })

  test("asks at the server's default location when the TUI has none", async () => {
    const fake = fakeContext(async () => ({ ...empty, idle: 1 }), {})
    await tui.setup(fake.context)
    const app = await renderFooter(fake.claim("prompt.footer.status"), () => "ses_parent")

    await app.waitForFrame((frame) => frame.includes("courier 1 idle"))
    expect(fake.calls).toEqual([[{ sessionID: "ses_parent" }, { location: { directory: "/default" } }]])
  })

  test("shows nothing on the home screen, where there is no session, and asks nothing", async () => {
    const fake = fakeContext(async () => ({ ...empty, idle: 1 }))
    await tui.setup(fake.context)
    const app = await renderFooter(fake.claim("prompt.footer.status"), () => undefined)

    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("courier")
    expect(fake.calls).toEqual([])
  })

  test("shows nothing for a session that started none, or when the RPC fails", async () => {
    for (const answer of [async () => empty, async () => Promise.reject(new Error("rpc.method_not_found"))]) {
      const fake = fakeContext(answer)
      await tui.setup(fake.context)
      const app = await renderFooter(fake.claim("prompt.footer.status"), () => "ses_parent")

      await settle()
      await app.renderOnce()
      expect(fake.calls).toHaveLength(1)
      expect(app.captureCharFrame()).not.toContain("courier")
    }
  })

  test("asks again once after a burst of changes, and not for other events", async () => {
    let idle = 0
    const fake = fakeContext(async () => ({ ...empty, idle: ++idle }))
    await tui.setup(fake.context)
    const app = await renderFooter(fake.claim("prompt.footer.status"), () => "ses_parent")
    await app.waitForFrame((frame) => frame.includes("courier 1 idle"))

    fake.emit("session.text.delta")
    await settle()
    expect(fake.calls).toHaveLength(1)

    fake.emit("permission.asked")
    fake.emit("session.idle")
    fake.emit("form.created")
    await settle()
    await app.waitForFrame((frame) => frame.includes("courier 2 idle"))
    expect(fake.calls).toHaveLength(2)
  })

  test("shows only the open session's summary, not the last one's while the new one is asked", async () => {
    let release = () => {}
    const fake = fakeContext((sessionID) =>
      sessionID === "ses_a" ? Promise.resolve({ ...empty, running: 1 }) : new Promise((resolve) => (release = () => resolve({ ...empty, idle: 4 }))),
    )
    await tui.setup(fake.context)
    const [open, setOpen] = createSignal("ses_a")
    const app = await renderFooter(fake.claim("prompt.footer.status"), open)
    await app.waitForFrame((frame) => frame.includes("courier 1 running"))

    setOpen("ses_b")
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("courier")
    release()
    await app.waitForFrame((frame) => frame.includes("courier 4 idle"))
  })

  test("the TUI part's cleanup stops listening and gives the slots back", async () => {
    const fake = fakeContext(async () => empty)
    const cleanup = await tui.setup(fake.context)
    // The footer entry's, the panel's and the asks inbox's, and the attention's.
    expect(fake.listeners.size).toBe(3)
    expect(fake.typed.get("session.inbox.enqueued")?.size).toBe(1)

    await cleanup?.()
    expect(fake.listeners.size).toBe(0)
    expect(fake.typed.get("session.inbox.enqueued")?.size).toBe(0)
    expect(fake.state.released).toBe(2)
  })
})

const NOW = Date.now()

/** A row of the tree panel: an idle child of ses_parent that owes its report, unless `fields` say otherwise. */
const row = (sessionID: string, fields: Partial<Row> = {}): Row => ({
  sessionID,
  parentID: "ses_parent",
  title: sessionID,
  depth: 1,
  state: "idle",
  report: { state: "owed", progressed: false },
  isolated: false,
  created: NOW - 125_000,
  idle: NOW - 5_000,
  cost: 0.0123,
  waits: [],
  ...fields,
})

describe("the tree panel's lines", () => {
  test("a duration reads in its two coarsest units", () => {
    expect(duration(45_900)).toBe("45s")
    expect(duration(185_000)).toBe("3m 05s")
    expect(duration(7_620_000)).toBe("2h 07m")
    expect(duration(-5)).toBe("0s")
  })

  test("a bar shows the parts reported out of those started", () => {
    expect(bar({ reported: 1, started: 2 })).toBe("[█████░░░░░] 1/2 reported")
    expect(bar({ reported: 0, started: 3 }, 6)).toBe("[░░░░░░] 0/3 reported")
    expect(bar({ reported: 0, started: 0 })).toBe("[░░░░░░░░░░] 0/0 reported")
  })

  test("the parts reported count a session's own children whose report arrived", () => {
    const rows = [
      row("ses_a", { report: { state: "reported", status: "done", progressed: false } }),
      row("ses_b", { report: { state: "ended", progressed: false } }),
      row("ses_c"),
      row("ses_d", { parentID: "ses_c", depth: 2, report: { state: "reported", progressed: false } }),
    ]
    expect(parts(rows, "ses_parent")).toEqual({ reported: 1, started: 3 })
    expect(parts(rows, "ses_c")).toEqual({ reported: 1, started: 1 })
    expect(parts(rows, "ses_d")).toEqual({ reported: 0, started: 0 })
  })

  test("a status line names what the session does, its report, its group standing and its isolation", () => {
    expect(statusLine(row("ses_a", { report: { state: "reported", status: "done", progressed: false }, group: { name: "pair", standing: "held" } }))).toBe(
      "idle · reported done · group pair held",
    )
    expect(statusLine(row("ses_a", { state: "waiting", isolated: true }))).toBe("waiting on you · owes a report · isolated")
    expect(statusLine(row("ses_a", { outcome: "failed", report: { state: "ended", progressed: false } }))).toBe("failed · ended without a report")
    const { report: _, ...unreported } = row("ses_a", { state: "running" })
    expect(statusLine(unreported)).toBe("running")
  })

  test("a leaf's activity: how long it ran, its last tool call and how long ago, its cost", () => {
    expect(activityLine(row("ses_a", { tool: { name: "shell", at: NOW - 30_000 } }), NOW)).toBe("ran 2m 00s · last shell 30s ago · $0.01")
    const running = row("ses_a", { state: "running", tool: undefined, cost: undefined })
    delete (running as { idle?: number }).idle
    expect(activityLine(running, NOW)).toBe("ran 2m 05s · no tool call yet")
  })

  test("an orchestrator gets its bar, a paused session what it waits on, a leaf its activity", () => {
    const rows = [
      row("ses_mid", { tool: { name: "courier_spawn", at: NOW - 1_000 } }),
      row("ses_leaf", { parentID: "ses_mid", depth: 2, report: { state: "reported", progressed: false } }),
      row("ses_ask", {
        state: "waiting",
        waits: [
          { type: "permission", action: "shell", resources: ["echo courier-asks"] },
          { type: "question", question: "Which greeting?" },
        ],
      }),
    ]
    expect(detailLines(rows[0]!, rows, NOW)).toEqual(["[██████████] 1/1 reported"])
    expect(detailLines(rows[1]!, rows, NOW)).toEqual(["ran 2m 00s · no tool call yet · $0.01"])
    expect(detailLines(rows[2]!, rows, NOW)).toEqual(["asks permission: shell echo courier-asks", "asks: Which greeting?"])
    // A session OpenCode no longer knows has no activity to show.
    expect(detailLines(row("ses_gone", { state: "gone", idle: undefined, cost: undefined }), rows, NOW)).toEqual([])
  })

  test("after a stop, a toast says how many sessions were interrupted and how many messages cancelled", () => {
    const stopped: Stopped = {
      stopped: [
        { sessionID: "ses_b", title: "b", outcome: "interrupted" },
        { sessionID: "ses_a", title: "a", outcome: "idle" },
      ],
      cancelled: 1,
    }
    expect(stoppedLine(stopped)).toBe("Stopped 2 sessions: 1 interrupted, 1 scheduled message cancelled")
    expect(stoppedLine({ stopped: [{ sessionID: "ses_a", title: "a", outcome: "failed" }], cancelled: 0 })).toBe("Stopped 1 session: 0 interrupted, 1 failed to stop")
  })
})

/** A panel's input, as the host gives the `session.panel` slot, for the panel opened in `sessionID`. */
function panelInput(sessionID = "ses_parent", name = PANEL, { presentation = "panel", focused = true }: { presentation?: "panel" | "fullscreen"; focused?: boolean } = {}) {
  const input = { closed: 0, fullscreen: 0 }
  return {
    input,
    value: {
      name,
      sessionID,
      width: 100,
      presentation,
      focused,
      focus: () => {},
      close: () => void input.closed++,
      toggleFullscreen: () => void input.fullscreen++,
    },
  }
}

/** Renders the claimed panel slot, 100 columns by 24 rows. */
async function renderPanel(claim: SlotClaim | undefined, value: ReturnType<typeof panelInput>["value"]) {
  expect(claim?.append).toBe("session.panel")
  const render = claim!.render as (input: unknown) => any
  const app = await testRender(() => render(value), { width: 100, height: 24 })
  renderers.push(app)
  return app
}

/** A tree of two children of ses_parent in group pair: one reported, one waits on a permission request. */
const pair = (reported: number): Tree => ({
  rows: [
    row("ses_one", {
      title: "Report back to your parent.",
      group: { name: "pair", standing: "held" },
      report: { state: "reported", status: "done", progressed: false },
      tool: { name: "courier_send", at: NOW - 3_000 },
    }),
    row("ses_two", {
      title: "CHILD-ASKS",
      state: reported === 2 ? "idle" : "waiting",
      group: { name: "pair", standing: reported === 2 ? "held" : "out" },
      report: reported === 2 ? { state: "reported", status: "done", progressed: false } : { state: "owed", progressed: false },
      waits: reported === 2 ? [] : [{ type: "permission", action: "shell", resources: ["echo courier-asks"] }],
    }),
  ],
})

describe("the tree panel", () => {
  test("shows each session under the panel's session, with the bar of its children reported, and follows a report", async () => {
    const fake = fakeContext(async () => empty)
    let reported = 1
    fake.state.tree = async () => pair(reported)
    await tui.setup(fake.context)
    const app = await renderPanel(fake.claim("session.panel"), panelInput().value)

    await app.waitForFrame((frame) => frame.includes("CHILD-ASKS"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("courier tree  [█████░░░░░] 1/2 reported")
    expect(frame).toContain("▸ Report back to your parent.  idle · reported done · group pair held")
    expect(frame).toContain("ran 2m 00s · last courier_send")
    expect(frame).toContain("  CHILD-ASKS  waiting on you · owes a report · group pair out")
    expect(frame).toContain("asks permission: shell echo courier-asks")
    expect(fake.calls).toContainEqual(["tree", { sessionID: "ses_parent" }, { location: { directory: "/workspace" } }])

    reported = 2
    const asked = fake.calls.length
    fake.emit("session.tool.success")
    fake.emit("session.tool.called")
    await settle()
    // A burst is asked once, a second after its first event, as each ask reads every row's messages.
    expect(fake.calls).toHaveLength(asked)
    await new Promise((resolve) => setTimeout(resolve, PANEL_SETTLE_MS - SETTLE_MS))
    await app.waitForFrame((frame) => frame.includes("2/2 reported"))
    expect(fake.calls).toHaveLength(asked + 1)
    expect(app.captureCharFrame()).toContain("CHILD-ASKS  idle · reported done · group pair held")
  })

  test("indents a session by its depth, and shows nothing for another panel", async () => {
    const fake = fakeContext(async () => empty)
    fake.state.tree = async () => ({ rows: [row("ses_mid"), row("ses_leaf", { parentID: "ses_mid", depth: 2 })], truncated: 2 })
    await tui.setup(fake.context)
    const app = await renderPanel(fake.claim("session.panel"), panelInput().value)

    await app.waitForFrame((frame) => frame.includes("ses_leaf"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("[░░░░░░░░░░] 0/1 reported")
    expect(frame).toContain("2 older left out")
    expect(frame).toMatch(/\n ▸ ses_mid {2}idle/)
    expect(frame).toMatch(/\n {5}ses_leaf {2}idle/)

    const other = await renderPanel(fake.claim("session.panel"), panelInput("ses_parent", "someone-else").value)
    await other.renderOnce()
    expect(other.captureCharFrame()).not.toContain("courier")
  })

  test("says when no session was started under it, and when the RPC fails", async () => {
    const fake = fakeContext(async () => empty)
    await tui.setup(fake.context)
    const app = await renderPanel(fake.claim("session.panel"), panelInput().value)
    await app.waitForFrame((frame) => frame.includes("No session started with courier_spawn under this one."))

    const failing = fakeContext(async () => empty)
    failing.state.tree = async () => Promise.reject(new Error("rpc.method_not_found"))
    await tui.setup(failing.context)
    const broken = await renderPanel(failing.claim("session.panel"), panelInput().value)
    await broken.waitForFrame((frame) => frame.includes("courier RPC failed: rpc.method_not_found"))
  })

  test("moves the selection with its keys, opens the selected session, and closes", async () => {
    const fake = fakeContext(async () => empty)
    fake.state.tree = async () => pair(1)
    await tui.setup(fake.context)
    const { input, value } = panelInput()
    const app = await renderPanel(fake.claim("session.panel"), value)
    await app.waitForFrame((frame) => frame.includes("CHILD-ASKS"))

    fake.command("down")!.run()
    await app.waitForFrame((frame) => frame.includes("▸ CHILD-ASKS"))
    fake.command("j")!.run()
    fake.command("return")!.run()
    expect(fake.state.navigated).toEqual([{ type: "session", sessionID: "ses_two" }])
    fake.command("k")!.run()
    fake.command("return")!.run()
    expect(fake.state.navigated.at(-1)).toEqual({ type: "session", sessionID: "ses_one" })

    fake.command("f")!.run()
    fake.command("q")!.run()
    expect(input).toEqual({ closed: 1, fullscreen: 1 })
    // Its keys are the panel's only while it has the keyboard.
    expect((fake.state.layers.at(-1)!() as { enabled?: () => boolean }).enabled?.()).toBe(true)
  })

  test("the selection stays on its session when rows are added above it", async () => {
    const fake = fakeContext(async () => empty)
    let rows = [row("ses_a", { title: "Alpha" }), row("ses_b", { title: "Bravo" }), row("ses_c", { title: "Charlie" })]
    fake.state.tree = async () => ({ rows })
    await tui.setup(fake.context)
    const app = await renderPanel(fake.claim("session.panel"), panelInput().value)
    await app.waitForFrame((frame) => frame.includes("Charlie"))
    fake.command("down")!.run()
    await app.waitForFrame((frame) => frame.includes("▸ Bravo"))
    rows = [rows[0]!, row("ses_a1", { title: "Alpha's child", parentID: "ses_a", depth: 2 }), rows[1]!, rows[2]!]
    fake.command("r")!.run()
    await app.waitForFrame((frame) => frame.includes("Alpha's child"))
    expect(app.captureCharFrame()).toContain("▸ Bravo")
    fake.state.confirm = false
    fake.command("s")!.run()
    await settle()
    expect(fake.state.confirms.at(-1)?.message).toStartWith('Stop "Bravo" (ses_b)')
  })

  test("the selection stays at its place when the selected session disappears", async () => {
    const fake = fakeContext(async () => empty)
    let rows = [row("ses_a", { title: "Alpha" }), row("ses_b", { title: "Bravo" }), row("ses_c", { title: "Charlie" }), row("ses_d", { title: "Delta" })]
    fake.state.tree = async () => ({ rows })
    await tui.setup(fake.context)
    const app = await renderPanel(fake.claim("session.panel"), panelInput().value)
    await app.waitForFrame((frame) => frame.includes("Delta"))
    fake.command("down")!.run()
    await app.waitForFrame((frame) => frame.includes("▸ Bravo"))
    rows = [rows[0]!, rows[2]!, rows[3]!]
    fake.command("r")!.run()
    await app.waitForFrame((frame) => !frame.includes("Bravo"))
    expect(app.captureCharFrame()).toContain("▸ Charlie")
    // The selection now belongs to Charlie, so a row added above it does not move it.
    rows = [row("ses_z", { title: "Zulu" }), ...rows]
    fake.command("r")!.run()
    await app.waitForFrame((frame) => frame.includes("Zulu"))
    expect(app.captureCharFrame()).toContain("▸ Charlie")
  })

  test("s stops the selected session through the RPC, as the panel's session, once the person confirms", async () => {
    const fake = fakeContext(async () => empty)
    fake.state.tree = async () => ({ rows: [row("ses_mid", { title: "Mid" }), row("ses_leaf", { parentID: "ses_mid", depth: 2 })] })
    fake.state.stop = async () => ({ stopped: [{ sessionID: "ses_leaf", title: "ses_leaf", outcome: "interrupted" }, { sessionID: "ses_mid", title: "Mid", outcome: "interrupted" }], cancelled: 0 })
    await tui.setup(fake.context)
    const app = await renderPanel(fake.claim("session.panel"), panelInput().value)
    await app.waitForFrame((frame) => frame.includes("ses_leaf"))

    fake.state.confirm = false
    fake.command("s")!.run()
    await settle()
    expect(fake.state.confirms.at(-1)?.message).toStartWith('Stop "Mid" (ses_mid) and the 1 session under it?')
    expect(fake.calls.filter((call) => Array.isArray(call) && call[0] === "stop")).toEqual([])

    fake.state.confirm = true
    fake.command("s")!.run()
    await settle()
    expect(fake.calls).toContainEqual(["stop", { sessionID: "ses_mid", by: "ses_parent" }, { location: { directory: "/workspace" } }])
    expect(fake.state.toasts.at(-1)).toMatchObject({ message: "Stopped 2 sessions: 2 interrupted", variant: "success" })
  })

  test("a stop the server refuses shows why", async () => {
    const fake = fakeContext(async () => empty)
    fake.state.tree = async () => ({ rows: [row("ses_a")] })
    fake.state.stop = async () => Promise.reject({ type: "refused", message: "ses_x is not above ses_a" })
    await tui.setup(fake.context)
    const app = await renderPanel(fake.claim("session.panel"), panelInput().value)
    await app.waitForFrame((frame) => frame.includes("ses_a"))

    fake.command("s")!.run()
    await settle()
    expect(fake.state.toasts.at(-1)).toMatchObject({ message: "ses_x is not above ses_a", variant: "error" })
  })
})

describe("the tree panel following navigation", () => {
  /** A context whose panel was opened with /courier tree in ses_parent, over `trees`, and drawn as `fields` say. */
  async function opened(trees: Record<string, Tree>, fields: Parameters<typeof panelInput>[2] = {}) {
    const fake = fakeContext(async () => empty)
    fake.state.tree = async (sessionID) => trees[sessionID] ?? { rows: [] }
    await tui.setup(fake.context)
    await fake.command("courier.command")!.run("tree")
    const app = await renderPanel(fake.claim("session.panel"), panelInput("ses_parent", PANEL, fields).value)
    await app.waitForFrame((frame) => frame.includes("CHILD-ASKS"))
    return fake
  }
  const trees = (fake: ReturnType<typeof fakeContext>) => fake.calls.filter((call) => Array.isArray(call) && call[0] === "tree").map((call) => (call as any)[1].sessionID)

  test("a panel shown fullscreen only because the terminal is narrow reopens as a panel once followed", async () => {
    const fake = fakeContext(async () => empty)
    fake.state.width = 80
    fake.state.tree = async (sessionID) => ({ ses_parent: pair(1) })[sessionID as "ses_parent"] ?? { rows: [] }
    await tui.setup(fake.context)
    await fake.command("courier.command")!.run("tree")
    const app = await renderPanel(fake.claim("session.panel"), panelInput("ses_parent", PANEL, { presentation: "fullscreen" }).value)
    await app.waitForFrame((frame) => frame.includes("CHILD-ASKS"))

    fake.state.route = { type: "session", sessionID: "ses_two" }
    expect(fake.state.presentations.at(-1)).toBe("panel")
  })

  test("reopens in a session of its tree with the same presentation, showing the root's tree with that session marked", async () => {
    const fake = await opened({ ses_parent: pair(1) }, { presentation: "fullscreen" })

    fake.state.route = { type: "session", sessionID: "ses_two" }
    expect(fake.state.opened).toEqual([PANEL, PANEL])
    expect(fake.state.presentations.at(-1)).toBe("fullscreen")
    expect(fake.context.ui.panel.current()).toEqual({ name: PANEL, sessionID: "ses_two" })

    const asked = trees(fake).length
    const app = await renderPanel(fake.claim("session.panel"), panelInput("ses_two").value)
    // The tree last read shows at once, then the root's is asked again, not the child's.
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("▸ CHILD-ASKS (on screen)  waiting on you")
    await settle()
    expect(trees(fake).slice(asked)).toEqual(["ses_parent"])
    expect(app.captureCharFrame()).toContain("courier tree  [█████░░░░░] 1/2 reported")
    // The panel had the keyboard, so it keeps it.
    expect(fake.state.dispatched).toEqual([])

    fake.state.route = { type: "session", sessionID: "ses_parent" }
    expect(fake.state.opened).toHaveLength(3)
  })

  test("gives the keyboard back to the prompt when the panel did not have it", async () => {
    const fake = await opened({ ses_parent: pair(1) }, { focused: false })
    fake.state.route = { type: "session", sessionID: "ses_one" }
    await renderPanel(fake.claim("session.panel"), panelInput("ses_one").value)
    await settle()
    expect(fake.state.dispatched).toEqual(["pane.focus.left"])
  })

  test("stays closed once closed with q or by the host", async () => {
    const fake = await opened({ ses_parent: pair(1) })
    fake.context.ui.panel.close()
    fake.state.route = { type: "session", sessionID: "ses_two" }
    await settle()
    expect(fake.state.opened).toEqual([PANEL])
  })

  test("a child spawned since the tree was read is looked up in the root's tree, which it keeps", async () => {
    const fake = await opened({ ses_parent: pair(1) })
    fake.state.tree = async (sessionID) => (sessionID === "ses_parent" ? { rows: [...pair(1).rows, row("ses_new")] } : { rows: [] })
    fake.state.route = { type: "session", sessionID: "ses_new" }
    await settle()
    expect(fake.state.opened).toHaveLength(2)
    const app = await renderPanel(fake.claim("session.panel"), panelInput("ses_new").value)
    await app.waitForFrame((frame) => frame.includes("ses_new (on screen)"))
    expect(app.captureCharFrame()).toContain("CHILD-ASKS")
  })

  test("outside its tree, shows the new session's own tree, or hides until a session with a tree", async () => {
    const fake = await opened({ ses_parent: pair(1), ses_other: { rows: [row("ses_far", { parentID: "ses_other", title: "Far away" })] } })

    fake.state.route = { type: "session", sessionID: "ses_other" }
    await settle()
    expect(fake.state.opened).toHaveLength(2)
    const app = await renderPanel(fake.claim("session.panel"), panelInput("ses_other").value)
    await app.waitForFrame((frame) => frame.includes("Far away"))
    expect(app.captureCharFrame()).not.toContain("CHILD-ASKS")

    fake.state.route = { type: "session", sessionID: "ses_lonely" }
    await settle()
    expect(fake.state.opened).toHaveLength(2)
    expect(fake.context.ui.panel.current()).toBeUndefined()
    // Hidden, not closed: back in a session with a tree, it shows again.
    fake.state.route = { type: "session", sessionID: "ses_parent" }
    await settle()
    expect(fake.state.opened).toHaveLength(3)
    expect(fake.context.ui.panel.current()).toEqual({ name: PANEL, sessionID: "ses_parent" })
  })

  test("hidden in a session without a tree, shows once that session starts one", async () => {
    const fake = await opened({ ses_parent: pair(1) })
    fake.state.route = { type: "session", sessionID: "ses_lonely" }
    await settle()
    expect(fake.state.opened).toHaveLength(1)

    fake.state.tree = async (sessionID) => (sessionID === "ses_lonely" ? { rows: [row("ses_new", { parentID: "ses_lonely" })] } : pair(1))
    fake.emit("session.created")
    await new Promise((resolve) => setTimeout(resolve, PANEL_SETTLE_MS + 100))
    expect(fake.state.opened).toHaveLength(2)
    expect(fake.context.ui.panel.current()).toEqual({ name: PANEL, sessionID: "ses_lonely" })
    // It opened without the person moving, so the prompt keeps the keyboard.
    await renderPanel(fake.claim("session.panel"), panelInput("ses_lonely").value)
    await settle()
    expect(fake.state.dispatched).toEqual(["pane.focus.left"])
  })

  test("hidden in a session without a tree, the home screen keeps it hidden, and it shows again in its tree", async () => {
    const fake = await opened({ ses_parent: pair(1) })
    fake.state.route = { type: "session", sessionID: "ses_lonely" }
    await settle()
    fake.state.route = { type: "home" }
    await settle()
    fake.state.route = { type: "session", sessionID: "ses_parent" }
    await settle()
    expect(fake.state.opened).toHaveLength(2)
    expect(fake.context.ui.panel.current()).toEqual({ name: PANEL, sessionID: "ses_parent" })
  })

  test("the home screen hides it, and it shows again in a session of its tree", async () => {
    const fake = await opened({ ses_parent: pair(1) }, { presentation: "fullscreen" })
    fake.state.route = { type: "home" }
    await settle()
    expect(fake.state.opened).toEqual([PANEL])

    fake.state.route = { type: "session", sessionID: "ses_parent" }
    await settle()
    expect(fake.state.opened).toEqual([PANEL, PANEL])
    expect(fake.state.presentations.at(-1)).toBe("fullscreen")
    expect(fake.context.ui.panel.current()).toEqual({ name: PANEL, sessionID: "ses_parent" })
  })

  test("closed with q where it shows again, it stays closed through the home screen and back", async () => {
    const fake = await opened({ ses_parent: pair(1) })
    fake.state.route = { type: "home" }
    fake.state.route = { type: "session", sessionID: "ses_parent" }
    await settle()
    expect(fake.state.opened).toHaveLength(2)
    fake.context.ui.panel.close()
    fake.state.route = { type: "home" }
    fake.state.route = { type: "session", sessionID: "ses_parent" }
    await settle()
    expect(fake.state.opened).toHaveLength(2)
  })
})

describe("the /courier command", () => {
  test("/courier and /courier tree open the panel in the open session; the palette's command too", async () => {
    const fake = fakeContext(async () => empty)
    await tui.setup(fake.context)
    const courier = fake.command("courier.command")!
    expect(courier.slash).toEqual({ name: "courier", arguments: true })
    const layer = fake.state.layers.map((one) => one() as { mode?: string; commands?: readonly any[] }).find((one) => one.commands?.some((command) => command.id === "courier.command"))
    expect(layer?.mode).toBe("global")

    await courier.run("tree")
    await courier.run("")
    await fake.command("courier.tree")!.run()
    expect(fake.state.opened).toEqual([PANEL, PANEL, PANEL])

    fake.state.route = { type: "home" }
    await courier.run("tree")
    expect(fake.state.toasts.at(-1)).toMatchObject({ message: "Open a session first", variant: "warning" })
  })

  test("/courier stop <session> stops it as the open session after a confirm that names it and those under it", async () => {
    const fake = fakeContext(async () => empty)
    fake.state.tree = async () => ({ rows: [row("ses_mid", { title: "Mid" }), row("ses_leaf", { parentID: "ses_mid", depth: 2 })] })
    fake.state.stop = async () => ({ stopped: [{ sessionID: "ses_mid", title: "Mid", outcome: "idle" }], cancelled: 2 })
    await tui.setup(fake.context)

    await fake.command("courier.command")!.run("stop ses_mid")
    expect(fake.state.confirms.at(-1)?.message).toStartWith('Stop "Mid" (ses_mid) and the 1 session under it?')
    expect(fake.calls).toContainEqual(["stop", { sessionID: "ses_mid", by: "ses_parent" }, { location: { directory: "/workspace" } }])
    expect(fake.state.toasts.at(-1)?.message).toBe("Stopped 1 session: 0 interrupted, 2 scheduled messages cancelled")
  })

  test("/courier stop with no session lets the person pick one of the tree, and stops nothing if they pick none", async () => {
    const fake = fakeContext(async () => empty)
    fake.state.tree = async () => ({ rows: [row("ses_a", { title: "A" })] })
    await tui.setup(fake.context)

    await fake.command("courier.command")!.run("stop")
    expect(fake.state.selects.at(-1)?.options).toEqual([{ title: "A", value: "ses_a", description: "ses_a · idle · owes a report" }])
    expect(fake.state.confirms).toEqual([])

    fake.state.select = "ses_a"
    await fake.command("courier.command")!.run("stop")
    expect(fake.calls).toContainEqual(["stop", { sessionID: "ses_a", by: "ses_parent" }, { location: { directory: "/workspace" } }])
  })

  test("an unknown verb shows the usage", async () => {
    const fake = fakeContext(async () => empty)
    await tui.setup(fake.context)
    await fake.command("courier.command")!.run("frobnicate")
    expect(fake.state.toasts.at(-1)).toMatchObject({ message: USAGE, variant: "warning" })
  })
})

describe("attention", () => {
  const enqueued = (inboxID: string, metadata: Record<string, unknown>, type = "synthetic") => ({
    sessionID: "ses_parent",
    inboxID,
    item: { type, payload: { text: "", metadata }, delivery: "steer" },
  })

  test("a group's reports arriving notifies; a child's report plays subagent_done; each delivery once", async () => {
    const fake = fakeContext(async () => empty, { location: { directory: "/w" }, sessions: { ses_parent: { title: "Parent" }, ses_one: { title: "One" } } })
    await tui.setup(fake.context)

    fake.emit("session.inbox.enqueued", enqueued("msg_1", { source: "courier", from: "ses_one,ses_two", group: "pair", reports: 2 }))
    fake.emit("session.inbox.enqueued", enqueued("msg_1", { source: "courier", from: "ses_one,ses_two", group: "pair", reports: 2 }))
    fake.emit("session.inbox.enqueued", enqueued("msg_2", { source: "courier", from: "ses_one", status: "done" }))
    expect(fake.state.notified).toEqual([
      { title: "Parent", message: "Group pair: 2 reports arrived", notification: { when: "blurred" }, sound: { name: "done", when: "always" } },
      { title: "Parent", message: "One reported done", notification: false, sound: { name: "subagent_done", when: "always" } },
    ])
  })

  test("nothing for a message without a status, one not the courier's, or another kind of item", async () => {
    const fake = fakeContext(async () => empty)
    await tui.setup(fake.context)

    fake.emit("session.inbox.enqueued", enqueued("msg_1", { source: "courier", from: "ses_one" }))
    fake.emit("session.inbox.enqueued", enqueued("msg_2", { source: "other", status: "done" }))
    fake.emit("session.inbox.enqueued", enqueued("msg_3", { source: "courier", status: "done" }, "user"))
    expect(fake.state.notified).toEqual([])
  })
})

describe("the footer's waiting on you", () => {
  test("a click opens the asks inbox for the open session, only while some wait on the person", async () => {
    for (const [waiting, opened] of [[1, ["ses_parent"]], [0, []]] as const) {
      const fake = fakeContext(async () => ({ ...empty, running: 1, waiting }))
      const clicked: string[] = []
      addTreeStatus(fake.context, (sessionID) => void clicked.push(sessionID))
      const app = await renderFooter(fake.claim("prompt.footer.status"), () => "ses_parent")
      await app.waitForFrame((frame) => frame.includes("1 running"))

      await app.mockMouse.click(4, 0)
      expect(clicked).toEqual([...opened])
    }
  })
})

describe("a tree past maxTotal (#188)", () => {
  test("the panel's header counts the older sessions its listing left out, and the footer counts every session", async () => {
    const fake = fakeContext(async () => ({ ...empty, waiting: 1, idle: 30 }))
    fake.state.tree = async () => ({ rows: [row("ses_new", { state: "waiting", waits: [{ type: "permission", action: "shell", resources: ["echo hi"] }] })], truncated: 30 })
    await tui.setup(fake.context)
    const app = await renderPanel(fake.claim("session.panel"), panelInput().value)
    await app.waitForFrame((frame) => frame.includes("ses_new"))
    expect(app.captureCharFrame()).toContain("30 older left out")

    expect(summaryLine({ ...empty, waiting: 1, idle: 30 })).toBe("courier 1 waiting on you · 30 idle")
  })
})

describe("the footer status entry's width", () => {
  const crowded = {
    running: 3,
    waiting: 1,
    idle: 2,
    groups: [
      { name: "tests", reported: 1, members: 3 },
      { name: "docs", reported: 0, members: 2 },
      { name: "api", reported: 2, members: 2 },
    ],
  }

  for (const width of [40, 80, 120]) {
    test(`shows whole parts and what waits at ${width} columns`, async () => {
      const fake = fakeContext(async () => crowded)
      await tui.setup(fake.context)
      const app = await renderFooter(fake.claim("prompt.footer.status"), () => "ses_parent", width)

      const frame = await app.waitForFrame((one) => one.includes("waiting on you"))
      const shown = frame.split("\n")[0]!
      // Every part is whole: a group reads "name n/m" and the count reads "+N groups".
      for (const word of shown.matchAll(/group (\S+)( (\S+))?/g)) expect(word[3]).toMatch(/^\d+\/\d+$/)
      expect(shown).not.toMatch(/ [·+]\s{2,}/)
      if (width === 120) expect(shown).toContain("group tests 1/3 · group docs 0/2 · group api 2/2")
      else if (width === 80) expect(shown).toMatch(/\+\d groups?/)
      else expect(shown).toContain("1 waiting on you")
    })
  }
})

describe("a native child's report (#177)", () => {
  const reported = (from: string) => ({
    sessionID: "ses_parent",
    inboxID: `msg_${from}`,
    item: { type: "synthetic", payload: { text: "", metadata: { source: "courier", from, status: "done" } }, delivery: "steer" },
  })
  const setup = async (native: boolean) => {
    const fake = fakeContext(async () => empty, { location: { directory: "/w" }, sessions: { ses_parent: { title: "Parent" }, ses_one: { title: "One" } } })
    const session = fake.context.data.session as any
    const get = session.get
    session.get = (id: string) => (native && id === "ses_one" ? { ...get(id), parentID: "ses_parent" } : get(id))
    await tui.setup(fake.context)
    await (hostNotifications as any).setup(fake.context)
    return fake
  }
  const subagentDone = (fake: Awaited<ReturnType<typeof setup>>) => fake.state.notified.filter((n: any) => n.sound.name === "subagent_done")

  test("sounds subagent_done once, OpenCode's, for a native child", async () => {
    const fake = await setup(true)
    fake.emit("session.inbox.enqueued", reported("ses_one"))
    fake.emit("session.execution.succeeded", { sessionID: "ses_one" })
    expect(subagentDone(fake)).toHaveLength(1)
  })

  test("a child without a parent still sounds the courier's subagent_done once", async () => {
    const fake = await setup(false)
    fake.emit("session.inbox.enqueued", reported("ses_one"))
    fake.emit("session.execution.succeeded", { sessionID: "ses_one" })
    expect(subagentDone(fake)).toHaveLength(1)
    expect(fake.state.notified.map((n: any) => n.sound.name)).toEqual(["subagent_done", "done"])
  })
})

describe("/courier stop with nothing to pick (#181)", () => {
  test("/courier stop with nothing to pick, or a tree it cannot read, says so instead of an empty picker", async () => {
    const fake = fakeContext(async () => empty)
    fake.state.tree = async () => ({ rows: [] })
    await tui.setup(fake.context)
    await fake.command("courier.command")!.run("stop")
    expect(fake.state.selects).toEqual([])
    expect(fake.state.toasts.at(-1)?.message).toContain("No session")

    fake.state.tree = async () => Promise.reject({ type: "rpc.unavailable", message: "closing" })
    await fake.command("courier.command")!.run("stop")
    expect(fake.state.selects).toEqual([])
    expect(fake.state.toasts.at(-1)).toMatchObject({ message: "closing", variant: "error" })
  })
})

test("a long title keeps the row's status in view, and a line break stays on the row", async () => {
  const fake = fakeContext(async () => empty)
  fake.state.tree = async () => ({ rows: [
    row("ses_a", { title: "Refactor the session tree panel so that it renders well…", state: "waiting", waits: [{ type: "permission", action: "shell", resources: ["rm -rf build"] }] }),
    row("ses_b", { title: "Line one\nline two" }),
  ] })
  await tui.setup(fake.context)
  const render = fake.claim("session.panel")!.render as (input: unknown) => any
  const app = await testRender(() => render({ ...panelInput().value, width: 60 }), { width: 60, height: 12 })
  renderers.push(app)
  await app.waitForFrame((frame) => frame.includes("Refactor"))
  const frame = app.captureCharFrame()
  expect(frame).toContain("waiting on you")
  expect(frame).not.toMatch(/\n line two/)
})
