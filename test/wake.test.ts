// The missed-wake watch: a delivery to an idle session whose turn never starts is re-woken once by the
// scheduler, then flagged stalled; a delivery to a running one is taken at its next step, and not tracked.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { envelope } from "../src/kernel/protocol.js"
import { deliverReleased, joinGroup } from "../src/tree/group.js"
import type { GroupPorts } from "../src/tree/ports.js"
import type { Member } from "../src/platform/hub.js"
import { send } from "../src/tree/send.js"
import type { CourierPorts, WatchPorts } from "../src/tree/ports.js"
import { reportBody } from "../src/tree/text.js"
import { expectWake, GRACE_MS, running, stalled, wakeJob } from "../src/tree/wake.js"
import type { WatchState } from "../src/tree/ports.js"
import { childStore, groupStore, wakeKey } from "../src/tree/store.js"
import { treeEvents, type SessionEvent } from "../src/tree/events.js"
import { child, fakePorts } from "./fixtures/events.js"

/** Ports whose clock a test moves, over a store it can read; the parent's last turn ended long before any join. */
function fakeClock() {
  let now = 1_000
  const { ports, store, sent } = fakePorts()
  const clock = { ...ports, now: () => now, session: { ...ports.session, get: async () => ({ time: { idle: 1_000 } }) } } as WatchPorts
  return { ports: clock, store, sent, setNow: (value: number) => (now = value) }
}

/** courier_send through the courier's own ports, at the clock's now. */
function sendFrom(ports: WatchPorts, from: string, to: string, message = "done") {
  const courier = { session: { synthetic: async () => ({ id: "msg_r" }) }, storage: ports.storage, now: ports.now, nudge: ports.nudge } as unknown as CourierPorts
  return send(courier, from, { sessionID: to, message, status: "done" })
}

/** Runs the missed-wake job through a fake owner whose watch ports are `ports`. */
function tick(ports: WatchPorts) {
  return wakeJob({ watch: ports } as unknown as Member, new Set())
}

/** Handles one OpenCode event through the tree's module, as a hub's subscription would, over a state of its own. */
function handle(ports: WatchPorts, event: SessionEvent & { type: string }) {
  const state: WatchState = { seen: new Set(), inbox: new Map(), running: new Set() }
  return treeEvents(state, () => Promise.resolve(false)).handle!(ports, event)
}

const started = (sessionID: string): SessionEvent & { type: string } => ({
  id: "evt_start",
  type: "session.execution.started",
  created: 500,
  data: { sessionID },
})

// The running set is process-wide, so these tests leave it as they found it for the other suites.
beforeEach(() => running.clear())
afterEach(() => running.clear())

describe("expectWake", () => {
  test("notes that a delivered message owes an idle session a turn, with the text it was delivered with", async () => {
    const { ports, store } = fakeClock()
    await childStore(ports.storage).record(child())

    await expectWake(ports.storage, ports.now, "ses_child", "the task")

    expect(store.get(wakeKey("ses_child"))).toEqual({ at: 1_000, state: "due", text: "the task" })
  })

  test("notes nothing for a session whose turn is already under way: it takes the message at its next step", async () => {
    const { ports, store } = fakeClock()
    await childStore(ports.storage).record(child())
    running.add("ses_child")

    await expectWake(ports.storage, ports.now, "ses_child", "the task")

    expect(store.has(wakeKey("ses_child"))).toBe(false)
  })

  test("keeps the first expectation when a second message is delivered within the grace", async () => {
    const { ports, store } = fakeClock()
    await childStore(ports.storage).record(child())

    await expectWake(ports.storage, ports.now, "ses_child", "first")
    await expectWake(ports.storage, () => 2_000, "ses_child", "second")

    expect(store.get(wakeKey("ses_child"))).toEqual({ at: 1_000, state: "due", text: "first" })
  })

  test("replaces a stored value that is not a valid expectation, rather than being blocked by it", async () => {
    const { ports, store } = fakeClock()
    await childStore(ports.storage).record(child())
    await ports.storage.set(wakeKey("ses_child"), { at: 1, state: "nonsense" })

    await expectWake(ports.storage, ports.now, "ses_child", "the task")

    expect(store.get(wakeKey("ses_child"))).toEqual({ at: 1_000, state: "due", text: "the task" })
  })
})

