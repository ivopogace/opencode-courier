import { describe, expect, test } from "bun:test"
import { envelope } from "../src/kernel/protocol.js"
import { failureNotice, silentNotice } from "../src/tree/text.js"
import { formNotice, formSettledNotice, permissionNotice, permissionSettledNotice as settledNotice } from "../src/person/text.js"
import { personEvents } from "../src/person/events.js"
import type { PersonState } from "../src/person/index.js"
import { asksPermission, type PermissionAsked } from "../src/person/permission.js"
import { eventsFollowed, shutdownReportedAt } from "../src/person/question/index.js"
import { open, type Hub, type Member } from "../src/platform/hub.js"
import { resetHub } from "./fixtures/reset.js"
import { shared as relayState } from "../src/person/question/shared.js"
import { send } from "../src/tree/send.js"
import { joinGroup } from "../src/tree/group.js"
import { reportOf } from "../src/tree/report.js"
import { forgetChild } from "../src/tree/forget.js"
import { childStore, groupStore, memberKey, promptKey, settledKey, toldKey } from "../src/tree/store.js"
import {
  noteDeleted,
  noteInterrupted,
  noteEnqueued,
  notePrompt,
  reportFailure,
  reportSilent,
  together,
  treeEvents,
  waitsOn,
  type ExecutionFailed,
  type SessionEvent,
} from "../src/tree/events.js"
import type { CourierPorts, WatchPorts, WatchState } from "../src/tree/ports.js"
import { follow, watchFromHub } from "../src/platform/events.js"
import { isScheduled } from "../src/scheduling/index.js"
import { asksQuestion } from "../src/person/question/index.js"
import { subscribedSince } from "../src/webhook/index.js"
import { asked, child, fakePorts, fresh, replied, request, settled, shown } from "./fixtures/events.js"

/** What a session waits on outside the tree, as src/index.ts composes it. */
const outside = waitsOn(asksPermission, asksQuestion, together(isScheduled, subscribedSince))

/** The plugin's event modules over `state`, in src/index.ts's order. */
const modules = (state: WatchState & PersonState) => [treeEvents(state, outside), personEvents(state)]

/** Follows the events through `ports` with the plugin's modules, as a hub's subscription does. */
const watchChildren = (ports: WatchPorts, state: WatchState & PersonState, signal: AbortSignal, retryMs?: number) =>
  follow(ports, modules(state), signal, retryMs)

/** Whether a spawned session owes its parent a report, as `reportOf` reads it. */
const owesReport = async (storage: Parameters<typeof childStore>[0], sessionID: string) => (await reportOf(childStore(storage), sessionID))?.owes

const blocked = { type: "provider.auth", message: "This model is not available in your country", status: 403 }

const failed = (sessionID = "ses_child", id = "evt_1"): ExecutionFailed & { type: string } => ({
  id,
  type: "session.execution.failed",
  data: { sessionID, error: blocked },
})


describe("reportFailure", () => {
  test("tells the parent which child failed and why, waking it", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())

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
    await childStore(ports.storage).record(child())

    expect(await reportFailure(ports, new Set(), failed("ses_other"))).toEqual([])
    expect(sent).toEqual([])
  })

  test("reports an event once, however many plugin instances see it", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    const seen = new Set<string>()

    await Promise.all([reportFailure(ports, seen, failed()), reportFailure(ports, seen, failed())])

    expect(sent).toHaveLength(1)
  })

  test("tells nothing of a failure after courier_stop stopped the child, until it is prompted again", async () => {
    const { ports, sent, store } = fakePorts()
    await childStore(ports.storage).record(child())
    await notePrompt(ports, delivered("evt_d", 100))
    await childStore(ports.storage).stopped("ses_child", 150)

    expect(await reportFailure(ports, new Set(), failed("ses_child", "evt_1"))).toEqual([])
    expect(sent).toEqual([])
    expect(store.get(settledKey("ses_child"))).toMatchObject({ by: "failed" })

    await notePrompt(ports, delivered("evt_d2", 300))
    expect(await reportFailure(ports, new Set(), failed("ses_child", "evt_2"))).toEqual(["ses_parent"])
  })

  test("reports each failed turn of the same child", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    const seen = new Set<string>()

    await reportFailure(ports, seen, failed("ses_child", "evt_1"))
    await reportFailure(ports, seen, failed("ses_child", "evt_2"))

    expect(sent).toHaveLength(2)
  })
})

/** OpenCode's event of type `type` for `sessionID`, published at `created`. */
const sessionEvent = (type: string, id: string, created: number, sessionID = "ses_child", reason?: string) => ({
  id,
  type,
  created,
  data: { sessionID, ...(reason ? { reason } : {}) },
})
const delivered = (id: string, created: number, sessionID = "ses_child", inboxID?: string) => {
  const event = sessionEvent("session.inbox.delivered", id, created, sessionID)
  return inboxID ? { ...event, data: { ...event.data, inboxID } } : event
}
/** OpenCode's `session.inbox.enqueued` of an item of type `type`, which a `delivered` with `inboxID` later delivers. */
const enqueued = (id: string, inboxID: string, type: string, sessionID = "ses_child") => ({
  id,
  type: "session.inbox.enqueued",
  created: 1,
  data: { sessionID, inboxID, item: { type, payload: {}, delivery: "steer" } },
})
const succeeded = (id: string, created: number, sessionID = "ses_child") => sessionEvent("session.execution.succeeded", id, created, sessionID)

/** courier_send through the courier's own ports, over the watcher's storage, at `now`: a report with `status`, or progress with "none". */
function sendFrom(ports: WatchPorts, from: string, to: string, now: number, status: "done" | "blocked" | "none" = "done") {
  const courier = { session: { synthetic: async () => ({ id: "msg_r" }) }, storage: ports.storage, now: () => now, nudge: ports.nudge } as unknown as CourierPorts
  return send(courier, from, { sessionID: to, message: "done", ...(status === "none" ? {} : { status }) })
}

describe("the Waits port's composition", () => {
  const ports = fakePorts().ports
  const supplier = (answer: boolean | Error, asked: string[], name: string) => async () => {
    asked.push(name)
    if (answer instanceof Error) throw answer
    return answer
  }

  test("waitsOn asks its suppliers in order, the first that waits answering", async () => {
    const asked: string[] = []
    const waits = waitsOn(supplier(false, asked, "a"), supplier(true, asked, "b"), supplier(true, asked, "c"))
    expect(await waits(ports, "ses_child", 0)).toBe(true)
    expect(asked).toEqual(["a", "b"])
    expect(await waitsOn(supplier(false, asked, "d"))(ports, "ses_child", 0)).toBe(false)
  })

  test("together asks its suppliers at once: it waits when one does, and fails when one fails", async () => {
    const asked: string[] = []
    expect(await together(supplier(false, asked, "a"), supplier(true, asked, "b"))(ports, "ses_child", 0)).toBe(true)
    expect(await together(supplier(false, asked, "c"), supplier(false, asked, "d"))(ports, "ses_child", 0)).toBe(false)
    await expect(together(supplier(true, asked, "e"), supplier(new Error("storage gone"), asked, "f"))(ports, "ses_child", 0)).rejects.toThrow("storage gone")
    expect(asked).toEqual(["a", "b", "c", "d", "e", "f"])
  })
})

