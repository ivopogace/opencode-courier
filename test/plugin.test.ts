import { afterEach, expect, spyOn, test } from "bun:test"
import { Schema } from "effect"
import plugin, { courier, type RelaySlot } from "../src/index.js"
import { builtVersions } from "../src/version.js"

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** An event stream the test feeds; it ends when the plugin stops watching. */
function fakeEvents() {
  const waiting: Array<(event: unknown) => void> = []
  const queued: unknown[] = []
  const counted = { subscriptions: 0 }
  return {
    counted,
    emit: (event: unknown) => (waiting.length ? waiting.shift()!(event) : void queued.push(event)),
    subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      counted.subscriptions++
      const stopped = new Promise<undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined)))
      while (!signal.aborted) {
        const event = queued.length ? queued.shift() : await Promise.race([new Promise((resolve) => waiting.push(resolve)), stopped])
        if (event !== undefined) yield event
      }
    },
  }
}

/** The pinned OpenCode, as the fake context reports it unless a test says otherwise. */
const pinned = { name: "opencode", version: builtVersions().opencode, channel: "latest" }

async function setUp(
  stored: Record<string, unknown> = {},
  options?: Record<string, unknown>,
  permissions: any[] = [],
  app: { name: string; version: string; channel: string } = pinned,
) {
  const store = new Map(Object.entries(stored))
  const tools = new Map<string, any>()
  const calls: { method: string; input: any }[] = []
  const record = (method: string, result: unknown) => async (input: any) => {
    calls.push({ method, input })
    return result
  }
  const events = fakeEvents()
  const ctx = {
    app,
    options,
    event: { subscribe: events.subscribe },
    agent: { get: record("agent.get", { data: { id: "build" } }) },
    location: { directory: "/repo", project: { id: "proj_1" } },
    session: {
      create: record("session.create", { id: "ses_child", location: { directory: "/repo" } }),
      prompt: record("session.prompt", { id: "msg_1" }),
      synthetic: record("session.synthetic", { id: "msg_2" }),
      get: async (input: any) => {
        calls.push({ method: "session.get", input })
        return { id: input.sessionID, time: { created: 1, updated: 2 } }
      },
      context: record("session.context", []),
    },
    worktree: {
      create: record("worktree.create", { directory: "/wt" }),
      remove: record("worktree.remove", undefined),
    },
    permission: {
      list: async ({ sessionID }: { sessionID: string }) => permissions.filter((item) => item.sessionID === sessionID),
      get: async ({ requestID }: { requestID: string }) => {
        const found = permissions.find((item) => item.id === requestID)
        if (!found) throw new Error(`Permission request not found: ${requestID}`)
        return found
      },
      reply: async (input: any) => {
        calls.push({ method: "permission.reply", input })
        permissions.splice(permissions.findIndex((item) => item.id === input.requestID), 1)
      },
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
  const relay: RelaySlot = {}
  const cleanup = await courier(relay).setup(ctx as any)
  if (cleanup) cleanups.push(cleanup)
  return { tools, calls, store, emit: events.emit, relay, cleanup, subscriptions: () => events.counted.subscriptions }
}

test("OpenCode loads an Effect plugin, which runs the promise one and wraps the question tool", () => {
  expect(plugin.id).toBe("courier")
  expect(typeof plugin.effect).toBe("function")
  expect("setup" in plugin).toBe(false)
})

test("a loaded instance hands the question relay its ports, and takes them back when it unloads", async () => {
  const { relay } = await setUp()

  expect(relay.ports).toBeDefined()
  await cleanups.shift()!()
  expect(relay.ports).toBeUndefined()
})

test("on the pinned OpenCode, loading logs nothing about the version", async () => {
  const logged = spyOn(console, "error").mockImplementation(() => {})
  try {
    const { tools } = await setUp()
    await tools.get("courier_status").execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })

    expect(logged.mock.calls.map(([line]) => line).filter((line) => String(line).includes("built and tested against"))).toEqual([])
  } finally {
    logged.mockRestore()
  }
})

test("on another OpenCode, loading logs one line naming both versions, and tool calls add nothing", async () => {
  const logged = spyOn(console, "error").mockImplementation(() => {})
  try {
    const { tools } = await setUp({}, undefined, [], { name: "opencode", version: "2.0.30", channel: "beta" })
    await tools.get("courier_status").execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    const result = await tools.get("courier_children").execute({}, { sessionID: "ses_parent" })

    const { plugin, opencode } = builtVersions()
    expect(logged.mock.calls.map(([line]) => line)).toEqual([
      `opencode-courier ${plugin} was built and tested against OpenCode ${opencode}; this server is 2.0.30 (channel beta). ` +
        "Its tools may fail: see the Supported OpenCode version table in the README, " +
        "https://github.com/ivopogace/opencode-courier#supported-opencode-version",
    ])
    expect(result.content).not.toContain("built and tested against")
  } finally {
    logged.mockRestore()
  }
})