describe("the missed-wake job", () => {
  test("re-wakes an idle session once when its turn does not start within the grace, then flags it stalled", async () => {
    const { ports, store, sent, setNow } = fakeClock()
    await childStore(ports.storage).record(child())
    const text = envelope("ses_child", reportBody("done", undefined), { status: "done" })
    await sendFrom(ports, "ses_child", "ses_parent")

    // The expectation is due, pointing at the message that reached the parent.
    expect(store.get(wakeKey("ses_parent"))).toEqual({ at: 1_000, state: "due", text })
    expect(sent).toEqual([])

    // One tick within the grace: nothing yet.
    setNow(1_000 + GRACE_MS - 1)
    await tick(ports)
    expect(sent).toEqual([])

    // Past the grace: exactly one re-wake, pointing at the message; the episode is marked rewoken.
    setNow(1_000 + GRACE_MS)
    await tick(ports)
    expect(sent).toEqual([
      {
        sessionID: "ses_parent",
        text,
        description: "Session ses_parent did not start its turn",
        metadata: { source: "courier", wake: "rewoken" },
        delivery: "steer",
      },
    ])
    expect(store.get(wakeKey("ses_parent"))).toMatchObject({ state: "rewoken", text })

    // The same episode is never re-woken twice, however many ticks pass.
    setNow(1_000 + 2 * GRACE_MS)
    await tick(ports)
    await tick(ports)
    expect(sent).toHaveLength(1)

    // Past the second grace, still no turn: flagged stalled.
    setNow(1_000 + 2 * GRACE_MS + GRACE_MS)
    await tick(ports)
    expect(store.get(wakeKey("ses_parent"))).toMatchObject({ state: "stalled", text })
    expect(await stalled(ports.storage, "ses_parent")).toBe(true)
    // Nothing more is sent: the stall is for the person to see, not another re-wake.
    expect(sent).toHaveLength(1)
  })

  test("a re-wake the mark could not record waits for a later tick rather than risking a second", async () => {
    const { ports, store, sent, setNow } = fakeClock()
    await childStore(ports.storage).record(child())
    await sendFrom(ports, "ses_child", "ses_parent")

    // The mark's write fails: no re-wake goes out, and the episode stays due.
    const set = ports.storage.set
    ;(ports.storage as any).set = async (key: string, value: unknown) => {
      if (key.endsWith("/wake")) throw new Error("disk full")
      return set(key, value as never)
    }
    setNow(1_000 + GRACE_MS)
    await tick(ports)
    expect(sent).toEqual([])
    expect(store.get(wakeKey("ses_parent"))).toMatchObject({ state: "due" })

    // The write works again: the mark lands, and exactly one re-wake follows.
    ;(ports.storage as any).set = set
    setNow(1_000 + 2 * GRACE_MS)
    await tick(ports)
    expect(sent).toHaveLength(1)
    expect(store.get(wakeKey("ses_parent"))).toMatchObject({ state: "rewoken" })
  })

  test("a delivery to a running session is not tracked, so the job has nothing to act on", async () => {
    const { ports, store, sent } = fakeClock()
    await childStore(ports.storage).record(child())
    running.add("ses_parent")

    await sendFrom(ports, "ses_child", "ses_parent")

    expect(store.has(wakeKey("ses_parent"))).toBe(false)
    await tick(ports)
    expect(sent).toEqual([])
  })

  test("a turn that starts within the grace clears the expectation: no re-wake, no flag", async () => {
    const { ports, store, sent } = fakeClock()
    await childStore(ports.storage).record(child())
    await sendFrom(ports, "ses_child", "ses_parent")

    await handle(ports, started("ses_parent"))
    expect(store.has(wakeKey("ses_parent"))).toBe(false)

    await tick(ports)
    expect(sent).toEqual([])
    expect(await stalled(ports.storage, "ses_parent")).toBe(false)
  })

  test("a turn under way when the job runs clears the expectation, however old", async () => {
    const { ports, store, sent } = fakeClock()
    await childStore(ports.storage).record(child())
    await sendFrom(ports, "ses_child", "ses_parent")
    running.add("ses_parent")

    await tick(ports)

    expect(store.has(wakeKey("ses_parent"))).toBe(false)
    expect(sent).toEqual([])
  })

  test("a deleted session leaves the running set, so it is not still turning", async () => {
    const { ports } = fakeClock()
    await childStore(ports.storage).record(child())
    running.add("ses_child")
    const state: WatchState = { seen: new Set(), inbox: new Map(), running }
    const event = { id: "evt_d", type: "session.deleted", created: 1, data: { sessionID: "ses_child" } } as SessionEvent & { type: string }
    await treeEvents(state, () => Promise.resolve(false)).handle!(ports, event)
    expect(running.has("ses_child")).toBe(false)
  })

  test("a released group's delivery to the parent is tracked like a report", async () => {
    const { ports, store, sent, setNow } = fakeClock()
    await childStore(ports.storage).record({ ...child(), sessionID: "ses_a", title: "A", group: "pair" })
    await joinGroup(groupStore(ports.storage), "ses_parent", "pair", "ses_a", "A", 1)
    await groupStore(ports.storage).put("ses_parent", "pair", "ses_a", {
      title: "A",
      joinedAt: 1,
      report: { at: 1, status: "done", message: "Did it." },
    })
    await deliverReleased(ports as unknown as GroupPorts, new Set())

    // The group's message owes the parent a turn; the job re-wakes it past the grace.
    expect(store.get(wakeKey("ses_parent"))).toMatchObject({ state: "due" })
    expect(sent).toHaveLength(1) // the group's own notice
    setNow(1_000 + GRACE_MS)
    await tick(ports)
    expect(sent).toHaveLength(2) // …then the re-wake, pointing at the message
    expect(sent[1]!.sessionID).toBe("ses_parent")
    expect(store.get(wakeKey("ses_parent"))).toMatchObject({ state: "rewoken" })
  })

  test("the expectation survives a restart: a new store over the same storage acts on it", async () => {
    const first = fakeClock()
    await childStore(first.ports.storage).record(child())
    await sendFrom(first.ports, "ses_child", "ses_parent")

    const second = fakePorts([], [], first.store)
    const moved = { ...second.ports, now: () => 1_000 + GRACE_MS } as WatchPorts
    await tick(moved)

    expect(second.sent).toHaveLength(1)
    expect(second.sent[0]!.sessionID).toBe("ses_parent")
    expect(first.store.get(wakeKey("ses_parent"))).toMatchObject({ state: "rewoken" })
  })

  test("a stalled expectation clears when a turn starts, and is dropped with the report state", async () => {
    const { ports, store, setNow } = fakeClock()
    await childStore(ports.storage).record(child())
    await sendFrom(ports, "ses_child", "ses_parent")

    // One transition per tick: due to re-woken past the first grace, then stalled past the second.
    setNow(1_000 + GRACE_MS)
    await tick(ports)
    expect(store.get(wakeKey("ses_parent"))).toMatchObject({ state: "rewoken" })
    setNow(1_000 + 2 * GRACE_MS)
    await tick(ports)
    expect(store.get(wakeKey("ses_parent"))).toMatchObject({ state: "stalled" })

    // A turn starts at last: the stall flag clears with it.
    await handle(ports, started("ses_parent"))
    expect(store.has(wakeKey("ses_parent"))).toBe(false)

    // A new stall can be flagged again after a fresh delivery and its graces.
    setNow(2_000)
    await sendFrom(ports, "ses_child", "ses_parent")
    setNow(2_000 + GRACE_MS)
    await tick(ports)
    setNow(2_000 + 2 * GRACE_MS)
    await tick(ports)
    expect(store.get(wakeKey("ses_parent"))).toMatchObject({ state: "stalled" })

    // It is dropped with the session's other report notes when it is forgotten.
    await childStore(ports.storage).forgetReport("ses_parent")
    expect(store.has(wakeKey("ses_parent"))).toBe(false)
  })
})
