import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import plugin from "../src/index.js"

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setUp(stored: Record<string, unknown> = {}, options?: Record<string, unknown>) {
  const store = new Map(Object.entries(stored))
  const tools = new Map<string, any>()
  const calls: { method: string; input: any }[] = []
  const record = (method: string, result: unknown) => async (input: any) => {
    calls.push({ method, input })
    return result
  }
  const ctx = {
    options,
    location: { directory: "/repo" },
    session: {
      create: record("session.create", { id: "ses_child", location: { directory: "/repo" } }),
      prompt: record("session.prompt", { id: "msg_1" }),
      synthetic: record("session.synthetic", { id: "msg_2" }),
      get: record("session.get", { id: "ses_parent" }),
      context: record("session.context", []),
    },
    worktree: {
      create: record("worktree.create", { directory: "/wt" }),
      remove: record("worktree.remove", undefined),
    },
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

  expect([...tools.keys()]).toEqual([
    "courier_spawn",
    "courier_send",
    "courier_status",
    "courier_children",
    "courier_cleanup",
    "courier_later",
    "courier_cancel",
    "courier_subscribe",
    "courier_unsubscribe",
  ])
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

test("courier_later takes delayMinutes as a number or a string, which some models send instead", async () => {
  const { tools } = await setUp()

  const input = tools.get("courier_later").input
  const decode = (delayMinutes: unknown) => Schema.decodeUnknownSync(input)({ message: "m", delayMinutes })
  expect(decode(3)).toEqual({ message: "m", delayMinutes: 3 })
  expect(decode("3")).toEqual({ message: "m", delayMinutes: "3" })
  expect(() => decode(true)).toThrow()
  const scheduled = await tools.get("courier_later").execute({ message: "m", delayMinutes: "3" }, { sessionID: "ses_parent" })
  expect(Date.parse(scheduled.metadata.fireAt) - Date.now()).toBeGreaterThan(170_000)
})

test("tool inputs use no schema checks or transformations, which OpenCode's own copy of effect cannot run", async () => {
  const { tools } = await setUp()

  const unsupported = (ast: any, path: string): string[] => [
    ...(ast.checks?.length ? [`${path} has a check`] : []),
    ...(ast.encoding?.length ? [`${path} has a transformation`] : []),
    ...(ast.propertySignatures ?? []).flatMap((property: any) => unsupported(property.type, `${path}.${String(property.name)}`)),
    ...(ast.types ?? []).flatMap((type: any) => unsupported(type, path)),
  ]
  expect([...tools.values()].flatMap((tool) => unsupported(tool.input.ast, tool.name))).toEqual([])
})

test("courier_spawn uses the calling session as the parent", async () => {
  const { tools, calls } = await setUp()

  const result = await tools.get("courier_spawn").execute({ task: "t" }, { sessionID: "ses_parent" })

  expect(calls[0]!.input.metadata).toEqual({ courier: { parentID: "ses_parent" } })
  expect(result.content).toContain("ses_child")
})

test("courier_spawn tells the parent to end its turn rather than wait for the child", async () => {
  const { tools } = await setUp()

  const result = await tools.get("courier_spawn").execute({ task: "t" }, { sessionID: "ses_parent" })

  expect(result.content).toContain("starts a new turn for you")
  expect(result.content).toContain("end your turn: reply without calling more tools. That does not drop the task")
})

test("courier_children lists what courier_spawn started from the calling session, or another", async () => {
  const { tools } = await setUp()

  await tools.get("courier_spawn").execute({ task: "t" }, { sessionID: "ses_parent" })

  const own = await tools.get("courier_children").execute({}, { sessionID: "ses_parent" })
  expect(own.metadata.children.map((child: any) => child.sessionID)).toEqual(["ses_child"])
  expect(own.content).toContain("ses_child")
  const other = await tools.get("courier_children").execute({ sessionID: "ses_parent" }, { sessionID: "ses_x" })
  expect(other.metadata.children).toHaveLength(1)
  const empty = await tools.get("courier_children").execute({ sessionID: "" }, { sessionID: "ses_parent" })
  expect(empty.metadata.children).toHaveLength(1)
  const none = await tools.get("courier_children").execute({}, { sessionID: "ses_x" })
  expect(none).toEqual({ content: "No sessions started with courier_spawn.", metadata: { children: [] } })
})

test("courier_cleanup reports the worktree of an isolated child that is already gone, and forgets it", async () => {
  const { tools, store } = await setUp()

  await tools.get("courier_spawn").execute({ task: "t", isolate: true }, { sessionID: "ses_parent" })
  const result = await tools.get("courier_cleanup").execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })

  expect(result.metadata).toEqual({ sessionID: "ses_child", directory: "/wt", outcome: "gone" })
  expect(result.content).toContain("already gone")
  expect([...store.keys()].filter((key) => key.startsWith("roster/"))).toEqual([])
  await expect(tools.get("courier_cleanup").execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })).rejects.toThrow(
    "courier_cleanup failed: ses_child is not on the courier_children list of ses_parent.",
  )
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

