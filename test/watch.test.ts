import { describe, expect, test } from "bun:test"
import {
  envelope,
  failureNotice,
  formNotice,
  formSettledNotice,
  permissionNotice,
  permissionSettledNotice as settledNotice,
  silentNotice,
  type FormField,
} from "../src/notices.js"
import {
  type FormCreated,
  type PermissionAsked,
  type PermissionReplied,
} from "../src/relay.js"
import { hub as processHub, open, resetHub, type Hub, type Member } from "../src/hub.js"
import { shutdownReportedAt } from "../src/question/index.js"
import { send, type CourierPorts } from "../src/courier.js"
import { reportOf, prompted, promptKey, settledKey, toldKey } from "../src/report.js"
import { record, remove } from "../src/roster.js"
import {
  noteDeleted,
  noteInterrupted,
  noteEnqueued,
  notePrompt,
  reportAsked,
  reportFailure,
  reportSilent,
  reportForm,
  reportFormSettled,
  relayPending,
  reportReplied,
  watchChildren,
  watchFromHub,
  type ExecutionFailed,
  type SessionEvent,
  type WatchPorts,
} from "../src/watch.js"

/** Whether a spawned session owes its parent a report, as `reportOf` reads it. */
const owesReport = async (storage: Parameters<typeof reportOf>[0], sessionID: string) => (await reportOf(storage, sessionID))?.owes

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

const fresh = () => ({ seen: new Set<string>(), waiting: new Set<string>(), answered: new Set<string>(), forms: { told: new Map<string, Promise<unknown>>(), settled: new Set<string>() }, inbox: new Map<string, string>() })

function fakePorts(streams: unknown[][] = [], pending: PermissionAsked["data"][] = [], store = new Map<string, unknown>()) {
  const sent: any[] = []
  const logged: string[] = []
  const scanned: string[] = []
  let subscriptions = 0
  const ports = {
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async ({ prefix }: { prefix: string }) => {
        scanned.push(prefix)
        return { entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }
      },
    },
    session: {
      synthetic: async (input: unknown) => {
        sent.push(input)
        return { id: "msg_1" }
      },
      context: async () => [
        { type: "user", text: "Fix the bug" },
        { type: "assistant", content: [{ type: "text", text: "Looked at it; " }, { type: "text", text: "line 4 is wrong." }] },
      ],
    },
    event: {
      subscribe: async function* () {
        const events = streams[subscriptions++]
        if (!events) throw new Error("stream closed")
        yield* events
      },
    },
    permissions: () => [
      { list: async ({ sessionID }: { sessionID: string }) => pending.filter((item) => item.sessionID === sessionID) },
    ],
    now: () => 1_000_000,
    log: (message: string) => void logged.push(message),
  } as unknown as WatchPorts
  return { ports, sent, logged, store, scanned, subscriptions: () => subscriptions }
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

/** courier_send through the courier's own ports, over the watcher's storage, at `now`. */
function sendFrom(ports: WatchPorts, from: string, to: string, now: number) {
  const courier = { session: { synthetic: async () => ({ id: "msg_r" }) }, storage: ports.storage, now: () => now } as unknown as CourierPorts
  return send(courier, from, { sessionID: to, message: "done" })
}