describe("reportSilent", () => {
  test("tells the parent once of a turn that ended without a report, with the child's last reply, waking it", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    const seen = new Set<string>()
    await notePrompt(ports, delivered("evt_d", 100))

    const told = await Promise.all([reportSilent(ports, seen, succeeded("evt_s", 200), outside), reportSilent(ports, seen, succeeded("evt_s", 200), outside)])

    expect(told).toEqual([["ses_parent"], []])
    expect(sent).toEqual([
      {
        sessionID: "ses_parent",
        text: envelope("ses_child", silentNotice("Fix the bug", "Looked at it; line 4 is wrong."), { ended: "without-report" }),
        description: "Session ses_child ended without a report",
        metadata: { source: "courier", from: "ses_child", ended: "without-report" },
        delivery: "steer",
      },
    ])
  })

  test("tells nothing of a turn that ended after courier_stop stopped the child, even before the interrupt was noted", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    await notePrompt(ports, delivered("evt_d", 100))
    await childStore(ports.storage).stopped("ses_child", 150)

    expect(await reportSilent(ports, new Set(), succeeded("evt_s", 200), outside)).toEqual([])
    expect(sent).toEqual([])
  })

  test("tells nothing of a turn in which the child reported to its parent", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    await notePrompt(ports, delivered("evt_d", 100))
    await sendFrom(ports, "ses_child", "ses_parent", 150)

    expect(await reportSilent(ports, new Set(), succeeded("evt_s", 200), outside)).toEqual([])
    expect(sent).toEqual([])
  })

  test("tells of a turn after a message to the parent without a status, which is progress, and says so", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    await notePrompt(ports, delivered("evt_d", 100))
    await sendFrom(ports, "ses_child", "ses_parent", 150, "none")

    expect(await reportSilent(ports, new Set(), succeeded("evt_s", 200), outside)).toEqual(["ses_parent"])

    expect(sent[0].text).toBe(envelope("ses_child", silentNotice("Fix the bug", "Looked at it; line 4 is wrong.", true), { ended: "without-report" }))
    expect(sent[0].text).toContain("Its last message to you had no status")
  })

  test("a blocked report settles the report too: the parent has been told and must act", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    await notePrompt(ports, delivered("evt_d", 100))
    await sendFrom(ports, "ses_child", "ses_parent", 150, "blocked")

    expect(await reportSilent(ports, new Set(), succeeded("evt_s", 200), outside)).toEqual([])
    expect(sent).toEqual([])
    expect(await owesReport(ports.storage, "ses_child")).toBe(false)
  })

  test("takes a message without a status from a child an older release briefed as its report, and tells nothing", async () => {
    const { ports, sent } = fakePorts()
    const { reports, ...older } = child()
    await childStore(ports.storage).record(older)
    await notePrompt(ports, delivered("evt_d", 100))
    await sendFrom(ports, "ses_child", "ses_parent", 150, "none")

    expect(await reportSilent(ports, new Set(), succeeded("evt_s", 200), outside)).toEqual([])
    expect(sent).toEqual([])
  })

  test("tells of a turn after a message that reached the child once it had reported", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    const seen = new Set<string>()
    await notePrompt(ports, delivered("evt_d1", 100))
    await sendFrom(ports, "ses_child", "ses_parent", 150)
    // Steered into the same turn, after the report.
    await notePrompt(ports, delivered("evt_d2", 160))

    expect(await reportSilent(ports, seen, succeeded("evt_s", 200), outside)).toEqual(["ses_parent"])
    expect(sent).toHaveLength(1)
  })

  test("judges by when OpenCode delivered the prompt, not when the watcher got to it", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    // The report is noted before the event of the prompt it answers is handled.
    await sendFrom(ports, "ses_child", "ses_parent", 150)
    await notePrompt(ports, delivered("evt_d", 100))

    expect(await reportSilent(ports, new Set(), succeeded("evt_s", 200), outside)).toEqual([])
    expect(sent).toEqual([])
  })

  test("a message to any session but its parent is not a report", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    await childStore(ports.storage).record({ ...child(), sessionID: "ses_sibling" })
    await notePrompt(ports, delivered("evt_d", 100))
    await sendFrom(ports, "ses_child", "ses_sibling", 150)
    await sendFrom(ports, "ses_child", "ses_root", 150)

    expect(await reportSilent(ports, new Set(), succeeded("evt_s", 200), outside)).toEqual(["ses_parent"])
    expect(sent).toHaveLength(1)
  })

  test("tells nothing while the child waits on a permission request or a question", async () => {
    const waiting = fakePorts([], [request])
    await childStore(waiting.ports.storage).record(child())
    await notePrompt(waiting.ports, delivered("evt_d", 100))
    expect(await reportSilent(waiting.ports, new Set(), succeeded("evt_s", 200), outside)).toEqual([])

    const asking = fakePorts()
    await childStore(asking.ports.storage).record(child())
    await notePrompt(asking.ports, delivered("evt_d", 100))
    await asking.ports.storage.set("question/question_1", {
      requestID: "question_1",
      sessionID: "ses_child",
      top: "ses_parent",
      title: "Fix the bug",
      questions: [],
      askedAt: 1,
    })
    expect(await reportSilent(asking.ports, new Set(), succeeded("evt_s", 200), outside)).toEqual([])
    expect([...waiting.sent, ...asking.sent]).toEqual([])
  })

  test("tells nothing while a session it started owes it a report, as one that split its task waits for them", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    await childStore(ports.storage).record({ ...child("ses_child"), sessionID: "ses_grandchild" })
    const seen = new Set<string>()
    await notePrompt(ports, delivered("evt_d1", 100))
    await notePrompt(ports, delivered("evt_d2", 110, "ses_grandchild"))
    expect(await reportSilent(ports, seen, succeeded("evt_s1", 200), outside)).toEqual([])

    // Woken by its child's report, it ends its turn without reporting itself.
    await sendFrom(ports, "ses_grandchild", "ses_child", 300)
    await notePrompt(ports, delivered("evt_d3", 310))
    expect(await reportSilent(ports, seen, succeeded("evt_s2", 400), outside)).toEqual(["ses_parent"])
    expect(sent).toHaveLength(1)
  })

  test("once told of a child's silent end, the parent no longer counts as waiting for it", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    await childStore(ports.storage).record({ ...child("ses_child"), sessionID: "ses_grandchild" })
    const seen = new Set<string>()
    await notePrompt(ports, delivered("evt_d1", 100))
    await notePrompt(ports, delivered("evt_d2", 110, "ses_grandchild"))
    expect(await reportSilent(ports, seen, succeeded("evt_s1", 200), outside)).toEqual([])
    // The grandchild ends silently too; ses_child is told, and that notice prompts it.
    expect(await reportSilent(ports, seen, succeeded("evt_s2", 300, "ses_grandchild"), outside)).toEqual(["ses_child"])
    await notePrompt(ports, delivered("evt_d3", 310))

    // It takes the grandchild's last reply and ends its turn without reporting itself.
    expect(await reportSilent(ports, seen, succeeded("evt_s3", 400), outside)).toEqual(["ses_parent"])
    expect(sent.map((notice: any) => notice.sessionID)).toEqual(["ses_child", "ses_parent"])
  })

  test("forgets the children of a deleted session, whose reports can no longer be delivered", async () => {
    const { ports, store } = fakePorts()
    await childStore(ports.storage).record(child())
    await notePrompt(ports, delivered("evt_d", 100))

    expect(await noteDeleted(ports, sessionEvent("session.deleted", "evt_x", 150, "ses_parent") as SessionEvent)).toEqual(["ses_child"])

    expect([...store.keys()].filter((key) => key.startsWith("report/"))).toEqual([])
  })

  test("forgets the roster entry of a deleted child that is not isolated and has no children of its own", async () => {
    const { ports, store } = fakePorts()
    await childStore(ports.storage).record(child())

    await noteDeleted(ports, sessionEvent("session.deleted", "evt_x", 150) as SessionEvent)

    expect(await childStore(ports.storage).entry("ses_parent", "ses_child")).toBeUndefined()
    expect(await childStore(ports.storage).indexedParent("ses_child")).toBeUndefined()
    expect([...store.keys()]).toEqual([])
  })

  test("keeps the roster entry of a deleted isolated child, for courier_cleanup", async () => {
    const { ports } = fakePorts()
    await childStore(ports.storage).record({ ...child(), isolated: true })

    await noteDeleted(ports, sessionEvent("session.deleted", "evt_x", 150) as SessionEvent)

    expect(await childStore(ports.storage).entry("ses_parent", "ses_child")).toMatchObject({ isolated: true })
  })

  test("keeps the entry of a deleted child whose own children are on the roster, until the last of them goes", async () => {
    const { ports } = fakePorts()
    const children = childStore(ports.storage)
    await children.record(child())
    await children.record({ ...child("ses_child"), sessionID: "ses_grandchild" })

    // Parent first, as with nativeChildren when the events arrive that way: the lineage still runs through it.
    await noteDeleted(ports, sessionEvent("session.deleted", "evt_x", 150) as SessionEvent)
    expect(await children.entry("ses_parent", "ses_child")).toBeDefined()
    await noteDeleted(ports, sessionEvent("session.deleted", "evt_y", 160, "ses_grandchild") as SessionEvent)
    expect(await children.entry("ses_child", "ses_grandchild")).toBeUndefined()
    expect(await children.entry("ses_parent", "ses_child")).toBeDefined()
  })

  test("forgets the whole chain of deleted children when the leaf is deleted first", async () => {
    const { ports, store } = fakePorts()
    const children = childStore(ports.storage)
    await children.record(child())
    await children.record({ ...child("ses_child"), sessionID: "ses_grandchild" })

    await noteDeleted(ports, sessionEvent("session.deleted", "evt_y", 150, "ses_grandchild") as SessionEvent)
    await noteDeleted(ports, sessionEvent("session.deleted", "evt_x", 160) as SessionEvent)

    expect([...store.keys()]).toEqual([])
  })

  test("takes back that the parent was told when the notice cannot be delivered", async () => {
    const { ports, store } = fakePorts()
    await childStore(ports.storage).record(child())
    ;(ports.session as any).synthetic = async () => Promise.reject(new Error("parent is gone"))
    await notePrompt(ports, delivered("evt_d", 100))

    await expect(reportSilent(ports, new Set(), succeeded("evt_s", 200), outside)).rejects.toThrow("parent is gone")
    expect(store.has(toldKey("ses_child"))).toBe(false)

    // A later notice told the parent meanwhile: that stays.
    ;(ports.session as any).synthetic = async () => {
      store.set(toldKey("ses_child"), { at: 400 })
      throw new Error("parent is gone")
    }
    await expect(reportSilent(ports, new Set(), succeeded("evt_s2", 300), outside)).rejects.toThrow("parent is gone")
    expect(store.get(toldKey("ses_child"))).toEqual({ at: 400 })
  })

  test("tells nothing while a scheduled message for the child is pending, or a webhook it subscribed to since its last prompt", async () => {
    const later = fakePorts()
    await childStore(later.ports.storage).record(child())
    await notePrompt(later.ports, delivered("evt_d", 100))
    await later.ports.storage.set("later/later_1", { id: "later_1", sessionID: "ses_child", from: "ses_child", message: "m", fireAt: 500, createdAt: 150 })
    expect(await reportSilent(later.ports, new Set(), succeeded("evt_s", 200), outside)).toEqual([])
    expect(later.sent).toEqual([])

    const hooked = fakePorts()
    await childStore(hooked.ports.storage).record(child())
    await notePrompt(hooked.ports, delivered("evt_d", 100))
    await hooked.ports.storage.set("webhook/o%2Fr%237/ses_child", { sessionID: "ses_child", topic: "o/r#7", createdAt: 150 })
    expect(await reportSilent(hooked.ports, new Set(), succeeded("evt_s1", 200), outside)).toEqual([])
    // The delivery it waited for came, and it ended its turn without reporting: the subscription is no wait.
    await notePrompt(hooked.ports, delivered("evt_d2", 300))
    expect(await reportSilent(hooked.ports, new Set(), succeeded("evt_s2", 400), outside)).toEqual(["ses_parent"])
  })

  test("notes the parent was told before telling it, as the notice may end the parent's turn at once", async () => {
    const { ports, store } = fakePorts()
    await childStore(ports.storage).record(child())
    let toldFirst: unknown
    ;(ports.session as any).synthetic = async () => {
      toldFirst = store.get(toldKey("ses_child"))
      return { id: "msg_1" }
    }
    await notePrompt(ports, delivered("evt_d", 100))
    await reportSilent(ports, new Set(), succeeded("evt_s", 200), outside)
    expect(toldFirst).toEqual({ at: 200 })
  })

  test("keeps the later time when a subscription that is behind notes an older event", async () => {
    const { ports, store } = fakePorts()
    await childStore(ports.storage).record(child())
    await notePrompt(ports, delivered("evt_d2", 160))
    await notePrompt(ports, delivered("evt_d1", 100))
    expect(store.get(promptKey("ses_child"))).toEqual({ at: 160 })

    await sendFrom(ports, "ses_child", "ses_parent", 200)
    await noteInterrupted(ports, sessionEvent("session.execution.interrupted", "evt_i", 150, "ses_child", "user") as SessionEvent)
    expect(store.get(settledKey("ses_child"))).toEqual({ at: 200, by: "report", status: "done" })
  })

  test("forgets a deleted child, so its parent no longer waits for it", async () => {
    const { ports, store, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    await childStore(ports.storage).record({ ...child("ses_child"), sessionID: "ses_grandchild" })
    await notePrompt(ports, delivered("evt_d1", 100))
    await notePrompt(ports, delivered("evt_d2", 110, "ses_grandchild"))

    expect(await noteDeleted(ports, sessionEvent("session.deleted", "evt_x", 150, "ses_grandchild") as SessionEvent)).toEqual(["ses_grandchild"])
    expect(await noteDeleted(ports, sessionEvent("session.deleted", "evt_y", 150, "ses_stranger") as SessionEvent)).toEqual([])

    expect(store.has(promptKey("ses_grandchild"))).toBe(false)
    expect(await reportSilent(ports, new Set(), succeeded("evt_s", 200), outside)).toEqual(["ses_parent"])
    expect(sent).toHaveLength(1)
  })

  test("what it keeps survives a restart: a new instance over the same storage judges the same", async () => {
    const before = fakePorts()
    await childStore(before.ports.storage).record(child())
    await notePrompt(before.ports, delivered("evt_d1", 100))
    await sendFrom(before.ports, "ses_child", "ses_parent", 150)

    const after = fakePorts([], [], before.store)
    expect(await reportSilent(after.ports, new Set(), succeeded("evt_s1", 200), outside)).toEqual([])
    await notePrompt(after.ports, delivered("evt_d2", 300))
    expect(await reportSilent(after.ports, new Set(), succeeded("evt_s2", 400), outside)).toEqual(["ses_parent"])
    expect(after.sent).toHaveLength(1)
  })

  test("sends the notice without the reply when the child's messages cannot be read", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    ;(ports.session as any).context = async () => {
      throw new Error("gone")
    }
    await notePrompt(ports, delivered("evt_d", 100))

    await reportSilent(ports, new Set(), succeeded("evt_s", 200), outside)

    expect(sent[0].text).toBe(envelope("ses_child", silentNotice("Fix the bug", undefined), { ended: "without-report" }))
  })

  test("ignores sessions courier_spawn did not start, and those of a release that kept nothing, reading the reverse index alone", async () => {
    const { ports, sent, scanned, store } = fakePorts()
    await childStore(ports.storage).record(child())
    scanned.length = 0
    expect(await notePrompt(ports, delivered("evt_d", 100, "ses_parent"))).toBe(false)
    expect(await reportSilent(ports, new Set(), succeeded("evt_s1", 200, "ses_parent"), outside)).toEqual([])
    expect(await reportSilent(ports, new Set(), succeeded("evt_s2", 200), outside)).toEqual([])
    expect(sent).toEqual([])
    expect(scanned).toEqual([])
    expect(store.has(promptKey("ses_parent"))).toBe(false)
  })

  test("claims only the turns of spawned sessions, so others do not crowd out the events remembered", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    await notePrompt(ports, delivered("evt_d", 100))
    const seen = new Set<string>()

    expect(await reportSilent(ports, seen, succeeded("evt_s1", 200, "ses_parent"), outside)).toEqual([])
    expect([...seen]).toEqual([])
    const told = await Promise.all([reportSilent(ports, seen, succeeded("evt_s2", 200), outside), reportSilent(ports, seen, succeeded("evt_s2", 200), outside)])

    expect(told).toEqual([["ses_parent"], []])
    expect(sent).toHaveLength(1)
    expect([...seen]).toEqual(["evt_s2"])
  })
})

