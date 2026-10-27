import { describe, expect, test } from "bun:test"
import { cleanup } from "../src/tree/cleanup.js"
import { DEFAULT_LIMITS } from "../src/tree/domain.js"
import { noteDeleted, noteInterrupted, notePrompt, reportFailure, reportSilent, type ExecutionFailed } from "../src/tree/events.js"
import { deliverReleased, holdReport, joinGroup, membershipOf } from "../src/tree/group.js"
import type { CleanupPorts, CourierPorts, GroupPorts, StopPorts, WatchPorts } from "../src/tree/ports.js"
import { send } from "../src/tree/send.js"
import { standingRows, stateOf, syncStanding } from "../src/tree/standing.js"
import { stop } from "../src/tree/stop.js"
import { childStore, groupStore } from "../src/tree/store.js"
import { STANDING_KEY, STANDING_MAX, STANDING_PREFIX, standingEntry, type StandingRow } from "../src/tree/text.js"
import { child, fakePorts } from "./fixtures/events.js"

// The parent's `standing` entry (#384): what the tree keeps of its children, one line each, put when it changes and
// removed when the parent has no children left, through every tool and event that changes it.

/** A host's keyed session instructions over `entries` (session id to key to value); each call is recorded in `calls`. */
function fakeInstructions(entries = new Map<string, Map<string, unknown>>(), calls: string[] = []) {
  const instructions = {
    entry: {
      put: async ({ sessionID, key, value }: { sessionID: string; key: string; value: unknown }) => {
        calls.push(`put ${sessionID} ${key}`)
        entries.set(sessionID, new Map(entries.get(sessionID)).set(key, value))
      },
      list: async ({ sessionID }: { sessionID: string }) => {
        calls.push(`list ${sessionID}`)
        return [...(entries.get(sessionID) ?? [])].map(([key, value]) => ({ key, value }))
      },
      remove: async ({ sessionID, key }: { sessionID: string; key: string }) => {
        calls.push(`remove ${sessionID} ${key}`)
        entries.get(sessionID)?.delete(key)
      },
    },
  }
  return { instructions, entries, calls, standingOf: (sessionID: string) => entries.get(sessionID)?.get(STANDING_KEY) as string | undefined }
}

/** The watcher's fake ports with keyed instructions on their session. */
function watchPorts() {
  const made = fakePorts()
  const host = fakeInstructions()
  ;(made.ports.session as any).instructions = host.instructions
  return { ...made, ...host }
}

const note = (at: number, more: object = {}) => ({ at, ...more })
const none = { at: undefined, by: undefined, status: undefined, resumesAt: undefined }
const notes = (given: Partial<Record<"prompt" | "settled" | "progress" | "told" | "stopped", object>>) =>
  ({ prompt: none, settled: none, progress: none, told: none, stopped: none, ...given }) as any

const line = (sessionID: string, title: string, state: StandingRow["state"], group?: StandingRow["group"]) => standingEntry([{ sessionID, title, state, ...(group ? { group } : {}) }])

describe("stateOf", () => {
  test("reads a child's state from its report notes, as the silent-turn rule and courier_tree do", () => {
    expect(stateOf(notes({}))).toEqual({ kind: "started" })
    expect(stateOf(notes({ prompt: note(10) }))).toEqual({ kind: "working" })
    expect(stateOf(notes({ prompt: note(10), progress: note(12) }))).toEqual({ kind: "working", progressed: true })
    expect(stateOf(notes({ prompt: note(10), told: note(15) }))).toEqual({ kind: "ended" })
    expect(stateOf(notes({ prompt: note(10), progress: note(12), told: note(15) }))).toEqual({ kind: "ended", progressed: true })
    expect(stateOf(notes({ prompt: note(10), settled: note(20, { by: "report", status: "partial" }) }))).toEqual({ kind: "reported", status: "partial" })
    expect(stateOf(notes({ prompt: note(10), settled: note(20, { by: "report" }) }))).toEqual({ kind: "reported", status: "done" })
    expect(stateOf(notes({ prompt: note(10), settled: note(20, { by: "failed" }) }))).toEqual({ kind: "failed" })
    expect(stateOf(notes({ prompt: note(10), settled: note(20, { by: "interrupted" }) }))).toEqual({ kind: "interrupted" })
    expect(stateOf(notes({ prompt: note(10), settled: note(20, { by: "report", status: "done" }), stopped: note(25) }))).toEqual({ kind: "stopped" })
    // Prompted again: the stop and the earlier report no longer count.
    expect(stateOf(notes({ prompt: note(30), settled: note(20, { by: "report", status: "done" }), stopped: note(25), told: note(16) }))).toEqual({ kind: "working" })
  })
})