describe("reportSilent", () => {
  test("tells the parent once of a turn that ended without a report, with the child's last reply, waking it", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const seen = new Set<string>()
    await notePrompt(ports, delivered("evt_d", 100))

    const told = await Promise.all([reportSilent(ports, seen, succeeded("evt_s", 200)), reportSilent(ports, seen, succeeded("evt_s", 200))])

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

  test("tells nothing of a turn in which the child reported to its parent", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    await notePrompt(ports, delivered("evt_d", 100))
    await sendFrom(ports, "ses_child", "ses_parent", 150)

    expect(await reportSilent(ports, new Set(), succeeded("evt_s", 200))).toEqual([])
    expect(sent).toEqual([])
  })

  test("tells of a turn after a message that reached the child once it had reported", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const seen = new Set<string>()
    await notePrompt(ports, delivered("evt_d1", 100))
    await sendFrom(ports, "ses_child", "ses_parent", 150)
    // Steered into the same turn, after the report.
    await notePrompt(ports, delivered("evt_d2", 160))

    expect(await reportSilent(ports, seen, succeeded("evt_s", 200))).toEqual(["ses_parent"])
    expect(sent).toHaveLength(1)
  })

  test("judges by when OpenCode delivered the prompt, not when the watcher got to it", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    // The report is noted before the event of the prompt it answers is handled.
    await sendFrom(ports, "ses_child", "ses_parent", 150)
    await notePrompt(ports, delivered("evt_d", 100))

    expect(await reportSilent(ports, new Set(), succeeded("evt_s", 200))).toEqual([])
    expect(sent).toEqual([])
  })

  test("a message to any session but its parent is not a report", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    await record(ports.storage, { ...child(), sessionID: "ses_sibling" })
    await notePrompt(ports, delivered("evt_d", 100))
    await sendFrom(ports, "ses_child", "ses_sibling", 150)
    await sendFrom(ports, "ses_child", "ses_root", 150)

    expect(await reportSilent(ports, new Set(), succeeded("evt_s", 200))).toEqual(["ses_parent"])
    expect(sent).toHaveLength(1)
  })

  test("tells nothing while the child waits on a permission request or a question", async () => {
    const waiting = fakePorts([], [request])
    await record(waiting.ports.storage, child())
    await notePrompt(waiting.ports, delivered("evt_d", 100))
    expect(await reportSilent(waiting.ports, new Set(), succeeded("evt_s", 200))).toEqual([])

    const asking = fakePorts()
    await record(asking.ports.storage, child())
    await notePrompt(asking.ports, delivered("evt_d", 100))
    await asking.ports.storage.set("question/question_1", {
      requestID: "question_1",
      sessionID: "ses_child",
      top: "ses_parent",
      title: "Fix the bug",
      questions: [],
      askedAt: 1,
    })
    expect(await reportSilent(asking.ports, new Set(), succeeded("evt_s", 200))).toEqual([])
    expect([...waiting.sent, ...asking.sent]).toEqual([])
  })

  test("tells nothing while a session it started owes it a report, as one that split its task waits for them", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    await record(ports.storage, { ...child("ses_child"), sessionID: "ses_grandchild" })
    const seen = new Set<string>()
    await notePrompt(ports, delivered("evt_d1", 100))
    await notePrompt(ports, delivered("evt_d2", 110, "ses_grandchild"))
    expect(await reportSilent(ports, seen, succeeded("evt_s1", 200))).toEqual([])

    // Woken by its child's report, it ends its turn without reporting itself.
    await sendFrom(ports, "ses_grandchild", "ses_child", 300)
    await notePrompt(ports, delivered("evt_d3", 310))
    expect(await reportSilent(ports, seen, succeeded("evt_s2", 400))).toEqual(["ses_parent"])
    expect(sent).toHaveLength(1)
  })

  test("once told of a child's silent end, the parent no longer counts as waiting for it", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    await record(ports.storage, { ...child("ses_child"), sessionID: "ses_grandchild" })
    const seen = new Set<string>()
    await notePrompt(ports, delivered("evt_d1", 100))
    await notePrompt(ports, delivered("evt_d2", 110, "ses_grandchild"))
    expect(await reportSilent(ports, seen, succeeded("evt_s1", 200))).toEqual([])
    // The grandchild ends silently too; ses_child is told, and that notice prompts it.
    expect(await reportSilent(ports, seen, succeeded("evt_s2", 300, "ses_grandchild"))).toEqual(["ses_child"])
    await notePrompt(ports, delivered("evt_d3", 310))

    // It takes the grandchild's last reply and ends its turn without reporting itself.
    expect(await reportSilent(ports, seen, succeeded("evt_s3", 400))).toEqual(["ses_parent"])
    expect(sent.map((notice: any) => notice.sessionID)).toEqual(["ses_child", "ses_parent"])
  })

  test("forgets the children of a deleted session, whose reports can no longer be delivered", async () => {
    const { ports, store } = fakePorts()
    await record(ports.storage, child())
    await notePrompt(ports, delivered("evt_d", 100))

    expect(await noteDeleted(ports, sessionEvent("session.deleted", "evt_x", 150, "ses_parent") as SessionEvent)).toEqual(["ses_child"])

    expect([...store.keys()].filter((key) => key.startsWith("report/"))).toEqual([])
  })

  test("takes back that the parent was told when the notice cannot be delivered", async () => {
    const { ports, store } = fakePorts()
    await record(ports.storage, child())
    ;(ports.session as any).synthetic = async () => Promise.reject(new Error("parent is gone"))
    await notePrompt(ports, delivered("evt_d", 100))

    await expect(reportSilent(ports, new Set(), succeeded("evt_s", 200))).rejects.toThrow("parent is gone")
    expect(store.has(toldKey("ses_child"))).toBe(false)

    // A later notice told the parent meanwhile: that stays.
    ;(ports.session as any).synthetic = async () => {
      store.set(toldKey("ses_child"), { at: 400 })
      throw new Error("parent is gone")
    }
    await expect(reportSilent(ports, new Set(), succeeded("evt_s2", 300))).rejects.toThrow("parent is gone")
    expect(store.get(toldKey("ses_child"))).toEqual({ at: 400 })
  })

  test("tells nothing while a scheduled message for the child is pending, or a webhook it subscribed to since its last prompt", async () => {
    const later = fakePorts()
    await record(later.ports.storage, child())
    await notePrompt(later.ports, delivered("evt_d", 100))
    await later.ports.storage.set("later/later_1", { id: "later_1", sessionID: "ses_child", from: "ses_child", message: "m", fireAt: 500, createdAt: 150 })
    expect(await reportSilent(later.ports, new Set(), succeeded("evt_s", 200))).toEqual([])
    expect(later.sent).toEqual([])

    const hooked = fakePorts()
    await record(hooked.ports.storage, child())
    await notePrompt(hooked.ports, delivered("evt_d", 100))
    await hooked.ports.storage.set("webhook/o%2Fr%237/ses_child", { sessionID: "ses_child", topic: "o/r#7", createdAt: 150 })
    expect(await reportSilent(hooked.ports, new Set(), succeeded("evt_s1", 200))).toEqual([])
    // The delivery it waited for came, and it ended its turn without reporting: the subscription is no wait.
    await notePrompt(hooked.ports, delivered("evt_d2", 300))
    expect(await reportSilent(hooked.ports, new Set(), succeeded("evt_s2", 400))).toEqual(["ses_parent"])
  })

  test("notes the parent was told before telling it, as the notice may end the parent's turn at once", async () => {
    const { ports, store } = fakePorts()
    await record(ports.storage, child())
    let toldFirst: unknown
    ;(ports.session as any).synthetic = async () => {
      toldFirst = store.get(toldKey("ses_child"))
      return { id: "msg_1" }
    }
    await notePrompt(ports, delivered("evt_d", 100))
    await reportSilent(ports, new Set(), succeeded("evt_s", 200))
    expect(toldFirst).toEqual({ at: 200 })
  })

  test("keeps the later time when a subscription that is behind notes an older event", async () => {
    const { ports, store } = fakePorts()
    await record(ports.storage, child())
    await notePrompt(ports, delivered("evt_d2", 160))
    await notePrompt(ports, delivered("evt_d1", 100))
    expect(store.get(promptKey("ses_child"))).toEqual({ at: 160 })

    await sendFrom(ports, "ses_child", "ses_parent", 200)
    await noteInterrupted(ports, sessionEvent("session.execution.interrupted", "evt_i", 150, "ses_child", "user") as SessionEvent)
    expect(store.get(settledKey("ses_child"))).toEqual({ at: 200, by: "report" })
  })

  test("forgets a deleted child, so its parent no longer waits for it", async () => {
    const { ports, store, sent } = fakePorts()
    await record(ports.storage, child())
    await record(ports.storage, { ...child("ses_child"), sessionID: "ses_grandchild" })
    await notePrompt(ports, delivered("evt_d1", 100))
    await notePrompt(ports, delivered("evt_d2", 110, "ses_grandchild"))

    expect(await noteDeleted(ports, sessionEvent("session.deleted", "evt_x", 150, "ses_grandchild") as SessionEvent)).toEqual(["ses_grandchild"])
    expect(await noteDeleted(ports, sessionEvent("session.deleted", "evt_y", 150, "ses_stranger") as SessionEvent)).toEqual([])

    expect(store.has(promptKey("ses_grandchild"))).toBe(false)
    expect(await reportSilent(ports, new Set(), succeeded("evt_s", 200))).toEqual(["ses_parent"])
    expect(sent).toHaveLength(1)
  })

  test("what it keeps survives a restart: a new instance over the same storage judges the same", async () => {
    const before = fakePorts()
    await record(before.ports.storage, child())
    await notePrompt(before.ports, delivered("evt_d1", 100))
    await sendFrom(before.ports, "ses_child", "ses_parent", 150)

    const after = fakePorts([], [], before.store)
    expect(await reportSilent(after.ports, new Set(), succeeded("evt_s1", 200))).toEqual([])
    await notePrompt(after.ports, delivered("evt_d2", 300))
    expect(await reportSilent(after.ports, new Set(), succeeded("evt_s2", 400))).toEqual(["ses_parent"])
    expect(after.sent).toHaveLength(1)
  })

  test("sends the notice without the reply when the child's messages cannot be read", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    ;(ports.session as any).context = async () => {
      throw new Error("gone")
    }
    await notePrompt(ports, delivered("evt_d", 100))

    await reportSilent(ports, new Set(), succeeded("evt_s", 200))

    expect(sent[0].text).toBe(envelope("ses_child", silentNotice("Fix the bug", undefined), { ended: "without-report" }))
  })

  test("ignores sessions courier_spawn did not start, and those of a release that kept nothing, reading the reverse index alone", async () => {
    const { ports, sent, scanned, store } = fakePorts()
    await record(ports.storage, child())
    scanned.length = 0
    expect(await notePrompt(ports, delivered("evt_d", 100, "ses_parent"))).toBe(false)
    expect(await reportSilent(ports, new Set(), succeeded("evt_s1", 200, "ses_parent"))).toEqual([])
    expect(await reportSilent(ports, new Set(), succeeded("evt_s2", 200))).toEqual([])
    expect(sent).toEqual([])
    expect(scanned).toEqual([])
    expect(store.has(promptKey("ses_parent"))).toBe(false)
  })
})

