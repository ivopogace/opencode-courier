import { describe, expect, test } from "bun:test"
import { envelope } from "../src/kernel/protocol.js"
import { BRIEF_FIRST_LINE, failureNotice, silentNotice, typedNotice } from "../src/tree/text.js"
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
import { awaited, reportOf } from "../src/tree/report.js"
import { forgetChild } from "../src/tree/forget.js"
import { childStore, groupStore, memberKey, promptKey, settledKey, toldKey, typedKey, wakeStore } from "../src/tree/store.js"
import {
  noteDeleted,
  noteInterrupted,
  reportDeclined,
  noteEnqueued,
  notePrompt,
  reportFailure,
  reportSilent,
  treeEvents,
  waitsOn,
  type ExecutionFailed,
  type SessionEvent,
} from "../src/tree/events.js"
import type { CourierPorts, WatchPorts, WatchState } from "../src/tree/ports.js"
import { follow, watchFromHub } from "../src/platform/events.js"
import { isScheduled } from "../src/scheduling/index.js"
import { asksQuestion } from "../src/person/question/index.js"
import { asked, child, fakePorts, fresh, replied, request, settled, shown } from "./fixtures/events.js"

const outside = waitsOn(asksPermission, asksQuestion, isScheduled)

const modules = (state: WatchState & PersonState) => [treeEvents(state, outside), personEvents(state)]