describe("join groups", () => {
  const grouped = (sessionID: string, title: string, parentID = "ses_parent") => ({ ...child(parentID), sessionID, title, group: "pair" })
  async function pair(ports: WatchPorts) {
    await childStore(ports.storage).record(grouped("ses_a", "A"))
    await childStore(ports.storage).record(grouped("ses_b", "B"))
    await joinGroup(groupStore(ports.storage), "ses_parent", "pair", "ses_a", "A", 1)
    await joinGroup(groupStore(ports.storage), "ses_parent", "pair", "ses_b", "B", 2)
  }

  test("a member whose turn failed leaves its group, which the notice says, and the scheduler delivers the group once it is complete", async () => {
    const { ports, sent, nudges, store } = fakePorts()
    await pair(ports)
    await sendFrom(ports, "ses_a", "ses_parent", 150)

    expect(await reportFailure(ports, new Set(), { ...failed("ses_b", "evt_1"), created: 200 })).toEqual(["ses_parent"])

    expect(sent[0].text).toBe(envelope("ses_b", failureNotice("B", blocked, "pair"), { failed: "provider.auth" }))
    expect(sent[0].text).toContain('It is a member of group "pair"')
    expect(store.get(memberKey("ses_parent", "pair", "ses_b"))).toEqual({ title: "B", joinedAt: 2, left: { at: 200, by: "failed" } })
    // The scheduler is nudged after the notice, so the group's message cannot overtake it.
    expect(nudges).toEqual([1])
  })

  test("the member is marked as left before the notice goes out, so the parent is waiting on the group meanwhile", async () => {
    const { ports, store } = fakePorts()
    await pair(ports)
    await sendFrom(ports, "ses_a", "ses_parent", 150)
    let leftFirst: unknown
    ;(ports.session as any).synthetic = async () => {
      leftFirst = store.get(memberKey("ses_parent", "pair", "ses_b"))
      return { id: "msg_1" }
    }

    await reportFailure(ports, new Set(), { ...failed("ses_b", "evt_1"), created: 200 })

    expect(leftFirst).toEqual({ title: "B", joinedAt: 2, left: { at: 200, by: "failed" } })
  })

  test("a member whose report is held, or whose group was released, keeps it when its turn fails, and the notice says nothing of the group", async () => {
    const { ports, sent, nudges, store } = fakePorts()
    await pair(ports)
    await sendFrom(ports, "ses_a", "ses_parent", 150)

    await reportFailure(ports, new Set(), failed("ses_a", "evt_1"))
    expect(sent[0].text).toBe(envelope("ses_a", failureNotice("A", blocked), { failed: "provider.auth" }))
    expect(store.get(memberKey("ses_parent", "pair", "ses_a"))).toMatchObject({ report: { status: "done" } })

    store.delete(memberKey("ses_parent", "pair", "ses_a"))
    store.delete(memberKey("ses_parent", "pair", "ses_b"))
    await reportFailure(ports, new Set(), failed("ses_b", "evt_2"))
    expect(sent[1].text).not.toContain("group")
    expect(nudges).toEqual([])
  })

  test("a member that ends its turn without a report stays out, and the notice says the group waits for it", async () => {
    const { ports, sent, store } = fakePorts()
    await pair(ports)
    const seen = new Set<string>()
    await notePrompt(ports, delivered("evt_d1", 100, "ses_a"))
    await notePrompt(ports, delivered("evt_d2", 100, "ses_b"))
    await sendFrom(ports, "ses_a", "ses_parent", 150)

    expect(await reportSilent(ports, seen, succeeded("evt_s1", 200, "ses_b"), outside)).toEqual(["ses_parent"])
    expect(sent[0].text).toBe(envelope("ses_b", silentNotice("B", "Looked at it; line 4 is wrong.", false, "pair"), { ended: "without-report" }))
    expect(sent[0].text).toContain('It is a member of group "pair", whose other reports are held until it reports')
    expect(store.get(memberKey("ses_parent", "pair", "ses_b"))).toEqual({ title: "B", joinedAt: 2 })

    // One whose report is held, told after a later turn of its own, is not said to hold the group up.
    await notePrompt(ports, delivered("evt_d3", 300, "ses_a"))
    expect(await reportSilent(ports, seen, succeeded("evt_s2", 400, "ses_a"), outside)).toEqual(["ses_parent"])
    expect(sent[1].text).not.toContain("group")
  })

  test("a member leaves its group even when the failure notice cannot be delivered, and the scheduler is nudged all the same", async () => {
    const { ports, store, nudges } = fakePorts()
    await pair(ports)
    await sendFrom(ports, "ses_a", "ses_parent", 150)
    ;(ports.session as any).synthetic = async () => Promise.reject(new Error("parent is gone"))

    await expect(reportFailure(ports, new Set(), failed("ses_b", "evt_1"))).rejects.toThrow("parent is gone")

    expect(store.get(memberKey("ses_parent", "pair", "ses_b"))).toMatchObject({ left: { by: "failed" } })
    expect(nudges).toEqual([0])
  })

  test("a deleted session with a reverse key but no roster entry is still forgotten", async () => {
    const { ports, store } = fakePorts()
    await childStore(ports.storage).record(child())
    await notePrompt(ports, delivered("evt_d", 100))
    store.delete("roster/ses_parent/ses_child")

    expect(await noteDeleted(ports, sessionEvent("session.deleted", "evt_x", 150) as SessionEvent)).toEqual(["ses_child"])
    expect([...store.keys()].filter((key) => key.startsWith("report/"))).toEqual([])
  })

  test("a member whose turn failed while another is still out leaves without completing the group", async () => {
    const { ports, nudges } = fakePorts()
    await pair(ports)

    await reportFailure(ports, new Set(), failed("ses_b", "evt_1"))

    expect(nudges).toEqual([])
    expect(await groupStore(ports.storage).member("ses_parent", "pair", "ses_a")).toEqual({ title: "A", joinedAt: 1 })
  })

  test("a failure that cannot be noted in the group is logged, and still told", async () => {
    const { ports, sent, logged } = fakePorts()
    await pair(ports)
    const set = ports.storage.set
    ;(ports.storage as any).set = async (key: string, value: unknown) => {
      if (key.startsWith("group/")) throw new Error("disk full")
      return set(key, value as never)
    }

    await reportFailure(ports, new Set(), failed("ses_b", "evt_1"))

    expect(sent).toHaveLength(1)
    expect(logged).toEqual(["courier watch: could not take ses_b out of group pair: Error: disk full"])
  })

  test("a deleted member leaves its group, and a deleted parent's groups go with it", async () => {
    const { ports, store, nudges } = fakePorts()
    await pair(ports)
    await sendFrom(ports, "ses_a", "ses_parent", 150)

    expect(await noteDeleted(ports, sessionEvent("session.deleted", "evt_x", 200, "ses_b") as SessionEvent)).toEqual(["ses_b"])
    expect(store.get(memberKey("ses_parent", "pair", "ses_b"))).toEqual({ title: "B", joinedAt: 2, left: { at: 200, by: "deleted" } })
    expect(nudges).toEqual([0])

    expect(await noteDeleted(ports, sessionEvent("session.deleted", "evt_y", 300, "ses_parent") as SessionEvent)).toEqual(["ses_a"])
    expect([...store.keys()].filter((key) => key.startsWith("group/"))).toEqual([])
  })

  test("a session waits for a group whose members still owe it reports, and for a complete one about to be delivered", async () => {
    const { ports, sent, store } = fakePorts()
    await childStore(ports.storage).record({ ...child("ses_root"), sessionID: "ses_parent", title: "Lead" })
    await pair(ports)
    const seen = new Set<string>()
    await notePrompt(ports, delivered("evt_d1", 100, "ses_parent"))
    await notePrompt(ports, delivered("evt_d2", 110, "ses_a"))
    await notePrompt(ports, delivered("evt_d3", 110, "ses_b"))
    // One report held, the other member still owes: the parent waits.
    await sendFrom(ports, "ses_a", "ses_parent", 150)
    expect(await reportSilent(ports, seen, succeeded("evt_s1", 200, "ses_parent"), outside)).toEqual([])
    // Its last member reports and the group is held complete, for the scheduler: the parent still waits.
    await sendFrom(ports, "ses_b", "ses_parent", 250)
    expect(await reportSilent(ports, seen, succeeded("evt_s2", 300, "ses_parent"), outside)).toEqual([])
    expect(sent).toEqual([])

    // Delivered and dropped, the group's message prompts the parent, which ends its turn without reporting: told.
    for (const id of ["ses_a", "ses_b"]) store.delete(memberKey("ses_parent", "pair", id))
    await notePrompt(ports, delivered("evt_d4", 350, "ses_parent"))
    expect(await reportSilent(ports, seen, succeeded("evt_s3", 400, "ses_parent"), outside)).toEqual(["ses_root"])
  })

  test("a session told that a group member ended without a report no longer waits for the group, as for a child in no group", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record({ ...child("ses_root"), sessionID: "ses_parent", title: "Lead" })
    await pair(ports)
    const seen = new Set<string>()
    await notePrompt(ports, delivered("evt_d1", 100, "ses_parent"))
    await notePrompt(ports, delivered("evt_d2", 110, "ses_a"))
    await notePrompt(ports, delivered("evt_d3", 110, "ses_b"))
    await sendFrom(ports, "ses_a", "ses_parent", 150)
    // ses_b ends silently: the parent is told, and prompted by that notice.
    expect(await reportSilent(ports, seen, succeeded("evt_s1", 200, "ses_b"), outside)).toEqual(["ses_parent"])
    await notePrompt(ports, delivered("evt_d4", 210, "ses_parent"))

    // It ends its turn without reporting, with the group open but stuck on a member it was told of: its parent is told.
    expect(await reportSilent(ports, seen, succeeded("evt_s2", 300, "ses_parent"), outside)).toEqual(["ses_root"])
    expect(sent.map((notice: any) => notice.sessionID)).toEqual(["ses_parent", "ses_root"])
  })

  test("a member that left, re-prompted and ending without a report, is not said to hold the group up", async () => {
    const { ports, sent, store } = fakePorts()
    await pair(ports)
    await reportFailure(ports, new Set(), { ...failed("ses_b", "evt_1"), created: 100 })
    await notePrompt(ports, delivered("evt_d", 200, "ses_b"))

    expect(await reportSilent(ports, new Set(), succeeded("evt_s", 300, "ses_b"), outside)).toEqual(["ses_parent"])

    expect(sent[1].text).not.toContain("group")
    expect(await noteInterrupted(ports, sessionEvent("session.execution.interrupted", "evt_i", 400, "ses_b", "user") as SessionEvent)).toBe(true)
    expect(store.get(memberKey("ses_parent", "pair", "ses_b"))).toEqual({ title: "B", joinedAt: 2, left: { at: 100, by: "failed" } })
  })

  test("a member whose turn is interrupted leaves its group, unless a shutdown stopped it, or its report is held", async () => {
    const { ports, store, nudges } = fakePorts()
    await pair(ports)
    await sendFrom(ports, "ses_a", "ses_parent", 150)

    expect(await noteInterrupted(ports, sessionEvent("session.execution.interrupted", "evt_i1", 200, "ses_b", "shutdown") as SessionEvent)).toBe(false)
    expect(store.get(memberKey("ses_parent", "pair", "ses_b"))).toEqual({ title: "B", joinedAt: 2 })
    expect(await noteInterrupted(ports, sessionEvent("session.execution.interrupted", "evt_i2", 200, "ses_b", "user") as SessionEvent)).toBe(true)
    expect(store.get(memberKey("ses_parent", "pair", "ses_b"))).toEqual({ title: "B", joinedAt: 2, left: { at: 200, by: "interrupted" } })
    expect(nudges).toHaveLength(1)
    expect(await noteInterrupted(ports, sessionEvent("session.execution.interrupted", "evt_i3", 300, "ses_a", "user") as SessionEvent)).toBe(true)
    expect(store.get(memberKey("ses_parent", "pair", "ses_a"))).toMatchObject({ report: { status: "done" } })
  })

  test("a deleted parent's groups go even when its children are off the roster, as a held report outlives its entry", async () => {
    const { ports, store } = fakePorts()
    await joinGroup(groupStore(ports.storage), "ses_parent", "pair", "ses_a", "A", 1)
    store.set(memberKey("ses_parent", "pair", "ses_a"), { title: "A", joinedAt: 1, report: { at: 2, status: "done", message: "m" } })

    expect(await noteDeleted(ports, sessionEvent("session.deleted", "evt_x", 300, "ses_parent") as SessionEvent)).toEqual([])
    expect([...store.keys()]).toEqual([])
  })

  test("a membership that cannot be read as a child fails is logged; the notice goes out, and the member stays as it was", async () => {
    const { ports, sent, logged, store, nudges } = fakePorts()
    await pair(ports)
    const get = ports.storage.get
    ;(ports.storage as any).get = async (key: string) => (key.startsWith("group/") ? Promise.reject(new Error("locked")) : get(key))

    await reportFailure(ports, new Set(), failed("ses_b", "evt_1"))

    expect(sent).toHaveLength(1)
    expect(sent[0].text).not.toContain("group")
    expect(logged).toEqual(["courier watch: could not read ses_b's place in group pair: Error: locked"])
    expect(store.get(memberKey("ses_parent", "pair", "ses_b"))).toEqual({ title: "B", joinedAt: 2 })
    expect(nudges).toEqual([])
  })
})

