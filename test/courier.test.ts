import { describe, expect, test } from "bun:test"
import { spawn } from "../src/tree/spawn.js"
import { send } from "../src/tree/send.js"
import { described, status } from "../src/tree/status.js"
import type { CourierPorts } from "../src/tree/ports.js"
import { DEFAULT_LIMITS } from "../src/tree/domain.js"
import { describeFailure, envelope } from "../src/kernel/protocol.js"
import { childBrief, modelFormatRefusal, nativeIsolateRefusal, reportBody, spawnText, variantWithoutModelRefusal } from "../src/tree/text.js"
import { childStore, progressKey, rosterKey, settledKey } from "../src/tree/store.js"

const CHILD_RULES = [{ action: "opencode_schedule_*", resource: "*", effect: "deny" }]

type Call = { method: string; input: any }

const afterLookups = (calls: Call[]) => calls.filter((call) => !["session.get", "agent.get", "model.list", "model.default"].includes(call.method))

type Known = { providerID: string; id: string; variants: string[] }
const KNOWN: Known[] = [
  { providerID: "mock", id: "chat", variants: ["low", "medium", "high"] },
  { providerID: "mock", id: "small", variants: [] },
]

function fakePorts(
  overrides: { messages?: unknown[]; info?: Record<string, unknown>; agent?: Record<string, unknown>; models?: Known[] | Error; defaultModel?: Known } = {},
) {
  const calls: Call[] = []
  const store = new Map<string, unknown>()
  const logs: string[] = []
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
    defaultModel: async () => {
      calls.push({ method: "model.default", input: undefined })
      return overrides.defaultModel && { providerID: overrides.defaultModel.providerID, id: overrides.defaultModel.id }
    },
    models: async () => {
      calls.push({ method: "model.list", input: undefined })
      if (overrides.models instanceof Error) throw overrides.models
      return (overrides.models ?? KNOWN).map((model) => ({ ...model, context: 1000 }))
    },
    worktree: {
      create: record("worktree.create", { directory: "/repo/.worktrees/ses" }),
      remove: record("worktree.remove", undefined),
    },
    head: async () => "abc123",
    dirty: async () => false,
    pending: async () => [],
    forms: async () => [],
    limits: DEFAULT_LIMITS,
    gate: { reserved: new Set(), turn: Promise.resolve() },
    roles: new Map(),
    log: (message: string) => void logs.push(message),
  } as unknown as CourierPorts
  return { ports, calls, store, logs }
}

