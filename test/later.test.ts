import { describe, expect, test } from "bun:test"
import { envelope } from "../src/notices.js"
import { cancel, deliverDue, schedule, type LaterPorts } from "../src/later.js"

const MINUTE = 60_000

function fakePorts(options: { pageSize?: number; failDelivery?: boolean } = {}) {
  const store = new Map<string, unknown>()
  const delivered: any[] = []
  const logs: string[] = []
  const clock = { now: 1_000_000 }
  let ids = 0
  const ports: LaterPorts = {
    storage: {
      get: async (key) => store.get(key) as any,
      set: async (key, value) => void store.set(key, value),
      remove: async (key) => void store.delete(key),
      scan: async ({ prefix, after, limit }) => {
        const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort()
        const start = after === undefined ? 0 : keys.indexOf(after) + 1
        const size = limit ?? options.pageSize ?? keys.length
        const page = keys.slice(start, start + size)
        const entries = page.map((key) => ({ key, value: store.get(key) as any }))
        return start + size < keys.length ? { entries, next: page.at(-1) } : { entries }
      },
    },
    session: {
      synthetic: (async (input: any) => {
        // Yield first, like a real call, so concurrent deliveries interleave.
        await Promise.resolve()
        if (options.failDelivery) throw new Error("session gone")
        delivered.push(input)
        return { id: `msg_${delivered.length}` }
      }) as any,
    },
    now: () => clock.now,
    newID: () => `later_${++ids}`,
    log: (message) => logs.push(message),
  }
  return { ports, store, delivered, logs, clock }
}