describe("what makes a child owe a report", () => {
  /** Runs `events` through a watcher of a child that reported at 150, returning the notices sent. */
  async function afterReport(events: unknown[]) {
    const watching = new AbortController()
    const { ports, sent } = fakePorts([events])
    ;(ports as any).log = () => watching.abort()
    await childStore(ports.storage).record(child())
    await notePrompt(ports, delivered("evt_d0", 100))
    await sendFrom(ports, "ses_child", "ses_parent", 150)
    await watchChildren(ports, fresh(), watching.signal, 1)
    return sent
  }
  const exchange = (type: string) => [enqueued("evt_e", "inb_1", type), delivered("evt_d", 160, "ses_child", "inb_1"), succeeded("evt_s", 200)]

  test("what the person types in the child's session does not", async () => {
    expect(await afterReport(exchange("user"))).toEqual([])
  })

  test("a compaction or a move of the child does not", async () => {
    expect(await afterReport(exchange("compaction"))).toEqual([])
    expect(await afterReport(exchange("move"))).toEqual([])
  })

  test("a message through courier or the plugin does", async () => {
    expect(await afterReport(exchange("synthetic"))).toHaveLength(1)
  })

  test("a delivery whose item was not seen enqueued does, failing toward telling the parent", async () => {
    expect(await afterReport([delivered("evt_d", 160, "ses_child", "inb_unknown"), succeeded("evt_s", 200)])).toHaveLength(1)
  })

  test("its task does, by the note courier_spawn writes before handing it over as a user prompt", async () => {
    const watching = new AbortController()
    const { ports, sent } = fakePorts([exchange("user")])
    ;(ports as any).log = () => watching.abort()
    await childStore(ports.storage).record(child())
    // What courier_spawn writes before `session.prompt`.
    await childStore(ports.storage).prompted("ses_child", 100)
    await watchChildren(ports, fresh(), watching.signal, 1)
    expect(sent.map((notice: any) => notice.metadata.ended)).toEqual(["without-report"])
  })

  test("remembers the item types of spawned sessions only, reading nothing but the reverse index for others", async () => {
    const { ports, scanned } = fakePorts()
    await childStore(ports.storage).record(child())
    scanned.length = 0
    const inbox = new Map<string, string>()
    expect(await noteEnqueued(ports, inbox, enqueued("evt_e1", "inb_1", "user", "ses_parent"))).toBe(false)
    expect(await noteEnqueued(ports, inbox, enqueued("evt_e2", "inb_2", "user"))).toBe(true)
    expect([...inbox]).toEqual([["inb_2", "user"]])
    expect(scanned).toEqual([])
  })
})