describe("standingEntry", () => {
  const rows = (n: number): StandingRow[] => Array.from({ length: n }, (_, i) => ({ sessionID: `ses_${i}`, title: `part ${i}`, state: { kind: "working" } }))

  test("begins with its prefix, lists each child with its state and its group's standing, and clips a long title", () => {
    const text = standingEntry([
      { sessionID: "ses_a", title: "  A long\n title ".padEnd(80, "x"), state: { kind: "reported", status: "done" }, group: { name: "pair", standing: "held" } },
      { sessionID: "ses_b", title: "B", state: { kind: "working" }, group: { name: "pair", standing: "out" } },
      { sessionID: "ses_c", title: "C", state: { kind: "failed" }, group: { name: "pair", standing: "failed" } },
      { sessionID: "ses_d", title: "D", state: { kind: "stopped" }, group: { name: "old", standing: "released" } },
      { sessionID: "ses_e", title: "E", state: { kind: "ended", progressed: true }, group: { name: "old", standing: "unknown" } },
    ])
    expect(text).toStartWith(STANDING_PREFIX)
    expect(text.split("\n").slice(1)).toEqual([
      `- ses_a "A long title ${"x".repeat(27)}… [37 more characters]": reported done; its report is held with group "pair"`,
      '- ses_b "B": working; group "pair" waits for it',
      '- ses_c "C": its turn failed; out of group "pair" (its turn failed)',
      '- ses_d "D": stopped; group "old" was delivered',
      '- ses_e "E": ended its turn without a report, sent progress; in group "old"',
    ])
  })

  test("lists at most STANDING_MAX children, the newest, and counts the older ones", () => {
    const text = standingEntry(rows(STANDING_MAX + 3))
    expect(text.split("\n")).toHaveLength(STANDING_MAX + 2)
    expect(text).toContain(`- ses_3 "part 3"`)
    expect(text).not.toContain(`- ses_2 "part 2"`)
    expect(text).toEndWith("3 older sessions not listed; courier_children lists them.")
    expect(standingEntry(rows(STANDING_MAX))).not.toContain("not listed")
    expect(standingEntry(rows(STANDING_MAX + 1))).toEndWith("1 older session not listed; courier_children lists them.")
  })

  test("stays well under a few KiB at its longest", () => {
    const longest = standingEntry(
      Array.from({ length: STANDING_MAX + 99 }, (_, i) => ({
        sessionID: `ses_${"x".repeat(26)}`,
        title: "t".repeat(200),
        state: { kind: "ended" as const, progressed: true },
        group: { name: "g".repeat(60), standing: "interrupted" as const },
      })),
    )
    expect(longest.length).toBeLessThan(3000)
  })
})

