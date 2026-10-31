import { describe, expect, test } from "bun:test"
import { envelope } from "../src/kernel/protocol.js"
import { asksPermission } from "../src/person/permission.js"
import { asksQuestion } from "../src/person/question/index.js"
import { isScheduled } from "../src/scheduling/index.js"
import { notePrompt, reportSilent, together, waitsOn } from "../src/tree/events.js"
import { nudgeSilent, onIdle } from "../src/tree/nudge.js"
import { reportOf } from "../src/tree/report.js"
import { send } from "../src/tree/send.js"
import { childStore, nudgedKey, promptKey } from "../src/tree/store.js"
import { reportReminder } from "../src/tree/text.js"
import { watchWake } from "../src/tree/wake.js"
import type { CourierPorts, WatchPorts } from "../src/tree/ports.js"
import { subscribedSince } from "../src/webhook/index.js"
import { child, fakePorts, request } from "./fixtures/events.js"

const outside = waitsOn(asksPermission, asksQuestion, together(isScheduled, subscribedSince))

const idle = (sessionID = "ses_child", background: { sessionID: string }[] = []) => ({ sessionID, background })

const delivered = (id: string, created: number, inboxID?: string, sessionID = "ses_child") => ({
  id,
  type: "session.inbox.delivered",
  created,
  data: { sessionID, ...(inboxID ? { inboxID } : {}) },
})

const succeeded = (id: string, created: number) => ({ id, type: "session.execution.succeeded", created, data: { sessionID: "ses_child" } })

/** A spawned child, prompted at 100, over fresh fake ports. */
async function prompted(pending: Parameters<typeof fakePorts>[1] = []) {
  const fake = fakePorts([], pending)
  await childStore(fake.ports.storage).record(child())
  await notePrompt(fake.ports, delivered("evt_d", 100))
  return fake
}

function reportFrom(ports: WatchPorts, now: number) {
  const courier = { session: { synthetic: async () => ({ id: "msg_r" }) }, storage: ports.storage, now: () => now, nudge: ports.nudge } as unknown as CourierPorts
  return send(courier, "ses_child", { sessionID: "ses_parent", message: "done", status: "done" })
}

describe("nudgeSilent", () => {
  test("reminds a child about to go idle owing a report, once, in its own execution and without a wake", async () => {
    const { ports, sent, store } = await prompted()

    expect(await nudgeSilent(ports, new Set(), outside, idle())).toBe(true)

    expect(sent).toEqual([
      {
        sessionID: "ses_child",
        text: envelope("courier", reportReminder("ses_parent"), { reminder: "report" }),
        description: "Reminded to report",
        metadata: { source: "courier", reminder: "report", resume: false },
        delivery: "steer",
        resume: false,
      },
    ])
    expect(store.get(nudgedKey("ses_child"))).toEqual({ at: 1_000_000, inboxID: "msg_1" })
    expect(await nudgeSilent(ports, new Set(), outside, idle())).toBe(false)
    expect(sent).toHaveLength(1)
  })

  test("sends one reminder however many hooks run at once", async () => {
    const { ports, sent } = await prompted()
    const seen = new Set<string>()

    await Promise.all([nudgeSilent(ports, seen, outside, idle()), nudgeSilent(ports, seen, outside, idle())])

    expect(sent).toHaveLength(1)
  })

  test("leaves a session courier_spawn did not start, one that reported, and one courier_stop stopped", async () => {
    const { ports, sent } = await prompted()
    expect(await nudgeSilent(ports, new Set(), outside, idle("ses_parent"))).toBe(false)

    const reported = await prompted()
    await reportFrom(reported.ports, 150)
    expect(await nudgeSilent(reported.ports, new Set(), outside, idle())).toBe(false)

    const stopped = await prompted()
    await childStore(stopped.ports.storage).stopped("ses_child", 150)
    expect(await nudgeSilent(stopped.ports, new Set(), outside, idle())).toBe(false)

    expect([...sent, ...reported.sent, ...stopped.sent]).toEqual([])
  })

  test("leaves a child that waits on a permission request or a session of its own", async () => {
    const asking = await prompted([request])
    expect(await nudgeSilent(asking.ports, new Set(), outside, idle())).toBe(false)

    const splitting = await prompted()
    await childStore(splitting.ports.storage).record({ ...child("ses_child"), sessionID: "ses_grandchild" })
    await notePrompt(splitting.ports, delivered("evt_g", 110, undefined, "ses_grandchild"))
    expect(await nudgeSilent(splitting.ports, new Set(), outside, idle())).toBe(false)

    expect([...asking.sent, ...splitting.sent]).toEqual([])
  })

  test("leaves a child with background work of its own, which wakes it, but not one whose work runs below it", async () => {
    const { ports, sent } = await prompted()

    expect(await nudgeSilent(ports, new Set(), outside, idle("ses_child", [{ sessionID: "ses_child" }]))).toBe(false)
    expect(sent).toEqual([])
    expect(await nudgeSilent(ports, new Set(), outside, idle("ses_child", [{ sessionID: "ses_native" }]))).toBe(true)
  })

  test("its delivery is not a prompt: the child still owes the same report, and its parent is told if it ends without one", async () => {
    const { ports, sent, store } = await prompted()
    await nudgeSilent(ports, new Set(), outside, idle())

    expect(await notePrompt(ports, delivered("evt_n", 200, "msg_1"))).toBe(false)
    expect(store.get(promptKey("ses_child"))).toEqual({ at: 100 })
    expect(await nudgeSilent(ports, new Set(), outside, idle())).toBe(false)

    expect(await reportSilent(ports, new Set(), succeeded("evt_s", 300), outside)).toEqual(["ses_parent"])
    expect(sent.map((item: any) => item.sessionID)).toEqual(["ses_child", "ses_parent"])
  })

  test("reminds again once a new prompt reaches the child", async () => {
    const { ports, sent } = await prompted()
    await nudgeSilent(ports, new Set(), outside, idle())
    await reportFrom(ports, 1_000_100)
    await notePrompt(ports, delivered("evt_d2", 1_000_200, "msg_other"))

    expect((await reportOf(childStore(ports.storage), "ses_child"))?.owes).toBe(true)
    expect(await nudgeSilent(ports, new Set(), outside, idle())).toBe(true)
    expect(sent).toHaveLength(2)
  })

  test("the missed-wake watch leaves it be", async () => {
    const { ports, sent, store } = await prompted()
    await nudgeSilent(ports, new Set(), outside, idle())
    const { sessionID, text, description, metadata } = sent[0]

    expect(await watchWake(ports, { data: { sessionID, inboxID: "msg_1", item: { type: "synthetic", payload: { text, description, metadata } } } })).toBe(false)
    expect([...store.keys()].filter((key) => key.startsWith("wake/"))).toEqual([])
  })

  test("a failure is logged, never thrown, as a failed hook fails the execution", async () => {
    const { ports, logged } = await prompted()
    const failing = { ...ports, session: { ...ports.session, synthetic: async () => Promise.reject(new Error("inbox closed")) } } as WatchPorts

    expect(await onIdle(failing, new Set(), outside, idle())).toBe(false)
    expect(logged).toEqual(["courier idle: could not remind ses_child to report: Error: inbox closed"])
  })
})
