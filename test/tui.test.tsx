// The TUI part against a fake TUI context, rendered headless by OpenTUI's test renderer.
import { afterEach, describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { SlotClaim } from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { Summary } from "../src/tree/rpc.js"
import { addTreeStatus, SETTLE_MS, summaryLine } from "../src/tree/tui.js"
import tui from "../src/tui.js"

const empty: Summary = { running: 0, waiting: 0, idle: 0, groups: [] }

/** A fake TUI context whose RPC answers `answer` for each session; the calls, the slot claimed and the event listeners are kept. */
function fakeContext(
  answer: (sessionID: string) => Promise<Summary>,
  { location, sessions = {} }: { location?: { directory: string }; sessions?: Record<string, { directory: string }> } = { location: { directory: "/workspace" } },
) {
  const calls: unknown[] = []
  const listeners = new Set<(event: { details: { type: string } }) => void>()
  const state = { claim: undefined as SlotClaim | undefined, released: 0 }
  const context = {
    location,
    data: {
      location: { default: () => ({ directory: "/default" }) },
      session: { get: (sessionID: string) => (sessions[sessionID] ? { id: sessionID, location: sessions[sessionID] } : undefined) },
      listen: (handler: (event: { details: { type: string } }) => void) => {
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
    },
    theme: { text: { muted: RGBA.fromInts(120, 120, 120) } },
    client: {
      rpc: () => ({
        summary: async (input: { sessionID: string }, options: unknown) => {
          calls.push([input, options])
          return answer(input.sessionID)
        },
      }),
    },
    ui: {
      slot: (value: SlotClaim) => {
        state.claim = value
        return () => void state.released++
      },
    },
    // The asks inbox's command, which test/inbox.test.tsx tests.
    keymap: { layer: () => undefined },
  } as unknown as Plugin.Context
  const emit = (type: string) => {
    for (const listener of listeners) listener({ details: { type } })
  }
  return { context, calls, listeners, state, emit }
}

const renderers: { renderer: { destroy(): void } }[] = []
afterEach(() => {
  for (const app of renderers.splice(0)) app.renderer.destroy()
})

/** Renders the claimed footer slot for the session `sessionID()` gives, 80 columns wide. */
async function renderFooter(claim: SlotClaim | undefined, sessionID: () => string | undefined) {
  expect(claim?.append).toBe("prompt.footer.status")
  const render = claim!.render as (input: unknown) => any
  const app = await testRender(
    () =>
      render({
        get sessionID() {
          return sessionID()
        },
        mode: "normal",
        showDetails: true,
      }),
    { width: 80, height: 2 },
  )
  renderers.push(app)
  return app
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 50))

describe("summaryLine", () => {
  test("names what the sessions do and each group's standing, leaving out what is zero", () => {
    expect(summaryLine({ running: 2, waiting: 1, idle: 0, groups: [{ name: "pair", reported: 1, members: 2 }] })).toBe(
      "courier 2 running · 1 waiting on you · group pair 1/2",
    )
    expect(summaryLine({ ...empty, idle: 3 })).toBe("courier 3 idle")
    expect(summaryLine({ ...empty, running: 20, truncated: 20 })).toBe("courier 20 running · first 20 counted")
  })

  test("is empty for a session that started none", () => {
    expect(summaryLine(empty)).toBe("")
  })
})

describe("the footer status entry", () => {
  test("shows the summary the server's RPC gives for the open session, asked at the TUI's location", async () => {
    const fake = fakeContext(async () => ({ running: 2, waiting: 1, idle: 0, groups: [{ name: "pair", reported: 1, members: 2 }] }))
    await tui.setup(fake.context)
    const app = await renderFooter(fake.state.claim, () => "ses_parent")

    await app.waitForFrame((frame) => frame.includes("group pair"))
    expect(app.captureCharFrame()).toContain("courier 2 running · 1 waiting on you · group pair 1/2")
    expect(fake.calls).toEqual([[{ sessionID: "ses_parent" }, { location: { directory: "/workspace" } }]])
  })

  test("asks at the open session's own location when the TUI knows it", async () => {
    const fake = fakeContext(async () => ({ ...empty, idle: 1 }), { location: { directory: "/workspace" }, sessions: { ses_parent: { directory: "/project" } } })
    await tui.setup(fake.context)
    const app = await renderFooter(fake.state.claim, () => "ses_parent")

    await app.waitForFrame((frame) => frame.includes("courier 1 idle"))
    expect(fake.calls).toEqual([[{ sessionID: "ses_parent" }, { location: { directory: "/project" } }]])
  })

  test("asks at the server's default location when the TUI has none", async () => {
    const fake = fakeContext(async () => ({ ...empty, idle: 1 }), {})
    await tui.setup(fake.context)
    const app = await renderFooter(fake.state.claim, () => "ses_parent")

    await app.waitForFrame((frame) => frame.includes("courier 1 idle"))
    expect(fake.calls).toEqual([[{ sessionID: "ses_parent" }, { location: { directory: "/default" } }]])
  })

  test("shows nothing on the home screen, where there is no session, and asks nothing", async () => {
    const fake = fakeContext(async () => ({ ...empty, idle: 1 }))
    await tui.setup(fake.context)
    const app = await renderFooter(fake.state.claim, () => undefined)

    await app.renderOnce()
    expect(app.captureCharFrame().trim()).toBe("")
    expect(fake.calls).toEqual([])
  })

  test("shows nothing for a session that started none, or when the RPC fails", async () => {
    for (const answer of [async () => empty, async () => Promise.reject(new Error("rpc.method_not_found"))]) {
      const fake = fakeContext(answer)
      await tui.setup(fake.context)
      const app = await renderFooter(fake.state.claim, () => "ses_parent")

      await settle()
      await app.renderOnce()
      expect(fake.calls).toHaveLength(1)
      expect(app.captureCharFrame().trim()).toBe("")
    }
  })

  test("asks again once after a burst of changes, and not for other events", async () => {
    let idle = 0
    const fake = fakeContext(async () => ({ ...empty, idle: ++idle }))
    await tui.setup(fake.context)
    const app = await renderFooter(fake.state.claim, () => "ses_parent")
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
    const app = await renderFooter(fake.state.claim, open)
    await app.waitForFrame((frame) => frame.includes("courier 1 running"))

    setOpen("ses_b")
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("courier")
    release()
    await app.waitForFrame((frame) => frame.includes("courier 4 idle"))
  })

  test("its cleanup stops listening and gives the slot back", async () => {
    const fake = fakeContext(async () => empty)
    const cleanup = await tui.setup(fake.context)
    // The footer's and the asks inbox's.
    expect(fake.listeners.size).toBe(2)

    await cleanup?.()
    expect(fake.listeners.size).toBe(0)
    expect(fake.state.released).toBe(1)
  })
})

describe("the footer's waiting on you", () => {
  test("a click opens the asks inbox for the open session, only while some wait on the person", async () => {
    for (const [waiting, opened] of [[1, ["ses_parent"]], [0, []]] as const) {
      const fake = fakeContext(async () => ({ ...empty, running: 1, waiting }))
      const clicked: string[] = []
      addTreeStatus(fake.context, (sessionID) => void clicked.push(sessionID))
      const app = await renderFooter(fake.state.claim, () => "ses_parent")
      await app.waitForFrame((frame) => frame.includes("courier 1 running"))

      await app.mockMouse.click(4, 0)
      expect(clicked).toEqual([...opened])
    }
  })
})
