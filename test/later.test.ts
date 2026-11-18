import { describe, expect, test } from "bun:test"
import { envelope } from "../src/kernel/protocol.js"
import { TICK_MS } from "../src/platform/hub.js"
import { cancel, cancelScheduled, deliverDue, schedule, type LaterPorts } from "../src/scheduling/index.js"
import { dueTimer, NEAR_MS } from "../src/scheduling/timer.js"

const MINUTE = 60_000

function fakeAlarm(wake: () => Promise<void> = async () => {}) {
  const alarms: Array<{ run: () => void; ms: number; cleared: boolean }> = []
  let wakes = 0
  const timer = dueTimer({
    set: (run, ms) => alarms[alarms.push({ run, ms, cleared: false }) - 1],
    clear: (handle) => void ((handle as (typeof alarms)[number]).cleared = true),
    wake: () => (wakes++, wake()),
  })
  const waiting = () => alarms.filter((alarm) => !alarm.cleared).map((alarm) => alarm.ms)
  return { timer, alarms, waiting, wakes: () => wakes }
}

function fakePorts(options: { pageSize?: number; failDelivery?: boolean; wake?: () => Promise<void> } = {}) {
  const alarm = fakeAlarm(options.wake)
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
        await Promise.resolve()
        if (options.failDelivery) throw new Error("session gone")
        delivered.push(input)
        return { id: `msg_${delivered.length}` }
      }) as any,
      get: (async () => ({ time: { idle: clock.now } })) as any,
      context: (async () => []) as any,
    },
    now: () => clock.now,
    newID: () => `later_${++ids}`,
    log: (message) => logs.push(message),
    timer: alarm.timer,
  }
  return { ports, store, delivered, logs, clock, ...alarm }
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
        metadata: { source: "courier", from: "ses_parent", scheduled: "later_1", scheduledAt: 1_000_000 },
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