const watchChildren = (ports: WatchPorts, state: WatchState & PersonState, signal: AbortSignal, retryMs?: number) =>
  follow(ports, modules(state), signal, retryMs)

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

  test("names the sessions still running under the failed one, which still counts, and offers no replacement (#462)", async () => {
    const { ports, sent } = fakePorts()
    ;(ports.session as any).get = async ({ sessionID }: { sessionID: string }) => ({
      time: sessionID === "ses_done" ? { created: 1, updated: 5, idle: 5 } : { created: 1, updated: 5 },
    })
    const children = childStore(ports.storage)
    await children.record(child())
    await children.record({ ...child("ses_child"), sessionID: "ses_grand", title: "Write the tests" })
    await children.record({ ...child("ses_grand"), sessionID: "ses_done", title: "Read the spec" })
    await children.settled("ses_done", "report", 2)

    await reportFailure(ports, new Set(), failed())

    expect(sent[0].text).toBe(envelope("ses_child", failureNotice("Fix the bug", blocked, undefined, 1_000_000, ["Write the tests"]), { failed: "provider.auth" }))
    expect(sent[0].text).toContain('It has 1 session of its own still running ("Write the tests"), whose reports will wake it')
    expect(sent[0].text).toContain("still counts toward your limits")
    expect(sent[0].text).not.toContain("start a replacement")
    expect(sent[0].text).not.toContain("will not report back on its own")
  })

  test("leaves out a status the error does not carry", () => {
    expect(failureNotice("t", { type: "unknown", message: "boom" })).toContain("failed: boom (unknown).")
  })

  test("gives the time a provider limit lifts, from the event, and notes it for the panel (#353)", async () => {
    const { ports, sent, store } = fakePorts()
    await childStore(ports.storage).record(child())
    await notePrompt(ports, delivered("evt_d", 100))
    const error = { type: "provider.rate-limit", message: "Rate limit reached", status: 429, retryAfterMs: 90_000 }

    await reportFailure(ports, new Set(), { ...failed(), created: 1_000_000, data: { sessionID: "ses_child", error } })

    expect(sent[0].text).toBe(envelope("ses_child", failureNotice("Fix the bug", error, undefined, 1_000_000), { failed: "provider.rate-limit" }))
    expect(sent[0].text).toContain("asked to wait about 2 minutes")
    expect(sent[0].text).toContain("Do not message it with courier_send before then")
    expect(store.get(settledKey("ses_child"))).toEqual({ at: 1_000_000, by: "failed", resumesAt: 1_090_000 })
    expect(await reportOf(childStore(ports.storage), "ses_child")).toMatchObject({ ended: true, resumesAt: 1_090_000 })
  })

  test("takes no retry time for a failure without one, or with one that is not a positive number", async () => {
    for (const retryAfterMs of [undefined, 0, -5, Number.NaN, "soon", 1e16, 31 * 24 * 3_600_000]) {
      const { ports, sent, store } = fakePorts()
      await childStore(ports.storage).record(child())
      await reportFailure(ports, new Set(), { ...failed(), data: { sessionID: "ses_child", error: { ...blocked, retryAfterMs } as never } })
      expect(sent[0].text).not.toContain("asked to wait")
      expect(sent[0].text).toContain("Message it with courier_send to have it try again")
      expect(store.get(settledKey("ses_child"))).not.toHaveProperty("resumesAt")
    }
  })

  test("forgets the retry time once the child is prompted again", async () => {
    const { ports } = fakePorts()
    await childStore(ports.storage).record(child())
    await notePrompt(ports, delivered("evt_d", 100))
    await reportFailure(ports, new Set(), { ...failed(), created: 200, data: { sessionID: "ses_child", error: { ...blocked, retryAfterMs: 60_000 } } })
    expect(await reportOf(childStore(ports.storage), "ses_child")).toHaveProperty("resumesAt", 60_200)

    await notePrompt(ports, delivered("evt_d2", 300))
    expect(await reportOf(childStore(ports.storage), "ses_child")).not.toHaveProperty("resumesAt")
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
const enqueued = (id: string, inboxID: string, type: string, sessionID = "ses_child", metadata?: Record<string, unknown>) => ({
  id,
  type: "session.inbox.enqueued",
  created: 1,
  data: { sessionID, inboxID, item: { type, payload: metadata ? { text: "t", metadata } : {}, delivery: "steer" } },
})
const groupMetadata = { source: "courier", from: "ses_a,ses_b", group: "halves", reports: 2 }
const succeeded = (id: string, created: number, sessionID = "ses_child") => sessionEvent("session.execution.succeeded", id, created, sessionID)

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
    await notePrompt(ports, delivered("evt_d2", 160))

    expect(await reportSilent(ports, seen, succeeded("evt_s", 200), outside)).toEqual(["ses_parent"])
    expect(sent).toHaveLength(1)
  })

  test("judges by when OpenCode delivered the prompt, not when the watcher got to it", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
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
    expect(await reportSilent(ports, seen, succeeded("evt_s2", 300, "ses_grandchild"), outside)).toEqual(["ses_child"])
    await notePrompt(ports, delivered("evt_d3", 310))

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

    ;(ports.session as any).synthetic = async () => {
      store.set(toldKey("ses_child"), { at: 400 })
      throw new Error("parent is gone")
    }
    await expect(reportSilent(ports, new Set(), succeeded("evt_s2", 300), outside)).rejects.toThrow("parent is gone")
    expect(store.get(toldKey("ses_child"))).toEqual({ at: 400 })
  })

  test("tells nothing while a scheduled message for the child is pending, but a webhook subscription left from an older release holds nothing", async () => {
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
    expect(await reportSilent(hooked.ports, new Set(), succeeded("evt_s1", 200), outside)).toEqual(["ses_parent"])
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
    await sendFrom(ports, "ses_a", "ses_parent", 150)
    expect(await reportSilent(ports, seen, succeeded("evt_s1", 200, "ses_parent"), outside)).toEqual([])
    await sendFrom(ports, "ses_b", "ses_parent", 250)
    expect(await reportSilent(ports, seen, succeeded("evt_s2", 300, "ses_parent"), outside)).toEqual([])
    expect(sent).toEqual([])

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
    expect(await reportSilent(ports, seen, succeeded("evt_s1", 200, "ses_b"), outside)).toEqual(["ses_parent"])
    await notePrompt(ports, delivered("evt_d4", 210, "ses_parent"))

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
  async function afterReport(events: unknown[]) {
    const watching = new AbortController()
    const { ports, sent } = fakePorts([events])
    ;(ports as any).log = () => watching.abort()
    await childStore(ports.storage).record(child())
    await childStore(ports.storage).record({ ...child("ses_child"), sessionID: "ses_grandchild" })
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

  test("its own group's reports delivered after it reported do not, but a later message does", async () => {
    const group = [enqueued("evt_e", "inb_1", "synthetic", "ses_child", groupMetadata), delivered("evt_d", 160, "ses_child", "inb_1"), succeeded("evt_s", 200)]
    expect(await afterReport(group)).toEqual([])
    const later = [enqueued("evt_e2", "inb_2", "synthetic"), delivered("evt_d2", 210, "ses_child", "inb_2"), succeeded("evt_s2", 250)]
    expect(await afterReport([...group, ...later])).toHaveLength(1)
  })

  test("its own check-in delivered after it reported does not, but its parent's scheduled message does", async () => {
    const scheduled = (from: string) => ({ source: "courier", from, scheduled: "lat_1", scheduledAt: 120 })
    const own = [enqueued("evt_e", "inb_1", "synthetic", "ses_child", scheduled("ses_child")), delivered("evt_d", 160, "ses_child", "inb_1"), succeeded("evt_s", 200)]
    expect(await afterReport(own)).toEqual([])
    const parents = [enqueued("evt_e", "inb_1", "synthetic", "ses_child", scheduled("ses_parent")), delivered("evt_d", 160, "ses_child", "inb_1"), succeeded("evt_s", 200)]
    expect(await afterReport(parents)).toHaveLength(1)
  })

  test("its own child's status-less message delivered after it reported does not, but its parent's or the child's status does", async () => {
    const from = (sender: string, extra = {}) => [
      enqueued("evt_e", "inb_1", "synthetic", "ses_child", { source: "courier", from: sender, ...extra }),
      delivered("evt_d", 160, "ses_child", "inb_1"),
      succeeded("evt_s", 200),
    ]
    expect(await afterReport(from("ses_grandchild"))).toEqual([])
    expect(await afterReport(from("ses_parent"))).toHaveLength(1)
    expect(await afterReport(from("ses_other"))).toHaveLength(1)
    expect(await afterReport(from("ses_grandchild", { status: "done" }))).toHaveLength(1)
    expect(await afterReport(from("ses_grandchild", { failed: true }))).toHaveLength(1)
  })

  test("its own child's status-less message delivered before it reported does, the report still owed", async () => {
    const { ports } = fakePorts()
    await childStore(ports.storage).record(child())
    await childStore(ports.storage).record({ ...child("ses_child"), sessionID: "ses_grandchild" })
    const inbox = new Map<string, string>()
    await notePrompt(ports, delivered("evt_d0", 100))
    await noteEnqueued(ports, inbox, enqueued("evt_e", "inb_1", "synthetic", "ses_child", { source: "courier", from: "ses_grandchild" }))
    expect(await notePrompt(ports, delivered("evt_d", 160, "ses_child", "inb_1"), inbox)).toBe(true)
    expect(await owesReport(ports.storage, "ses_child")).toBe(true)
  })

  test("its own message scheduled after it reported does, delivered after it too (#514)", async () => {
    const scheduled = (scheduledAt: number) => ({ source: "courier", from: "ses_child", scheduled: "lat_1", scheduledAt })
    const after = [enqueued("evt_e", "inb_1", "synthetic", "ses_child", scheduled(155)), delivered("evt_d", 160, "ses_child", "inb_1"), succeeded("evt_s", 200)]
    expect(await afterReport(after)).toHaveLength(1)
    const sameTime = [enqueued("evt_e", "inb_1", "synthetic", "ses_child", scheduled(150)), delivered("evt_d", 160, "ses_child", "inb_1"), succeeded("evt_s", 200)]
    expect(await afterReport(sameTime)).toHaveLength(1)
  })

  test("its own check-in delivered before it reported does, the report still owed", async () => {
    const { ports } = fakePorts()
    await childStore(ports.storage).record(child())
    const inbox = new Map<string, string>()
    await notePrompt(ports, delivered("evt_d0", 100))
    await noteEnqueued(ports, inbox, enqueued("evt_e", "inb_1", "synthetic", "ses_child", { source: "courier", from: "ses_child", scheduled: "lat_1" }))
    expect(await notePrompt(ports, delivered("evt_d", 160, "ses_child", "inb_1"), inbox)).toBe(true)
    expect(await owesReport(ports.storage, "ses_child")).toBe(true)
  })

  test("its own group's reports delivered before it reported do, the report still owed", async () => {
    const { ports } = fakePorts()
    await childStore(ports.storage).record(child())
    const inbox = new Map<string, string>()
    await notePrompt(ports, delivered("evt_d0", 100))
    await noteEnqueued(ports, inbox, enqueued("evt_e", "inb_1", "synthetic", "ses_child", groupMetadata))
    expect(await notePrompt(ports, delivered("evt_d", 160, "ses_child", "inb_1"), inbox)).toBe(true)
    expect(await owesReport(ports.storage, "ses_child")).toBe(true)
  })

  test("its own group's reports delivered after a blocked report do", async () => {
    const { ports } = fakePorts()
    await childStore(ports.storage).record(child())
    const inbox = new Map<string, string>()
    await notePrompt(ports, delivered("evt_d0", 100))
    await sendFrom(ports, "ses_child", "ses_parent", 150, "blocked")
    await noteEnqueued(ports, inbox, enqueued("evt_e", "inb_1", "synthetic", "ses_child", groupMetadata))
    expect(await notePrompt(ports, delivered("evt_d", 160, "ses_child", "inb_1"), inbox)).toBe(true)
    expect(await owesReport(ports.storage, "ses_child")).toBe(true)
  })

  test("its own group's reports delivered after a turn interrupted without a report do", async () => {
    const { ports } = fakePorts()
    await childStore(ports.storage).record(child())
    const inbox = new Map<string, string>()
    await notePrompt(ports, delivered("evt_d0", 100))
    await noteInterrupted(ports, sessionEvent("session.execution.interrupted", "evt_i", 150, "ses_child", "user") as SessionEvent)
    await noteEnqueued(ports, inbox, enqueued("evt_e", "inb_1", "synthetic", "ses_child", groupMetadata))
    expect(await notePrompt(ports, delivered("evt_d", 160, "ses_child", "inb_1"), inbox)).toBe(true)
    expect(await owesReport(ports.storage, "ses_child")).toBe(true)
  })

  test("a delivery whose item was not seen enqueued does, failing toward telling the parent", async () => {
    expect(await afterReport([delivered("evt_d", 160, "ses_child", "inb_unknown"), succeeded("evt_s", 200)])).toHaveLength(1)
  })

  test("its task does, by the note courier_spawn writes before handing it over as a user prompt", async () => {
    const watching = new AbortController()
    const { ports, sent } = fakePorts([exchange("user")])
    ;(ports as any).log = () => watching.abort()
    await childStore(ports.storage).record(child())
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

  test("a plain decline's end, which OpenCode reports as a shutdown, tells the parent as a silent turn does; a real shutdown between steps does not", async () => {
    const declined = [{ type: "user" }, { type: "assistant", content: [], error: { type: "aborted" } }]
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    const seen = new Set<string>()
    await notePrompt(ports, delivered("evt_d", 100))
    const shutdown = sessionEvent("session.execution.interrupted", "evt_i1", 150, "ses_child", "shutdown") as SessionEvent

    expect(await reportDeclined(ports, seen, shutdown, outside)).toEqual([])
    expect(await owesReport(ports.storage, "ses_child")).toBe(true)

    ;(ports.session as { context: unknown }).context = async () => declined
    expect(await awaited(childStore(ports.storage), "ses_child")).toBe(true)
    expect(await reportDeclined(ports, seen, shutdown, outside)).toEqual(["ses_parent"])
    expect(await awaited(childStore(ports.storage), "ses_child")).toBe(false)
    expect(sent).toHaveLength(1)
    expect(await reportDeclined(ports, seen, { ...shutdown, data: { ...shutdown.data, reason: "user" } }, outside)).toEqual([])
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

  test("a parent's turn that a plain decline ended, reported as a shutdown, has a complete group of its delivered at once; a real shutdown's does not", async () => {
    const watching = new AbortController()
    const { ports, nudges } = fakePorts([
      [
        sessionEvent("session.execution.interrupted", "evt_i1", 150, "ses_parent", "shutdown"),
        sessionEvent("session.execution.interrupted", "evt_i2", 160, "ses_other", "shutdown"),
      ],
    ])
    for (const parentID of ["ses_parent", "ses_other"])
      await ports.storage.set(memberKey(parentID, "pair", `ses_of_${parentID}`), { title: "A", joinedAt: 1, report: { at: 2, status: "done", message: "m" } })
    const read: string[] = []
    ;(ports.session as any).context = async ({ sessionID }: { sessionID: string }) => {
      read.push(sessionID)
      return sessionID === "ses_other"
        ? [{ type: "user" }, { type: "assistant", content: [], error: { type: "aborted" } }]
        : [{ type: "user" }, { type: "assistant", content: [] }]
    }
    const seen: string[][] = []
    ;(ports as any).nudge = () => {
      seen.push([...read])
      nudges.push(1)
      watching.abort()
    }

    await watchChildren(ports, fresh(), watching.signal, 1)

    expect(seen).toEqual([["ses_parent", "ses_other"]])
  })

  test("a sub-orchestrator's turn that ends with a complete group is not told of as silent, though the nudge delivers the group at once", async () => {
    const watching = new AbortController()
    const { ports, sent, store } = fakePorts([[delivered("evt_d", 100), succeeded("evt_s", 200)]])
    await childStore(ports.storage).record(child())
    await childStore(ports.storage).record({ ...child("ses_child"), sessionID: "ses_grandchild", createdAt: 150, group: "pair" })
    await ports.storage.set(memberKey("ses_child", "pair", "ses_grandchild"), { title: "G", joinedAt: 150, report: { at: 180, status: "done", message: "m" } })
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
    ;(ports.event as any).subscribe = async function* () {
      yield failed()
      await new Promise(() => {})
    }
    let ended = false
    const done = watchChildren(ports, fresh(), watching.signal, 1).then(() => (ended = true))
    await Bun.sleep(1)
    expect(sent).toHaveLength(1)

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
  const idle = { every: () => 0, stop: () => {}, wait: async () => {} }

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

    await unloadC()
    expect(watchingThrough(opened.hub)).toEqual([a.joined, b.joined])

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
    expect(watchingThrough(opened.hub)).toEqual([b.joined, c.joined])
    expect(relayState.following).toBe(3)
    await ended
    expect(relayState.following).toBe(2)
    expect([b.subscriptions(), c.subscriptions()]).toEqual([1, 1])

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

describe("the fan-up of text typed into a spawned session", () => {
  const REST = { created: 1, updated: 30, idle: 30 }
  const entry = (sessionID: string, parentID: string, title: string) => ({ ...child(parentID), sessionID, title })
  const item = (inboxID: string, text: string, metadata: Record<string, unknown> | null = null, sessionID = "ses_leaf", extra: Record<string, unknown> = {}) => ({
    id: `evt_e_${inboxID}`,
    type: "session.inbox.enqueued",
    created: 500,
    data: { sessionID, inboxID, item: { type: "user", payload: { text, metadata, ...extra }, delivery: "steer" } },
  })
  const taken = (inboxID: string, sessionID = "ses_leaf") => ({ id: `evt_d_${inboxID}`, type: "session.inbox.delivered", created: 600, data: { sessionID, inboxID } })
  const envelopeOf = (text: string) => envelope("courier", typedNotice("ses_leaf", "Leaf", 500, 1_000_000, text), { route: "prompt", in: "ses_leaf" })
  const ROW = typedKey("ses_leaf", "msg_1")

  async function finished() {
    const made = fakePorts()
    const state = fresh() as unknown as WatchState & PersonState
    const children = childStore(made.ports.storage)
    await children.record(entry("ses_mid", "ses_root", "Mid"))
    await children.record(entry("ses_leaf", "ses_mid", "Leaf"))
    for (const sessionID of ["ses_root", "ses_mid", "ses_leaf"]) made.times.set(sessionID, REST)
    for (const sessionID of ["ses_mid", "ses_leaf"]) {
      await children.prompted(sessionID, 10)
      await children.settled(sessionID, "report", 20, "done")
    }
    const module = treeEvents(state, outside)
    const handle = (event: unknown) => module.handle!(made.ports, event as never)
    const type = async (text = "PERSON-SAYS", metadata: Record<string, unknown> | null = null) => {
      await handle(item("msg_1", text, metadata))
      return handle(taken("msg_1"))
    }
    return { ...made, state, children, handle, type }
  }

  const envelopes = (sent: any[]) => sent.map((message) => message.sessionID)

  test("a user item writes the row; delivery with the tree at work sends one envelope per ancestor, parent first", async () => {
    const { sent, store, logged, handle, children, ports } = await finished()
    await children.prompted("ses_leaf", 100)

    await handle(item("msg_1", "PERSON-SAYS"))
    expect(store.get(ROW)).toEqual({ at: 500, text: "PERSON-SAYS" })
    expect(sent).toEqual([])
    await handle(taken("msg_1"))

    expect(sent).toEqual(
      ["ses_mid", "ses_root"].map((sessionID) => ({
        sessionID,
        text: envelopeOf("PERSON-SAYS"),
        description: "Text typed into ses_leaf",
        metadata: { source: "courier", route: "prompt", in: "ses_leaf" },
        delivery: "steer",
      })),
    )
    expect(sent[0].text).toStartWith('<courier from="courier" route="prompt" in="ses_leaf">\n')
    for (const sessionID of ["ses_mid", "ses_root"]) expect(await wakeStore(ports.storage).of(sessionID)).toHaveLength(1)
    expect(store.has(ROW)).toBe(false)
    expect(logged).toContain("courier fan-up: text typed into ses_leaf passed to 2 sessions")
  })

  test("the item's time falls back to the plugin's clock, and the envelope's title to none when the entry is gone", async () => {
    const { sent, handle, children, store } = await finished()
    await children.prompted("ses_leaf", 100)
    const { created: _, ...noTime } = item("msg_1", "PERSON-SAYS")
    await handle(noTime)
    expect(store.get(ROW)).toEqual({ at: 1_000_000, text: "PERSON-SAYS" })
    store.delete("roster/ses_mid/ses_leaf")
    await handle(taken("msg_1"))
    expect(sent[0].text).toBe(envelope("courier", typedNotice("ses_leaf", undefined, 1_000_000, 1_000_000, "PERSON-SAYS"), { route: "prompt", in: "ses_leaf" }))
    expect(sent[0].text).not.toContain('("')
  })

  describe("what counts as typed", () => {
    const stored = async (event: unknown) => {
      const { handle, store } = await finished()
      await handle(event)
      return [...store.keys()].some((key) => key.startsWith("typed/"))
    }

    test.each([
      ["no metadata", null],
      ["another plugin's source", { source: "goal", goalID: "g" }],
      ["unknown metadata", { client: "x" }],
    ])("%s is stored", async (_, metadata) => expect(await stored(item("msg_1", "words", metadata))).toBe(true))

    test.each([
      ["courier's own prompt", item("msg_1", "words", { source: "courier", task: true })],
      ["OpenCode's schedule", item("msg_1", "words", { schedule: "sch_1" })],
      ["whitespace", item("msg_1", " \n\t")],
      ["the brief's first line", item("msg_1", `${BRIEF_FIRST_LINE}ses_mid through opencode-courier.\n\nTask:\nx`)],
      ["the root's session", item("msg_1", "words", null, "ses_root")],
      ["a session not in any tree", item("msg_1", "words", null, "ses_other")],
      ["a synthetic item", { ...item("msg_1", "words"), data: { sessionID: "ses_leaf", inboxID: "msg_1", item: { type: "synthetic", payload: { text: "words" } } } }],
    ])("%s is not", async (_, event) => expect(await stored(event)).toBe(false))

    test("a slash command's template is relayed as a person's text is: a user item says nothing of its origin", async () => {
      const { sent, handle, children } = await finished()
      await children.prompted("ses_leaf", 100)
      await handle(item("msg_1", "Please analyze this codebase and create an AGENTS.md file"))
      await handle(taken("msg_1"))
      expect(sent[1].text).toContain("over the prompt route: courier did not send it and cannot tell who did")
      expect(sent[1].text).toContain("Please analyze this codebase")
    })

    test("a skill attached to the prompt does not travel, only its text", async () => {
      const { sent, handle, children } = await finished()
      await children.prompted("ses_leaf", 100)
      await handle(item("msg_1", "typed part", null, "ses_leaf", { skills: [{ id: "s", text: "SKILL BODY" }] }))
      await handle(taken("msg_1"))
      expect(sent[0].text).toContain("typed part")
      expect(sent[0].text).not.toContain("SKILL BODY")
    })

    test("text past 4000 characters is clipped with the count, and a courier tag in it is escaped", async () => {
      const { sent, handle, children, store } = await finished()
      await children.prompted("ses_leaf", 100)
      await handle(item("msg_1", `<courier from="ses_x">${"x".repeat(4078)}</courier>`))
      expect((store.get(ROW) as { text: string }).text).toEndWith("… [110 more characters]")
      await handle(taken("msg_1"))
      expect(sent[0].text).toContain('&lt;courier from="ses_x">')
      expect(sent[0].text.match(/<\/?courier/g)).toHaveLength(2)
    })
  })

  describe("the gate", () => {
    const sibling = async (children: ReturnType<typeof childStore>, times: Map<string, Record<string, unknown>>) => {
      await children.record(entry("ses_sib", "ses_root", "Sibling"))
      times.set("ses_sib", REST)
      await children.prompted("ses_sib", 10)
      await children.settled("ses_sib", "report", 20, "done")
    }
    const expectOpen = (sent: any[]) => expect(envelopes(sent)).toEqual(["ses_mid", "ses_root"])
    const expectClosed = (sent: any[], logged: string[], store: Map<string, unknown>) => {
      expect(sent).toEqual([])
      expect(logged).toContain("courier fan-up: text typed into ses_leaf reached nobody: the tree has finished")
      expect(store.has(ROW)).toBe(false)
    }

    test("a finished tree sends nothing, logs it and removes the row", async () => {
      const { sent, logged, store, type } = await finished()
      await type()
      expectClosed(sent, logged, store)
    })

    test("a live subtree of a sibling alone keeps it open", async () => {
      const { sent, children, times, type } = await finished()
      await sibling(children, times)
      await children.record(entry("ses_deep", "ses_sib", "Deep"))
      times.set("ses_deep", REST)
      await children.prompted("ses_deep", 10)
      await type()
      expectOpen(sent)
    })

    test("a blocked child alone keeps it open", async () => {
      const { sent, children, times, type } = await finished()
      await sibling(children, times)
      await children.settled("ses_sib", "report", 25, "blocked")
      await type()
      expectOpen(sent)
    })

    test("a message waiting in another session's inbox alone keeps it open", async () => {
      const { sent, ports, type } = await finished()
      await wakeStore(ports.storage).put({ sessionID: "ses_mid", inboxID: "msg_w", at: 1, text: "t", running: false, idleAt: 1 })
      await type()
      expect(envelopes(sent)).toEqual(["ses_mid", "ses_root"])
    })

    test("a stalled wake alone does not", async () => {
      const { sent, logged, store, ports, type } = await finished()
      await wakeStore(ports.storage).put({ sessionID: "ses_mid", inboxID: "msg_w", at: 1, text: "t", running: false, idleAt: 1, stalled: 5 })
      await type()
      expectClosed(sent, logged, store)
    })

    test("the root's turn keeps it open, through time.busy and through the transcript", async () => {
      for (const time of [{ created: 1, updated: 40, idle: 30, busy: 40 }, { created: 1, updated: 40, idle: 30 }]) {
        const { sent, times, transcripts, type } = await finished()
        times.set("ses_root", time)
        transcripts.set("ses_root", [{ type: "user", text: "go" }])
        await type()
        expectOpen(sent)
      }
    })

    test("a root at rest whose times cannot tell reads its transcript, and stays closed", async () => {
      const { sent, logged, store, times, transcripts, type } = await finished()
      times.set("ses_root", { created: 1, updated: 40, idle: 30 })
      transcripts.set("ses_root", [{ type: "user", text: "go" }, { type: "idle", outcome: "succeeded" }])
      await type()
      expectClosed(sent, logged, store)
    })

    test("the typed-in session's own started turn does not hold it open", async () => {
      const { sent, logged, store, times, transcripts, type } = await finished()
      times.set("ses_leaf", { created: 1, updated: 600, idle: 30, busy: 600 })
      transcripts.set("ses_leaf", [{ type: "user", text: "PERSON-SAYS" }])
      await type()
      expectClosed(sent, logged, store)
    })

    test("the typed-in session owing a report, blocked, or with a courier message waiting keeps it open", async () => {
      const owing = await finished()
      await owing.children.prompted("ses_leaf", 100)
      await owing.type()
      expectOpen(owing.sent)

      const blocked = await finished()
      await blocked.children.settled("ses_leaf", "report", 25, "blocked")
      await blocked.type()
      expectOpen(blocked.sent)

      const waiting = await finished()
      await wakeStore(waiting.ports.storage).put({ sessionID: "ses_leaf", inboxID: "msg_w", at: 1, text: "t", running: false, idleAt: 1 })
      await waiting.type()
      expectOpen(waiting.sent)
    })

    test("a rejected session.get counts as not running, and is logged", async () => {
      const { sent, logged, store, times, type } = await finished()
      times.delete("ses_root")
      await type()
      expect(logged.join("\n")).toContain("courier fan-up: could not read session ses_root")
      expectClosed(sent, logged, store)
    })

    test("a rejected session.get of a part under the root is logged too", async () => {
      const { sent, logged, store, times, type } = await finished()
      times.delete("ses_mid")
      await type()
      expect(logged.join("\n")).toContain("courier fan-up: could not read session ses_mid")
      expectClosed(sent, logged, store)
    })

    test("a rejected storage read counts as at work, so it never silences the person", async () => {
      const scanFails = await finished()
      const scan = scanFails.ports.storage.scan
      ;(scanFails.ports.storage as any).scan = (input: { prefix: string }) => (input.prefix === "roster/" ? Promise.reject(new Error("down")) : scan(input))
      await scanFails.type()
      expectOpen(scanFails.sent)

      const reportFails = await finished()
      const get = reportFails.ports.storage.get
      ;(reportFails.ports.storage as any).get = (key: string) => (key === "report/ses_mid/settled" ? Promise.reject(new Error("down")) : get(key))
      await reportFails.type()
      expectOpen(reportFails.sent)
    })
  })

  test("a cancelled item removes the row and sends nothing", async () => {
    const { sent, store, handle, children } = await finished()
    await children.prompted("ses_leaf", 100)
    await handle(item("msg_1", "words"))
    await handle({ id: "evt_c", type: "session.inbox.cancelled", data: { sessionID: "ses_leaf", inboxID: "msg_1" } })
    expect(store.has(ROW)).toBe(false)
    await handle(taken("msg_1"))
    expect(sent).toEqual([])
  })

  test("two subscriptions send once and leave no row, a late enqueue included", async () => {
    const { sent, store, handle, children } = await finished()
    await children.prompted("ses_leaf", 100)
    await handle(item("msg_1", "words"))
    await handle(taken("msg_1"))
    await handle(item("msg_1", "words"))
    expect(store.has(ROW)).toBe(true)
    await handle(taken("msg_1"))
    expect(envelopes(sent)).toEqual(["ses_mid", "ses_root"])
    expect(store.has(ROW)).toBe(false)
  })

  test("a failing send does not stop the others, and is logged", async () => {
    const { sent, logged, store, handle, children, ports } = await finished()
    await children.prompted("ses_leaf", 100)
    const synthetic = ports.session.synthetic
    ;(ports.session as any).synthetic = (input: { sessionID: string }) =>
      input.sessionID === "ses_mid" ? Promise.reject(new Error("gone")) : synthetic(input as never)
    await handle(item("msg_1", "words"))
    await handle(taken("msg_1"))
    expect(envelopes(sent)).toEqual(["ses_root"])
    expect(logged).toContain("courier fan-up: could not pass text typed into ses_leaf to ses_mid: Error: gone")
    expect(logged).toContain("courier fan-up: text typed into ses_leaf passed to 1 sessions")
    expect(store.has(ROW)).toBe(false)
  })

  test("the envelope is unowed at an ancestor: delivering it asks for no new report", async () => {
    const { handle, store } = await finished()
    const metadata = { source: "courier", route: "prompt", in: "ses_leaf" }
    await handle({ id: "evt_e", type: "session.inbox.enqueued", created: 700, data: { sessionID: "ses_mid", inboxID: "msg_e", item: { type: "synthetic", payload: { text: "t", metadata } } } })
    await handle({ id: "evt_d", type: "session.inbox.delivered", created: 800, data: { sessionID: "ses_mid", inboxID: "msg_e" } })
    expect(store.get(promptKey("ses_mid"))).toEqual({ at: 10 })
  })

  test("a failed fan-up still leaves the delivery noted", async () => {
    const { handle, logged, store, children, ports } = await finished()
    await children.prompted("ses_leaf", 100)
    await handle(item("msg_1", "words"))
    const get = ports.storage.get
    ;(ports.storage as any).get = (key: string) => (key === ROW ? Promise.reject(new Error("down")) : get(key))
    await handle(taken("msg_1"))
    expect(logged).toContain("courier fan-up: could not pass on text typed into ses_leaf: Error: down")
    expect(store.get(promptKey("ses_leaf"))).toEqual({ at: 100 })
  })
})