test("registers the courier tools", async () => {
  const { tools } = await setUp()

  expect([...tools.keys()]).toEqual([
    "courier_spawn",
    "courier_send",
    "courier_status",
    "courier_children",
    "courier_cleanup",
    "courier_answer",
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
  const answer = { sessionID: "s", requestID: "per_1", reply: "reject", message: "no" }
  expect(decode("courier_answer", answer)).toEqual(answer)
  expect(() => decode("courier_answer", { ...answer, reply: "yes" })).toThrow()
  const answers = { sessionID: "s", requestID: "question_1", answers: ["Hi", ["Hello", "Hey"]] }
  expect(decode("courier_answer", answers)).toEqual(answers)
  expect(() => decode("courier_answer", { ...answers, answers: [1] })).toThrow()
})

test("courier_answer tells a question from a permission request by its id, and says what each takes", async () => {
  const { tools } = await setUp()
  const call = (input: object) => tools.get("courier_answer").execute({ sessionID: "ses_child", ...input }, { sessionID: "ses_parent" })

  await expect(call({ requestID: "question_1", reply: "once" })).rejects.toThrow(
    "courier_answer failed: question_1 is a question: pass the person's answers in answers, not reply or message.",
  )
  await expect(call({ requestID: "question_1" })).rejects.toThrow("question_1 is a question: answers is required")
  await expect(call({ requestID: "per_1", answers: ["Hi"] })).rejects.toThrow(
    "per_1 is a permission request: pass the person's choice in reply (once, always or reject), not answers.",
  )
  await expect(call({ requestID: "per_1" })).rejects.toThrow("per_1 is a permission request: reply is required")
})

test("a spawned child's question shows under pending, and courier_answer passes the answers on", async () => {
  const { tools, calls, store } = await setUp()
  await tools.get("courier_spawn").execute({ task: "Fix the bug" }, { sessionID: "ses_parent" })
  // A question whose call was cut off, as after a restart: the answer goes to the child as a message.
  const questions = [{ question: "Which greeting?", header: "Greeting", options: [{ label: "Hi", description: "" }] }]
  store.set("question/question_p1", { requestID: "question_p1", sessionID: "ses_child", top: "ses_parent", title: "Fix the bug", questions, askedAt: Date.now() })

  const status = await tools.get("courier_status").execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
  expect(status.metadata.pending).toEqual([{ type: "question", requestID: "question_p1", questions, stopped: true }])

  const answered = await tools
    .get("courier_answer")
    .execute({ sessionID: "ses_child", requestID: "question_p1", answers: ["Hi"] }, { sessionID: "ses_parent" })
  expect(answered.metadata).toEqual({ sessionID: "ses_child", requestID: "question_p1", answered: true, by: "message", answers: [["Hi"]] })
  expect(answered.content).toContain("Passed the answers to question question_p1 on to ses_child as a message")
  const message = calls.findLast((call) => call.method === "session.synthetic")!.input
  expect(message.sessionID).toBe("ses_child")
  expect(message.text).toContain('<courier from="ses_parent" answers="question_p1">')
  expect(message.text).toContain('User has answered your questions: "Which greeting?"="Hi".')

  const late = await tools
    .get("courier_answer")
    .execute({ sessionID: "ses_child", requestID: "question_p1", answers: ["Hi"] }, { sessionID: "ses_parent" })
  expect(late.metadata.answered).toBe(false)
  expect(late.content).toContain("no longer waits on question question_p1")
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
    ...(ast.indexSignatures ?? []).flatMap((index: any) => [...unsupported(index.parameter, `${path}[key]`), ...unsupported(index.type, `${path}[]`)]),
    ...[...(ast.elements ?? []), ...(ast.rest ?? [])].flatMap((element: any) => unsupported(element, `${path}[]`)),
    ...(ast.types ?? []).flatMap((type: any) => unsupported(type, path)),
  ]
  expect([...tools.values()].flatMap((tool) => unsupported(tool.input.ast, tool.name))).toEqual([])
})

test("courier_spawn uses the calling session as the parent", async () => {
  const { tools, calls } = await setUp()

  const result = await tools.get("courier_spawn").execute({ task: "t" }, { sessionID: "ses_parent" })

  expect(calls.find((call) => call.method === "session.create")!.input.metadata).toEqual({ courier: { parentID: "ses_parent" } })
  expect(result.content).toContain("ses_child")
})

test("a spawned child whose turn fails is reported to its parent", async () => {
  const { tools, calls, emit } = await setUp()
  await tools.get("courier_spawn").execute({ task: "Fix the bug" }, { sessionID: "ses_parent" })

  emit({
    id: `evt_${Math.random()}`,
    type: "session.execution.failed",
    data: { sessionID: "ses_child", error: { type: "provider.auth", message: "blocked", status: 403 } },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const notice = calls.find((call) => call.method === "session.synthetic")!.input
  expect(notice.sessionID).toBe("ses_parent")
  expect(notice.text).toContain('<courier from="ses_child" failed="provider.auth">')
  expect(notice.text).toContain("failed: blocked (provider.auth, status 403)")
})

test("two instances follow OpenCode's events, one as a standby, and a third takes over when one of them unloads", async () => {
  const request = { id: "per_9", sessionID: "ses_child", action: "shell", resources: ["git push"] }
  const first = await setUp()
  const second = await setUp()
  const third = await setUp({}, undefined, [request])
  expect([first.subscriptions(), second.subscriptions(), third.subscriptions()]).toEqual([1, 1, 0])

  // The roster is the third instance's storage, which the others do not share in this fake.
  await third.tools.get("courier_spawn").execute({ task: "Fix the bug" }, { sessionID: "ses_parent" })
  await first.cleanup!()
  cleanups.splice(cleanups.indexOf(first.cleanup!), 1)
  expect(third.subscriptions()).toBe(1)

  // Subscribing relays what is already pending, since the request was asked before.
  await new Promise((resolve) => setTimeout(resolve, 20))
  const notices = third.calls.filter((call) => call.method === "session.synthetic").map((call) => call.input.text)
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain('<courier from="ses_child" asks="permission" request="per_9">')
})

test("a spawned child's permission request reaches its parent, and courier_answer passes the choice back", async () => {
  const request = { id: "per_1", sessionID: "ses_child", action: "shell", resources: ["git push"] }
  const { tools, calls, emit } = await setUp({}, undefined, [request])
  await tools.get("courier_spawn").execute({ task: "Fix the bug" }, { sessionID: "ses_parent" })

  emit({ id: `evt_${Math.random()}`, type: "permission.asked", data: request })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const notice = calls.find((call) => call.method === "session.synthetic")!.input
  expect(notice.sessionID).toBe("ses_parent")
  expect(notice.text).toContain('<courier from="ses_child" asks="permission" request="per_1">')
  const status = await tools.get("courier_status").execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
  expect(status.metadata.pending).toEqual([{ type: "permission", requestID: "per_1", action: "shell", resources: ["git push"] }])

  const answered = await tools.get("courier_answer").execute({ sessionID: "ses_child", requestID: "per_1", reply: "once" }, { sessionID: "ses_parent" })
  expect(answered.metadata).toEqual({ sessionID: "ses_child", requestID: "per_1", reply: "once", answered: true })
  expect(answered.content).toContain("Passed on once for request per_1 of ses_child")
  expect(calls.find((call) => call.method === "permission.reply")!.input).toEqual({ sessionID: "ses_child", requestID: "per_1", decision: "once" })

  // The reply event that answer causes is not reported back as a stale notice.
  emit({ id: `evt_${Math.random()}`, type: "permission.replied", data: { sessionID: "ses_child", requestID: "per_1", reply: "once" } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(calls.filter((call) => call.method === "session.synthetic")).toHaveLength(1)

  const late = await tools.get("courier_answer").execute({ sessionID: "ses_child", requestID: "per_1", reply: "once" }, { sessionID: "ses_parent" })
  expect(late.metadata.answered).toBe(false)
  expect(late.content).toContain("no request per_1 of ses_child is pending in this OpenCode server")
  await expect(
    tools.get("courier_answer").execute({ sessionID: "ses_child", requestID: "per_1", reply: "once" }, { sessionID: "ses_x" }),
  ).rejects.toThrow("courier_answer failed: ses_child's permission requests go to ses_parent")
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
  expect([...store.keys()].filter((key) => key.startsWith("roster"))).toEqual([])
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
  expect([...store.keys()].filter((key) => key.startsWith("later/"))).toEqual([])
})

test("courier_later tells a session scheduling its own check-in to end its turn, and no one else", async () => {
  const { tools } = await setUp()

  const own = await tools.get("courier_later").execute({ message: "check", delayMinutes: 10 }, { sessionID: "ses_parent" })
  const other = await tools
    .get("courier_later")
    .execute({ message: "check", delayMinutes: 10, sessionID: "ses_child" }, { sessionID: "ses_parent" })

  expect(own.content).toContain("It arrives when due, after your current turn if one is running, so do not wait for it")
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

  // The first tick takes the scheduler's owner key, reading it back after a wait of up to a second.
  for (let i = 0; i < 300 && store.has("later/later_x"); i++) await Bun.sleep(10)

  expect(calls.find((call) => call.method === "session.synthetic")?.input).toMatchObject({
    sessionID: "ses_parent",
    delivery: "queue",
  })
  expect([...store.keys()]).toEqual(["scheduler/owner"])
})

test("courier_subscribe subscribes the calling session and says when no receiver runs", async () => {
  const { tools, store } = await setUp()

  const result = await tools.get("courier_subscribe").execute({ topic: "Octo/Repo#5" }, { sessionID: "ses_parent" })

  expect(result.metadata).toEqual({ sessionID: "ses_parent", topic: "github:octo/repo#5", receiver: false })
  expect(result.content).toContain("no webhook receiver runs")
  expect([...store.keys()].filter((key) => key.startsWith("webhook/"))).toEqual(["webhook/github%3Aocto%2Frepo%235/ses_parent"])
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