describe("schedule", () => {
  test("stores the message with its due time, for the calling session by default", async () => {
    const { ports, store } = fakePorts()

    const entry = await schedule(ports, "ses_parent", { message: "check on ses_child", delayMinutes: 30 })

    expect(entry).toEqual({
      id: "later_1",
      sessionID: "ses_parent",
      from: "ses_parent",
      message: "check on ses_child",
      fireAt: 1_000_000 + 30 * MINUTE,
      createdAt: 1_000_000,
    })
    expect(store.get("later/later_1")).toEqual(entry)
  })

  test("takes an absolute time and another target session", async () => {
    const { ports } = fakePorts()
    const at = new Date(1_000_000 + 5 * MINUTE).toISOString()

    const entry = await schedule(ports, "ses_parent", { message: "m", at, sessionID: "ses_other" })

    expect(entry).toMatchObject({ sessionID: "ses_other", from: "ses_parent", fireAt: 1_000_000 + 5 * MINUTE })
  })

  test("reads a delay sent as a string, as some models send it", async () => {
    const { ports } = fakePorts()

    const entry = await schedule(ports, "ses_parent", { message: "m", delayMinutes: " 2.5 " })

    expect(entry.fireAt).toBe(1_000_000 + 2.5 * MINUTE)
  })

  test.each([
    ["1.", 1],
    [".5", 0.5],
    ["007", 7],
    ["\t3\n", 3],
    ["\u00a04\u2028", 4],
  ])("reads the delay %j", async (delayMinutes, minutes) => {
    const { ports } = fakePorts()

    const entry = await schedule(ports, "ses_parent", { message: "m", delayMinutes })

    expect(entry.fireAt).toBe(1_000_000 + minutes * MINUTE)
  })

  test("rejects a long run of digits with a stray character at once", async () => {
    const { ports } = fakePorts()
    const started = performance.now()

    await expect(schedule(ports, "ses_parent", { message: "m", delayMinutes: `${"1".repeat(100_000)}x` })).rejects.toThrow(
      "zero or more",
    )
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test.each([
    [{ message: "m" }, "exactly one"],
    [{ message: "m", delayMinutes: 1, at: "2030-01-01T00:00:00Z" }, "exactly one"],
    [{ message: "m", delayMinutes: -1 }, "zero or more"],
    [{ message: "m", delayMinutes: Number.NaN }, "zero or more"],
    [{ message: "m", delayMinutes: "soon" }, "zero or more"],
    [{ message: "m", delayMinutes: "" }, "zero or more"],
    [{ message: "m", delayMinutes: "Infinity" }, "zero or more"],
    [{ message: "m", delayMinutes: "0x10" }, "zero or more"],
    [{ message: "m", delayMinutes: "1e3" }, "zero or more"],
    [{ message: "m", delayMinutes: "-2" }, "zero or more"],
    [{ message: "m", delayMinutes: "." }, "zero or more"],
    [{ message: "m", delayMinutes: " " }, "zero or more"],
    [{ message: "m", delayMinutes: "1.2.3" }, "zero or more"],
    [{ message: "m", delayMinutes: "1 2" }, "zero or more"],
    [{ message: "m", delayMinutes: "+1" }, "zero or more"],
    [{ message: "m", delayMinutes: "1x" }, "zero or more"],
    [{ message: "m", delayMinutes: "1..2" }, "zero or more"],
    [{ message: "m", delayMinutes: 1e12 }, "too far away"],
    [{ message: "m", delayMinutes: "1000000000000" }, "too far away"],
    [{ message: "m", at: "tomorrow-ish" }, "not a date"],
    [{ message: "m", at: "1970-01-01T00:00:00Z" }, "in the past"],
  ])("rejects %o", async (input, error) => {
    const { ports, store } = fakePorts()

    await expect(schedule(ports, "ses_parent", input)).rejects.toThrow(error)
    expect(store.size).toBe(0)
  })
})

describe("cancel", () => {
  test("drops a pending message", async () => {
    const { ports, store } = fakePorts()
    const entry = await schedule(ports, "ses_parent", { message: "m", delayMinutes: 1 })

    expect(await cancel(ports, entry.id)).toBe(true)
    expect(store.size).toBe(0)
  })

  test("says so when nothing is pending under the id", async () => {
    const { ports } = fakePorts()

    expect(await cancel(ports, "later_missing")).toBe(false)
  })
})

describe("deliverDue", () => {
  test("delivers only due messages, queued behind any running turn, then forgets them", async () => {
    const { ports, store, delivered, clock } = fakePorts()
    await schedule(ports, "ses_parent", { message: "soon", delayMinutes: 1 })
    await schedule(ports, "ses_parent", { message: "later", delayMinutes: 60 })
    clock.now += 2 * MINUTE

    await deliverDue(ports, new Set())

    expect(delivered).toEqual([
      {
        sessionID: "ses_parent",
        text: envelope("ses_parent", "soon", { scheduled: new Date(1_000_000).toISOString() }),
        description: "Scheduled message from ses_parent",
        metadata: { source: "courier", from: "ses_parent", scheduled: "later_1" },
        delivery: "queue",
      },
    ])
    expect([...store.keys()]).toEqual(["later/later_2"])
  })

  test("delivers nothing before a message is due", async () => {
    const { ports, delivered } = fakePorts()
    await schedule(ports, "ses_parent", { message: "m", delayMinutes: 1 })

    await deliverDue(ports, new Set())

    expect(delivered).toEqual([])
  })

  test("two plugin instances sharing storage and claims deliver a message once", async () => {
    const { ports, delivered, clock } = fakePorts()
    await schedule(ports, "ses_parent", { message: "m", delayMinutes: 1 })
    clock.now += 2 * MINUTE
    const claimed = new Set<string>()

    await Promise.all([deliverDue(ports, claimed), deliverDue(ports, claimed), deliverDue(ports, claimed)])

    expect(delivered).toHaveLength(1)
    expect(claimed.size).toBe(0)
  })

  test("an instance that scanned before another delivered does not deliver again", async () => {
    const { ports, delivered, clock } = fakePorts()
    await schedule(ports, "ses_parent", { message: "m", delayMinutes: 1 })
    clock.now += 2 * MINUTE
    const claimed = new Set<string>()
    const stale = { ...ports, storage: { ...ports.storage } }
    const firstScan = ports.storage.scan({ prefix: "later/" })
    stale.storage.scan = () => firstScan

    await deliverDue(ports, claimed)
    await deliverDue(stale, claimed)

    expect(delivered).toHaveLength(1)
  })

  test("reads every page of pending messages", async () => {
    const { ports, delivered, clock } = fakePorts({ pageSize: 2 })
    for (const message of ["a", "b", "c", "d", "e"]) await schedule(ports, "ses_parent", { message, delayMinutes: 1 })
    clock.now += 2 * MINUTE

    await deliverDue(ports, new Set())

    expect(delivered).toHaveLength(5)
  })

  test("logs and drops a message that cannot be delivered", async () => {
    const { ports, store, logs, clock } = fakePorts({ failDelivery: true })
    await schedule(ports, "ses_parent", { message: "m", delayMinutes: 1 })
    clock.now += 2 * MINUTE

    await deliverDue(ports, new Set())

    expect(store.size).toBe(0)
    expect(logs).toEqual(["courier_later later_1 to ses_parent not delivered: Error: session gone"])
  })
})
