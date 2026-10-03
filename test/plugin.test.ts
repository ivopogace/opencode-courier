import { expect, test } from "bun:test"
import { Schema } from "effect"
import plugin from "../src/index.js"

async function setUp() {
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
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({ add: (tool: any) => tools.set(tool.name, tool) })
        return { dispose: async () => {} }
      },
    },
  }
  await plugin.setup(ctx as any)
  return { tools, calls }
}

test("registers the three courier tools", async () => {
  const { tools } = await setUp()

  expect([...tools.keys()]).toEqual(["courier_spawn", "courier_send", "courier_status"])
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