test("courier_later tells a session scheduling its own check-in to end its turn, and no one else", async () => {
  const { tools } = await setUp()

  const own = await tools.get("courier_later").execute({ message: "check", delayMinutes: 10 }, { sessionID: "ses_parent" })
  const other = await tools
    .get("courier_later")
    .execute({ message: "check", delayMinutes: 10, sessionID: "ses_child" }, { sessionID: "ses_parent" })

  expect(own.content).toContain("It starts a new turn for you when due, so do not wait for it: once nothing else")
  expect(own.content).toContain("end your turn by replying without calling more tools")
  expect(own.content).toContain("If what it checks on reports first, cancel it then with courier_cancel.")
  expect(other.content).toContain("to ses_child. Cancel it with courier_cancel if it is no longer needed.")
  expect(other.content).not.toContain("end your turn")
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

test("courier_subscribe subscribes the calling session and says when no receiver runs", async () => {
  const { tools, store } = await setUp()

  const result = await tools.get("courier_subscribe").execute({ topic: "Octo/Repo#5" }, { sessionID: "ses_parent" })

  expect(result.metadata).toEqual({ sessionID: "ses_parent", topic: "github:octo/repo#5", receiver: false })
  expect(result.content).toContain("no webhook receiver runs")
  expect([...store.keys()]).toEqual(["webhook/github%3Aocto%2Frepo%235/ses_parent"])
  const dropped = await tools.get("courier_unsubscribe").execute({}, { sessionID: "ses_parent" })
  expect(dropped.metadata).toEqual({ sessionID: "ses_parent", dropped: ["github:octo/repo#5"] })
})

test("with a webhook option, the receiver is shared by instances and stops when the last unloads", async () => {
  const port = 20000 + Math.floor(Math.random() * 20000)
  process.env.COURIER_TEST_SECRET = "s"
  const options = { webhook: { port, secretEnv: "COURIER_TEST_SECRET" } }
  const first = await setUp({}, options)
  const second = await setUp({}, options)
  const ping = () =>
    fetch(`http://127.0.0.1:${port}/github`, { method: "POST", body: "{}" }).then((response) => response.status, () => "down")

  for (let i = 0; i < 50 && (await ping()) === "down"; i++) await Bun.sleep(10)
  expect(await ping()).toBe(401)
  expect(first.tools.size).toBe(second.tools.size)
  await cleanups.shift()!()
  expect(await ping()).toBe(401)
  await cleanups.shift()!()
  expect(await ping()).toBe("down")
})

test("a receiver that cannot listen is dropped, and the next instance to load tries again", async () => {
  const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") })
  const port = blocker.port
  process.env.COURIER_TEST_SECRET = "s"
  const options = { webhook: { port, secretEnv: "COURIER_TEST_SECRET" } }
  const first = await setUp({}, options)
  const subscribed = await first.tools.get("courier_subscribe").execute({ topic: "o/r" }, { sessionID: "ses_parent" })
  expect(subscribed.metadata.receiver).toBe(false)

  blocker.stop(true)
  const second = await setUp({}, options)
  const again = await second.tools.get("courier_subscribe").execute({ topic: "o/r" }, { sessionID: "ses_parent" })
  expect(again.metadata.receiver).toBe(true)
  const status = await fetch(`http://127.0.0.1:${port}/github`, { method: "POST", body: "{}" }).then((response) => response.status)
  expect(status).toBe(401)
})

test("a reload's new instance listens once the old one has closed", async () => {
  const port = 20000 + Math.floor(Math.random() * 20000)
  process.env.COURIER_TEST_SECRET = "s"
  const options = { webhook: { port, secretEnv: "COURIER_TEST_SECRET" } }
  const old = await setUp({}, options)
  await (await old.tools.get("courier_subscribe").execute({ topic: "o/r" }, { sessionID: "ses_parent" }))
  const closing = cleanups.shift()!()
  const fresh = await setUp({}, options)
  await closing

  const result = await fresh.tools.get("courier_subscribe").execute({ topic: "o/r" }, { sessionID: "ses_parent" })
  expect(result.metadata.receiver).toBe(true)
})
