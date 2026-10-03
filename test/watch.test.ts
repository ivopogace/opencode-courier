import { describe, expect, test } from "bun:test"
import { envelope } from "../src/courier.js"
import { record } from "../src/roster.js"
import { failureNotice, reportFailure, watchFailures, type ExecutionFailed, type WatchPorts } from "../src/watch.js"

const blocked = { type: "provider.auth", message: "This model is not available in your country", status: 403 }

const failed = (sessionID = "ses_child", id = "evt_1"): ExecutionFailed & { type: string } => ({
  id,
  type: "session.execution.failed",
  data: { sessionID, error: blocked },
})

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

describe("watchFailures", () => {
  test("reports failed turns from the event stream and skips other events", async () => {
    const watching = new AbortController()
    const { ports, sent } = fakePorts([[{ id: "evt_0", type: "session.execution.succeeded", data: { sessionID: "ses_child" } }, failed()]])
    await record(ports.storage, child())
    ;(ports.session as any).synthetic = async (input: unknown) => {
      sent.push(input)
      watching.abort()
      return { id: "msg_1" }
    }

    await watchFailures(ports, new Set(), watching.signal, 1)

    expect(sent).toHaveLength(1)
  })

  test("subscribes again after the stream ends or breaks, and logs the break", async () => {
    const watching = new AbortController()
    const { ports, logged, subscriptions } = fakePorts([[], []])
    ;(ports as any).log = (message: string) => {
      logged.push(message)
      watching.abort()
    }

    await watchFailures(ports, new Set(), watching.signal, 1)

    expect(subscriptions()).toBe(3)
    expect(logged).toEqual(["courier watch: event stream broke: Error: stream closed"])
  })

  test("logs a notice that cannot be delivered and keeps watching", async () => {
    const watching = new AbortController()
    const { ports, logged } = fakePorts([[failed("ses_child", "evt_1"), failed("ses_child", "evt_2")]])
    await record(ports.storage, child())
    let attempts = 0
    ;(ports.session as any).synthetic = async () => {
      if (++attempts === 2) watching.abort()
      throw new Error("parent is gone")
    }

    await watchFailures(ports, new Set(), watching.signal, 1)

    expect(attempts).toBe(2)
    expect(logged[0]).toBe("courier watch: could not report the failure of ses_child: Error: parent is gone")
  })
})