describe("what makes a child owe a report", () => {
  /** Runs `events` through a watcher of a child that reported at 150, returning the notices sent. */
  async function afterReport(events: unknown[]) {
    const watching = new AbortController()
    const { ports, sent } = fakePorts([events])
    ;(ports as any).log = () => watching.abort()
    await record(ports.storage, child())
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
    await record(ports.storage, child())
    // What courier_spawn writes before `session.prompt`.
    await prompted(ports.storage, "ses_child", 100)
    await watchChildren(ports, fresh(), watching.signal, 1)
    expect(sent.map((notice: any) => notice.metadata.ended)).toEqual(["without-report"])
  })

  test("remembers the item types of spawned sessions only, reading nothing but the reverse index for others", async () => {
    const { ports, scanned } = fakePorts()
    await record(ports.storage, child())
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
    await record(ports.storage, child())
    const seen = new Set<string>()
    await notePrompt(ports, delivered("evt_d", 100))

    expect(await noteInterrupted(ports, sessionEvent("session.execution.interrupted", "evt_i1", 150, "ses_child", "shutdown") as SessionEvent)).toBe(false)
    expect(await owesReport(ports.storage, "ses_child")).toBe(true)
    expect(await noteInterrupted(ports, sessionEvent("session.execution.interrupted", "evt_i2", 160, "ses_child", "user") as SessionEvent)).toBe(true)
    expect(await owesReport(ports.storage, "ses_child")).toBe(false)
    expect(await reportSilent(ports, seen, succeeded("evt_s", 200))).toEqual([])
    expect(sent).toEqual([])
  })

  test("a failed turn does, and is reported as a failure", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    await notePrompt(ports, delivered("evt_d", 100))

    await reportFailure(ports, new Set(), { ...failed(), created: 150 })

    expect(await owesReport(ports.storage, "ses_child")).toBe(false)
    expect(sent.map((notice: any) => notice.description)).toEqual(["Session ses_child failed"])
  })

  test("a failure that cannot be noted is still reported", async () => {
    const { ports, sent, logged } = fakePorts()
    await record(ports.storage, child())
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
    await record(ports.storage, child())
    await notePrompt(ports, delivered("evt_d", 100))
    await reportSilent(ports, new Set(), succeeded("evt_s", 120))
    await sendFrom(ports, "ses_child", "ses_parent", 150)
    expect([...store.keys()].filter((key) => key.startsWith("report/")).sort()).toEqual([
      "report/ses_child/prompt",
      "report/ses_child/settled",
      "report/ses_child/told",
    ])

    await remove(ports.storage, "ses_parent", "ses_child")

    expect([...store.keys()]).toEqual([])
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
        text: envelope("ses_child", permissionNotice("Fix the bug", request), { asks: "permission", request: "per_1" }),
        description: "Session ses_child asks for permission",
        metadata: { source: "courier", from: "ses_child", asks: "permission", requestID: "per_1" },
        delivery: "steer",
      },
    ])
    expect(state.waiting).toEqual(new Set(["per_1"]))
  })

  test("tells the session at the top, where the person is, about a request of a child's child", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    await record(ports.storage, { ...child("ses_root"), sessionID: "ses_parent", title: "Lead" })

    expect(await reportAsked(ports, fresh(), asked())).toEqual(["ses_root"])

    expect(sent[0].sessionID).toBe("ses_root")
    expect(sent[0].text).toBe(
      envelope("ses_child", permissionNotice("Fix the bug", request, "ses_parent"), { asks: "permission", request: "per_1" }),
    )
    expect(sent[0].text).toContain('This session, "Fix the bug", which ses_parent started with courier_spawn, a session started from yours,')
  })

  test("does not tell anyone about a request answered while its roster was looked up", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const state = fresh()

    const telling = reportAsked(ports, state, asked())
    await reportReplied(ports, state, replied())
    await telling

    expect(sent).toEqual([])
    expect(state.waiting.size).toBe(0)
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

const choice: FormField = {
  key: "choice",
  description: "Allow OpenCode to search the web for up-to-date information?",
  type: "string",
  options: [
    { value: "allow", label: "Allow search via Courier Search" },
    { value: "choose", label: "Choose another provider" },
    { value: "disable", label: "Disable web search" },
  ],
}

const webForm = { id: "frm_1", sessionID: "ses_child", title: "Web Search", metadata: { kind: "websearch.provider" }, fields: [choice] }

const shown = (id = "evt_f", form: FormCreated["data"]["form"] = webForm): FormCreated & { type: string } => ({
  id,
  type: "form.created",
  data: { form },
})

const settled = (id = "evt_s", type = "form.replied", formID = "frm_1") => ({ id, type, data: { id: formID, sessionID: "ses_child" } })

describe("reportForm", () => {
  test("tells the parent which form its child shows and that only the person can answer it, waking it", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const state = fresh()

    expect(await reportForm(ports, state, shown())).toEqual(["ses_parent"])

    expect(sent).toEqual([
      {
        sessionID: "ses_parent",
        text: envelope("ses_child", formNotice("Fix the bug", webForm), { asks: "form", form: "frm_1", kind: "websearch.provider" }),
        description: "Session ses_child shows a form",
        metadata: { source: "courier", from: "ses_child", asks: "form", formID: "frm_1", kind: "websearch.provider" },
        delivery: "steer",
      },
    ])
    const text = sent[0].text as string
    expect(text).toContain('shows a form, "Web Search", and waits until it is answered.')
    expect(text).toContain("- Allow OpenCode to search the web for up-to-date information?\n  - Allow search via Courier Search\n  - Choose another provider\n  - Disable web search")
    expect(text).toContain('fails with "Web search cancelled"')
    expect(text).toContain("once it is made, in any session, no session is asked again")
    expect(text).toContain("only the person you are working with can, in session ses_child itself")
    expect([...state.forms.told.keys()]).toEqual(["frm_1"])
  })

  test("tells about another kind of form without the web search note, and shows each kind of field", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const many = Array.from({ length: 22 }, (_, index) => ({ value: `v${index}`, label: `Option ${index}` }))
    const form = {
      id: "frm_2",
      sessionID: "ses_child",
      title: "Sign in",
      fields: [
        { key: "name", type: "string" },
        { key: "count", type: "integer", title: "How many?" },
        { key: "link", type: "external", url: "https://example.com/login" },
        { key: "pick", type: "multiselect", description: "Pick some", options: many },
      ],
    }

    await reportForm(ports, fresh(), shown("evt_f", form))

    expect(sent[0].metadata).toEqual({ source: "courier", from: "ses_child", asks: "form", formID: "frm_2" })
    const text = sent[0].text as string
    expect(text).toStartWith('<courier from="ses_child" asks="form" form="frm_2">')
    expect(text).toContain("- name (string)\n- How many? (integer)\n- link, opens https://example.com/login\n- Pick some\n  - Option 0")
    expect(text).toContain("  - Option 19\n  - and 2 more")
    expect(text).not.toContain("Web search cancelled")
  })

  test("names a field by its title and description, leaves hidden fields out and says when there are more", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const extra = Array.from({ length: 21 }, (_, index) => ({ key: `f${index}`, type: "boolean" }))
    const form = {
      ...webForm,
      metadata: {},
      fields: [
        { key: "secret", type: "string", title: "Secret", hidden: true },
        { key: "provider", type: "string", title: "Provider", description: "Pick one.", when: [{ key: "choice", op: "eq", value: "choose" }] },
        ...extra,
      ],
    }

    await reportForm(ports, fresh(), shown("evt_f", form))

    const text = sent[0].text as string
    expect(text).not.toContain("Secret")
    expect(text).toContain("- Provider: Pick one. (string) (only for some earlier answers)\n- f0 (boolean)")
    expect(text).toContain("- f18 (boolean)\n- and 2 more fields")
  })

  test("leaves a kind that cannot go in the envelope out of it", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())

    await reportForm(ports, fresh(), shown("evt_f", { ...webForm, metadata: { kind: 'x" y' } }))

    expect(sent[0].text).toStartWith('<courier from="ses_child" asks="form" form="frm_1">')
  })

  test("tells the session at the top about a form of a child's child", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    await record(ports.storage, { ...child("ses_root"), sessionID: "ses_parent", title: "Lead" })

    expect(await reportForm(ports, fresh(), shown())).toEqual(["ses_root"])
    expect(sent[0].text).toContain("which ses_parent started with courier_spawn, a session started from yours,")
  })

  test("leaves a question's form to the question relay", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const question = { ...webForm, title: "Questions", metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_1" } } }

    expect(await reportForm(ports, fresh(), shown("evt_f", question))).toEqual([])
    expect(sent).toEqual([])
  })

  test("ignores a form of a session courier_spawn did not start, and tells each form once", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const state = fresh()

    expect(await reportForm(ports, state, shown("evt_o", { ...webForm, sessionID: "ses_other" }))).toEqual([])
    expect(state.forms.told.size).toBe(0)
    await Promise.all([reportForm(ports, state, shown("evt_f")), reportForm(ports, state, shown("evt_f"))])
    await reportForm(ports, state, shown("evt_g"))
    expect(sent).toHaveLength(1)
  })

  test("does not tell anyone about a form settled while its roster was looked up", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const state = fresh()

    const telling = reportForm(ports, state, shown())
    await reportFormSettled(ports, state, settled())
    await telling

    expect(sent).toEqual([])
    expect(state.forms.told.size).toBe(0)
  })
})