describe("what settles a child's report", () => {
  test("an interrupted turn does, unless a shutdown stopped it, which the next start resumes", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    const seen = new Set<string>()
    await notePrompt(ports, delivered("evt_d", 100))

    expect(await noteInterrupted(ports, sessionEvent("session.execution.interrupted", "evt_i1", 150, "ses_child", "shutdown") as SessionEvent)).toBe(false)
    expect(await owesReport(ports.storage, "ses_child")).toBe(true)
    expect(await noteInterrupted(ports, sessionEvent("session.execution.interrupted", "evt_i2", 160, "ses_child", "user") as SessionEvent)).toBe(true)
    expect(await owesReport(ports.storage, "ses_child")).toBe(false)
    expect(await reportSilent(ports, seen, succeeded("evt_s", 200), outside)).toEqual([])
    expect(sent).toEqual([])
  })

  test("a failed turn does, and is reported as a failure", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    await notePrompt(ports, delivered("evt_d", 100))

    await reportFailure(ports, new Set(), { ...failed(), created: 150 })

    expect(await owesReport(ports.storage, "ses_child")).toBe(false)
    expect(sent.map((notice: any) => notice.description)).toEqual(["Session ses_child failed"])
  })

  test("a failure that cannot be noted is still reported", async () => {
    const { ports, sent, logged } = fakePorts()
    await childStore(ports.storage).record(child())
    const set = ports.storage.set
    ;(ports.storage as any).set = async (key: string, value: unknown) => {
      if (key === settledKey("ses_child")) throw new Error("disk full")
      return set(key, value as never)
    }

    await reportFailure(ports, new Set(), failed())

    expect(sent).toHaveLength(1)
    expect(logged).toEqual(["courier watch: could not note the failed turn of ses_child: Error: disk full"])
  })

  test("is dropped with the child's roster entry", async () => {
    const { ports, store } = fakePorts()
    await childStore(ports.storage).record(child())
    await notePrompt(ports, delivered("evt_d", 100))
    await reportSilent(ports, new Set(), succeeded("evt_s", 120), outside)
    await sendFrom(ports, "ses_child", "ses_parent", 130, "none")
    await sendFrom(ports, "ses_child", "ses_parent", 150)
    expect([...store.keys()].filter((key) => key.startsWith("report/")).sort()).toEqual([
      "report/ses_child/progress",
      "report/ses_child/prompt",
      "report/ses_child/settled",
      "report/ses_child/told",
    ])

    await forgetChild(ports.storage, "ses_parent", "ses_child")

    expect([...store.keys()]).toEqual([])
  })
})

