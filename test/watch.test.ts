import { describe, expect, test } from "bun:test"
import {
  envelope,
  failureNotice,
  formNotice,
  formSettledNotice,
  permissionNotice,
  permissionSettledNotice as settledNotice,
  type FormField,
} from "../src/notices.js"
import {
  type FormCreated,
  type PermissionAsked,
  type PermissionReplied,
} from "../src/relay.js"
import { hub as processHub, open, resetHub, type Member } from "../src/hub.js"
import { shutdownReportedAt } from "../src/question.js"
import { record } from "../src/roster.js"
import {
  reportAsked,
  reportFailure,
  reportForm,
  reportFormSettled,
  handOver,
  relayPending,
  reportReplied,
  watchChildren,
  watchForHub,
  type ExecutionFailed,
  type WatchPorts,
} from "../src/watch.js"

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

const fresh = () => ({ seen: new Set<string>(), waiting: new Set<string>(), answered: new Set<string>(), forms: { told: new Map<string, Promise<unknown>>(), settled: new Set<string>() } })

function fakePorts(streams: unknown[][] = [], pending: PermissionAsked["data"][] = []) {
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
    permissions: () => [
      { list: async ({ sessionID }: { sessionID: string }) => pending.filter((item) => item.sessionID === sessionID) },
    ],
    now: () => 1_000_000,
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
      [{ id: "evt_0", type: "session.execution.succeeded", data: { sessionID: "ses_child" } }, failed(), asked(), replied()],
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

describe("one watcher per hub", () => {
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

  test("subscribes once, through the first member to join, however many join, and hands over to the latest", async () => {
    resetHub()
    const { hub, join } = open({})
    const [first, second, third] = [member("a"), member("b"), member("c")]
    const leaves = [first, second, third].map(({ joined }) => {
      const leave = join(joined)
      watchForHub(hub, fresh(), 1)
      return leave
    })

    expect([first.subscriptions(), second.subscriptions(), third.subscriptions()]).toEqual([1, 0, 0])
    expect(hub.watcher?.member).toBe(first.joined)
    expect(processHub.questions.following).toBe(1)

    // A member that does not run the subscription leaves without touching it.
    leaves[1]!()
    handOver(hub, second.joined, fresh(), 1)
    expect(hub.watcher?.member).toBe(first.joined)

    // Then it moves to the member that joined last, and ends with it.
    const old = hub.watcher!
    leaves[0]!()
    handOver(hub, first.joined, fresh(), 1)
    await old.done
    expect(hub.watcher?.member).toBe(third.joined)
    expect([first.ended(), third.subscriptions()]).toEqual([1, 1])
    const last = hub.watcher!
    leaves[2]!()
    handOver(hub, third.joined, fresh(), 1)
    await last.done
    expect(hub.watcher).toBeUndefined()
    expect(processHub.questions.following).toBe(0)
    resetHub()
  })

  test("hands the subscription over when its member leaves, subscribing again before the old one ends", async () => {
    resetHub()
    const { hub, join } = open({})
    const state = fresh()
    const first = member("a")
    const second = member("b", [request])
    await record(second.ports.storage, child())
    const leaveFirst = join(first.joined)
    watchForHub(hub, state, 1)
    const leaveSecond = join(second.joined)
    watchForHub(hub, state, 1)
    const old = hub.watcher!

    leaveFirst()
    handOver(hub, first.joined, state, 1)

    expect(hub.watcher?.member).toBe(second.joined)
    expect(second.subscriptions()).toBe(1)
    // The events stay followed throughout: the new subscription counts before the old one ends, so
    // question forms are not taken as missed.
    expect(processHub.questions.following).toBe(2)
    await old.done
    expect(first.ended()).toBe(1)
    expect(processHub.questions.following).toBe(1)

    // Like any resubscription, the new one relays what is already pending, which it was not sent.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(second.sent.map((notice: any) => notice.metadata.requestID)).toEqual(["per_1"])

    const last = hub.watcher!
    leaveSecond()
    handOver(hub, second.joined, state, 1)
    await last.done
    expect(processHub.questions.following).toBe(0)
    resetHub()
  })

  test("a member joining after the last one left subscribes again", async () => {
    resetHub()
    const { hub, join } = open({})
    watchForHub(hub, fresh(), 1)
    expect(hub.watcher).toBeUndefined()

    const only = member("a")
    const leave = join(only.joined)
    watchForHub(hub, fresh(), 1)
    expect(only.subscriptions()).toBe(1)
    const watcher = hub.watcher!
    leave()
    handOver(hub, only.joined, fresh(), 1)
    await watcher.done
    expect(hub.watcher).toBeUndefined()

    const next = member("b")
    const leaveNext = join(next.joined)
    watchForHub(hub, fresh(), 1)
    expect(hub.watcher?.member).toBe(next.joined)
    leaveNext()
    handOver(hub, next.joined, fresh(), 1)
    await watcher.done
    resetHub()
  })

  test("never hands over to the member leaving, even before it has left", async () => {
    resetHub()
    const { hub, join } = open({})
    const first = member("a")
    const second = member("b")
    const leaveFirst = join(first.joined)
    watchForHub(hub, fresh(), 1)
    const leaveSecond = join(second.joined)
    const old = hub.watcher!

    handOver(hub, first.joined, fresh(), 1)
    leaveFirst()

    expect(hub.watcher?.member).toBe(second.joined)
    expect(first.subscriptions()).toBe(1)
    await old.done
    const last = hub.watcher!
    leaveSecond()
    handOver(hub, second.joined, fresh(), 1)
    await last.done
    resetHub()
  })

  test("on its first event, the subscription taken over releases the question calls waiting for their form", async () => {
    resetHub()
    const { hub, join } = open({})
    const first = member("a")
    const second = member("b", [], [{ id: "evt_x", type: "session.execution.succeeded", data: { sessionID: "ses_other" } }])
    const leaveFirst = join(first.joined)
    watchForHub(hub, fresh(), 1)
    const leaveSecond = join(second.joined)
    let released = false
    processHub.questions.shown.set("ses_child call_1", () => (released = true))

    const old = hub.watcher!
    leaveFirst()
    handOver(hub, first.joined, fresh(), 1)
    // Not at once: the events are still followed, so nothing is taken as missed yet.
    expect(released).toBe(false)
    await old.done
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(released).toBe(true)

    const last = hub.watcher!
    leaveSecond()
    handOver(hub, second.joined, fresh(), 1)
    await last.done
    resetHub()
  })
})