describe("reportFormSettled", () => {
  test("tells the parent that a form it was told about was answered, or withdrawn", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const state = fresh()
    await reportForm(ports, state, shown())
    await reportForm(ports, state, shown("evt_g", { ...webForm, id: "frm_2" }))

    expect(await reportFormSettled(ports, state, settled())).toEqual(["ses_parent"])
    expect(await reportFormSettled(ports, state, settled("evt_t", "form.cancelled", "frm_2"))).toEqual(["ses_parent"])

    expect(sent[2]).toEqual({
      sessionID: "ses_parent",
      text: envelope("ses_child", formSettledNotice("Fix the bug", "frm_1", "answered"), { settled: "answered", form: "frm_1" }),
      description: "Session ses_child no longer shows a form",
      metadata: { source: "courier", from: "ses_child", settled: "answered", formID: "frm_1" },
      delivery: "steer",
    })
    expect(sent[2].text).toContain("has been answered in that session")
    expect(sent[3].text).toStartWith('<courier from="ses_child" settled="cancelled" form="frm_2">')
    expect(sent[3].text).toContain("has been withdrawn unanswered")
    expect(state.forms.told.size).toBe(0)
  })

  test("says nothing about a form no one was told about, or about one event twice", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const state = fresh()

    expect(await reportFormSettled(ports, state, settled())).toEqual([])
    await reportForm(ports, state, shown("evt_f", { ...webForm, id: "frm_2" }))
    await Promise.all([
      reportFormSettled(ports, state, settled("evt_t", "form.cancelled", "frm_2")),
      reportFormSettled(ports, state, settled("evt_t", "form.cancelled", "frm_2")),
    ])
    expect(sent).toHaveLength(2)
  })

  test("waits for the notice that the form is shown, which another instance may still be sending", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const state = fresh()
    let deliver: () => void = () => undefined
    ;(ports.session as any).synthetic = (input: any) =>
      input.metadata.asks
        ? new Promise((resolve) => (deliver = () => resolve(sent.push(input))))
        : Promise.resolve(sent.push(input))

    const telling = reportForm(ports, state, shown())
    while (!state.forms.told.size) await Bun.sleep(1)
    const settling = reportFormSettled(ports, state, settled())
    await Bun.sleep(5)
    expect(sent).toEqual([])
    deliver()
    await Promise.all([telling, settling])

    expect(sent.map((notice: any) => notice.metadata.asks ?? notice.metadata.settled)).toEqual(["form", "answered"])
  })

  test("says nothing of the settling when the notice that the form is shown did not go out", async () => {
    const { ports, sent } = fakePorts()
    await record(ports.storage, child())
    const state = fresh()
    state.forms.told.set("frm_1", Promise.reject(new Error("parent is gone")))

    expect(await reportFormSettled(ports, state, settled())).toEqual([])
    expect(sent).toEqual([])
  })

  test("says nothing when the session is no longer on a roster", async () => {
    const { ports, sent } = fakePorts()
    const state = fresh()
    state.forms.told.set("frm_1", Promise.resolve())

    expect(await reportFormSettled(ports, state, settled())).toEqual([])
    expect(sent).toEqual([])
  })
})

