// The TUI part against a fake TUI context, rendered headless by OpenTUI's test renderer.
import { afterEach, describe, expect, jest, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { SlotClaim } from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { MouseButtons, type MouseButton } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { batch, createRoot, createSignal } from "solid-js"
import type { Forgotten, Row, Stopped, Summary, Tree } from "../src/tree/rpc.js"
import { activityLine, addTreePanel, addTreeStatus, animationsOn, bar, BAR_MS, blend, restBackground, createFlashes, createMotion, FLASH_MS, filledCells, FRAME_MS, SPINNER, detailLines, duration, forgottenLine, PANEL, PANEL_SETTLE_MS, parts, SETTLE_MS, rowMark, statusLine, stoppedLine, summaryLine, USAGE, countsLine, mascotState, GLYPH_ROWS, GLYPH_COLUMNS, ART_ROWS, BELOW_ROWS, digbyColours } from "../src/tree/tui.js"
import { ART, art, BLINK_EVERY, cells, digby, glyph, GLYPH, MASCOT_EVERY, type MascotState } from "../src/tree/mascot.js"
import { MEMORY_USAGE } from "../src/memory/tui.js"
import tui from "../src/tui.js"
import hostNotifications from "./host-notifications.js"

/** The fake theme's success background, a row's flash. */
const FLASH = RGBA.fromInts(0, 200, 0)

/** The fake theme's `background.raised.base`, a hovered row's. */
const HOVER = RGBA.fromInts(40, 40, 40)

const empty: Summary = { running: 0, waiting: 0, idle: 0, groups: [] }

type Listener = (event: { type: string; data?: unknown; details: { type: string; data?: unknown } }) => void

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
    cleanup: async (_input: { sessionID: string; by: string }): Promise<Forgotten> => ({ outcome: "forgotten" }),
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
      text: { base: color, muted: color, action: { primary: { base: color, selected: color } }, feedback: THEME },
      background: { base: RGBA.fromInts(0, 0, 0), raised: { base: HOVER, high: color, max: color }, feedback: { success: { base: FLASH } } },
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
        cleanup: async (input: { sessionID: string; by: string }, options: unknown) => {
          calls.push(["cleanup", input, options])
          return state.cleanup(input)
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
    for (const listener of listeners) listener({ type, details: { type, data } })
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

  test("puts the stalled sessions right after those waiting on you, which stays first", () => {
    expect(summaryLine({ ...empty, stalled: 1, waiting: 1, running: 2 })).toBe("courier 1 waiting on you · 1 stalled · 2 running")
    expect(summaryLine({ ...empty, stalled: 1, waiting: 1, running: 2 }, 30)).toBe("courier 1 waiting on you")
    expect(summaryLine({ ...empty, stalled: 2 }, 12)).toBe("2 stalled")
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

/** A theme colour per feedback token, distinct, as the fake context's and the marks' tests'. */
const THEME = {
  warning: { base: "#ffaa00" },
  error: { base: "#ff0000" },
  success: { base: "#00ff00" },
  info: { base: "#00aaff" },
}

describe("the tree panel's lines", () => {
  test("each row state has its mark and the theme's colour for it", () => {
    const mark = (fields: Partial<Row>) => rowMark(row("ses_a", fields), { text: { feedback: THEME } })
    expect(mark({ report: { state: "reported", progressed: false } })).toEqual({ mark: "✓", color: "#00ff00" })
    expect(mark({ state: "running" })).toEqual({ mark: "•", color: "#00aaff" })
    expect(mark({ state: "waiting" })).toEqual({ mark: "●", color: "#ffaa00" })
    expect(mark({ state: "stalled" })).toEqual({ mark: "!", color: "#ff0000" })
    expect(mark({ outcome: "failed", report: { state: "ended", progressed: false } })).toEqual({ mark: "✗", color: "#ff0000" })
    expect(mark({ outcome: "interrupted" })).toEqual({ mark: "✗", color: "#ff0000" })
    expect(mark({ outcome: "interrupted", stopped: true })).toEqual({ mark: " ", color: undefined })
    expect(mark({})).toEqual({ mark: " ", color: undefined })
    expect(mark({ state: "gone" })).toEqual({ mark: " ", color: undefined })
  })


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
    expect(statusLine(row("ses_a", { outcome: "interrupted", stopped: true, report: { state: "ended", progressed: false } }))).toBe("stopped")
    expect(statusLine(row("ses_a", { stopped: true, report: { state: "owed", progressed: false } }))).toBe("stopped · owes a report")
    const { report: _, ...unreported } = row("ses_a", { state: "running" })
    expect(statusLine(unreported)).toBe("running")
    expect(statusLine(row("ses_a", { state: "stalled", stalled: NOW - 65_000 }))).toBe("stalled · owes a report")
  })

  test("a leaf's activity: how long it ran, its last tool call and how long ago, its cost", () => {
    expect(activityLine(row("ses_a", { tool: { name: "shell", at: NOW - 30_000 } }), NOW)).toBe("ran 2m 00s · last shell 30s ago · $0.01")
    const running = row("ses_a", { state: "running", tool: undefined, cost: undefined })
    delete (running as { idle?: number }).idle
    expect(activityLine(running, NOW)).toBe("ran 2m 05s · no tool call yet")
  })

  test("a leaf's context use sits between its last tool call and its cost, rounded to a whole percent, and is left out when unknown", () => {
    const tool = { name: "shell", at: NOW - 30_000 }
    expect(activityLine(row("ses_a", { tool, context: 0.31 }), NOW)).toBe("ran 2m 00s · last shell 30s ago · ctx 31% · $0.01")
    expect(activityLine(row("ses_a", { tool, context: 0.846 }), NOW)).toBe("ran 2m 00s · last shell 30s ago · ctx 85% · $0.01")
    expect(activityLine(row("ses_a", { tool }), NOW)).not.toContain("ctx")
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
          { type: "form", title: "Web Search" },
        ],
      }),
    ]
    expect(detailLines(rows[0]!, rows, NOW)).toEqual(["[██████████] 1/1 reported"])
    expect(detailLines(rows[1]!, rows, NOW)).toEqual(["ran 2m 00s · no tool call yet · $0.01"])
    expect(detailLines(rows[2]!, rows, NOW)).toEqual(["asks permission: shell echo courier-asks", "asks: Which greeting?", "shows a form: Web Search"])
    // A stalled session says since when a message waits, under its bar if it is an orchestrator.
    expect(detailLines(row("ses_mid", { state: "stalled", stalled: NOW - 65_000 }), rows, NOW)).toEqual([
      "[██████████] 1/1 reported",
      "a message waits in its inbox since 1m 05s, woken again in vain",
    ])
    // What it waits on the person for comes first: that is what the person can act on.
    expect(detailLines(row("ses_ask", { state: "waiting", stalled: NOW - 65_000, waits: [{ type: "form", title: "Web Search" }] }), rows, NOW)).toEqual([
      "shows a form: Web Search",
    ])
    // A session OpenCode no longer knows has no activity to show.
    expect(detailLines(row("ses_gone", { state: "gone", idle: undefined, cost: undefined }), rows, NOW)).toEqual([])
  })

  test("after a forget, a toast says what courier_cleanup did, on one line", () => {
    expect(forgottenLine("Fix\nthe bug", { outcome: "forgotten" })).toBe('Forgot "Fix the bug"')
    expect(forgottenLine("a", { outcome: "kept", reason: "2 commits on no branch, tag or remote (x, y)" })).toBe('Kept "a" and its worktree: 2 commits on no branch, tag or remote (x, y)')
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

/** Renders the claimed panel slot, 100 columns by 24 rows unless `height` and `width` say otherwise, on `under` as the host's panel background. */
async function renderPanel(claim: SlotClaim | undefined, value: ReturnType<typeof panelInput>["value"], height = 24, width = 100, under?: RGBA) {
  expect(claim?.append).toBe("session.panel")
  const render = claim!.render as (input: unknown) => any
  const app = await testRender(() => (under ? <box flexGrow={1} backgroundColor={under}>{render(value)}</box> : render(value)), { width, height })
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
    expect(frame).toContain("▸ ✓ Report back to your parent.  idle · reported done · group pair held")
    expect(frame).toContain("ran 2m 00s · last courier_send")
    expect(frame).toContain("  ● CHILD-ASKS  waiting on you · owes a report · group pair out")
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
    expect(app.captureCharFrame()).toContain("✓ CHILD-ASKS  idle · reported done · group pair held")
  })

  test("shows a session's context use muted, and in the warning colour past 80%", async () => {
    const fake = fakeContext(async () => empty)
    const leaf = (sessionID: string, context: number) => row(sessionID, { state: "running", tool: { name: "shell", at: NOW }, report: { state: "owed", progressed: false }, context })
    fake.state.tree = async () => ({ rows: [leaf("ses_low", 0.31), leaf("ses_edge", 0.8), leaf("ses_high", 0.84)] })
    await tui.setup(fake.context)
    const app = await renderPanel(fake.claim("session.panel"), panelInput().value)
    await app.waitForFrame((frame) => frame.includes("ctx 84%"))
    const spans = app.captureSpans().lines.flatMap((line) => line.spans)
    const colourOf = (text: string) => spans.find((span) => span.text.includes(text))?.fg.toInts()
    const muted = colourOf("ctx 31%")
    expect(muted).toEqual(RGBA.fromInts(120, 120, 120).toInts())
    expect(colourOf("ctx 80%")).toEqual(muted)
    expect(colourOf("ctx 84%")).toEqual(RGBA.fromHex(THEME.warning.base).toInts())
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
    expect(frame).toMatch(/\n ▸ {3}ses_mid {2}idle/)
    expect(frame).toMatch(/\n {7}ses_leaf {2}idle/)

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
    await app.waitForFrame((frame) => frame.includes("▸ ● CHILD-ASKS"))
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
    await app.waitForFrame((frame) => frame.includes("▸   Bravo"))
    rows = [rows[0]!, row("ses_a1", { title: "Alpha's child", parentID: "ses_a", depth: 2 }), rows[1]!, rows[2]!]
    fake.command("r")!.run()
    await app.waitForFrame((frame) => frame.includes("Alpha's child"))
    expect(app.captureCharFrame()).toContain("▸   Bravo")
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
    await app.waitForFrame((frame) => frame.includes("▸   Bravo"))
    rows = [rows[0]!, rows[2]!, rows[3]!]
    fake.command("r")!.run()
    await app.waitForFrame((frame) => !frame.includes("Bravo"))
    expect(app.captureCharFrame()).toContain("▸   Charlie")
    // The selection now belongs to Charlie, so a row added above it does not move it.
    rows = [row("ses_z", { title: "Zulu" }), ...rows]
    fake.command("r")!.run()
    await app.waitForFrame((frame) => frame.includes("Zulu"))
    expect(app.captureCharFrame()).toContain("▸   Charlie")
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

  test("x on a gone row forgets it through the RPC, as the panel's session, once the person confirms, and reads the tree again", async () => {
    const fake = fakeContext(async () => empty)
    fake.state.tree = async () => ({ rows: [row("ses_gone", { title: "Fix the bug", state: "gone", isolated: true })] })
    await tui.setup(fake.context)
    const app = await renderPanel(fake.claim("session.panel"), panelInput().value)
    await app.waitForFrame((frame) => frame.includes("Fix the bug"))
    expect(app.captureCharFrame()).toContain("s stop · x forget · r refresh")

    fake.state.confirm = false
    fake.command("x")!.run()
    await settle()
    expect(fake.state.confirms.at(-1)).toMatchObject({
      title: "Forget session",
      message: 'Forget "Fix the bug" (ses_gone)? Its worktree is removed unless it has uncommitted changes or commits found nowhere else.',
    })
    expect(fake.calls.filter((call) => Array.isArray(call) && call[0] === "cleanup")).toEqual([])

    fake.state.confirm = true
    const reads = fake.calls.filter((call) => Array.isArray(call) && call[0] === "tree").length
    fake.state.cleanup = async () => ({ outcome: "removed" })
    fake.command("x")!.run()
    await settle()
    expect(fake.calls).toContainEqual(["cleanup", { sessionID: "ses_gone", by: "ses_parent" }, { location: { directory: "/workspace" } }])
    expect(fake.state.toasts.at(-1)).toMatchObject({ message: 'Forgot "Fix the bug" and removed its worktree', variant: "success" })
    expect(fake.calls.filter((call) => Array.isArray(call) && call[0] === "tree").length).toBeGreaterThan(reads)

    const outcomes: [Forgotten, string, string][] = [
      [{ outcome: "forgotten" }, 'Forgot "Fix the bug"', "success"],
      [{ outcome: "gone" }, 'Forgot "Fix the bug"; its worktree was already gone', "success"],
      [{ outcome: "kept", reason: "1 uncommitted change (a.ts)" }, 'Kept "Fix the bug" and its worktree: 1 uncommitted change (a.ts)', "warning"],
    ]
    for (const [result, message, variant] of outcomes) {
      fake.state.cleanup = async () => result
      fake.command("x")!.run()
      await settle()
      expect(fake.state.toasts.at(-1)).toMatchObject({ message, variant })
    }
  })

  test("x on a live row forgets nothing and says why; a non-isolated gone row's confirm names no worktree; a refusal shows why", async () => {
    const fake = fakeContext(async () => empty)
    fake.state.tree = async () => ({ rows: [row("ses_live", { title: "Live" }), row("ses_gone", { title: "Gone", state: "gone" })] })
    fake.state.cleanup = async () => Promise.reject({ type: "refused", message: "ses_x is not above ses_gone" })
    await tui.setup(fake.context)
    const app = await renderPanel(fake.claim("session.panel"), panelInput().value)
    await app.waitForFrame((frame) => frame.includes("Gone"))

    fake.command("x")!.run()
    await settle()
    expect(fake.state.confirms).toEqual([])
    expect(fake.state.toasts.at(-1)).toMatchObject({ message: 'x forgets only a gone session; "Live" is idle.', variant: "warning" })

    fake.command("down")!.run()
    await app.waitForFrame((frame) => frame.includes("▸   Gone"))
    fake.command("x")!.run()
    await settle()
    expect(fake.state.confirms.at(-1)?.message).toBe('Forget "Gone" (ses_gone)? It leaves this tree and courier_children.')
    expect(fake.state.toasts.at(-1)).toMatchObject({ message: "ses_x is not above ses_gone", variant: "error" })
  })
})

/** Where `text` first shows in the app's frame: its column and line. */
function cellOf(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  const lines = app.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  if (y < 0) throw new Error(`no line with ${text}`)
  return { x: lines[y]!.indexOf(text), y }
}

/** The background of the cell where `text` starts, as integers. */
function backgroundOf(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  for (const line of app.captureSpans().lines) {
    const span = line.spans.find((one) => one.text.includes(text))
    if (span) return span.bg.toInts()
  }
  throw new Error(`no span with ${text}`)
}

describe("the tree panel's mouse (#250)", () => {
  /** Opens the panel on `pair(1)`, focused unless `focused` is false, and waits for its rows. */
  async function opened(focused = true) {
    const fake = fakeContext(async () => empty)
    fake.state.tree = async () => pair(1)
    await tui.setup(fake.context)
    const app = await renderPanel(fake.claim("session.panel"), panelInput("ses_parent", PANEL, { focused }).value)
    await app.waitForFrame((frame) => frame.includes("asks permission"))
    // The header's second line shows once the panel's size is known, which moves the rows down a line.
    await app.waitForFrame((frame) => frame.split("\n")[1]!.includes("1 waiting on you · 1 idle"))
    /** Moves the pointer to where `text` starts, `down` lines below it, and draws what follows. */
    const moveTo = async (text: string, down = 0) => {
      const at = cellOf(app, text)
      await app.mockMouse.moveTo(at.x, at.y + down)
      await app.renderOnce()
    }
    const click = async (text: string, button: MouseButton = MouseButtons.LEFT) => {
      const at = cellOf(app, text)
      await app.mockMouse.click(at.x, at.y, button)
      await app.renderOnce()
    }
    return { fake, app, moveTo, click }
  }

  test("a row under the pointer takes raised.base, over its title and detail lines, and gives it back once the pointer leaves", async () => {
    const { app, moveTo } = await opened()
    const rest = backgroundOf(app, "CHILD-ASKS")
    expect(backgroundOf(app, "asks permission")).toEqual(rest)
    await moveTo("CHILD-ASKS")
    expect(backgroundOf(app, "CHILD-ASKS")).toEqual(HOVER.toInts())
    expect(backgroundOf(app, "asks permission")).toEqual(HOVER.toInts())
    // The detail line is the same row: the hover stays on it.
    await moveTo("asks permission")
    expect(backgroundOf(app, "CHILD-ASKS")).toEqual(HOVER.toInts())
    await moveTo("courier tree")
    expect(backgroundOf(app, "CHILD-ASKS")).toEqual(rest)
    expect(backgroundOf(app, "asks permission")).toEqual(rest)
  })

  test("the selected row keeps the selection's colour under the pointer, and the hover moves neither ▸ nor what s and x act on", async () => {
    const { fake, app, moveTo } = await opened()
    const selection = backgroundOf(app, "Report back")
    expect(selection).toEqual(RGBA.fromInts(120, 120, 120).toInts())
    await moveTo("Report back")
    expect(backgroundOf(app, "Report back")).toEqual(selection)
    await moveTo("CHILD-ASKS")
    expect(app.captureCharFrame()).toContain("▸ ✓ Report back to your parent.")
    expect(app.captureCharFrame()).not.toContain("▸ ● CHILD-ASKS")
    fake.state.confirm = false
    fake.command("s")!.run()
    fake.command("x")!.run()
    await settle()
    expect(fake.state.confirms.at(-1)?.message).toStartWith('Stop "Report back to your parent." (ses_one)')
    expect(fake.state.toasts.at(-1)?.message).toBe('x forgets only a gone session; "Report back to your parent." is idle.')
    expect(fake.state.navigated).toEqual([])
  })

  test("the hover survives a read of the tree, which draws its rows anew, and leaves with its row", async () => {
    // Unfocused, so the selection, which the returning row takes, has no colour to hide a hover.
    const { fake, app, moveTo } = await opened(false)
    let tree = pair(1)
    fake.state.tree = async () => tree
    await moveTo("CHILD-ASKS")
    fake.command("r")!.run()
    await settle()
    await app.renderOnce()
    expect(backgroundOf(app, "CHILD-ASKS")).toEqual(HOVER.toInts())
    // Its row gone, nothing is under the pointer, and the hover goes: the row back, away from the pointer, is not hovered.
    const [first, second] = tree.rows
    tree = { rows: [first!] }
    fake.command("r")!.run()
    await app.waitForFrame((frame) => !frame.includes("CHILD-ASKS"))
    tree = { rows: [second!] }
    fake.command("r")!.run()
    await app.waitForFrame((frame) => frame.includes("CHILD-ASKS") && !frame.includes("Report back"))
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("▸ ● CHILD-ASKS")
    expect(backgroundOf(app, "CHILD-ASKS")).not.toEqual(HOVER.toInts())
  })

  test("a click on a row's title or detail line selects it and opens its session, as enter does", async () => {
    const { fake, app, click } = await opened()
    await click("CHILD-ASKS")
    expect(fake.state.navigated).toEqual([{ type: "session", sessionID: "ses_two" }])
    expect(app.captureCharFrame()).toContain("▸ ● CHILD-ASKS")
    await click("ran 2m 00s")
    expect(fake.state.navigated.at(-1)).toEqual({ type: "session", sessionID: "ses_one" })
    expect(app.captureCharFrame()).toContain("▸ ✓ Report back to your parent.")
  })

  test("a right-click, or a drag released on a row, even the one it started on, opens nothing", async () => {
    const { fake, app, click } = await opened()
    await click("CHILD-ASKS", MouseButtons.RIGHT)
    const from = cellOf(app, "Report back")
    const to = cellOf(app, "CHILD-ASKS")
    await app.mockMouse.drag(from.x, from.y, to.x, to.y)
    await app.renderOnce()
    await app.mockMouse.drag(to.x, to.y, to.x + 6, to.y)
    await app.renderOnce()
    const header = cellOf(app, "courier tree")
    await app.mockMouse.drag(header.x, header.y, to.x, to.y)
    await app.renderOnce()
    expect(fake.state.navigated).toEqual([])
    expect(app.captureCharFrame()).toContain("▸ ✓ Report back to your parent.")
  })

  test("a click opens a row while the panel does not have the keyboard", async () => {
    const { fake, click } = await opened(false)
    await click("CHILD-ASKS")
    expect(fake.state.navigated).toEqual([{ type: "session", sessionID: "ses_two" }])
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

  for (const width of [80, 100, 107]) {
    test(`a panel shown fullscreen only because the terminal is narrow reopens as a panel once followed, at ${width} columns`, async () => {
      await narrowThenFollowed(width, "panel")
    })
  }

  for (const width of [108, 160]) {
    test(`a panel shown fullscreen at ${width} columns was asked for, and reopens fullscreen once followed`, async () => {
      await narrowThenFollowed(width, "fullscreen")
    })
  }

  async function narrowThenFollowed(width: number, reopened: "panel" | "fullscreen") {
    const fake = fakeContext(async () => empty)
    fake.state.width = width
    fake.state.tree = async (sessionID) => ({ ses_parent: pair(1) })[sessionID as "ses_parent"] ?? { rows: [] }
    await tui.setup(fake.context)
    await fake.command("courier.command")!.run("tree")
    const app = await renderPanel(fake.claim("session.panel"), panelInput("ses_parent", PANEL, { presentation: "fullscreen" }).value)
    await app.waitForFrame((frame) => frame.includes("CHILD-ASKS"))

    fake.state.route = { type: "session", sessionID: "ses_two" }
    expect(fake.state.presentations.at(-1)).toBe(reopened)
  }

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
    expect(app.captureCharFrame()).toContain("▸ ● CHILD-ASKS (on screen)  waiting on you")
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
    // With the memory view's verb, which src/tui.tsx hands the command, in the usage.
    expect(fake.state.toasts.at(-1)).toMatchObject({ message: `${USAGE}; ${MEMORY_USAGE}`, variant: "warning" })
  })

  test("a further verb another module supplies runs, and its line joins the usage", async () => {
    const fake = fakeContext(async () => empty)
    const ran: string[] = []
    addTreePanel(fake.context, { memory: { run: () => void ran.push("memory"), usage: "/courier memory lists the records" } })
    const command = fake.command("courier.command")!
    expect(command.description).toBe(`${USAGE}; /courier memory lists the records`)

    await command.run("memory")
    expect(ran).toEqual(["memory"])
    await command.run("remember")
    expect(fake.state.toasts.at(-1)).toMatchObject({ message: `${USAGE}; /courier memory lists the records`, variant: "warning" })
    // The verbs are the command's own, not an object's: a prototype's name runs nothing.
    await command.run("constructor")
    expect(ran).toEqual(["memory"])
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

describe("an ask sounds once (#176)", () => {
  const setup = async (native: boolean) => {
    const fake = fakeContext(async () => empty, { location: { directory: "/w" }, sessions: { ses_parent: { title: "Parent" }, ses_kid: { title: "Kid" } } })
    const session = fake.context.data.session as any
    const get = session.get
    session.get = (id: string) => (native && id === "ses_kid" ? { ...get(id), parentID: "ses_parent" } : get(id))
    const rpc = (fake.context.client as any).rpc
    ;(fake.context.client as any).rpc = (d: any) => ({
      ...rpc(d),
      asks: async () => ({
        top: "ses_parent",
        sessions: [{ sessionID: "ses_kid", title: "Kid", parentID: "ses_parent", depth: 1 }],
        permissions: [{ sessionID: "ses_kid", requestID: "per_1", action: "shell", resources: ["echo hi"] }],
        questions: [],
      }),
    })
    ;(fake.context.client as any).session = { form: { list: async () => [] } }
    await tui.setup(fake.context)
    await (hostNotifications as any).setup(fake.context)
    fake.emit("permission.asked", { id: "per_1", sessionID: "ses_kid" })
    await settle()
    return fake
  }

  test("a child's permission request sounds once", async () => {
    const fake = await setup(false)
    expect(fake.state.notified.filter((n: any) => n.sound?.name === "permission")).toHaveLength(1)
    expect(fake.state.notified.filter((n: any) => n.notification)).toHaveLength(1)
  })

  test("a native child's still gets one blurred notification, with the sound once", async () => {
    const fake = await setup(true)
    expect(fake.state.notified.filter((n: any) => n.sound?.name === "permission")).toHaveLength(1)
    expect(fake.state.notified.filter((n: any) => n.notification)).toEqual([
      { title: "Parent › Kid", message: "Permission: shell echo hi", notification: { when: "blurred" }, sound: false },
    ])
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

/** Counts the panel's frame timers, the intervals of `FRAME_MS` set and not cleared, while fake timers run. */
function frameTimers() {
  const live = new Set<unknown>()
  const slow = new Set<unknown>()
  const set = globalThis.setInterval
  const clear = globalThis.clearInterval
  globalThis.setInterval = ((handler: () => void, ms?: number) => {
    const id = set(handler, ms)
    if (ms === FRAME_MS) live.add(id)
    if (ms === FRAME_MS * MASCOT_EVERY) slow.add(id)
    return id
  }) as typeof setInterval
  globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => {
    live.delete(id)
    slow.delete(id)
    clear(id)
  }) as typeof clearInterval
  return {
    count: () => live.size,
    /** The timer at Digby's own cadence, which runs while only he moves. */
    slow: () => slow.size,
    restore: () => {
      globalThis.setInterval = set
      globalThis.clearInterval = clear
    },
  }
}

describe("the tree panel's motion (#224)", () => {
  let timers: ReturnType<typeof frameTimers> | undefined
  afterEach(() => {
    timers?.restore()
    timers = undefined
    jest.useRealTimers()
  })

  /** Opens the panel, unfocused so no selection colours a row, on the trees `trees()` gives, with fake timers and `options`. */
  async function motion(trees: () => Tree, options: Record<string, unknown> = {}, height = 24, width = 100, under?: RGBA) {
    jest.useFakeTimers()
    timers = frameTimers()
    const fake = fakeContext(async () => empty)
    Object.assign(fake.context, { options })
    fake.state.tree = async () => trees()
    await tui.setup(fake.context)
    const [name, setName] = createSignal(PANEL)
    const value = Object.defineProperty(panelInput("ses_parent", PANEL, { focused: false }).value, "name", { get: name })
    const app = await renderPanel(fake.claim("session.panel"), value, height, width, under)
    const frame = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve()
      await app.renderOnce()
      return app.captureCharFrame()
    }
    /** Moves the fake clock by `ms` and draws what follows. */
    const advance = async (ms: number) => {
      jest.advanceTimersByTime(ms)
      return frame()
    }
    const refresh = async () => {
      fake.command("r").run()
      return frame()
    }
    /** The background of the cell where `text` starts, as integers. */
    const background = (text: string) => {
      for (const line of app.captureSpans().lines) {
        const span = line.spans.find((one) => one.text.includes(text))
        if (span) return span.bg.toInts()
      }
      throw new Error(`no span with ${text}`)
    }
    await frame()
    await frame()
    /** The header glyph's two lines, as drawn, or undefined with none. */
    const glyphShown = async (): Promise<string[] | undefined> => {
      const lines = (await frame()).split("\n")
      return lines[0]!.includes("courier tree") && lines[0]!.indexOf("courier tree") > 1 ? [lines[0]!.slice(1, 9), lines[1]!.slice(1, 9)] : undefined
    }
    return { app, frame, advance, refresh, background, glyph: glyphShown, hide: () => setName("someone-else"), tokens: digbyColours(fake.context.theme as never) }
  }

  const running = (): Tree => ({ rows: [row("ses_run", { state: "running" })] })

  test("a running row's mark spins a frame every FRAME_MS, on the panel's one timer, which stops once the panel is hidden", async () => {
    const panel = await motion(running)
    expect(await panel.frame()).toContain("⠋ ses_run  running")
    expect(timers!.count()).toBe(1)
    expect(await panel.advance(FRAME_MS)).toContain("⠙ ses_run  running")
    expect(await panel.advance(FRAME_MS * 9)).toContain("⠋ ses_run  running")
    panel.hide()
    await panel.frame()
    expect(timers!.count()).toBe(0)
  })

  test("no frame-rate timer runs with nothing to animate, and none once a running row goes idle: only Digby's slower one", async () => {
    let state: Row["state"] = "idle"
    const panel = await motion(() => ({ rows: [row("ses_a", { state })] }))
    expect(timers!.count()).toBe(0)
    expect(timers!.slow()).toBe(1)
    state = "running"
    await panel.refresh()
    expect(timers!.count()).toBe(1)
    state = "idle"
    expect(await panel.refresh()).toContain("   ses_a  idle")
    expect(timers!.count()).toBe(0)
  })

  test("a report flashes its row once, in the theme's success background, which fades back over FLASH_MS", async () => {
    let state: "owed" | "reported" = "owed"
    const panel = await motion(() => ({ rows: [row("ses_one", { report: state === "reported" ? { state, status: "done", progressed: false } : { state, progressed: false } }), row("ses_two")] }))
    const rest = panel.background("ses_two")
    expect(panel.background("ses_one")).toEqual(rest)
    state = "reported"
    expect(await panel.refresh()).toContain("✓ ses_one  idle · reported done")
    expect(panel.background("ses_one")).toEqual(FLASH.toInts())
    expect(panel.background("ses_two")).toEqual(rest)
    expect(timers!.count()).toBe(1)
    await panel.advance(FLASH_MS / 2)
    const halfway = panel.background("ses_one")
    expect(halfway[1]).toBeGreaterThan(0)
    expect(halfway[1]).toBeLessThan(200)
    await panel.advance(FLASH_MS / 2 + FRAME_MS)
    expect(panel.background("ses_one")).toEqual(rest)
    expect(timers!.count()).toBe(0)
    // Read again still reported, it does not flash again.
    await panel.refresh()
    expect(panel.background("ses_one")).toEqual(rest)
    expect(timers!.count()).toBe(0)
  })

  test("a hovered row's flash fades back to the hover's colour (#250)", async () => {
    let state: "owed" | "reported" = "owed"
    const panel = await motion(() => ({ rows: [row("ses_one", { report: state === "reported" ? { state, status: "done", progressed: false } : { state, progressed: false } }), row("ses_two")] }))
    const at = cellOf(panel.app, "ses_one")
    await panel.app.mockMouse.moveTo(at.x, at.y)
    await panel.frame()
    expect(panel.background("ses_one")).toEqual(HOVER.toInts())
    state = "reported"
    await panel.refresh()
    expect(panel.background("ses_one")).toEqual(FLASH.toInts())
    await panel.advance(FLASH_MS / 2)
    expect(panel.background("ses_one")).not.toEqual(HOVER.toInts())
    await panel.advance(FLASH_MS / 2 + FRAME_MS)
    expect(panel.background("ses_one")).toEqual(HOVER.toInts())
  })

  test("the header's bar grows to its new length over BAR_MS, its count at once", async () => {
    let reported = 1
    const panel = await motion(() => pair(reported))
    expect(await panel.frame()).toContain("[█████░░░░░] 1/2 reported")
    reported = 2
    expect(await panel.refresh()).toContain("[█████░░░░░] 2/2 reported")
    const step = await panel.advance(FRAME_MS)
    expect(step).toContain("2/2 reported")
    expect(step).not.toContain("[█████░░░░░]")
    expect(step).not.toContain("[██████████]")
    expect(await panel.advance(BAR_MS)).toContain("[██████████] 2/2 reported")
    // The flash of the row that reported holds a while longer.
    await panel.advance(FLASH_MS)
    expect(timers!.count()).toBe(0)
  })

  test("the first report of a tree shown at 0 reported eases the bar too", async () => {
    let reported = 0
    const report = (done: boolean): Row["report"] => (done ? { state: "reported", status: "done", progressed: false } : { state: "owed", progressed: false })
    const panel = await motion(() => ({ rows: [row("ses_one", { report: report(reported > 0) }), row("ses_two", { report: report(reported > 1) })] }))
    expect(await panel.frame()).toContain("[░░░░░░░░░░] 0/2 reported")
    reported = 1
    expect(await panel.refresh()).toContain("[░░░░░░░░░░] 1/2 reported")
    const step = await panel.advance(FRAME_MS)
    expect(step).not.toContain("[░░░░░░░░░░]")
    expect(step).not.toContain("[█████░░░░░]")
    expect(await panel.advance(BAR_MS)).toContain("[█████░░░░░] 1/2 reported")
    await panel.advance(FLASH_MS)
    expect(timers!.count()).toBe(0)
  })

  test("with \"animations\": false nothing moves: the running mark stays •, a report does not flash, the bar jumps", async () => {
    let reported = 1
    let state: Row["state"] = "running"
    const tree = (): Tree => ({ rows: [...pair(reported).rows, row("ses_run", { state })] })
    const panel = await motion(tree, { animations: false })
    expect(await panel.frame()).toContain("[███░░░░░░░] 1/3 reported")
    expect(await panel.advance(FRAME_MS * 3)).toContain("• ses_run  running")
    const rest = panel.background("ses_run")
    reported = 2
    expect(await panel.refresh()).toContain("[███████░░░] 2/3 reported")
    expect(panel.background("CHILD-ASKS")).toEqual(rest)
    expect(timers!.count()).toBe(0)
    state = "idle"
    await panel.refresh()
    expect(timers!.count()).toBe(0)
  })

  /** The glyph's two lines of cells as the panel draws them, for `state` at mascot frame `frame`. */
  const drawn = (state: MascotState, frame?: number) => cells(glyph(state, frame)).map((line) => line.map((one) => one.char).join(""))

  /** Each glyph the panel shows over `steps` of Digby's frames. */
  const seen = async (panel: Awaited<ReturnType<typeof motion>>, steps: number) => {
    const shown: string[][] = []
    for (let i = 0; i < steps; i++) {
      shown.push((await panel.glyph())!)
      await panel.advance(FRAME_MS * MASCOT_EVERY)
    }
    return shown
  }

  test("Digby's header glyph cycles each state's frames for its tree state, at his own cadence while only he moves (#226)", async () => {
    let state: Row["state"] = "idle"
    const panel = await motion(() => ({ rows: [row("ses_a", { state }), row("ses_b", { state: state === "gone" ? "gone" : "idle" })] }), {}, GLYPH_ROWS)
    expect(await panel.glyph()).toEqual(drawn("idle", 0))
    expect(await seen(panel, 4)).toContainEqual(drawn("idle", 2))
    expect(timers!.count()).toBe(0)
    expect(timers!.slow()).toBe(1)
    for (const next of ["running", "waiting", "stalled"] as const) {
      state = next
      await panel.refresh()
      const shown = await seen(panel, 4)
      for (const frame of GLYPH[next].keys()) expect(shown).toContainEqual(drawn(next, frame))
    }
    expect(await panel.frame()).toContain("1 stalled · 1 idle")
    state = "gone"
    await panel.refresh()
    expect(await panel.glyph()).toEqual(drawn("gone"))
    expect(timers!.count() + timers!.slow()).toBe(0)
  })

  test("a report, then a spawn, shows Digby's pose for FLASH_MS, then the tree's state again (#226)", async () => {
    let reported = false
    let spawned = false
    const panel = await motion(() => ({
      rows: [
        row("ses_one", { report: reported ? { state: "reported", status: "done", progressed: false } : { state: "owed", progressed: false } }),
        ...(spawned ? [row("ses_new")] : []),
      ],
    }), {}, GLYPH_ROWS)
    expect(await panel.glyph()).toEqual(drawn("idle", 0))
    reported = true
    await panel.refresh()
    expect(GLYPH.report.map((_, frame) => drawn("report", frame))).toContainEqual((await panel.glyph())!)
    await panel.advance(FLASH_MS - FRAME_MS * 2)
    expect(GLYPH.report.map((_, frame) => drawn("report", frame))).toContainEqual((await panel.glyph())!)
    await panel.advance(FRAME_MS * 3)
    expect(GLYPH.idle.map((_, frame) => drawn("idle", frame)).concat([drawn("idle", 2)])).toContainEqual((await panel.glyph())!)
    spawned = true
    await panel.refresh()
    expect(GLYPH.spawn.map((_, frame) => drawn("spawn", frame))).toContainEqual((await panel.glyph())!)
    await panel.advance(FLASH_MS + FRAME_MS)
    expect(GLYPH.idle.map((_, frame) => drawn("idle", frame)).concat([drawn("idle", 2)])).toContainEqual((await panel.glyph())!)
    // Read again with the same sessions, nothing new arrived.
    await panel.refresh()
    expect(GLYPH.spawn.map((_, frame) => drawn("spawn", frame))).not.toContainEqual((await panel.glyph())!)
  })

  test("a panel too short for the glyph's two rows, or too narrow for it beside the bar, shows none and runs no timer for it (#226)", async () => {
    const panel = await motion(() => ({ rows: [row("ses_a")] }), {}, GLYPH_ROWS - 1)
    expect(await panel.glyph()).toBeUndefined()
    expect((await panel.frame()).split("\n")[0]).toStartWith(" courier tree  [")
    expect(timers!.count() + timers!.slow()).toBe(0)
    timers!.restore()
    jest.useRealTimers()
    const narrow = await motion(() => ({ rows: [row("ses_a")] }), {}, GLYPH_ROWS, GLYPH_COLUMNS - 1)
    expect(await narrow.glyph()).toBeUndefined()
    expect((await narrow.frame()).split("\n")[0]).toContain("courier tree  [░░░░░░░░░░] 0/1 reported")
    expect(timers!.count() + timers!.slow()).toBe(0)
  })

  test("with \"animations\": false Digby shows each state's first frame and stays still (#226)", async () => {
    let state: Row["state"] = "waiting"
    let reported = false
    const panel = await motion(
      () => ({ rows: [row("ses_a", { state, report: reported ? { state: "reported", status: "done", progressed: false } : { state: "owed", progressed: false } })] }),
      { animations: false },
      GLYPH_ROWS,
    )
    for (const next of ["waiting", "running", "stalled", "idle"] as const) {
      state = next
      await panel.refresh()
      expect(await panel.glyph()).toEqual(drawn(next))
      await panel.advance(FRAME_MS * MASCOT_EVERY * 3)
      expect(await panel.glyph()).toEqual(drawn(next))
    }
    reported = true
    await panel.refresh()
    expect(await panel.glyph()).toEqual(drawn("idle"))
    expect(timers!.count() + timers!.slow()).toBe(0)
  })

  /** The 16×16's lines as the panel draws them, for `state` at mascot frame `frame`. */
  const drawnArt = (state: MascotState, frame?: number) => art(state, frame).map((line) => line.map((one) => one.char).join(""))

  /** The 16×16 the panel shows, its eight lines ending on the ground's full one, or undefined with none. */
  const artIn = (frame: string) => {
    const lines = frame.split("\n").map((line) => line.slice(1, 17))
    const ground = lines.lastIndexOf("█".repeat(16))
    return ground < 7 ? undefined : lines.slice(ground - 7, ground + 1)
  }

  /** The frame counts of each state's 16×16, idle's breathing and drifting `z` taking four. */
  const artFrames = (state: MascotState) => (state === "idle" ? 4 : ART[state].length)

  test("the empty panel shows the 16×16 idle Digby where there is room, breathing, and no header glyph (#226, #245)", async () => {
    const panel = await motion(() => ({ rows: [] }))
    const frame = await panel.frame()
    expect(frame).toContain("No session started with courier_spawn under this one.")
    expect(artIn(frame)).toEqual(drawnArt("idle", 0))
    expect(await panel.glyph()).toBeUndefined()
    expect(timers!.slow()).toBe(1)
    expect(artIn(await panel.advance(FRAME_MS * MASCOT_EVERY * 2))).toEqual(drawnArt("idle", 2))
    timers!.restore()
    jest.useRealTimers()
    const short = await motion(() => ({ rows: [] }), {}, ART_ROWS - 1)
    expect(artIn(await short.frame())).toBeUndefined()
    expect(await short.glyph()).toBeDefined()
  })

  test("with BELOW_ROWS free under the last row the 16×16 shows there in the tree's state, each frame, and the header drops its glyph (#245)", async () => {
    let state: Row["state"] = "waiting"
    const panel = await motion(() => ({ rows: [row("ses_a", { state }), row("ses_b", { state: state === "gone" ? "gone" : "idle" })] }))
    for (const next of ["waiting", "stalled", "running", "idle", "gone"] as const) {
      state = next
      await panel.refresh()
      const shown: Array<string[] | undefined> = []
      for (let step = 0; step < 4; step++) {
        const frame = await panel.frame()
        shown.push(artIn(frame))
        expect(await panel.glyph()).toBeUndefined()
        expect(frame).toContain("courier tree")
        await panel.advance(FRAME_MS * MASCOT_EVERY)
      }
      for (let frame = 0; frame < Math.min(artFrames(next), 4); frame++) expect(shown).toContainEqual(drawnArt(next, frame))
    }
    expect(timers!.count() + timers!.slow()).toBe(0)
  })

  test("the 16×16 shows below the rows from BELOW_ROWS free rows, the header's glyph below that (#245)", async () => {
    // Two header lines, the footer, and one row with its detail line leave the list `height - 5` rows free.
    const free = (height: number) => height - 5
    const at = async (height: number) => {
      timers?.restore()
      jest.useRealTimers()
      const panel = await motion(() => ({ rows: [row("ses_a", { state: "waiting" })] }), {}, height)
      return { art: artIn(await panel.frame()), glyph: await panel.glyph() }
    }
    const room = BELOW_ROWS + 5
    expect(free(room)).toBe(BELOW_ROWS)
    expect(await at(room)).toEqual({ art: drawnArt("waiting", 0), glyph: undefined })
    expect(await at(room - 1)).toEqual({ art: undefined, glyph: drawn("waiting", 0) })
  })

  test("a report or a spawn shows its 16×16 below the rows while it holds (#245)", async () => {
    let reported = false
    let spawned = false
    const panel = await motion(() => ({
      rows: [
        row("ses_one", { report: reported ? { state: "reported", status: "done", progressed: false } : { state: "owed", progressed: false } }),
        ...(spawned ? [row("ses_new")] : []),
      ],
    }))
    reported = true
    await panel.refresh()
    expect(ART.report.map((_, frame) => drawnArt("report", frame))).toContainEqual(artIn(await panel.frame())!)
    await panel.advance(FLASH_MS + FRAME_MS)
    spawned = true
    await panel.refresh()
    expect(ART.spawn.map((_, frame) => drawnArt("spawn", frame))).toContainEqual(artIn(await panel.frame())!)
  })

  test("with \"animations\": false the 16×16 shows each state's first frame, still, and no timer runs for it (#245)", async () => {
    let state: Row["state"] = "waiting"
    const panel = await motion(() => ({ rows: [row("ses_a", { state })] }), { animations: false })
    for (const next of ["waiting", "running", "stalled", "idle", "gone"] as const) {
      state = next
      await panel.refresh()
      expect(artIn(await panel.frame())).toEqual(drawnArt(next))
      expect(artIn(await panel.advance(FRAME_MS * MASCOT_EVERY * 3))).toEqual(drawnArt(next))
    }
    expect(timers!.count() + timers!.slow()).toBe(0)
  })

  /** The tree's states Digby shows when no report or spawn holds his pose. */
  const STEADY = ["idle", "running", "waiting", "stalled", "gone"] as const

  /** The host's background under the panel, as it paints a split one. */
  const UNDER = RGBA.fromInts(10, 20, 30)

  /** A panel on `UNDER` whose tree `go`, `report` and `spawn` move, and `holds`, which reads Digby back cell by cell, chars and backgrounds. */
  async function poses(where: "header" | "below") {
    let state: Row["state"] = "idle"
    let reported = false
    let spawned = 0
    const panel = await motion(
      () => ({
        rows: [
          row("ses_a", { state, report: reported ? { state: "reported", status: "done", progressed: false } : { state: "owed", progressed: false } }),
          ...Array.from({ length: spawned }, (_, at) => row(`ses_new${at}`, { state })),
        ],
      }),
      {},
      where === "header" ? GLYPH_ROWS : 40,
      100,
      UNDER,
    )
    const [height, width] = where === "header" ? [2, 8] : [8, 16]
    const expected = (lines: ReturnType<typeof art>) => ({
      chars: lines.map((line) => line.map((one) => one.char).join("")),
      backgrounds: lines.map((line) => line.map((one) => (one.bg ? panel.tokens[one.bg] : UNDER).toInts())),
    })
    const shown = async () => {
      const lines = (await panel.frame()).split("\n")
      const top = where === "header" ? 0 : lines.findLastIndex((line) => line.slice(1, 17) === "█".repeat(16)) - 7
      return {
        chars: lines.slice(top, top + height).map((line) => line.slice(1, 1 + width)),
        backgrounds: panel.app
          .captureSpans()
          .lines.slice(top, top + height)
          .map((line) => line.spans.flatMap((span) => Array.from({ length: span.width }, () => span.bg.toInts())).slice(1, 1 + width)),
      }
    }
    /** Digby shows one of `pose`'s frames, each cell's background its own token's or the panel's, now and for `steps` frames on. */
    const holds = async (pose: MascotState, steps = 3) => {
      // Every frame until the cycles of 2, 3 and 4 frames and the blink line up again.
      const each = Array.from({ length: BLINK_EVERY * 12 }, (_, frame) => JSON.stringify(expected(where === "header" ? cells(glyph(pose, frame)) : art(pose, frame))))
      const frames = [...new Set(each)].map((one) => JSON.parse(one))
      expect(frames).toContainEqual(await shown())
      for (let step = 0; step < steps; step++) {
        await panel.advance(FRAME_MS * MASCOT_EVERY)
        expect(frames).toContainEqual(await shown())
      }
    }
    return {
      holds,
      advance: panel.advance,
      go: async (next: Row["state"]) => {
        state = next
        await panel.refresh()
      },
      report: async () => {
        reported = false
        await panel.refresh()
        reported = true
        await panel.refresh()
      },
      spawn: async () => {
        spawned++
        await panel.refresh()
      },
      settle: () => panel.advance(FLASH_MS + FRAME_MS),
    }
  }

  for (const where of ["header", "below"] as const)
    test(`no cell of Digby's ${where === "header" ? "header glyph" : "16×16 below the rows"} keeps a background the pose he moves to does not give it (#281)`, async () => {
      const digby = await poses(where)
      for (const from of STEADY)
        for (const to of STEADY.filter((one) => one !== from)) {
          await digby.go(from)
          await digby.holds(from)
          await digby.go(to)
          await digby.holds(to)
        }
      for (const under of STEADY) {
        await digby.go(under)
        await digby.report()
        await digby.holds("report", 2)
        await digby.settle()
        await digby.holds(under)
        await digby.spawn()
        await digby.holds("spawn", 2)
        await digby.settle()
        await digby.holds(under)
      }
      // A spawn during a report shows once the report ends; a report during a spawn shows at once.
      await digby.go("idle")
      await digby.report()
      await digby.advance(FRAME_MS * MASCOT_EVERY * 2)
      await digby.spawn()
      await digby.advance(FLASH_MS - FRAME_MS * MASCOT_EVERY * 2 + FRAME_MS)
      await digby.holds("spawn", 1)
      await digby.report()
      await digby.holds("report", 1)
    })
})

describe("Digby, the tree panel's mascot (#226)", () => {
  test("his state follows the tree by the footer's priority, a report or a spawn first", () => {
    const rows = (...states: Row["state"][]) => states.map((state, at) => row(`ses_${at}`, { state }))
    expect(mascotState([])).toBe("idle")
    expect(mascotState(rows("idle", "gone"))).toBe("idle")
    expect(mascotState(rows("gone", "gone"))).toBe("gone")
    expect(mascotState(rows("running", "idle"))).toBe("running")
    expect(mascotState(rows("running", "stalled"))).toBe("stalled")
    expect(mascotState(rows("stalled", "waiting"))).toBe("waiting")
    expect(mascotState(rows("waiting"), { spawned: true })).toBe("spawn")
    expect(mascotState(rows("waiting"), { spawned: true, reported: true })).toBe("report")
  })

  test("the header's second line counts what the sessions do, live ones only", () => {
    expect(countsLine([row("a", { state: "running" }), row("b", { state: "waiting" }), row("c", { state: "running" }), row("d", { state: "gone" })])).toBe(
      "1 waiting on you · 2 running",
    )
    expect(countsLine([row("a", { state: "gone" })])).toBe("")
  })

  test("a cell is ▀ over a differing bottom pixel, ▄ with only a bottom one, █ with two alike, blank with none", () => {
    expect(cells(["bb.b", "gb.."])).toEqual([[{ char: "▀", fg: "b", bg: "g" }, { char: "█", fg: "b" }, { char: " " }, { char: "▀", fg: "b" }]])
    expect(cells(["..", "g."])).toEqual([[{ char: "▄", fg: "g" }, { char: " " }]])
  })

  test("he blinks every eleventh frame where his eyes are open, and the idle mound breathes", () => {
    expect(glyph("waiting", 10).join("")).not.toContain("k")
    expect(glyph("waiting", 9).join("")).toContain("k")
    expect(glyph("stalled", 10).join("")).toContain("k")
    expect(glyph("idle", 2)[2]).toBe(".gggggg.")
    expect(glyph("idle")[2]).toBe("..gggg..")
  })

  test("no muted pixel touches the mound, in the 8×4 or the 16×16 (#248, #251)", () => {
    const touching = (pixels: ReadonlyArray<string>) =>
      pixels.flatMap((line, row) =>
        [...line].flatMap((pixel, column) =>
          pixel === "m" && [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([down, right]) => pixels[row + down!]?.[column + right!] === "g") ? [[row, column]] : [],
        ),
      )
    // The cells' pixels back, two rows to a line; a character such as idle's `z` fills both with its colour.
    const unfold = (lines: ReadonlyArray<ReadonlyArray<{ char: string; fg?: string; bg?: string }>>) =>
      lines.flatMap((line) => {
        const halves = line.map(({ char, fg, bg }) =>
          char === " " ? [".", "."] : char === "▄" ? [".", fg!] : char === "▀" ? [fg!, bg ?? "."] : [fg!, fg!],
        )
        return [halves.map(([top]) => top).join(""), halves.map(([, bottom]) => bottom).join("")]
      })
    // Frames 0 to 43 cover every frame of every state with the blink (11) and the breathing (4).
    const frames = Array.from({ length: 44 }, (_, frame) => frame)
    for (const state of Object.keys(GLYPH) as MascotState[])
      for (const frame of [undefined, ...frames]) {
        expect({ state, frame, touching: touching(glyph(state, frame)) }).toEqual({ state, frame, touching: [] })
        expect({ state, frame, touching: touching(unfold(art(state, frame))) }).toEqual({ state, frame, touching: [] })
      }
  })

  test("no 16×16 frame covers the body's columns 6 to 9 on the mound's top row with mound (#286)", () => {
    for (const [state, frames] of Object.entries(ART))
      frames.forEach((frame, at) => expect({ state, at, row: frame(true)[10]!.slice(6, 10).replace(/[bk.a]/g, "") }).toEqual({ state, at, row: "" }))
  })

  test("his frames, as the panel draws them", () => {
    const draw = (pixels: ReadonlyArray<string>) => cells(pixels).map((line) => line.map((one) => one.char).join(""))
    const glyphs = Object.fromEntries(Object.entries(GLYPH).map(([state, frames]) => [state, frames.map((frame) => ({ pixels: frame, drawn: draw(frame) }))]))
    const rises = Object.fromEntries([-0.3, 0.12, 0.7, 1, 1.25].map((rise) => [rise, draw(digby(rise))]))
    const drawnArt = (state: MascotState, frame: number) => art(state, frame).map((line) => line.map((one) => one.char).join(""))
    const arts = Object.fromEntries(
      (["idle", ...Object.keys(ART)] as MascotState[]).map((state) => [
        state,
        Array.from({ length: state === "idle" ? 4 : ART[state as Exclude<MascotState, "idle">].length }, (_, frame) => drawnArt(state, frame)),
      ]),
    )
    const pixels = Object.fromEntries(Object.entries(ART).map(([state, frames]) => [state, frames.map((frame) => frame(true))]))
    expect({ glyphs, rises, arts, pixels }).toMatchSnapshot()
  })
})

describe("the tree panel's motion, its pieces", () => {
  test("animations are on unless the options say false", () => {
    expect(animationsOn(undefined)).toBe(true)
    expect(animationsOn({})).toBe(true)
    expect(animationsOn({ animations: true })).toBe(true)
    expect(animationsOn({ animations: false })).toBe(false)
  })

  test("a running row's mark is the spinner's frame, • with none", () => {
    const running = row("ses_a", { state: "running" })
    expect(rowMark(running, { text: { feedback: THEME } }, 0).mark).toBe(SPINNER[0]!)
    expect(rowMark(running, { text: { feedback: THEME } }, SPINNER.length + 3).mark).toBe(SPINNER[3]!)
    expect(rowMark(running, { text: { feedback: THEME } }).mark).toBe("•")
    expect(rowMark(row("ses_a", { state: "waiting" }), { text: { feedback: THEME } }, 4).mark).toBe("●")
  })

  test("a bar eases by its filled cells, clamped to its width", () => {
    expect(filledCells({ reported: 1, started: 2 })).toBe(5)
    expect(bar({ reported: 2, started: 2 }, 10, 6.6)).toBe("[███████░░░] 2/2 reported")
    expect(bar({ reported: 2, started: 2 }, 10, 12)).toBe("[██████████] 2/2 reported")
    expect(bar({ reported: 0, started: 2 }, 10, -1)).toBe("[░░░░░░░░░░] 0/2 reported")
  })

  test("a report holds for FLASH_MS, and a predicate given to animates keeps the frames coming", async () => {
    jest.useFakeTimers()
    const timers = frameTimers()
    try {
      const [rows, setRows] = createSignal<ReadonlyArray<Row>>([row("ses_a")])
      const [breathing, setBreathing] = createSignal(true)
      const { motion, flashes, dispose } = createRoot((dispose) => {
        const motion = createMotion(true)
        motion.animates(breathing)
        return { motion, flashes: createFlashes(motion, rows), dispose }
      })
      expect(timers.count()).toBe(1)
      jest.advanceTimersByTime(FRAME_MS * 5)
      expect(motion.frame()).toBe(5)
      expect(flashes.reported()).toBe(false)
      setRows([row("ses_a", { report: { state: "reported", progressed: false } })])
      expect(flashes.reported()).toBe(true)
      expect(flashes.strength("ses_a")).toBe(1)
      setBreathing(false)
      // The hold ends on the first frame at or past FLASH_MS.
      jest.advanceTimersByTime((Math.ceil(FLASH_MS / FRAME_MS) - 1) * FRAME_MS)
      expect(flashes.reported()).toBe(true)
      jest.advanceTimersByTime(FRAME_MS)
      expect(flashes.reported()).toBe(false)
      expect(flashes.strength("ses_a")).toBe(0)
      expect(timers.count()).toBe(0)
      dispose()
    } finally {
      timers.restore()
      jest.useRealTimers()
    }
  })

  test("a blend goes from the rest colour to the tint", () => {
    const tint = RGBA.fromInts(0, 200, 0)
    const rest = RGBA.fromInts(100, 0, 0)
    expect(blend(tint, rest, 1).toInts()).toEqual([0, 200, 0, 255])
    expect(blend(tint, rest, 0).toInts()).toEqual([100, 0, 0, 255])
    expect(blend(tint, rest, 0.5).toInts()).toEqual([50, 100, 0, 255])
  })
})

describe("Digby's colours", () => {
  const hex = RGBA.fromHex
  // The resolved `opencode` theme (see the PR): dark's accent is #fab283, light's is the v1 theme's #ec5b2b.
  const themes = {
    dark: { base: "#0a0a0a", text: "#eeeeee", max: "#4c4c4c", selected: "#fab283" },
    light: { base: "#ffffff", text: "#1a1a1a", max: "#bebcb9", selected: "#ec5b2b" },
  }
  for (const [mode, one] of Object.entries(themes)) {
    const colours = digbyColours({
      text: { base: hex(one.text), muted: hex("#808080"), action: { primary: { base: hex(one.text), selected: hex(one.selected) } }, feedback: THEME },
      background: { base: hex(one.base), raised: { high: hex(one.base), max: hex(one.max) } },
    } as never)
    test(`the mound differs from the background in the default ${mode} theme`, () => {
      expect(colours.g.equals(colours.k)).toBe(false)
    })
    test(`the snout and letter differ from the body in the default ${mode} theme`, () => {
      expect(colours.a.equals(colours.b)).toBe(false)
    })
  }
})

describe("a hovered row's colour (#250)", () => {
  const hex = RGBA.fromHex
  // The default `opencode` theme at v2.0.32 (packages/tui/src/theme/assets/v2/opencode.json), resolved with @opencode/theme.
  const themes = {
    dark: { base: "#0a0a0a", raised: "#141414", high: "#1e1e1e" },
    light: { base: "#ffffff", raised: "#fafafa", high: "#f5f5f5" },
  }
  for (const [mode, one] of Object.entries(themes)) {
    const theme = { background: { base: hex(one.base), raised: { base: hex(one.raised), high: hex(one.high), max: hex(one.high) } } } as never
    test(`a hovered row differs from the panel and from the selection in the default ${mode} theme`, () => {
      const hovered = restBackground(theme, { selected: false, hovered: true })!
      expect(hovered.equals(hex(one.base))).toBe(false)
      expect(hovered.equals(restBackground(theme, { selected: true, hovered: true })!)).toBe(false)
      expect(restBackground(theme, { selected: false, hovered: false })).toBeUndefined()
    })
  }
})