describe("standingRows and syncStanding", () => {
  test("reads a parent's children oldest first with their states and group standings, leaving out expired entries", async () => {
    const { ports } = watchPorts()
    const children = childStore(ports.storage)
    const groups = groupStore(ports.storage)
    await children.record({ ...child(), sessionID: "ses_a", title: "A", createdAt: 1_000_001, group: "pair" })
    await children.record({ ...child(), sessionID: "ses_b", title: "B", createdAt: 1_000_002, group: "pair" })
    await children.record({ ...child(), sessionID: "ses_c", title: "C", createdAt: 1_000_003 })
    await children.record({ ...child(), sessionID: "ses_old", title: "Old", createdAt: 1_000_000 - 13 * 24 * 3_600_000 })
    await joinGroup(groups, "ses_parent", "pair", "ses_a", "A", 1)
    await joinGroup(groups, "ses_parent", "pair", "ses_b", "B", 2)
    await children.prompted("ses_a", 5)
    await children.prompted("ses_b", 5)
    await children.settled("ses_a", "report", 9, "done")
    await holdReport(groups, (await membershipOf(groups, "ses_parent", "pair", "ses_a"))!, { at: 9, status: "done", message: "m" })

    expect(await standingRows(ports.storage, "ses_parent", 1_000_000)).toEqual([
      { sessionID: "ses_old", title: "Old", state: { kind: "started" } },
      { sessionID: "ses_a", title: "A", state: { kind: "reported", status: "done" }, group: { name: "pair", standing: "held" } },
      { sessionID: "ses_b", title: "B", state: { kind: "working" }, group: { name: "pair", standing: "out" } },
      { sessionID: "ses_c", title: "C", state: { kind: "started" } },
    ])
    expect(await standingRows(ports.storage, "ses_parent", 1_000_000 + 14 * 24 * 3_600_000)).toHaveLength(3)
    expect(await standingRows(ports.storage, "ses_other", 1_000_000)).toEqual([])
  })

  test("puts the entry when its text changed, skips a put of the text stored, and removes it once the parent has no children", async () => {
    const { ports, calls, standingOf } = watchPorts()
    const children = childStore(ports.storage)
    expect(await syncStanding(ports, "ses_parent")).toBe("absent")
    await children.record({ ...child(), title: "A" })

    expect(await syncStanding(ports, "ses_parent")).toBe("put")
    expect(standingOf("ses_parent")).toBe(line("ses_child", "A", { kind: "started" }))
    expect(await syncStanding(ports, "ses_parent")).toBe("unchanged")
    await children.prompted("ses_child", 5)
    expect(await syncStanding(ports, "ses_parent")).toBe("put")
    expect(standingOf("ses_parent")).toBe(line("ses_child", "A", { kind: "working" }))
    await children.remove("ses_parent", "ses_child")
    expect(await syncStanding(ports, "ses_parent")).toBe("removed")
    expect(standingOf("ses_parent")).toBeUndefined()
    expect(calls).toEqual(["list ses_parent", "list ses_parent", `put ses_parent ${STANDING_KEY}`, "list ses_parent", "list ses_parent", `put ses_parent ${STANDING_KEY}`, "list ses_parent", `remove ses_parent ${STANDING_KEY}`])
  })

  test("is skipped without keyed instructions, as through an older copy's watch ports or on a host before 2.2.0", async () => {
    const { ports } = fakePorts()
    await childStore(ports.storage).record(child())
    expect(await syncStanding(ports, "ses_parent")).toBe("skipped")
    expect(await syncStanding({ ...ports, session: {} }, "ses_parent")).toBe("skipped")
  })

  test("logs a failed put or read and never throws, so the notice or tool result it follows is the one reported", async () => {
    const { ports, logged, instructions } = watchPorts()
    await childStore(ports.storage).record(child())
    instructions.entry.put = async () => Promise.reject(new Error("no such route"))
    expect(await syncStanding(ports, "ses_parent")).toBe("skipped")
    instructions.entry.list = async () => Promise.reject(new Error("db locked"))
    expect(await syncStanding(ports, "ses_parent")).toBe("skipped")
    expect(logged).toEqual([
      "courier: the standing entry of ses_parent could not be written, so it may be behind courier_children: Error: no such route",
      "courier: the standing entry of ses_parent could not be written, so it may be behind courier_children: Error: db locked",
    ])
  })
})

const blocked = { type: "provider.auth", message: "This model is not available in your country", status: 403 }
const failedEvent = (sessionID = "ses_child", id = "evt_1"): ExecutionFailed & { type: string } => ({ id, type: "session.execution.failed", data: { sessionID, error: blocked } })
const sessionEvent = (type: string, id: string, created: number, sessionID = "ses_child", reason?: string) => ({ id, type, created, data: { sessionID, ...(reason ? { reason } : {}) } })

/** courier_send through the courier's own ports over the watcher's, at `now`. */
function sendFrom(ports: WatchPorts, from: string, to: string, now: number, status?: "done" | "blocked" | "partial") {
  const courier = { session: { synthetic: async () => ({ id: "msg_r" }), instructions: (ports.session as any).instructions }, storage: ports.storage, now: () => now, nudge: ports.nudge, log: ports.log } as unknown as CourierPorts
  return send(courier, from, { sessionID: to, message: "m", ...(status ? { status } : {}) })
}