describe("watchChildren", () => {
  test("reports failed turns and permission requests from the event stream and skips other events", async () => {
    const watching = new AbortController()
    const { ports, sent } = fakePorts([
      [{ id: "evt_0", type: "session.idle", data: { sessionID: "ses_child" } }, failed(), asked(), replied()],
    ])
    await childStore(ports.storage).record(child())
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

  test("a parent's turn that ends, not by a shutdown, has a complete group of its delivered at once", async () => {
    const watching = new AbortController()
    const { ports, nudges } = fakePorts([
      [
        succeeded("evt_o", 100, "ses_other"),
        sessionEvent("session.execution.interrupted", "evt_i", 150, "ses_parent", "shutdown"),
        succeeded("evt_p", 200, "ses_parent"),
      ],
    ])
    await joinGroup(groupStore(ports.storage), "ses_other", "pair", "ses_x", "X", 1)
    await joinGroup(groupStore(ports.storage), "ses_parent", "pair", "ses_child", "A", 1)
    await ports.storage.set(memberKey("ses_parent", "pair", "ses_child"), { title: "A", joinedAt: 1, report: { at: 2, status: "done", message: "m" } })
    ;(ports as any).nudge = () => {
      nudges.push(1)
      watching.abort()
    }

    await watchChildren(ports, fresh(), watching.signal, 1)

    expect(nudges).toEqual([1])
  })

  test("a sub-orchestrator's turn that ends with a complete group is not told of as silent, though the nudge delivers the group at once", async () => {
    const watching = new AbortController()
    const { ports, sent, store } = fakePorts([[delivered("evt_d", 100), succeeded("evt_s", 200)]])
    await childStore(ports.storage).record(child())
    await childStore(ports.storage).record({ ...child("ses_child"), sessionID: "ses_grandchild", createdAt: 150, group: "pair" })
    await ports.storage.set(memberKey("ses_child", "pair", "ses_grandchild"), { title: "G", joinedAt: 150, report: { at: 180, status: "done", message: "m" } })
    // A tick that delivers and drops the group before anything else runs.
    ;(ports as any).nudge = () => {
      for (const key of [...store.keys()]) if (key.startsWith("group/")) store.delete(key)
      watching.abort()
    }

    await watchChildren(ports, fresh(), watching.signal, 1)

    expect(sent).toEqual([])
  })

  test("tells of a child's turn that ended without a report from the event stream", async () => {
    const watching = new AbortController()
    const { ports, sent } = fakePorts([[delivered("evt_d", 100), succeeded("evt_s", 200)]])
    await childStore(ports.storage).record(child())
    ;(ports.session as any).synthetic = async (input: unknown) => {
      sent.push(input)
      watching.abort()
      return { id: "msg_1" }
    }

    await watchChildren(ports, fresh(), watching.signal, 1)

    expect(sent.map((notice: any) => notice.description)).toEqual(["Session ses_child ended without a report"])
  })

  test("notes a location's shutdown for the question relay, and one reported without a location for every location", async () => {
    const watching = new AbortController()
    const { ports } = fakePorts([
      [{ id: "evt_s", type: "location.shutdown", location: { directory: "/repo", workspaceID: "ws" } }, failed()],
    ])
    await childStore(ports.storage).record(child())
    ;(ports.session as any).synthetic = async () => (watching.abort(), { id: "msg_1" })

    await watchChildren(ports, fresh(), watching.signal, 1)

    expect(shutdownReportedAt("/repo")).toBe(1_000_000)
    expect(shutdownReportedAt("/elsewhere")).toBeUndefined()
    resetHub()

    const again = new AbortController()
    const second = fakePorts([[{ id: "evt_t", type: "location.shutdown" }, failed()]])
    await childStore(second.ports.storage).record(child())
    ;(second.ports.session as any).synthetic = async () => (again.abort(), { id: "msg_1" })

    await watchChildren(second.ports, fresh(), again.signal, 1)

    expect(shutdownReportedAt("/elsewhere")).toBeDefined()
    resetHub()
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

  test("tells about a child's form and its settling from the event stream", async () => {
    const watching = new AbortController()
    const { ports, sent } = fakePorts([[shown(), settled("evt_s", "form.cancelled")]])
    await childStore(ports.storage).record(child())
    ;(ports.session as any).synthetic = async (input: any) => {
      sent.push(input)
      if (sent.length === 2) watching.abort()
      return { id: "msg_1" }
    }

    await watchChildren(ports, fresh(), watching.signal, 1)

    expect(sent.map((notice: any) => notice.metadata.asks ?? notice.metadata.settled)).toEqual(["form", "cancelled"])
  })

  test("logs a notice that cannot be delivered and keeps watching", async () => {
    const watching = new AbortController()
    const { ports, logged } = fakePorts([[failed("ses_child", "evt_1"), asked("evt_2"), shown("evt_3")]])
    await childStore(ports.storage).record(child())
    let attempts = 0
    ;(ports.session as any).synthetic = async () => {
      if (++attempts === 3) watching.abort()
      throw new Error("parent is gone")
    }

    await watchChildren(ports, fresh(), watching.signal, 1)

    expect(attempts).toBe(3)
    expect(logged).toEqual([
      "courier watch: could not handle session.execution.failed of ses_child: Error: parent is gone",
      "courier watch: could not handle permission.asked of ses_child: Error: parent is gone",
      "courier watch: could not handle form.created of ses_child: Error: parent is gone",
    ])
  })
})

describe("watchChildren, stopped", () => {
  test("ends once aborted, though the stream neither ends nor yields again, after the event it is handling", async () => {
    const watching = new AbortController()
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    let deliver = (_: unknown) => {}
    ;(ports.session as any).synthetic = (input: unknown) => {
      sent.push(input)
      return new Promise((resolve) => (deliver = resolve))
    }
    // A stream that yields one event and then never another, and is never closed.
    ;(ports.event as any).subscribe = async function* () {
      yield failed()
      await new Promise(() => {})
    }
    let ended = false
    const done = watchChildren(ports, fresh(), watching.signal, 1).then(() => (ended = true))
    await Bun.sleep(1)
    expect(sent).toHaveLength(1)

    // Its notice is going out: aborting does not end it until the notice has gone.
    watching.abort()
    await Bun.sleep(1)
    expect(ended).toBe(false)
    deliver({ id: "msg_1" })
    await done
    expect(ended).toBe(true)
  })

  test("holds no listener on its signal per event it has seen", async () => {
    const watching = new AbortController()
    const { ports } = fakePorts()
    let listening = 0
    const add = watching.signal.addEventListener.bind(watching.signal)
    const remove = watching.signal.removeEventListener.bind(watching.signal)
    watching.signal.addEventListener = ((...args: Parameters<typeof add>) => (listening++, add(...args))) as typeof add
    watching.signal.removeEventListener = ((...args: Parameters<typeof remove>) => (listening--, remove(...args))) as typeof remove
    let seen = 0
    let atEnd = -1
    ;(ports.event as any).subscribe = async function* () {
      for (; seen < 1_000; seen++) yield { id: `evt_${seen}`, type: "session.idle", data: {} }
      atEnd = listening
      watching.abort()
    }
    await watchChildren(ports, fresh(), watching.signal, 1)
    expect(seen).toBe(1_000)
    // One wait for the next event listening, whatever the number of events before it.
    expect(atEnd).toBe(1)
  })

  test("ends after the relay of the requests already pending", async () => {
    const watching = new AbortController()
    const { ports, sent } = fakePorts([], [request])
    await childStore(ports.storage).record(child())
    let deliver = (_: unknown) => {}
    ;(ports.session as any).synthetic = (input: unknown) => {
      sent.push(input)
      return new Promise((resolve) => (deliver = resolve))
    }
    ;(ports.event as any).subscribe = async function* () {
      await new Promise(() => {})
    }
    let ended = false
    const done = watchChildren(ports, fresh(), watching.signal, 1).then(() => (ended = true))
    await Bun.sleep(1)
    expect(sent.map((notice: any) => notice.description)).toEqual(["Session ses_child asks for permission"])

    watching.abort()
    await Bun.sleep(1)
    expect(ended).toBe(false)
    deliver({ id: "msg_1" })
    await done
    expect(ended).toBe(true)
  })
})

describe("the hub's subscriptions: one active, one standby", () => {
  /** The scheduler's loop, which joining starts, never ticks here. */
  const idle = { every: () => 0, stop: () => {}, wait: async () => {} }

  /** A member whose event stream stays open until its subscription is aborted, counting subscriptions. */
  function member(name: string, pending: PermissionAsked["data"][] = [], events: unknown[] = []) {
    const { ports, sent } = fakePorts([], pending)
    let subscriptions = 0
    let ended = 0
    ;(ports.event as any).subscribe = async function* ({ signal }: { signal: AbortSignal }) {
      subscriptions++
      try {
        yield* events
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve))
      } finally {
        ended++
      }
    }
    const joined = { directory: `/${name}`, watch: ports, log: () => {} } as unknown as Member
    return { joined, ports, sent, subscriptions: () => subscriptions, ended: () => ended }
  }

  /** Loads `member` as an instance does, with this copy's watcher; returns its unload, which settles once its subscription, if any, has ended. */
  function load(opened: ReturnType<typeof open>, loaded: ReturnType<typeof member>, state = fresh()) {
    watchFromHub(opened.hub, modules(state), 1)
    const leave = opened.join(loaded.joined)
    return () => {
      const done = opened.hub.watchers.find((watcher) => watcher.member === loaded.joined)?.done
      leave()
      return done ?? Promise.resolve()
    }
  }

  const watchingThrough = (hub: Hub) => hub.watchers.map((watcher) => watcher.member)

  test("one instance gives one subscription and no standby; a second starts the standby, a third neither", async () => {
    resetHub()
    const opened = open({}, [], idle)
    const [a, b, c] = [member("a"), member("b"), member("c")]
    const unloadA = load(opened, a)
    expect(watchingThrough(opened.hub)).toEqual([a.joined])
    expect(relayState.following).toBe(1)

    const unloadB = load(opened, b)
    const unloadC = load(opened, c)
    expect(watchingThrough(opened.hub)).toEqual([a.joined, b.joined])
    expect([a.subscriptions(), b.subscriptions(), c.subscriptions()]).toEqual([1, 1, 0])
    expect(relayState.following).toBe(2)

    // An instance with no subscription leaves without touching them.
    await unloadC()
    expect(watchingThrough(opened.hub)).toEqual([a.joined, b.joined])

    // The last one to leave stops the last subscription.
    await unloadA()
    expect(watchingThrough(opened.hub)).toEqual([b.joined])
    await unloadB()
    expect(watchingThrough(opened.hub)).toEqual([])
    expect([a.ended(), b.ended()]).toEqual([1, 1])
    expect(relayState.following).toBe(0)
    resetHub()
  })

  test("when the first one's instance leaves, the standby keeps following and a new one starts, through the earliest instance without one", async () => {
    resetHub()
    const opened = open({}, [], idle)
    const state = fresh()
    const [a, b, c] = [member("a"), member("b"), member("c", [request])]
    await childStore(c.ports.storage).record(child())
    const unloadA = load(opened, a, state)
    const unloadB = load(opened, b, state)
    const unloadC = load(opened, c, state)
    let released = false
    relayState.shown.set("ses_child call_1", () => (released = true))

    const ended = unloadA()
    // Never fewer than one subscription following the events, so nothing is taken as missed.
    expect(watchingThrough(opened.hub)).toEqual([b.joined, c.joined])
    expect(relayState.following).toBe(3)
    await ended
    expect(relayState.following).toBe(2)
    expect([b.subscriptions(), c.subscriptions()]).toEqual([1, 1])

    // The new standby, like any subscription, relays what is already pending, once.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(c.sent.map((notice: any) => notice.metadata.requestID)).toEqual(["per_1"])
    expect(released).toBe(false)

    await unloadB()
    await unloadC()
    expect(relayState.following).toBe(0)
    resetHub()
  })

  test("when the standby's instance leaves, another starts", async () => {
    resetHub()
    const opened = open({}, [], idle)
    const [a, b, c] = [member("a"), member("b"), member("c")]
    const unloadA = load(opened, a)
    const unloadB = load(opened, b)
    const unloadC = load(opened, c)

    await unloadB()

    expect(watchingThrough(opened.hub)).toEqual([a.joined, c.joined])
    expect([b.subscriptions(), b.ended(), c.subscriptions()]).toEqual([1, 1, 1])
    await unloadA()
    await unloadC()
    resetHub()
  })

  test("a subscription started after an update runs the watcher of the copy loaded last", async () => {
    resetHub()
    const opened = open({}, [], idle)
    const [a, b, c] = [member("a"), member("b"), member("c")]
    const unloadA = load(opened, a)
    const unloadB = load(opened, b)
    let newer = 0
    const subscribe = opened.hub.subscribe!
    opened.hub.subscribe = (joined) => (newer++, subscribe(joined))
    const leaveC = opened.join(c.joined)

    await unloadA()

    expect(newer).toBe(1)
    expect(watchingThrough(opened.hub)).toEqual([b.joined, c.joined])
    await unloadB()
    leaveC()
    resetHub()
  })

  test("after a reload, which closes every location and loads it again, both subscriptions run through new instances", async () => {
    resetHub()
    const opened = open({}, [], idle)
    const old = [member("a"), member("b"), member("c")]
    const unloads = old.map((loaded) => load(opened, loaded))
    const fresh_ = [member("a2"), member("b2"), member("c2")]
    const reloads: Array<() => Promise<void>> = []
    for (const [index, unload] of unloads.entries()) {
      await unload()
      reloads.push(load(opened, fresh_[index]!))
    }
    expect(watchingThrough(opened.hub).every((joined) => fresh_.some((loaded) => loaded.joined === joined))).toBe(true)
    expect(watchingThrough(opened.hub)).toHaveLength(2)
    for (const reload of reloads) await reload()
    resetHub()
  })
})
