import { describe, expect, test } from "bun:test"
import type { WatchPorts } from "../src/tree/ports.js"
import { wakeKey, wakeStore } from "../src/tree/store.js"
import { treeEvents } from "../src/tree/events.js"
import { missed, stalledAmong, WAKE_MS, wakeMissed, type WakePorts } from "../src/tree/wake.js"

type Message = { id: string; type: string }

/** Ports over an in-memory store, each session's stored messages as given, the clock as set. */
function fakePorts(messages: Record<string, Message[]> = {}) {
  const store = new Map<string, unknown>()
  const sent: any[] = []
  const logged: string[] = []
  let now = 100_000
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
      context: async ({ sessionID }: { sessionID: string }) => messages[sessionID] ?? [],
      synthetic: async (input: { id?: string }) => {
        sent.push(input)
        return { id: input.id ?? "msg_new" }
      },
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID }),
    },
    now: () => now,
    log: (message: string) => void logged.push(message),
    nudge: () => undefined,
    permissions: () => [],
  }
  return {
    ports: ports as unknown as WatchPorts & WakePorts,
    store,
    sent,
    logged,
    messages,
    at: (time: number) => void (now = time),
  }
}

const idle = (id = "msg_idle"): Message => ({ id, type: "idle" })
const assistant = (id = "msg_a"): Message => ({ id, type: "assistant" })

/** A courier message enqueued for `sessionID`, as OpenCode publishes it. */
const enqueued = (sessionID = "ses_parent", inboxID = "msg_report", created = 100_000, metadata: object = { source: "courier", from: "ses_child" }) => ({
  id: `evt_enq_${inboxID}`,
  type: "session.inbox.enqueued",
  created,
  data: { sessionID, inboxID, item: { type: "synthetic", payload: { text: "<courier from=\"ses_child\">done</courier>", description: "Message from ses_child", metadata }, delivery: "steer" } },
})

const event = (type: string, sessionID = "ses_parent", created = 100_000, extra: object = {}) => ({
  id: `evt_${type}_${created}`,
  type,
  created,
  data: { sessionID, ...extra },
})

/** The tree's event module over `ports`, as a hub subscription runs it. */
const handle = (ports: WatchPorts, e: { type: string; data?: unknown }) =>
  treeEvents({ seen: new Set(), inbox: new Map() }, async () => false).handle!(ports, e as never)

describe("watching a courier message until it is delivered", () => {
  test("a courier message enqueued for an idle session is watched as waiting since it arrived", async () => {
    const { ports, store } = fakePorts({ ses_parent: [assistant(), idle()] })
    await handle(ports, enqueued())
    expect(store.get(wakeKey("ses_parent", "msg_report"))).toEqual({
      at: 100_000,
      text: "<courier from=\"ses_child\">done</courier>",
      description: "Message from ses_child",
      running: false,
      idleAt: 100_000,
    })
  })

  test("one enqueued for a session running a turn is watched as running, and the person's prompts and others' messages not at all", async () => {
    const { ports, store } = fakePorts({ ses_parent: [assistant()] })
    await handle(ports, enqueued())
    await handle(ports, enqueued("ses_parent", "msg_other", 100_000, { source: "someone" }))
    await handle(ports, { ...enqueued("ses_parent", "msg_user"), data: { sessionID: "ses_parent", inboxID: "msg_user", item: { type: "user", payload: { text: "hi" } } } })
    expect([...store.keys()]).toEqual([wakeKey("ses_parent", "msg_report")])
    expect((await wakeStore(ports.storage).of("ses_parent"))[0]).toMatchObject({ running: true })
  })

  test("one sent without a wake, which waits for the next turn, is not watched, so it is not sent again or flagged stalled", async () => {
    const { ports, store, sent, at } = fakePorts({ ses_parent: [idle()] })
    await handle(ports, enqueued("ses_parent", "msg_settled", 100_000, { source: "courier", from: "ses_child", resume: false }))
    expect(store.size).toBe(0)
    at(100_000 + WAKE_MS * 3)
    await wakeMissed(ports, new Set())
    expect(sent).toEqual([])
    expect(await stalledAmong(ports, ["ses_parent"])).toEqual(new Map())
  })

  test("its delivery or cancellation ends the watch", async () => {
    const { ports, store } = fakePorts({ ses_parent: [idle()] })
    await handle(ports, enqueued())
    await handle(ports, enqueued("ses_parent", "msg_second"))
    await handle(ports, event("session.inbox.delivered", "ses_parent", 100_100, { inboxID: "msg_report" }))
    await handle(ports, event("session.inbox.cancelled", "ses_parent", 100_100, { inboxID: "msg_second" }))
    expect(store.size).toBe(0)
  })

  test("a turn starting marks it running; one ending keeps it waiting from then, unless the turn took it", async () => {
    const { ports, messages } = fakePorts({ ses_parent: [idle()] })
    await handle(ports, enqueued())
    await handle(ports, enqueued("ses_parent", "msg_taken"))
    await handle(ports, event("session.execution.started", "ses_parent", 100_500))
    expect((await wakeStore(ports.storage).of("ses_parent")).map((wake) => [wake.running, wake.idleAt])).toEqual([
      [true, undefined],
      [true, undefined],
    ])
    // The turn took msg_taken, whose delivery this subscription missed, and left msg_report waiting.
    messages.ses_parent = [idle(), { id: "msg_taken", type: "synthetic" }, assistant(), idle("msg_idle_2")]
    await handle(ports, event("session.execution.succeeded", "ses_parent", 101_000))
    expect(await wakeStore(ports.storage).of("ses_parent")).toEqual([
      expect.objectContaining({ inboxID: "msg_report", running: false, idleAt: 101_000 }),
    ])
  })

  test("a deleted session's watched messages are forgotten", async () => {
    const { ports, store } = fakePorts({ ses_parent: [idle()] })
    await handle(ports, enqueued())
    await handle(ports, event("session.deleted"))
    expect(store.size).toBe(0)
  })
})