describe("the standing through the tools and events", () => {
  test("moves with a child's progress, its report, and a prompt that has it owe a report again", async () => {
    const { ports, standingOf } = watchPorts()
    await childStore(ports.storage).record({ ...child(), title: "A" })
    await childStore(ports.storage).prompted("ses_child", 5)

    await sendFrom(ports, "ses_child", "ses_parent", 10)
    expect(standingOf("ses_parent")).toBe(line("ses_child", "A", { kind: "working", progressed: true }))
    await sendFrom(ports, "ses_child", "ses_parent", 20, "partial")
    expect(standingOf("ses_parent")).toBe(line("ses_child", "A", { kind: "reported", status: "partial", progressed: true }))
    await notePrompt(ports, sessionEvent("session.inbox.delivered", "evt_p", 30))
    expect(standingOf("ses_parent")).toBe(line("ses_child", "A", { kind: "working" }))
    await sendFrom(ports, "ses_child", "ses_parent", 40, "blocked")
    expect(standingOf("ses_parent")).toBe(line("ses_child", "A", { kind: "reported", status: "blocked" }))
  })

  test("a message to a session that did not start the sender moves no standing", async () => {
    const { ports, calls } = watchPorts()
    await childStore(ports.storage).record({ ...child(), title: "A" })
    await sendFrom(ports, "ses_child", "ses_stranger", 10, "done")
    expect(calls).toEqual([])
  })

  test("shows a member's report held with its group, and the group delivered once the scheduler releases it", async () => {
    const { ports, standingOf, instructions } = watchPorts()
    const children = childStore(ports.storage)
    await children.record({ ...child(), sessionID: "ses_a", title: "A", group: "pair" })
    await joinGroup(groupStore(ports.storage), "ses_parent", "pair", "ses_a", "A", 1)
    await children.prompted("ses_a", 5)

    const sent = await sendFrom(ports, "ses_a", "ses_parent", 10, "done")
    expect(sent.held?.group).toBe("pair")
    expect(standingOf("ses_parent")).toBe(line("ses_a", "A", { kind: "reported", status: "done" }, { name: "pair", standing: "held" }))

    const group: GroupPorts = { storage: ports.storage, session: { synthetic: ports.session.synthetic, get: async () => ({ time: { idle: 1_000 } }), instructions } as any, now: () => 2_000, log: ports.log }
    await deliverReleased(group, new Set())
    expect(standingOf("ses_parent")).toBe(line("ses_a", "A", { kind: "reported", status: "done" }, { name: "pair", standing: "released" }))
  })

  test("a child's failed turn, silent end, interruption and deletion each move its parent's standing, the last removing it", async () => {
    const { ports, standingOf } = watchPorts()
    const children = childStore(ports.storage)
    await children.record({ ...child(), title: "A" })
    await children.prompted("ses_child", 5)

    await reportFailure(ports, new Set(), { ...failedEvent(), created: 10 })
    expect(standingOf("ses_parent")).toBe(line("ses_child", "A", { kind: "failed" }))
    await notePrompt(ports, sessionEvent("session.inbox.delivered", "evt_p", 20))
    await reportSilent(ports, new Set(), sessionEvent("session.execution.succeeded", "evt_s", 30), async () => false)
    expect(standingOf("ses_parent")).toBe(line("ses_child", "A", { kind: "ended" }))
    await notePrompt(ports, sessionEvent("session.inbox.delivered", "evt_p2", 40))
    await noteInterrupted(ports, sessionEvent("session.execution.interrupted", "evt_i", 50))
    expect(standingOf("ses_parent")).toBe(line("ses_child", "A", { kind: "interrupted" }))
    await noteDeleted(ports, sessionEvent("session.deleted", "evt_d", 60))
    expect(standingOf("ses_parent")).toBeUndefined()
  })

  test("courier_stop marks the stopped children on each parent among them, and courier_cleanup drops a forgotten child", async () => {
    const { ports, standingOf, instructions } = watchPorts()
    const children = childStore(ports.storage)
    await children.record({ ...child(), sessionID: "ses_mid", title: "Mid" })
    await children.record({ ...child("ses_mid"), sessionID: "ses_leaf", title: "Leaf" })
    await children.prompted("ses_mid", 5)
    await children.prompted("ses_leaf", 5)
    const courier = { ...ports, session: { ...ports.session, interrupt: async () => ({ interrupted: true }), instructions }, limits: DEFAULT_LIMITS } as unknown as CourierPorts
    const cleanupPorts: CleanupPorts = { ...courier, worktree: { remove: async () => {} }, inspect: async () => undefined } as unknown as CleanupPorts
    const stopPorts: StopPorts = { courier, cancelScheduled: async () => [], cleanup: cleanupPorts }

    await stop(stopPorts, "ses_parent", { sessionID: "ses_mid" })
    expect(standingOf("ses_parent")).toBe(line("ses_mid", "Mid", { kind: "stopped" }))
    expect(standingOf("ses_mid")).toBe(line("ses_leaf", "Leaf", { kind: "stopped" }))

    await cleanup(cleanupPorts, "ses_mid", { sessionID: "ses_leaf" })
    expect(standingOf("ses_mid")).toBeUndefined()
    expect(standingOf("ses_parent")).toBe(line("ses_mid", "Mid", { kind: "stopped" }))
  })
})