describe("relayPending", () => {
  test("relays the requests spawned sessions already wait on, once, alongside the events", async () => {
    const other = { ...request, id: "per_2", sessionID: "ses_other" }
    const { ports, sent } = fakePorts([], [request, other])
    await record(ports.storage, child())
    const state = fresh()

    await Promise.all([relayPending(ports, state), reportAsked(ports, state, asked())])
    await relayPending(ports, state)

    expect(sent.map((notice: any) => notice.metadata.requestID)).toEqual(["per_1"])
  })
})

describe("relayPending, across locations", () => {
  test("relays the requests pending in every loaded location, each once", async () => {
    const isolated = { ...request, id: "per_2" }
    const { ports, sent } = fakePorts([], [request])
    const here = [...ports.permissions()][0]!
    const worktree = { list: async ({ sessionID }: { sessionID: string }) => [isolated, request].filter((item) => item.sessionID === sessionID) }
    ;(ports as any).permissions = () => [here, worktree]
    await record(ports.storage, child())

    await relayPending(ports, fresh())

    expect(sent.map((notice: any) => notice.metadata.requestID).sort()).toEqual(["per_1", "per_2"])
  })
})

describe("relayPending, concurrency", () => {
  test("a notice slow to go out does not hold up the others", async () => {
    const second = { ...request, id: "per_2", sessionID: "ses_child2" }
    const { ports, sent } = fakePorts([], [request, second])
    await record(ports.storage, child())
    await record(ports.storage, { ...child(), sessionID: "ses_child2" })
    let secondSent: () => void = () => undefined
    const told = new Promise<void>((resolve) => (secondSent = resolve))
    ;(ports.session as any).synthetic = async (input: any) => {
      // Waits for the other notice, or gives up after a while when there is none.
      if (input.metadata.requestID === "per_1") await Promise.race([told, new Promise((resolve) => setTimeout(resolve, 200))])
      sent.push(input)
      if (input.metadata.requestID === "per_2") secondSent()
      return { id: "msg_1" }
    }

    await relayPending(ports, fresh())

    expect(sent.map((notice: any) => notice.metadata.requestID)).toEqual(["per_2", "per_1"])
  })
})

