import { describe, expect, test } from "bun:test"
import { childBrief, describeFailure, envelope, listChildren, send, spawn, status, type CourierPorts } from "../src/courier.js"
import { record, rosterKey } from "../src/roster.js"

type Call = { method: string; input: any }

/** What spawn did after looking up the model to give the child. */
const afterLookups = (calls: Call[]) => calls.filter((call) => call.method !== "session.get" && call.method !== "agent.get")

function fakePorts(overrides: { messages?: unknown[]; info?: Record<string, unknown>; agent?: Record<string, unknown> } = {}) {
  const calls: Call[] = []
  const store = new Map<string, unknown>()
  const record = (method: string, result: unknown) => async (input: any) => {
    calls.push({ method, input })
    return result
  }
  const ports = {
    directory: "/repo",
    now: () => 1_000,
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
    },
    session: {
      create: record("session.create", { id: "ses_child", location: { directory: "/repo" } }),
      prompt: record("session.prompt", { id: "msg_1" }),
      synthetic: record("session.synthetic", { id: "msg_2" }),
      get: record("session.get", {
        id: "ses_child",
        title: "Fix the bug",
        parentID: undefined,
        outcome: "succeeded",
        time: { created: 1, updated: 5, idle: 5 },
        ...overrides.info,
      }),
      context: record("session.context", overrides.messages ?? []),
    },
    agent: { get: record("agent.get", { data: { id: "build", ...overrides.agent } }) },
    worktree: {
      create: record("worktree.create", { directory: "/repo/.worktrees/ses" }),
      remove: record("worktree.remove", undefined),
    },
    head: async () => "abc123",
  } as unknown as CourierPorts
  return { ports, calls, store }
}

