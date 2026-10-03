import { describe, expect, test } from "bun:test"
import { envelope } from "../src/courier.js"
import { permissionNotice, settledNotice, type PermissionAsked, type PermissionReplied } from "../src/relay.js"
import { record } from "../src/roster.js"
import {
  claim,
  failureNotice,
  reportAsked,
  reportFailure,
  reportReplied,
  watchChildren,
  type ExecutionFailed,
  type WatchPorts,
} from "../src/watch.js"

const blocked = { type: "provider.auth", message: "This model is not available in your country", status: 403 }

const failed = (sessionID = "ses_child", id = "evt_1"): ExecutionFailed & { type: string } => ({
  id,
  type: "session.execution.failed",
  data: { sessionID, error: blocked },
})

const request = { id: "per_1", sessionID: "ses_child", action: "shell", resources: ["git push"], save: ["git push*"] }

const asked = (id = "evt_a", data: PermissionAsked["data"] = request): PermissionAsked & { type: string } => ({
  id,
  type: "permission.asked",
  data,
})

const replied = (id = "evt_r", reply: PermissionReplied["data"]["reply"] = "once"): PermissionReplied & { type: string } => ({
  id,
  type: "permission.replied",
  data: { sessionID: "ses_child", requestID: "per_1", reply },
})

const fresh = () => ({ seen: new Set<string>(), waiting: new Set<string>() })

function fakePorts(streams: unknown[][] = []) {
  const store = new Map<string, unknown>()
  const sent: any[] = []
  const logged: string[] = []
  let subscriptions = 0
  const ports = {
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
    },
    session: {
      synthetic: async (input: unknown) => {
        sent.push(input)
        return { id: "msg_1" }
      },
    },
    event: {
      subscribe: async function* () {
        const events = streams[subscriptions++]
        if (!events) throw new Error("stream closed")
        yield* events
      },
    },
    log: (message: string) => void logged.push(message),
  } as unknown as WatchPorts
  return { ports, sent, logged, subscriptions: () => subscriptions }
}

const child = (parentID = "ses_parent") => ({
  sessionID: "ses_child",
  parentID,
  title: "Fix the bug",
  directory: "/repo",
  isolated: false,
  createdAt: 1,
})

describe("reportFailure", () => {
  test("tells the parent which child failed and why, waking it", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())

    const told = await reportFailure(ports, new Set(), failed())

    expect(told).toEqual(["ses_parent"])
    expect(sent).toEqual([
      {
        sessionID: "ses_parent",
        text: envelope("ses_child", failureNotice("Fix the bug", blocked), { failed: "provider.auth" }),
        description: "Session ses_child failed",
        metadata: { source: "courier", from: "ses_child", failed: true },
        delivery: "steer",
      },
    ])
    expect(sent[0].text).toContain("failed: This model is not available in your country (provider.auth, status 403)")
    expect(sent[0].text).toContain("will not report back on its own")
  })

  test("leaves out a status the error does not carry", () => {
    expect(failureNotice("t", { type: "unknown", message: "boom" })).toContain("failed: boom (unknown).")
  })

  test("ignores a failed session that courier_spawn did not start", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())

    expect(await reportFailure(ports, new Set(), failed("ses_other"))).toEqual([])
    expect(sent).toEqual([])
  })

  test("reports an event once, however many plugin instances see it", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const seen = new Set<string>()

    await Promise.all([reportFailure(ports, seen, failed()), reportFailure(ports, seen, failed())])

    expect(sent).toHaveLength(1)
  })

  test("reports each failed turn of the same child", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const seen = new Set<string>()

    await reportFailure(ports, seen, failed("ses_child", "evt_1"))
    await reportFailure(ports, seen, failed("ses_child", "evt_2"))

    expect(sent).toHaveLength(2)
  })
})