describe("the timer of a message that is near", () => {
  test("is set for the message's time as it is scheduled, and asks for a tick when it fires", async () => {
    const { ports, alarms, wakes } = fakePorts()

    await schedule(ports, "ses_parent", { message: "m", delayMinutes: 0.05 })

    expect(alarms.map((alarm) => alarm.ms)).toEqual([3_000])
    expect(wakes()).toBe(0)
    alarms[0]!.run()
    expect(wakes()).toBe(1)
  })

  test("fires at once for a message due as it is scheduled", async () => {
    const { ports, waiting } = fakePorts()

    await schedule(ports, "ses_parent", { message: "m", delayMinutes: 0 })

    expect(waiting()).toEqual([0])
  })

  test("covers two ticks, so one tick that does not come leaves no gap", () => {
    expect(NEAR_MS).toBe(2 * TICK_MS)
  })

  test("is not set for a message further away, until a tick finds it near, and then only once", async () => {
    const { ports, delivered, waiting, clock } = fakePorts()
    await schedule(ports, "ses_parent", { message: "m", at: new Date(clock.now + NEAR_MS + 1_000).toISOString() })
    expect(waiting()).toEqual([])

    await deliverDue(ports, new Set())
    expect(waiting()).toEqual([])

    clock.now += TICK_MS
    await deliverDue(ports, new Set())
    await deliverDue(ports, new Set())

    expect(waiting()).toEqual([NEAR_MS + 1_000 - TICK_MS])
    expect(delivered).toEqual([])
  })

  test("is set by a tick for a message another server scheduled", async () => {
    const { ports, store, waiting, clock } = fakePorts()
    store.set("later/later_other", { id: "later_other", sessionID: "ses_parent", from: "ses_parent", message: "m", fireAt: clock.now + 5_000, createdAt: clock.now })

    await deliverDue(ports, new Set())

    expect(waiting()).toEqual([5_000])
  })

  test("is cleared by courier_cancel, and by one that finds the message gone", async () => {
    const { ports, store, alarms, waiting } = fakePorts()
    const first = await schedule(ports, "ses_parent", { message: "m", delayMinutes: 0.05 })
    const second = await schedule(ports, "ses_parent", { message: "m", delayMinutes: 0.1 })
    store.delete(`later/${second.id}`)

    expect(await cancel(ports, first.id)).toBe(true)
    expect(await cancel(ports, second.id)).toBe(false)

    expect(alarms.map((alarm) => alarm.cleared)).toEqual([true, true])
    expect(waiting()).toEqual([])
  })

  test("is cleared for every message of a stopped session, and left for another session's", async () => {
    const { ports, waiting } = fakePorts()
    await schedule(ports, "ses_parent", { message: "m", delayMinutes: 0.05, sessionID: "ses_child" })
    await schedule(ports, "ses_parent", { message: "m", delayMinutes: 0.1, sessionID: "ses_child" })
    await schedule(ports, "ses_parent", { message: "m", delayMinutes: 0.2 })

    await cancelScheduled(ports, "ses_child")

    expect(waiting()).toEqual([12_000])
  })

  test("is cleared when a tick delivers the message first", async () => {
    const { ports, delivered, waiting, clock } = fakePorts()
    await schedule(ports, "ses_parent", { message: "m", delayMinutes: 0.05 })
    clock.now += 3_000

    await deliverDue(ports, new Set())

    expect(delivered).toHaveLength(1)
    expect(waiting()).toEqual([])
  })

  test("is cleared when a tick finds the message already delivered by another copy", async () => {
    const { ports, store, delivered, alarms, waiting, clock } = fakePorts()
    const entry = await schedule(ports, "ses_parent", { message: "m", delayMinutes: 0.05 })
    clock.now += 3_000
    const scanned = await ports.storage.scan({ prefix: "later/" })
    store.delete(`later/${entry.id}`)

    await deliverDue({ ...ports, storage: { ...ports.storage, scan: async () => scanned } }, new Set())

    expect(delivered).toEqual([])
    expect(alarms.map((alarm) => alarm.cleared)).toEqual([true])
    expect(waiting()).toEqual([])
  })

  test("that fires before the clock reaches the message's time is set again by the tick it asked for", async () => {
    const { ports, delivered, alarms, clock } = fakePorts()
    await schedule(ports, "ses_parent", { message: "m", delayMinutes: 0.05 })
    clock.now += 2_999

    alarms[0]!.run()
    await deliverDue(ports, new Set())
    expect(delivered).toEqual([])
    expect(alarms.map((alarm) => alarm.ms)).toEqual([3_000, 1])

    clock.now += 1
    alarms[1]!.run()
    await deliverDue(ports, new Set())
    expect(delivered).toHaveLength(1)
    expect(alarms).toHaveLength(2)
  })

  test("logs a tick it could not ask for, and the message waits for the next one", async () => {
    const { ports, store, logs, alarms } = fakePorts({ wake: () => Promise.reject(new Error("no hub")) })
    await schedule(ports, "ses_parent", { message: "m", delayMinutes: 0.05 })

    alarms[0]!.run()
    await Promise.resolve()
    await Promise.resolve()

    expect(logs).toEqual(["courier_later timer: later_1 waits for the next tick: Error: no hub"])
    expect([...store.keys()]).toEqual(["later/later_1"])
  })

  test("is the copy's own when the ports bring none", async () => {
    const { ports, store, delivered, clock } = fakePorts()
    const { timer: _, ...plain } = ports

    const entry = await schedule(plain, "ses_parent", { message: "m", delayMinutes: 0.4 })
    expect(await cancel(plain, entry.id)).toBe(true)
    await schedule(plain, "ses_parent", { message: "m", delayMinutes: 0.4 })
    clock.now += MINUTE
    await deliverDue(plain, new Set())

    expect(delivered).toHaveLength(1)
    expect(store.size).toBe(0)
  })
})