describe("spawn", () => {
  test("creates the child, then prompts it with a brief naming the parent", async () => {
    const { ports, calls: all } = fakePorts()

    const child = await spawn(ports, "ses_parent", { task: "Fix the bug\nin checkout" })
    const calls = afterLookups(all)

    expect(child).toEqual({ sessionID: "ses_child", directory: "/repo" })
    expect(calls.map((call) => call.method)).toEqual(["session.create", "session.prompt"])
    expect(calls[0]!.input).toEqual({ title: "Fix the bug", metadata: { courier: { parentID: "ses_parent" } } })
    expect(calls[1]!.input).toEqual({ sessionID: "ses_child", text: childBrief("ses_parent", "Fix the bug\nin checkout") })
  })

  test("records the child on its parent's roster before prompting it", async () => {
    const { ports, store } = fakePorts()
    ;(ports.session as any).prompt = async () => {
      throw new Error("prompt failed")
    }

    await expect(spawn(ports, "ses_parent", { task: "Fix the bug" })).rejects.toThrow("prompt failed")

    expect(store.get(rosterKey("ses_parent", "ses_child"))).toEqual({
      sessionID: "ses_child",
      parentID: "ses_parent",
      title: "Fix the bug",
      directory: "/repo",
      isolated: false,
      createdAt: 1_000,
    })
  })

  test("still prompts the child when the roster cannot be written, and says so", async () => {
    const { ports, calls: all } = fakePorts()
    ;(ports.storage as any).set = async () => {
      throw new Error("disk full")
    }

    const child = await spawn(ports, "ses_parent", { task: "t" })
    const calls = afterLookups(all)

    expect(calls.map((call) => call.method)).toEqual(["session.create", "session.prompt"])
    expect(child).toEqual({ sessionID: "ses_child", directory: "/repo", rosterError: "roster failed: disk full" })
  })

  test("passes the agent and title through", async () => {
    const { ports, calls: all } = fakePorts()

    await spawn(ports, "ses_parent", { task: "t", title: "Custom", agent: "build" })
    const calls = afterLookups(all)

    expect(calls[0]!.input).toMatchObject({ title: "Custom", agent: "build" })
  })

  test("with isolate, creates a worktree and runs the child there", async () => {
    const { ports, calls: all } = fakePorts()

    const child = await spawn(ports, "ses_parent", { task: "t", isolate: true })
    const calls = afterLookups(all)

    expect(calls[0]).toEqual({ method: "worktree.create", input: { location: { directory: "/repo" } } })
    expect(calls[1]!.input).toMatchObject({ location: { directory: "/repo/.worktrees/ses" } })
    expect(child.directory).toBe("/repo/.worktrees/ses")
  })

  test("records an isolated child with its worktree and the directory it was made from", async () => {
    const { ports, store } = fakePorts()

    await spawn(ports, "ses_parent", { task: "t", title: "Custom", isolate: true })

    expect(store.get(rosterKey("ses_parent", "ses_child"))).toMatchObject({
      title: "Custom",
      directory: "/repo/.worktrees/ses",
      isolated: true,
      source: "/repo",
      base: "abc123",
    })
  })

  test("removes the fresh worktree when the session cannot be created", async () => {
    const { ports, calls: all, store } = fakePorts()
    ;(ports.session as any).create = async () => {
      throw new Error("no such agent")
    }

    await expect(spawn(ports, "ses_parent", { task: "t", isolate: true })).rejects.toThrow("no such agent")
    const calls = afterLookups(all)

    expect(calls.map((call) => call.method)).toEqual(["worktree.create", "worktree.remove"])
    expect(calls[1]!.input).toEqual({ location: { directory: "/repo" }, directory: "/repo/.worktrees/ses", force: false })
    expect(store.size).toBe(0)
  })

  test("shortens a long first line for the title", async () => {
    const { ports, calls: all } = fakePorts()

    await spawn(ports, "ses_parent", { task: "x".repeat(100) })
    const calls = afterLookups(all)

    expect(calls[0]!.input.title).toBe(`${"x".repeat(57)}...`)
  })

  test("gives the child its parent's model", async () => {
    const model = { id: "chat", providerID: "mock", variant: "default" }
    const { ports, calls } = fakePorts({ info: { model } })

    await spawn(ports, "ses_parent", { task: "t" })

    expect(calls[0]).toEqual({ method: "session.get", input: { sessionID: "ses_parent" } })
    expect(calls.find((call) => call.method === "session.create")!.input).toMatchObject({ model })
  })

  test("gives it the parent's model with an agent that names none", async () => {
    const model = { id: "chat", providerID: "mock" }
    const { ports, calls } = fakePorts({ info: { model } })

    await spawn(ports, "ses_parent", { task: "t", agent: "build" })

    expect(calls.find((call) => call.method === "agent.get")!.input).toEqual({ agentID: "build", location: { directory: "/repo" } })
    expect(calls.find((call) => call.method === "session.create")!.input).toMatchObject({ agent: "build", model })
  })

  test("leaves the model to an agent that names its own", async () => {
    const { ports, calls } = fakePorts({
      info: { model: { id: "chat", providerID: "mock" } },
      agent: { model: { id: "small", providerID: "mock" } },
    })

    await spawn(ports, "ses_parent", { task: "t", agent: "build" })

    expect(calls.find((call) => call.method === "session.create")!.input).not.toHaveProperty("model")
  })

  test("starts the child on OpenCode's default when the parent's model cannot be looked up", async () => {
    const { ports, calls } = fakePorts()
    ;(ports.session as any).get = async () => {
      throw new Error("lookup failed")
    }

    const child = await spawn(ports, "ses_parent", { task: "t" })

    expect(child.sessionID).toBe("ses_child")
    expect(calls[0]!.input).not.toHaveProperty("model")
  })
})
describe("send", () => {
  test("delivers a synthetic message that steers by default and leaves resume on", async () => {
    const { ports, calls } = fakePorts()

    const result = await send(ports, "ses_child", { sessionID: "ses_parent", message: "Done: PR #4" })

    expect(result).toEqual({ messageID: "msg_2" })
    expect(calls[0]).toEqual({
      method: "session.synthetic",
      input: {
        sessionID: "ses_parent",
        text: envelope("ses_child", "Done: PR #4"),
        description: "Message from ses_child",
        metadata: { source: "courier", from: "ses_child" },
        delivery: "steer",
      },
    })
    expect(calls[0]!.input).not.toHaveProperty("resume")
  })

  test("queues when asked", async () => {
    const { ports, calls } = fakePorts()

    await send(ports, "ses_child", { sessionID: "ses_parent", message: "m", queue: true })

    expect(calls[0]!.input.delivery).toBe("queue")
  })
})