describe("reportAsked", () => {
  test("tells the parent what the child asks for and how to answer, waking it", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const state = fresh()

    const told = await reportAsked(ports, state, asked())

    expect(told).toEqual(["ses_parent"])
    expect(sent).toEqual([
      {
        sessionID: "ses_parent",
        text: envelope("ses_child", permissionNotice("Fix the bug", request, false), { asks: "permission", request: "per_1" }),
        description: "Session ses_child asks for permission",
        metadata: { source: "courier", from: "ses_child", asks: "permission", requestID: "per_1" },
        delivery: "steer",
      },
    ])
    expect(state.waiting).toEqual(new Set(["per_1"]))
  })

  test("tells a parent that was itself spawned that it may ask its own parent", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    await record(ports.storage, { ...child("ses_root"), sessionID: "ses_parent", title: "Lead" })

    await reportAsked(ports, fresh(), asked())

    expect(sent[0].text).toContain("ask the session that started you with courier_send instead")
  })

  test("ignores a request of a session that courier_spawn did not start, and a repeated event", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const state = fresh()

    expect(await reportAsked(ports, state, asked("evt_a", { ...request, sessionID: "ses_other" }))).toEqual([])
    expect(state.waiting.size).toBe(0)
    await Promise.all([reportAsked(ports, state, asked("evt_b")), reportAsked(ports, state, asked("evt_b"))])
    expect(sent).toHaveLength(1)
  })
})

describe("reportReplied", () => {
  test("tells the parent that a request it was told about was answered without it", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const state = fresh()
    await reportAsked(ports, state, asked())

    expect(await reportReplied(ports, state, replied())).toEqual(["ses_parent"])

    expect(sent[1]).toEqual({
      sessionID: "ses_parent",
      text: envelope("ses_child", settledNotice("Fix the bug", "per_1", "once"), { answered: "once", request: "per_1" }),
      description: "Session ses_child no longer asks for permission",
      metadata: { source: "courier", from: "ses_child", answered: "once", requestID: "per_1" },
      delivery: "steer",
    })
    expect(state.waiting.size).toBe(0)
  })

  test("says nothing about a request the parent was not told about or has answered itself", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())

    expect(await reportReplied(ports, fresh(), replied())).toEqual([])
    expect(sent).toEqual([])
  })
})

describe("claim", () => {
  test("remembers a bounded number of values, dropping the oldest", () => {
    const set = new Set<string>()
    expect(claim(set, "a")).toBe(true)
    expect(claim(set, "a")).toBe(false)
    for (let i = 0; i < 1_000; i++) claim(set, `v${i}`)
    expect(set.size).toBe(1_000)
    expect(set.has("a")).toBe(false)
  })
})

describe("watchChildren", () => {
  test("reports failed turns and permission requests from the event stream and skips other events", async () => {
    const watching = new AbortController()
    const { ports, sent } = fakePorts([
      [{ id: "evt_0", type: "session.execution.succeeded", data: { sessionID: "ses_child" } }, failed(), asked(), replied()],
    ])
    await record(ports.storage, child())
    ;(ports.session as any).synthetic = async (input: unknown) => {
      if (sent.push(input) === 3) watching.abort()
      return { id: "msg_1" }
    }

    await watchChildren(ports, fresh(), watching.signal, 1)

    expect(sent.map((notice: any) => notice.description)).toEqual([
      "Session ses_child failed",
      "Session ses_child asks for permission",
      "Session ses_child no longer asks for permission",
    ])
  })

  test("subscribes again after the stream ends or breaks, and logs the break", async () => {
    const watching = new AbortController()
    const { ports, logged, subscriptions } = fakePorts([[], []])
    ;(ports as any).log = (message: string) => {
      logged.push(message)
      watching.abort()
    }

    await watchChildren(ports, fresh(), watching.signal, 1)

    expect(subscriptions()).toBe(3)
    expect(logged).toEqual(["courier watch: event stream broke: Error: stream closed"])
  })

  test("logs a notice that cannot be delivered and keeps watching", async () => {
    const watching = new AbortController()
    const { ports, logged } = fakePorts([[failed("ses_child", "evt_1"), asked("evt_2")]])
    await record(ports.storage, child())
    let attempts = 0
    ;(ports.session as any).synthetic = async () => {
      if (++attempts === 2) watching.abort()
      throw new Error("parent is gone")
    }

    await watchChildren(ports, fresh(), watching.signal, 1)

    expect(attempts).toBe(2)
    expect(logged).toEqual([
      "courier watch: could not handle session.execution.failed of ses_child: Error: parent is gone",
      "courier watch: could not handle permission.asked of ses_child: Error: parent is gone",
    ])
  })
})