describe("watchChildren", () => {
  test("reports failed turns and permission requests from the event stream and skips other events", async () => {
    const watching = new AbortController()
    const { ports, sent } = fakePorts([
      [{ id: "evt_0", type: "session.idle", data: { sessionID: "ses_child" } }, failed(), asked(), replied()],
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

  test("tells of a child's turn that ended without a report from the event stream", async () => {
    const watching = new AbortController()
    const { ports, sent } = fakePorts([[delivered("evt_d", 100), succeeded("evt_s", 200)]])
    await record(ports.storage, child())
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
    await record(ports.storage, child())
    ;(ports.session as any).synthetic = async () => (watching.abort(), { id: "msg_1" })

    await watchChildren(ports, fresh(), watching.signal, 1)

    expect(shutdownReportedAt("/repo")).toBe(1_000_000)
    expect(shutdownReportedAt("/elsewhere")).toBeUndefined()
    resetHub()

    const again = new AbortController()
    const second = fakePorts([[{ id: "evt_t", type: "location.shutdown" }, failed()]])
    await record(second.ports.storage, child())
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
    await record(ports.storage, child())
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
    await record(ports.storage, child())
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
    await record(ports.storage, child())
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
    await record(ports.storage, child())
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
    watchFromHub(opened.hub, state, 1)
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
    const opened = open({}, idle)
    const [a, b, c] = [member("a"), member("b"), member("c")]
    const unloadA = load(opened, a)
    expect(watchingThrough(opened.hub)).toEqual([a.joined])
    expect(processHub.questions.following).toBe(1)

    const unloadB = load(opened, b)
    const unloadC = load(opened, c)
    expect(watchingThrough(opened.hub)).toEqual([a.joined, b.joined])
    expect([a.subscriptions(), b.subscriptions(), c.subscriptions()]).toEqual([1, 1, 0])
    expect(processHub.questions.following).toBe(2)

    // An instance with no subscription leaves without touching them.
    await unloadC()
    expect(watchingThrough(opened.hub)).toEqual([a.joined, b.joined])

    // The last one to leave stops the last subscription.
    await unloadA()
    expect(watchingThrough(opened.hub)).toEqual([b.joined])
    await unloadB()
    expect(watchingThrough(opened.hub)).toEqual([])
    expect([a.ended(), b.ended()]).toEqual([1, 1])
    expect(processHub.questions.following).toBe(0)
    resetHub()
  })

  test("when the first one's instance leaves, the standby keeps following and a new one starts, through the earliest instance without one", async () => {
    resetHub()
    const opened = open({}, idle)
    const state = fresh()
    const [a, b, c] = [member("a"), member("b"), member("c", [request])]
    await record(c.ports.storage, child())
    const unloadA = load(opened, a, state)
    const unloadB = load(opened, b, state)
    const unloadC = load(opened, c, state)
    let released = false
    processHub.questions.shown.set("ses_child call_1", () => (released = true))

    const ended = unloadA()
    // Never fewer than one subscription following the events, so nothing is taken as missed.
    expect(watchingThrough(opened.hub)).toEqual([b.joined, c.joined])
    expect(processHub.questions.following).toBe(3)
    await ended
    expect(processHub.questions.following).toBe(2)
    expect([b.subscriptions(), c.subscriptions()]).toEqual([1, 1])

    // The new standby, like any subscription, relays what is already pending, once.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(c.sent.map((notice: any) => notice.metadata.requestID)).toEqual(["per_1"])
    expect(released).toBe(false)

    await unloadB()
    await unloadC()
    expect(processHub.questions.following).toBe(0)
    resetHub()
  })

  test("when the standby's instance leaves, another starts", async () => {
    resetHub()
    const opened = open({}, idle)
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
    const opened = open({}, idle)
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
    const opened = open({}, idle)
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