describe("spawn", () => {
  test("creates the child, then prompts it with a brief naming the parent", async () => {
    const { ports, calls: all } = fakePorts()

    const child = await spawn(ports, "ses_parent", { task: "Fix the bug\nin checkout" })
    const calls = afterLookups(all)

    expect(child).toEqual({ sessionID: "ses_child", directory: "/repo" })
    expect(calls.map((call) => call.method)).toEqual(["session.create", "session.prompt"])
    expect(calls[0]!.input).toEqual({ title: "Fix the bug", permissions: CHILD_RULES, metadata: { courier: { parentID: "ses_parent" } } })
    expect(calls[1]!.input).toEqual({ sessionID: "ses_child", text: childBrief("ses_parent", "Fix the bug\nin checkout", 1, DEFAULT_LIMITS), metadata: { source: "courier", task: true } })
  })

  test("a child started below the top is marked so, and its result says its asks go to the top", async () => {
    const { ports } = fakePorts()
    await childStore(ports.storage).record({ sessionID: "ses_parent", parentID: "ses_root", title: "P", directory: "/repo", isolated: false, createdAt: 1 })
    const child = await spawn(ports, "ses_parent", { task: "t" })
    expect(child).toEqual({ sessionID: "ses_child", directory: "/repo", belowTop: true })
    expect(spawnText(child)).toContain(
      "It will report back with courier_send, which starts a new turn for you. Its permission requests and questions go to the top session of the tree, not to you",
    )
  })

  test("a child of the top is not marked, and its result says nothing of the top session", async () => {
    const { ports } = fakePorts()
    const child = await spawn(ports, "ses_parent", { task: "t" })
    expect(child).not.toHaveProperty("belowTop")
    expect(spawnText(child)).not.toContain("top session")
  })

  describe("a native child, OpenCode's subagent of its parent", () => {
    const AS_SUBAGENT = { title: "Fix the bug", parentID: "ses_parent", permissions: CHILD_RULES, metadata: { courier: { parentID: "ses_parent" } } }
    const STANDALONE = { title: "Fix the bug", permissions: CHILD_RULES, metadata: { courier: { parentID: "ses_parent" } } }
    const created = (calls: Call[]) => calls.find((call) => call.method === "session.create")!.input

    test("a child without native is standalone: no parentID, nothing recorded", async () => {
      const { ports, calls, store } = fakePorts()

      const child = await spawn(ports, "ses_parent", { task: "Fix the bug" })

      expect(created(calls)).toEqual(STANDALONE)
      expect(child).toEqual({ sessionID: "ses_child", directory: "/repo" })
      expect(store.get(rosterKey("ses_parent", "ses_child"))).not.toHaveProperty("native")
    })

    test("native: true makes the child a subagent", async () => {
      const { ports, calls, store } = fakePorts()

      const child = await spawn(ports, "ses_parent", { task: "Fix the bug", native: true })

      expect(created(calls)).toEqual(AS_SUBAGENT)
      expect(child).toEqual({ sessionID: "ses_child", directory: "/repo", native: true })
      expect(store.get(rosterKey("ses_parent", "ses_child"))).toMatchObject({ isolated: false, native: true })
    })

    test("native: false keeps the child standalone", async () => {
      const { ports, calls, store } = fakePorts()

      const child = await spawn(ports, "ses_parent", { task: "Fix the bug", native: false })

      expect(created(calls)).toEqual(STANDALONE)
      expect(child).toEqual({ sessionID: "ses_child", directory: "/repo" })
      expect(store.get(rosterKey("ses_parent", "ses_child"))).not.toHaveProperty("native")
    })

    test("a null native, as some models send an optional field left out, is a standalone child", async () => {
      const { ports, calls } = fakePorts()
      await spawn(ports, "ses_parent", { task: "Fix the bug", native: null as unknown as undefined })
      expect(created(calls)).toEqual(STANDALONE)
    })

    test("a nativeChildren field left on the ports makes no child native", async () => {
      const { ports, calls } = fakePorts()
      ;(ports as any).nativeChildren = true
      await spawn(ports, "ses_parent", { task: "Fix the bug" })
      expect(created(calls)).toEqual(STANDALONE)
    })

    test("an isolated child is created in its worktree's location, with no parentID", async () => {
      const { ports, calls, store } = fakePorts()

      const child = await spawn(ports, "ses_parent", { task: "t", isolate: true })

      expect(created(calls)).toEqual({ title: "t", location: { directory: "/repo/.worktrees/ses" }, permissions: CHILD_RULES, metadata: { courier: { parentID: "ses_parent" } } })
      expect(child).not.toHaveProperty("native")
      expect(store.get(rosterKey("ses_parent", "ses_child"))).not.toHaveProperty("native")
    })

    test("native: true with isolate: true is refused before anything is started, naming both", async () => {
      const { ports, calls, store } = fakePorts()

      await expect(spawn(ports, "ses_parent", { task: "t", native: true, isolate: true })).rejects.toThrow(nativeIsolateRefusal())

      expect(calls).toEqual([])
      expect(store.size).toBe(0)
      expect(ports.gate.reserved.size).toBe(0)
    })

    test("native: false with isolate: true is an isolated child as any other", async () => {
      const { ports, calls } = fakePorts()

      await spawn(ports, "ses_parent", { task: "t", native: false, isolate: true })

      expect(created(calls)).toEqual({ title: "t", location: { directory: "/repo/.worktrees/ses" }, permissions: CHILD_RULES, metadata: { courier: { parentID: "ses_parent" } } })
    })
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

  test("keeps no report state for a child the roster could not record, which nothing would ever remove", async () => {
    const { ports, store } = fakePorts()
    const set = ports.storage.set
    ;(ports.storage as any).set = async (key: string, value: any) => {
      if (key.startsWith("roster/")) throw new Error("disk full")
      return set(key, value)
    }

    await spawn(ports, "ses_parent", { task: "t" })
    ;(ports.session as any).prompt = async () => {
      throw new Error("prompt failed")
    }
    await expect(spawn(ports, "ses_parent", { task: "t" })).rejects.toThrow("prompt failed")

    expect([...store.keys()].filter((key) => key.startsWith("report/"))).toEqual([])
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

  describe("nested isolation", () => {
    const isolatedParent = async (ports: CourierPorts) =>
      childStore(ports.storage).record({ sessionID: "ses_parent", parentID: "ses_root", title: "P", directory: "/wt/parent", isolated: true, createdAt: 1, base: "root000" })

    test("starts an isolated child's worktree from an isolated parent's HEAD, and records it as the base", async () => {
      const { ports, calls: all, store } = fakePorts()
      await isolatedParent(ports)
      const heads: string[] = []
      ;(ports as any).head = async (directory: string) => (heads.push(directory), directory === "/wt/parent" ? "par777" : "par777")

      const child = await spawn(ports, "ses_parent", { task: "t", isolate: true })

      expect(afterLookups(all)[0]).toEqual({ method: "worktree.create", input: { projectID: "proj_1", from: "/wt/parent", branch: "par777" } })
      expect(heads).toEqual(["/wt/parent", "/repo/.worktrees/ses"])
      expect(store.get(rosterKey("ses_parent", "ses_child"))).toMatchObject({ isolated: true, base: "par777" })
      expect(child).toMatchObject({ fromParent: true })
      expect(child).not.toHaveProperty("uncommitted")
    })

    test("a root's isolated child, and a parent that is not isolated, start from the project", async () => {
      const root = fakePorts()
      await spawn(root.ports, "ses_root", { task: "t", isolate: true })
      expect(afterLookups(root.calls)[0]!.input).toEqual({ projectID: "proj_1" })

      const plain = fakePorts()
      await childStore(plain.ports.storage).record({ sessionID: "ses_parent", parentID: "ses_root", title: "P", directory: "/repo", isolated: false, createdAt: 1 })
      const child = await spawn(plain.ports, "ses_parent", { task: "t", isolate: true })
      expect(afterLookups(plain.calls)[0]!.input).toEqual({ projectID: "proj_1" })
      expect(child).not.toHaveProperty("fromParent")
    })

    test("a child that is not isolated does not read the parent's HEAD", async () => {
      const { ports, calls } = fakePorts()
      await isolatedParent(ports)
      ;(ports as any).head = async () => {
        throw new Error("not read")
      }
      await spawn(ports, "ses_parent", { task: "t" })
      expect(afterLookups(calls).map((call) => call.method)).toEqual(["session.create", "session.prompt"])
    })

    test("fails the spawn, starting nothing, when the parent's HEAD cannot be read", async () => {
      const { ports, calls } = fakePorts()
      await isolatedParent(ports)
      ;(ports as any).head = async () => undefined

      await expect(spawn(ports, "ses_parent", { task: "t", isolate: true })).rejects.toThrow("HEAD of your worktree /wt/parent could not be read")
      expect(afterLookups(calls)).toEqual([])
    })

    test("warns when the parent's worktree has uncommitted changes, and not when git cannot tell", async () => {
      const dirty = fakePorts()
      await isolatedParent(dirty.ports)
      ;(dirty.ports as any).dirty = async () => true
      expect(await spawn(dirty.ports, "ses_parent", { task: "t", isolate: true })).toMatchObject({ fromParent: true, uncommitted: true })

      const unknown = fakePorts()
      await isolatedParent(unknown.ports)
      ;(unknown.ports as any).dirty = async () => undefined
      expect(await spawn(unknown.ports, "ses_parent", { task: "t", isolate: true })).not.toHaveProperty("uncommitted")
    })

    test("warns a root with uncommitted changes in its own directory, starting the worktree from the project (#461)", async () => {
      const { ports, calls } = fakePorts()
      const read: string[] = []
      ;(ports as any).dirty = async (directory: string) => (read.push(directory), true)
      ;(ports as any).head = async (directory: string) => (directory === "/repo" ? "root999" : "wt000")

      const child = await spawn(ports, "ses_root", { task: "t", isolate: true })

      expect(read).toEqual(["/repo"])
      expect(afterLookups(calls)[0]!.input).toEqual({ projectID: "proj_1" })
      expect(child).toMatchObject({ uncommitted: true })
      expect(child).not.toHaveProperty("fromParent")
    })

    test("warns a parent that is not isolated about uncommitted changes in its recorded directory", async () => {
      const { ports } = fakePorts()
      await childStore(ports.storage).record({ sessionID: "ses_parent", parentID: "ses_root", title: "P", directory: "/repo/sub", isolated: false, createdAt: 1 })
      const read: string[] = []
      ;(ports as any).dirty = async (directory: string) => (read.push(directory), true)

      expect(await spawn(ports, "ses_parent", { task: "t", isolate: true })).toMatchObject({ uncommitted: true })
      expect(read).toEqual(["/repo/sub"])
    })

    test("starts a root's isolated child without a warning when git fails or the directory is no repository", async () => {
      for (const dirty of [async () => undefined, async () => Promise.reject(new Error("git: not found"))]) {
        const { ports, calls } = fakePorts()
        ;(ports as any).dirty = dirty
        const child = await spawn(ports, "ses_root", { task: "t", isolate: true })
        expect(child).not.toHaveProperty("uncommitted")
        expect(afterLookups(calls).map((call) => call.method)).toContain("session.prompt")
      }
    })

    test("a child that is not isolated does not read the parent's working tree", async () => {
      const { ports } = fakePorts()
      const read: string[] = []
      ;(ports as any).dirty = async (directory: string) => (read.push(directory), true)
      expect(await spawn(ports, "ses_root", { task: "t" })).not.toHaveProperty("uncommitted")
      expect(read).toEqual([])
    })

    test("briefs an isolated child with its branch, and a plain one without", async () => {
      const { ports, calls } = fakePorts()
      await spawn(ports, "ses_parent", { task: "t", isolate: true })
      expect(calls.find((call) => call.method === "session.prompt")!.input.text).toBe(
        childBrief("ses_parent", "t", 1, DEFAULT_LIMITS, "courier/ses_child"),
      )
      expect(childBrief("ses_parent", "t", 1, DEFAULT_LIMITS)).not.toContain("courier/")
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

  test("gives it the agent's own model over the parent's", async () => {
    const model = { id: "small", providerID: "mock" }
    const { ports, calls } = fakePorts({
      info: { model: { id: "chat", providerID: "mock" } },
      agent: { model },
    })

    await spawn(ports, "ses_parent", { task: "t", agent: "build" })

    expect(calls.find((call) => call.method === "session.create")!.input).toMatchObject({ agent: "build", model })
  })

  test("gives it the agent's own model when the parent has none", async () => {
    const model = { id: "small", providerID: "mock" }
    const { ports, calls } = fakePorts({ agent: { model } })

    await spawn(ports, "ses_parent", { task: "t", agent: "build" })

    expect(calls.find((call) => call.method === "session.create")!.input).toMatchObject({ model })
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

  describe("with a model or variant of the caller's choosing", () => {
    const parent = { id: "chat", providerID: "mock", variant: "default" }

    test("runs the child on the named model, checked against the models OpenCode lists, at that model's default variant", async () => {
      const { ports, calls, store } = fakePorts({ info: { model: parent } })

      const child = await spawn(ports, "ses_parent", { task: "t", model: "mock/small" })

      expect(calls.map((call) => call.method)).toEqual(["session.get", "model.list", "session.create", "session.prompt"])
      expect(calls[2]!.input).toMatchObject({ model: { providerID: "mock", id: "small" } })
      expect(calls[2]!.input.model).not.toHaveProperty("variant")
      expect(child).toEqual({ sessionID: "ses_child", directory: "/repo", model: "mock/small" })
      expect(store.get(rosterKey("ses_parent", "ses_child"))).toMatchObject({ model: "mock/small" })
      expect(spawnText(child)).toContain("Started session ses_child in /repo, on mock/small.")
    })

    test("the named model goes before the agent's own and the parent's; the agent is not even looked up", async () => {
      const { ports, calls } = fakePorts({ info: { model: parent }, agent: { model: { id: "chat", providerID: "mock", variant: "high" } } })

      await spawn(ports, "ses_parent", { task: "t", agent: "build", model: "mock/small" })

      expect(calls.map((call) => call.method)).not.toContain("agent.get")
      expect(calls.find((call) => call.method === "session.create")!.input).toMatchObject({ agent: "build", model: { providerID: "mock", id: "small" } })
    })

    test("a variant alone applies to the inherited model, the parent's", async () => {
      const { ports, calls, store } = fakePorts({ info: { model: parent } })

      const child = await spawn(ports, "ses_parent", { task: "t", variant: "high" })

      expect(calls.find((call) => call.method === "session.create")!.input).toMatchObject({ model: { providerID: "mock", id: "chat", variant: "high" } })
      expect(child).toMatchObject({ model: "mock/chat#high" })
      expect(store.get(rosterKey("ses_parent", "ses_child"))).toMatchObject({ model: "mock/chat#high" })
    })

    test("a variant alone applies to the agent's model, replacing the agent's own variant", async () => {
      const { ports, calls } = fakePorts({ info: { model: parent }, agent: { model: { id: "chat", providerID: "mock", variant: "high" } } })

      await spawn(ports, "ses_parent", { task: "t", agent: "build", variant: "low" })

      expect(calls.find((call) => call.method === "session.create")!.input).toMatchObject({ model: { providerID: "mock", id: "chat", variant: "low" } })
    })

    test("an agent that cannot be looked up leaves the child without a model, since the agent may name one, and refuses a variant", async () => {
      const { ports, calls } = fakePorts({ info: { model: parent } })
      ;(ports.agent as any).get = async () => {
        throw new Error("lookup failed")
      }

      await spawn(ports, "ses_parent", { task: "t", agent: "build" })
      expect(calls.find((call) => call.method === "session.create")!.input).not.toHaveProperty("model")

      await expect(spawn(ports, "ses_parent", { task: "t", agent: "build", variant: "high" })).rejects.toThrow(variantWithoutModelRefusal("high", "build"))
    })

    test("a model-less parent's default goes to a child with an agent that names no model, and goes unread when it cannot be read", async () => {
      const { ports, calls } = fakePorts({ defaultModel: KNOWN[0] })
      await spawn(ports, "ses_parent", { task: "t", agent: "build" })
      expect(calls.find((call) => call.method === "session.create")!.input).toMatchObject({ agent: "build", model: { providerID: "mock", id: "chat" } })

      const none = fakePorts()
      ;(none.ports as any).defaultModel = async () => {
        throw new Error("no default")
      }
      const child = await spawn(none.ports, "ses_parent", { task: "t" })
      expect(child).toEqual({ sessionID: "ses_child", directory: "/repo" })
      expect(none.calls.find((call) => call.method === "session.create")!.input).not.toHaveProperty("model")
    })

    test("a model and a variant together", async () => {
      const { ports, calls, store } = fakePorts({ info: { model: parent } })

      await spawn(ports, "ses_parent", { task: "t", model: "mock/chat", variant: "medium" })

      expect(calls.find((call) => call.method === "session.create")!.input).toMatchObject({ model: { providerID: "mock", id: "chat", variant: "medium" } })
      expect(store.get(rosterKey("ses_parent", "ses_child"))).toMatchObject({ model: "mock/chat#medium" })
    })

    test("the caller's own model named again is not recorded as another one, nor said in the result", async () => {
      const { ports, store } = fakePorts({ info: { model: parent } })

      const child = await spawn(ports, "ses_parent", { task: "t", model: "mock/chat", variant: "default" })

      expect(child).toEqual({ sessionID: "ses_child", directory: "/repo" })
      expect(store.get(rosterKey("ses_parent", "ses_child"))).not.toHaveProperty("model")
    })

    test("the agent's model, differing from the parent's, is recorded without a choice made", async () => {
      const { ports, store } = fakePorts({ info: { model: parent }, agent: { model: { id: "small", providerID: "mock" } } })

      const child = await spawn(ports, "ses_parent", { task: "t", agent: "build" })

      expect(child).toMatchObject({ model: "mock/small" })
      expect(store.get(rosterKey("ses_parent", "ses_child"))).toMatchObject({ model: "mock/small" })
    })

    test("null and blank, as some models send an optional field, are left out", async () => {
      const { ports, calls } = fakePorts({ info: { model: parent } })

      await spawn(ports, "ses_parent", { task: "t", model: null as any, variant: " " })

      expect(calls.map((call) => call.method)).toEqual(["session.get", "session.create", "session.prompt"])
      expect(calls[1]!.input).toMatchObject({ model: parent })
    })

    test("refuses a model not named provider/model, before anything is looked up", async () => {
      const { ports, calls } = fakePorts({ info: { model: parent } })

      await expect(spawn(ports, "ses_parent", { task: "t", model: "small" })).rejects.toThrow(modelFormatRefusal("small"))
      await expect(spawn(ports, "ses_parent", { task: "t", model: "mock/" })).rejects.toThrow("Not started: model must be provider/model")
      expect(calls).toEqual([])
    })

    test("refuses a model OpenCode does not list, naming the provider's models, or the providers for an unknown provider", async () => {
      const { ports, calls, store } = fakePorts({ info: { model: parent } })

      await expect(spawn(ports, "ses_parent", { task: "t", model: "mock/huge" })).rejects.toThrow(
        "Not started: OpenCode lists no model mock/huge here. The models of mock here are chat, small. Leave model unset",
      )
      await expect(spawn(ports, "ses_parent", { task: "t", model: "other/huge" })).rejects.toThrow("The providers here are mock.")
      expect(calls.map((call) => call.method)).toEqual(["session.get", "model.list", "session.get", "model.list"])
      expect(store.size).toBe(0)
    })

    test("refuses a variant the model has not, naming its variants", async () => {
      const { ports, calls } = fakePorts({ info: { model: parent } })

      await expect(spawn(ports, "ses_parent", { task: "t", variant: "max" })).rejects.toThrow(
        'Not started: the model mock/chat has no variant "max". Its variants are low, medium, high and default',
      )
      await expect(spawn(ports, "ses_parent", { task: "t", model: "mock/small", variant: "high" })).rejects.toThrow("Its variants are default alone")
      expect(calls.map((call) => call.method)).not.toContain("session.create")
    })

    test("refuses a variant on an inherited model OpenCode does not list", async () => {
      const { ports } = fakePorts({ info: { model: { id: "gone", providerID: "mock" } } })

      await expect(spawn(ports, "ses_parent", { task: "t", variant: "high" })).rejects.toThrow(
        "Not started: the variant cannot be checked, since OpenCode lists no model mock/gone here, the one the session would run on.",
      )
    })

    test("a variant alone, with a parent whose session names no model, applies to OpenCode's default model, which the parent runs on", async () => {
      const { ports, calls, store } = fakePorts({ defaultModel: KNOWN[0] })

      const child = await spawn(ports, "ses_parent", { task: "t", variant: "high" })

      expect(calls.map((call) => call.method)).toEqual(["session.get", "model.default", "model.list", "session.create", "session.prompt"])
      expect(calls[3]!.input).toMatchObject({ model: { providerID: "mock", id: "chat", variant: "high" } })
      expect(child).toMatchObject({ model: "mock/chat#high" })
      expect(store.get(rosterKey("ses_parent", "ses_child"))).toMatchObject({ model: "mock/chat#high" })
    })

    test("a parent whose session names no model runs on OpenCode's default, which its child gets as its own, not as another model", async () => {
      const { ports, calls, store } = fakePorts({ defaultModel: KNOWN[0] })

      const child = await spawn(ports, "ses_parent", { task: "t", model: "mock/chat" })

      expect(calls.map((call) => call.method)).toEqual(["session.get", "model.default", "model.list", "session.create", "session.prompt"])
      expect(calls[3]!.input).toMatchObject({ model: { providerID: "mock", id: "chat" } })
      expect(child).toEqual({ sessionID: "ses_child", directory: "/repo" })
      expect(store.get(rosterKey("ses_parent", "ses_child"))).not.toHaveProperty("model")
    })

    test("with neither a model nor a variant, that default is passed on all the same, so no host falls back on its own", async () => {
      const { ports, calls } = fakePorts({ defaultModel: KNOWN[0] })

      await spawn(ports, "ses_parent", { task: "t" })

      expect(calls.map((call) => call.method)).toEqual(["session.get", "model.default", "session.create", "session.prompt"])
      expect(calls[2]!.input).toMatchObject({ model: { providerID: "mock", id: "chat" } })
    })

    test("refuses a variant when the caller cannot be read, and when its session names no model and the default cannot be read", async () => {
      const { ports } = fakePorts()
      ;(ports.session as any).get = async () => {
        throw new Error("lookup failed")
      }
      await expect(spawn(ports, "ses_parent", { task: "t", variant: "high" })).rejects.toThrow(variantWithoutModelRefusal("high"))

      const none = fakePorts()
      ;(none.ports as any).defaultModel = async () => {
        throw new Error("no default")
      }
      await expect(spawn(none.ports, "ses_parent", { task: "t", variant: "high" })).rejects.toThrow(variantWithoutModelRefusal("high"))
    })

    test("passes a choice through unchecked, logging why, when the models cannot be listed", async () => {
      const { ports, calls, logs } = fakePorts({ info: { model: parent }, models: new Error("no catalog") })

      await spawn(ports, "ses_parent", { task: "t", model: "mock/huge", variant: "max" })

      expect(calls.find((call) => call.method === "session.create")!.input).toMatchObject({ model: { providerID: "mock", id: "huge", variant: "max" } })
      expect(logs).toEqual(["courier_spawn: cannot list the models to check mock/huge#max against: Error: no catalog"])
    })

    test("refuses the lot before any worktree is made", async () => {
      const { ports, calls } = fakePorts({ info: { model: parent } })

      await expect(spawn(ports, "ses_parent", { task: "t", isolate: true, model: "mock/huge" })).rejects.toThrow("Not started")
      expect(calls.map((call) => call.method)).not.toContain("worktree.create")
    })
  })
})
describe("spawn, with a group a model still passes", () => {
  test("ignores it: no group in the result, on the roster entry or in storage, and no name is refused", async () => {
    const { ports, store } = fakePorts()

    const child = await spawn(ports, "ses_parent", { task: "Review a.ts", group: "a/b" } as never)

    expect(child).toEqual({ sessionID: "ses_child", directory: "/repo" })
    expect(store.get(rosterKey("ses_parent", "ses_child"))).not.toHaveProperty("group")
    expect([...store.keys()].filter((key) => key.startsWith("group/"))).toEqual([])
    expect(spawnText(child)).toStartWith("Started session ses_child in /repo. It will report back with courier_send, which starts a new turn for you. Once you have started")
  })

  test("the child's report is delivered alone, when it is sent", async () => {
    const { ports, calls, store } = fakePorts()
    await spawn(ports, "ses_parent", { task: "Review a.ts", group: "pair" } as never)
    await spawn(ports, "ses_parent", { task: "Review b.ts", group: "pair" } as never)
    calls.length = 0

    const sent = await send(ports, "ses_child", { sessionID: "ses_parent", message: "Done.", status: "done" })

    expect(sent).toEqual({ messageID: "msg_2", status: "done", report: true })
    expect(calls.filter((call) => call.method === "session.synthetic").map((call) => call.input.text)).toEqual([envelope("ses_child", "Done.", { status: "done" })])
    expect(store.get(settledKey("ses_child"))).toEqual({ at: 1_000, by: "report", status: "done" })
    expect([...store.keys()].filter((key) => key.startsWith("group/"))).toEqual([])
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

  test("steers a message in even when a model still passes queue", async () => {
    const { ports, calls } = fakePorts()

    await send(ports, "ses_child", { sessionID: "ses_parent", message: "m", queue: true } as never)

    expect(calls[0]!.input.delivery).toBe("steer")
  })

  const spawned = { sessionID: "ses_child", parentID: "ses_parent", title: "t", directory: "/repo", isolated: false, createdAt: 1, reports: "status" as const }
  const report = { sessionID: "ses_parent", message: "m", status: "done" as const }

  test("notes a spawned session's message with a status to its parent, and only that, as its report, with the status", async () => {
    const { ports, store } = fakePorts()
    await childStore(ports.storage).record(spawned)

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

  test("drops a status on a message to a session below the sender, where it means nothing, and says so", async () => {
    const { ports, calls } = fakePorts()
    await childStore(ports.storage).record(spawned)
    await childStore(ports.storage).record({ ...spawned, sessionID: "ses_grand", parentID: "ses_child" })

    expect(await send(ports, "ses_parent", { sessionID: "ses_grand", message: "Undo it.", status: "blocked" })).toEqual({ messageID: "msg_2", dropped: "blocked" })
    expect(calls[0]!.input).toMatchObject({ text: envelope("ses_parent", "Undo it."), metadata: { source: "courier", from: "ses_parent" } })
    expect(await send(ports, "ses_child", { sessionID: "ses_grand", message: "m", status: "done" })).toEqual({ messageID: "msg_2", dropped: "done" })
    expect(await send(ports, "ses_grand", { sessionID: "ses_child", message: "m", status: "done" })).toEqual({ messageID: "msg_2", status: "done", report: true })
    expect(await send(ports, "ses_grand", { sessionID: "ses_parent", message: "m", status: "done" })).toEqual({ messageID: "msg_2", status: "done" })
    expect(await send(ports, "ses_other", { sessionID: "ses_grand", message: "m", status: "done" })).toEqual({ messageID: "msg_2", status: "done" })
  })

  test("drops it to a grandchild whose parent's roster entry has expired, by the reverse index's ancestors", async () => {
    const { ports, store } = fakePorts()
    await childStore(ports.storage).record(spawned)
    await childStore(ports.storage).record({ ...spawned, sessionID: "ses_grand", parentID: "ses_child" })
    store.delete(rosterKey("ses_parent", "ses_child"))

    expect(await send(ports, "ses_parent", { sessionID: "ses_grand", message: "m", status: "blocked" })).toEqual({ messageID: "msg_2", dropped: "blocked" })
  })

  test("keeps the status when the roster cannot be read, as the session may be the sender's parent", async () => {
    const { ports } = fakePorts()
    await childStore(ports.storage).record(spawned)
    ;(ports.storage as any).get = async () => Promise.reject(new Error("disk gone"))

    expect(await send(ports, "ses_parent", { sessionID: "ses_child", message: "m", status: "done" })).toEqual({ messageID: "msg_2", status: "done" })
  })

  test("refuses a status that is none of the four, since OpenCode does not check the schema", async () => {
    const { ports, calls } = fakePorts()

    await expect(send(ports, "ses_child", { sessionID: "ses_parent", message: "m", status: "finished" as never })).rejects.toThrow(
      'status must be one of done, partial, blocked, failed, not "finished".',
    )
    expect(calls).toEqual([])
    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "m", status: null as never })).toEqual({ messageID: "msg_2" })
  })

  test("notes a message without a status to the parent as progress, not as the report, and says so", async () => {
    const { ports, store } = fakePorts()
    await childStore(ports.storage).record(spawned)

    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "halfway" })).toEqual({ messageID: "msg_2", report: false })

    expect(store.has(settledKey("ses_child"))).toBe(false)
    expect(store.get(progressKey("ses_child"))).toEqual({ at: 1_000 })
    await send(ports, "ses_child", { sessionID: "ses_other", message: "m" })
    expect(store.has(progressKey("ses_other"))).toBe(false)
  })

  test("takes a message without a status from a child an older release briefed as its report, as before", async () => {
    const { ports, store } = fakePorts()
    const { reports, ...older } = spawned
    await childStore(ports.storage).record(older)

    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "m" })).toEqual({ messageID: "msg_2", report: true })

    expect(store.get(settledKey("ses_child"))).toEqual({ at: 1_000, by: "report" })
    expect(store.has(progressKey("ses_child"))).toBe(false)
  })

  test("notes the report before delivering it, which may end the parent's turn at once", async () => {
    const { ports, store } = fakePorts()
    await childStore(ports.storage).record(spawned)
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
    await childStore(ports.storage).record(spawned)
    ;(ports.session as any).synthetic = async () => Promise.reject(new Error("parent is gone"))
    await expect(send(ports, "ses_child", report)).rejects.toThrow("parent is gone")
    expect(store.has(settledKey("ses_child"))).toBe(false)
    await expect(send(ports, "ses_child", { sessionID: "ses_parent", message: "m" })).rejects.toThrow("parent is gone")
    expect(store.has(progressKey("ses_child"))).toBe(false)
    store.set(settledKey("ses_child"), { at: 5, by: "failed" })
    await expect(send(ports, "ses_child", report)).rejects.toThrow("parent is gone")
    expect(store.get(settledKey("ses_child"))).toEqual({ at: 5, by: "failed" })

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

describe("send, with what an earlier release left", () => {
  const spawned = { sessionID: "ses_child", parentID: "ses_parent", title: "A", directory: "/repo", isolated: false, createdAt: 1, reports: "status" as const, group: "pair" }

  test("a child whose roster entry names a group reports alone, and a report held for that group stays in storage, unread", async () => {
    const { ports, calls, store } = fakePorts()
    await childStore(ports.storage).record(spawned)
    const held = { title: "B", joinedAt: 2, report: { at: 3, status: "done", message: "held earlier" } }
    store.set("group/ses_parent/pair/ses_child", { title: "A", joinedAt: 1 })
    store.set("group/ses_parent/pair/ses_other", held)
    const { get, scan } = ports.storage
    ;(ports.storage as any).get = async (key: string) => (key.startsWith("group/") ? Promise.reject(new Error("read")) : get(key))
    ;(ports.storage as any).scan = async (input: { prefix: string }) => (input.prefix.startsWith("group/") ? Promise.reject(new Error("read")) : scan(input))

    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "Which?", status: "blocked" })).toEqual({ messageID: "msg_2", status: "blocked", report: true })
    expect(await send(ports, "ses_child", { sessionID: "ses_parent", message: "Done.", status: "done" })).toEqual({ messageID: "msg_2", status: "done", report: true })

    expect(calls.filter((call) => call.method === "session.synthetic").map((call) => call.input.text)).toEqual([
      envelope("ses_child", "Which?", { status: "blocked" }),
      envelope("ses_child", "Done.", { status: "done" }),
    ])
    expect(store.get("group/ses_parent/pair/ses_child")).toEqual({ title: "A", joinedAt: 1 })
    expect(store.get("group/ses_parent/pair/ses_other")).toEqual(held)
  })

  test("a finding a model still passes is dropped: the message has no finding line and the result no finding", async () => {
    const { ports, calls } = fakePorts()
    const { group: _, ...alone } = spawned
    await childStore(ports.storage).record(alone)

    const sent = await send(ports, "ses_child", { sessionID: "ses_parent", message: "init ran.", status: "done", finding: "the key is k", artifacts: { files: ["a"] } } as never)

    expect(sent).toEqual({ messageID: "msg_2", status: "done", report: true })
    const [delivered] = calls.filter((call) => call.method === "session.synthetic")
    expect(delivered!.input.text).toBe('<courier from="ses_child" status="done">\ninit ran.\n\nArtifacts:\n- files: a\n</courier>')
    expect(delivered!.input.metadata).toEqual({ source: "courier", from: "ses_child", status: "done" })
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

  test("says when the person archived the session, archiving having stamped its updated time too (#324)", async () => {
    const { ports } = fakePorts({ info: { time: { created: 1, updated: 9, idle: 5, archived: 9 } } })

    expect(await status(ports, { sessionID: "ses_child" })).toMatchObject({ updated: 9, idle: 5, archived: 9 })
  })
})

describe("described", () => {
  test("gives each child its status and roster fields, or the error looking it up gave", async () => {
    const { ports } = fakePorts({ messages: [{ type: "assistant", content: [{ type: "text", text: "Done" }] }] })
    const get = ports.session.get
    ;(ports.session as any).get = async (input: { sessionID: string }) => {
      if (input.sessionID === "ses_gone") throw Object.assign(new Error(""), { _tag: "Session.NotFoundError", sessionID: "ses_gone" })
      return get(input)
    }
    await childStore(ports.storage).record({ sessionID: "ses_child", parentID: "ses_parent", title: "Fix the bug", directory: "/repo", isolated: false, createdAt: 900 })
    await childStore(ports.storage).record({ sessionID: "ses_gone", parentID: "ses_parent", title: "Gone", directory: "/wt", isolated: true, createdAt: 950 })
    await childStore(ports.storage).record({ sessionID: "ses_else", parentID: "ses_other", title: "Else", directory: "/repo", isolated: false, createdAt: 900 })

    const entries = await childStore(ports.storage).children("ses_parent")
    expect(await Promise.all(entries.map((entry) => described(ports, entry)))).toStrictEqual([
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
        error: "reading the session failed: Session.NotFoundError ses_gone",
      },
    ])
  })

  test("names no group for a child whose roster entry has one from an earlier release, and reads no group key", async () => {
    const { ports } = fakePorts()
    ;(ports.session as any).get = async (input: { sessionID: string }) => ({ id: input.sessionID, time: { created: 1, updated: 2 } })
    const get = ports.storage.get
    ;(ports.storage as any).get = async (key: string) => (key.startsWith("group/") ? Promise.reject(new Error("read")) : get(key))
    await childStore(ports.storage).record({ sessionID: "ses_held", parentID: "ses_parent", title: "t", directory: "/repo", isolated: false, createdAt: 1, reports: "status", group: "pair" })
    await ports.storage.set("group/ses_parent/pair/ses_held", { title: "t", joinedAt: 1, report: { at: 2, status: "done", message: "m" } } as never)

    const [entry] = await childStore(ports.storage).children("ses_parent")
    const listed = await described(ports, entry!)

    expect(listed).toMatchObject({ sessionID: "ses_held", directory: "/repo", isolated: false })
    expect(listed).not.toHaveProperty("group")
    expect(listed).not.toHaveProperty("error")
  })
})

describe("describeFailure", () => {
  test("keeps an error's message", () => {
    expect(describeFailure("courier_send", new Error("boom")).message).toBe("courier_send failed: boom")
  })

  test("falls back to the tag and session of an OpenCode error with an empty message", () => {
    const error = Object.assign(new Error(""), { _tag: "Session.NotFoundError", sessionID: "ses_x" })

    expect(describeFailure("courier_tree", error).message).toBe("courier_tree failed: Session.NotFoundError ses_x")
  })
})
