import { describe, expect, test } from "bun:test"
import { describeFailure, listChildren, send, spawn, status, type CourierPorts } from "../src/courier.js"
import { DEFAULT_LIMITS } from "../src/limits.js"
import { childBrief, envelope, reportBody } from "../src/notices.js"
import { progressKey, settledKey } from "../src/report.js"
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
    projectID: "proj_1",
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
    pending: async () => [],
    limits: DEFAULT_LIMITS,
    gate: { reserved: new Set(), turn: Promise.resolve() },
    roles: new Map(),
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
    expect(calls[1]!.input).toEqual({ sessionID: "ses_child", text: childBrief("ses_parent", "Fix the bug\nin checkout", 1, DEFAULT_LIMITS) })
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
      reports: "status",
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

    expect(calls[0]).toEqual({ method: "worktree.create", input: { projectID: "proj_1" } })
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
      project: "proj_1",
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
    expect(calls[1]!.input).toEqual({ projectID: "proj_1", directory: "/repo/.worktrees/ses", force: false })
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

    // Not a spawned session: neither a report nor progress.
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

  const spawned = { sessionID: "ses_child", parentID: "ses_parent", title: "t", directory: "/repo", isolated: false, createdAt: 1, reports: "status" as const }
  const report = { sessionID: "ses_parent", message: "m", status: "done" as const }

  test("notes a spawned session's message with a status to its parent, and only that, as its report, with the status", async () => {
    const { ports, store } = fakePorts()
    await record(ports.storage, spawned)

    await send(ports, "ses_child", { sessionID: "ses_other", message: "m", status: "done" })
    expect(store.has(settledKey("ses_child"))).toBe(false)
    await send(ports, "ses_parent", { sessionID: "ses_child", message: "m", status: "done" })
    expect(store.has(settledKey("ses_parent"))).toBe(false)
    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "m", status: "blocked" })).toEqual({ messageID: "msg_2", status: "blocked", report: true })
    expect(store.get(settledKey("ses_child"))).toEqual({ at: 1_000, by: "report", status: "blocked" })
  })

  test("carries the status as an attribute of the envelope and in the metadata, and the artifacts in the body", async () => {
    const { ports, calls } = fakePorts()
    const artifacts = { branch: "fix/checkout", commits: ["abc1234"], files: ["src/a.ts"], checks: [{ command: "bun test", result: "412 passed" }] }

    await send(ports, "ses_child", { sessionID: "ses_parent", message: "Fixed it.", status: "done", artifacts })

    expect(calls[0]!.input).toEqual({
      sessionID: "ses_parent",
      text: envelope("ses_child", reportBody("Fixed it.", artifacts), { status: "done" }),
      description: "Message from ses_child",
      metadata: { source: "courier", from: "ses_child", status: "done" },
      delivery: "steer",
    })
    expect(calls[0]!.input.text).toStartWith('<courier from="ses_child" status="done">\nFixed it.\n\nArtifacts:\n- branch: fix/checkout\n')
  })

  test("refuses a status that is none of the four, since OpenCode does not check the schema", async () => {
    const { ports, calls } = fakePorts()

    await expect(send(ports, "ses_child", { sessionID: "ses_parent", message: "m", status: "finished" as never })).rejects.toThrow(
      'status must be one of done, partial, blocked, failed, not "finished".',
    )
    expect(calls).toEqual([])
    // Some models send null for an optional field they leave out.
    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "m", status: null as never })).toEqual({ messageID: "msg_2" })
  })

  test("notes a message without a status to the parent as progress, not as the report, and says so", async () => {
    const { ports, store } = fakePorts()
    await record(ports.storage, spawned)

    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "halfway" })).toEqual({ messageID: "msg_2", report: false })

    expect(store.has(settledKey("ses_child"))).toBe(false)
    expect(store.get(progressKey("ses_child"))).toEqual({ at: 1_000 })
    await send(ports, "ses_child", { sessionID: "ses_other", message: "m" })
    expect(store.has(progressKey("ses_other"))).toBe(false)
  })

  test("takes a message without a status from a child an older release briefed as its report, as before", async () => {
    const { ports, store } = fakePorts()
    const { reports, ...older } = spawned
    await record(ports.storage, older)

    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "m" })).toEqual({ messageID: "msg_2", report: true })

    expect(store.get(settledKey("ses_child"))).toEqual({ at: 1_000, by: "report" })
    expect(store.has(progressKey("ses_child"))).toBe(false)
  })

  test("notes the report before delivering it, which may end the parent's turn at once", async () => {
    const { ports, store } = fakePorts()
    await record(ports.storage, spawned)
    let noted: unknown
    ;(ports.session as any).synthetic = async () => {
      noted = store.get(settledKey("ses_child"))
      return { id: "msg_3" }
    }
    await send(ports, "ses_child", report)
    expect(noted).toEqual({ at: 1_000, by: "report", status: "done" })
  })

  test("takes the note back when the message is not delivered, and delivers it when the report cannot be noted", async () => {
    const { ports, store } = fakePorts()
    await record(ports.storage, spawned)
    ;(ports.session as any).synthetic = async () => Promise.reject(new Error("parent is gone"))
    await expect(send(ports, "ses_child", report)).rejects.toThrow("parent is gone")
    expect(store.has(settledKey("ses_child"))).toBe(false)
    await expect(send(ports, "ses_child", { sessionID: "ses_parent", message: "m" })).rejects.toThrow("parent is gone")
    expect(store.has(progressKey("ses_child"))).toBe(false)
    store.set(settledKey("ses_child"), { at: 5, by: "failed" })
    await expect(send(ports, "ses_child", report)).rejects.toThrow("parent is gone")
    expect(store.get(settledKey("ses_child"))).toEqual({ at: 5, by: "failed" })

    // Another courier_send of the child's noted its report meanwhile: that note stays.
    ;(ports.session as any).synthetic = async () => {
      store.set(settledKey("ses_child"), { at: 2_000, by: "report", status: "done" })
      throw new Error("parent is gone")
    }
    await expect(send(ports, "ses_child", report)).rejects.toThrow("parent is gone")
    expect(store.get(settledKey("ses_child"))).toEqual({ at: 2_000, by: "report", status: "done" })

    store.delete(settledKey("ses_child"))
    ;(ports.session as any).synthetic = async () => ({ id: "msg_3" })
    ;(ports.storage as any).set = async () => Promise.reject(new Error("disk full"))
    expect(await send(ports, "ses_child", report)).toEqual({ messageID: "msg_3", status: "done" })
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

  test("lists the requests the session waits on, and leaves pending out when there are none", async () => {
    const { ports } = fakePorts()
    const waiting = { type: "permission" as const, requestID: "per_1", action: "shell", resources: ["git push"] }
    ;(ports as any).pending = async (sessionID: string) => (sessionID === "ses_child" ? [waiting] : [])

    expect((await status(ports, { sessionID: "ses_child" })).pending).toEqual([waiting])
    expect(await status(ports, { sessionID: "ses_other" })).not.toHaveProperty("pending")
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