describe("status", () => {
  test("reports the session's state and its last assistant text", async () => {
    const { ports } = fakePorts({
      messages: [
        { type: "user", text: "go" },
        { type: "assistant", content: [{ type: "text", text: "first" }] },
        {
          type: "assistant",
          content: [
            { type: "reasoning", text: "hidden" },
            { type: "text", text: "Opened " },
            { type: "text", text: "PR #4" },
          ],
        },
        { type: "synthetic", text: "later" },
      ],
    })

    expect(await status(ports, { sessionID: "ses_child" })).toStrictEqual({
      sessionID: "ses_child",
      title: "Fix the bug",
      outcome: "succeeded",
      updated: 5,
      idle: 5,
      lastText: "Opened PR #4",
    })
  })

  test("leaves lastText out when the session has not replied", async () => {
    const { ports } = fakePorts()

    expect(await status(ports, { sessionID: "ses_child" })).not.toHaveProperty("lastText")
  })

  test("never returns undefined values, which make OpenCode hang the tool call", async () => {
    const { ports } = fakePorts({ info: { title: undefined, outcome: undefined, time: { created: 1, updated: 2 } } })

    const result = await status(ports, { sessionID: "ses_child" })

    expect(Object.values(result)).not.toContain(undefined)
    expect(result).toStrictEqual({ sessionID: "ses_child", updated: 2 })
  })
})

describe("listChildren", () => {
  test("lists each child with its status and roster fields, or the error looking it up gave", async () => {
    const { ports } = fakePorts({ messages: [{ type: "assistant", content: [{ type: "text", text: "Done" }] }] })
    const get = ports.session.get
    ;(ports.session as any).get = async (input: { sessionID: string }) => {
      if (input.sessionID === "ses_gone") throw Object.assign(new Error(""), { _tag: "Session.NotFoundError", sessionID: "ses_gone" })
      return get(input)
    }
    await record(ports.storage, { sessionID: "ses_child", parentID: "ses_parent", title: "Fix the bug", directory: "/repo", isolated: false, createdAt: 900 })
    await record(ports.storage, { sessionID: "ses_gone", parentID: "ses_parent", title: "Gone", directory: "/wt", isolated: true, createdAt: 950 })
    await record(ports.storage, { sessionID: "ses_else", parentID: "ses_other", title: "Else", directory: "/repo", isolated: false, createdAt: 900 })

    expect(await listChildren(ports, "ses_parent")).toStrictEqual([
      {
        sessionID: "ses_child",
        title: "Fix the bug",
        outcome: "succeeded",
        updated: 5,
        idle: 5,
        lastText: "Done",
        directory: "/repo",
        isolated: false,
        created: 900,
      },
      {
        sessionID: "ses_gone",
        title: "Gone",
        directory: "/wt",
        isolated: true,
        created: 950,
        error: "courier_status failed: Session.NotFoundError ses_gone",
      },
    ])
  })

  test("is empty for a session that started none", async () => {
    const { ports } = fakePorts()

    expect(await listChildren(ports, "ses_parent")).toEqual([])
  })
})

describe("describeFailure", () => {
  test("keeps an error's message", () => {
    expect(describeFailure("courier_send", new Error("boom")).message).toBe("courier_send failed: boom")
  })

  test("falls back to the tag and session of an OpenCode error with an empty message", () => {
    const error = Object.assign(new Error(""), { _tag: "Session.NotFoundError", sessionID: "ses_x" })

    expect(describeFailure("courier_status", error).message).toBe("courier_status failed: Session.NotFoundError ses_x")
  })
})
