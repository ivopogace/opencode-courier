import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import plugin from "../src/index.js"

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setUp(stored: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(stored))
  const tools = new Map<string, any>()
  const calls: { method: string; input: any }[] = []
  const record = (method: string, result: unknown) => async (input: any) => {
    calls.push({ method, input })
    return result
  }
  const ctx = {
    location: { directory: "/repo" },
    session: {
      create: record("session.create", { id: "ses_child", location: { directory: "/repo" } }),
      prompt: record("session.prompt", { id: "msg_1" }),
      synthetic: record("session.synthetic", { id: "msg_2" }),
      get: record("session.get", {}),
      context: record("session.context", []),
    },
    worktree: { create: record("worktree.create", { directory: "/wt" }) },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
    },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({ add: (tool: any) => tools.set(tool.name, tool) })
        return { dispose: async () => {} }
      },
    },
  }
  const cleanup = await plugin.setup(ctx as any)
  if (cleanup) cleanups.push(cleanup)
  return { tools, calls, store }
}

test("registers the courier tools", async () => {
  const { tools } = await setUp()

  expect([...tools.keys()]).toEqual(["courier_spawn", "courier_send", "courier_status", "courier_later", "courier_cancel"])
})

test("registers them as direct tools, not code-mode ones only reachable through execute", async () => {
  const { tools } = await setUp()

  for (const tool of tools.values()) expect(tool.options).toEqual({ codemode: false })
})

test("tool inputs decode with their schemas", async () => {
  const { tools } = await setUp()

  const decode = (name: string, value: unknown) => Schema.decodeUnknownSync(tools.get(name).input)(value)
  expect(decode("courier_spawn", { task: "t", isolate: true })).toEqual({ task: "t", isolate: true })
  expect(decode("courier_send", { sessionID: "s", message: "m" })).toEqual({ sessionID: "s", message: "m" })
  expect(() => decode("courier_send", { sessionID: "s" })).toThrow()
})

test("courier_spawn uses the calling session as the parent", async () => {
  const { tools, calls } = await setUp()

  const result = await tools.get("courier_spawn").execute({ task: "t" }, { sessionID: "ses_parent" })

  expect(calls[0]!.input.metadata).toEqual({ courier: { parentID: "ses_parent" } })
  expect(result.content).toContain("ses_child")
})

test("courier_send signs the message with the calling session", async () => {
  const { tools, calls } = await setUp()

  await tools.get("courier_send").execute({ sessionID: "ses_parent", message: "done" }, { sessionID: "ses_child" })

  expect(calls[0]!.input.metadata).toEqual({ source: "courier", from: "ses_child" })
})

test("courier_later schedules for the calling session and courier_cancel drops it", async () => {
  const { tools, store } = await setUp()

  const scheduled = await tools.get("courier_later").execute({ message: "check", delayMinutes: 10 }, { sessionID: "ses_parent" })

  expect(scheduled.metadata.sessionID).toBe("ses_parent")
  expect(store.get(`later/${scheduled.metadata.id}`)).toMatchObject({ from: "ses_parent", message: "check" })
  const cancelled = await tools.get("courier_cancel").execute({ id: scheduled.metadata.id }, { sessionID: "ses_parent" })
  expect(cancelled.metadata).toEqual({ id: scheduled.metadata.id, cancelled: true })
  expect(store.size).toBe(0)
})

test("courier_later names what was wrong with its input", async () => {
  const { tools } = await setUp()

  await expect(tools.get("courier_later").execute({ message: "m" }, { sessionID: "ses_parent" })).rejects.toThrow(
    "courier_later failed: Give exactly one of delayMinutes or at.",
  )
})

test("on setup, delivers messages that fell due while OpenCode was down", async () => {
  const due = { id: "later_x", sessionID: "ses_parent", from: "ses_parent", message: "wake", fireAt: 1, createdAt: 0 }
  const { calls, store } = await setUp({ "later/later_x": due })

  for (let i = 0; i < 20 && store.size > 0; i++) await Bun.sleep(5)

  expect(calls.find((call) => call.method === "session.synthetic")?.input).toMatchObject({
    sessionID: "ses_parent",
    delivery: "queue",
  })
  expect(store.size).toBe(0)
})
