import { describe, expect, test } from "bun:test"
import { childBrief, describeFailure, envelope, send, spawn, status, type CourierPorts } from "../src/courier.js"

type Call = { method: string; input: any }

function fakePorts(overrides: { messages?: unknown[]; info?: Record<string, unknown> } = {}) {
  const calls: Call[] = []
  const record = (method: string, result: unknown) => async (input: any) => {
    calls.push({ method, input })
    return result
  }
  const ports = {
    directory: "/repo",
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
    worktree: {
      create: record("worktree.create", { directory: "/repo/.worktrees/ses" }),
    },
  } as unknown as CourierPorts
  return { ports, calls }
}

describe("spawn", () => {
  test("creates the child, then prompts it with a brief naming the parent", async () => {
    const { ports, calls } = fakePorts()

    const child = await spawn(ports, "ses_parent", { task: "Fix the bug\nin checkout" })

    expect(child).toEqual({ sessionID: "ses_child", directory: "/repo" })
    expect(calls.map((call) => call.method)).toEqual(["session.create", "session.prompt"])
    expect(calls[0]!.input).toEqual({ title: "Fix the bug", metadata: { courier: { parentID: "ses_parent" } } })
    expect(calls[1]!.input).toEqual({ sessionID: "ses_child", text: childBrief("ses_parent", "Fix the bug\nin checkout") })
  })

  test("passes the agent and title through", async () => {
    const { ports, calls } = fakePorts()

    await spawn(ports, "ses_parent", { task: "t", title: "Custom", agent: "build" })

    expect(calls[0]!.input).toMatchObject({ title: "Custom", agent: "build" })
  })

  test("with isolate, creates a worktree and runs the child there", async () => {
    const { ports, calls } = fakePorts()

    const child = await spawn(ports, "ses_parent", { task: "t", isolate: true })

    expect(calls[0]).toEqual({ method: "worktree.create", input: { location: { directory: "/repo" } } })
    expect(calls[1]!.input).toMatchObject({ location: { directory: "/repo/.worktrees/ses" } })
    expect(child.directory).toBe("/repo/.worktrees/ses")
  })

  test("shortens a long first line for the title", async () => {
    const { ports, calls } = fakePorts()

    await spawn(ports, "ses_parent", { task: "x".repeat(100) })

    expect(calls[0]!.input.title).toBe(`${"x".repeat(57)}...`)
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

describe("describeFailure", () => {
  test("keeps an error's message", () => {
    expect(describeFailure("courier_send", new Error("boom")).message).toBe("courier_send failed: boom")
  })

  test("falls back to the tag and session of an OpenCode error with an empty message", () => {
    const error = Object.assign(new Error(""), { _tag: "Session.NotFoundError", sessionID: "ses_x" })

    expect(describeFailure("courier_status", error).message).toBe("courier_status failed: Session.NotFoundError ses_x")
  })
})