describe("waking a session whose wake was missed", () => {
  test("a message left waiting in an idle session is sent again under its inbox id once WAKE_MS has passed, and only once", async () => {
    const { ports, sent, at } = fakePorts({ ses_parent: [idle()] })
    await handle(ports, enqueued())
    at(100_000 + WAKE_MS - 1)
    await wakeMissed(ports, new Set())
    expect(sent).toEqual([])
    at(100_000 + WAKE_MS)
    await wakeMissed(ports, new Set())
    expect(sent).toEqual([
      {
        sessionID: "ses_parent",
        id: "msg_report",
        text: "<courier from=\"ses_child\">done</courier>",
        description: "Message from ses_child",
        metadata: { source: "courier", wake: "again" },
        delivery: "steer",
      },
    ])
    await wakeMissed(ports, new Set())
    expect(sent).toHaveLength(1)
    expect((await wakeStore(ports.storage).of("ses_parent"))[0]).toMatchObject({ rewoken: 100_000 + WAKE_MS })
  })

  test("a session that still does not take it WAKE_MS after the wake again is flagged stalled, and is not woken a third time", async () => {
    const { ports, sent, at, logged } = fakePorts({ ses_parent: [idle()] })
    await handle(ports, enqueued())
    at(100_000 + WAKE_MS)
    await wakeMissed(ports, new Set())
    at(100_000 + 2 * WAKE_MS)
    await wakeMissed(ports, new Set())
    expect(sent).toHaveLength(1)
    expect((await wakeStore(ports.storage).of("ses_parent"))[0]).toMatchObject({ stalled: 100_000 + 2 * WAKE_MS })
    expect(await stalledAmong(ports, ["ses_parent", "ses_other"])).toEqual(new Map([["ses_parent", 100_000]]))
    at(100_000 + 5 * WAKE_MS)
    await wakeMissed(ports, new Set())
    expect(sent).toHaveLength(1)
    expect(logged.some((line) => line.includes("flagged stalled"))).toBe(true)
  })

  test("a stalled session's flag goes once the message is delivered, as when the person prompts it", async () => {
    const { ports, at } = fakePorts({ ses_parent: [idle()] })
    await handle(ports, enqueued())
    at(100_000 + WAKE_MS)
    await wakeMissed(ports, new Set())
    at(100_000 + 2 * WAKE_MS)
    await wakeMissed(ports, new Set())
    await handle(ports, event("session.inbox.delivered", "ses_parent", 200_000, { inboxID: "msg_report" }))
    expect(await stalledAmong(ports, ["ses_parent"])).toEqual(new Map())
  })

  test("a wake that was only slow, whose turn started within WAKE_MS, is left alone", async () => {
    const { ports, sent, at } = fakePorts({ ses_parent: [idle()] })
    await handle(ports, enqueued())
    await handle(ports, event("session.execution.started", "ses_parent", 100_000 + WAKE_MS - 1_000))
    at(100_000 + 3 * WAKE_MS)
    await wakeMissed(ports, new Set())
    expect(sent).toEqual([])
  })

  test("a session that was running anyway is not woken, however long its turn takes", async () => {
    const { ports, sent, at } = fakePorts({ ses_parent: [assistant()] })
    await handle(ports, enqueued())
    at(100_000 + 10 * WAKE_MS)
    await wakeMissed(ports, new Set())
    expect(sent).toEqual([])
  })

  test("but one whose turn ends without taking it is woken WAKE_MS after that end", async () => {
    const { ports, sent, at } = fakePorts({ ses_parent: [assistant()] })
    await handle(ports, enqueued())
    await handle(ports, event("session.execution.interrupted", "ses_parent", 200_000, { reason: "user" }))
    at(200_000 + WAKE_MS - 1)
    await wakeMissed(ports, new Set())
    expect(sent).toEqual([])
    at(200_000 + WAKE_MS)
    await wakeMissed(ports, new Set())
    expect(sent).toHaveLength(1)
  })

  test("a turn the wake again starts may take the message before the send returns, and the watch stays over", async () => {
    const { ports, sent, at } = fakePorts({ ses_parent: [idle()] })
    await handle(ports, enqueued())
    const synthetic = ports.session.synthetic
    ;(ports.session as { synthetic: unknown }).synthetic = async (input: any) => {
      await handle(ports, event("session.execution.started", "ses_parent", 140_000))
      await handle(ports, event("session.inbox.delivered", "ses_parent", 140_000, { inboxID: "msg_report" }))
      return synthetic(input)
    }
    at(100_000 + WAKE_MS)
    await wakeMissed(ports, new Set())
    expect(sent).toHaveLength(1)
    expect(await wakeStore(ports.storage).all()).toEqual([])
  })

  test("a turn a shutdown stops, which resumes on the next start, leaves the watch as it was", async () => {
    const { ports } = fakePorts({ ses_parent: [assistant()] })
    await handle(ports, enqueued())
    await handle(ports, event("session.execution.interrupted", "ses_parent", 200_000, { reason: "shutdown" }))
    expect((await wakeStore(ports.storage).of("ses_parent"))[0]).toMatchObject({ running: true })
  })

  test("a message another tick of the process has claimed is left to it", async () => {
    const { ports, sent, at } = fakePorts({ ses_parent: [idle()] })
    await handle(ports, enqueued())
    at(100_000 + WAKE_MS)
    await wakeMissed(ports, new Set(["wake ses_parent msg_report"]))
    expect(sent).toEqual([])
  })

  test("a wake again that fails is logged, and tried again at the next tick", async () => {
    const { ports, sent, at, logged } = fakePorts({ ses_parent: [idle()] })
    await handle(ports, enqueued())
    const synthetic = ports.session.synthetic
    ;(ports.session as { synthetic: unknown }).synthetic = async () => {
      throw new Error("session not found")
    }
    at(100_000 + WAKE_MS)
    await wakeMissed(ports, new Set())
    expect(logged.some((line) => line.includes("could not wake ses_parent again"))).toBe(true)
    ;(ports.session as { synthetic: unknown }).synthetic = synthetic
    await wakeMissed(ports, new Set())
    expect(sent).toHaveLength(1)
  })
})

test("missed reads only the stored watch: idle past WAKE_MS since it arrived, went idle or was woken again", () => {
  const wake = { sessionID: "s", inboxID: "m", at: 0, text: "t", running: false }
  expect(missed(wake, WAKE_MS)).toBe(true)
  expect(missed({ ...wake, idleAt: 10 }, WAKE_MS)).toBe(false)
  expect(missed({ ...wake, rewoken: 10 }, WAKE_MS)).toBe(false)
  expect(missed({ ...wake, running: true }, WAKE_MS)).toBe(false)
  expect(missed({ ...wake, stalled: 5 }, 10 * WAKE_MS)).toBe(false)
})
