import { describe, expect, test } from "bun:test"
import { envelope } from "../src/kernel/protocol.js"
import { formNotice, formSettledNotice, permissionNotice, permissionSettledNotice as settledNotice } from "../src/person/text.js"
import { personEvents } from "../src/person/events.js"
import type { FormCreated } from "../src/person/form.js"
import { relayPending, reportAsked, reportReplied } from "../src/person/events.js"
import { formsShown, reportForm, reportFormSettled } from "../src/person/form.js"
import { forgetChild } from "../src/tree/forget.js"
import { childStore } from "../src/tree/store.js"
import { asked, child, fakePorts, fresh, replied, request, settled, shown, webForm } from "./fixtures/events.js"

describe("reportAsked", () => {
  test("tells the parent what the child asks for and how to answer, waking it", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
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
    await childStore(ports.storage).record(child())
    await childStore(ports.storage).record({ ...child("ses_root"), sessionID: "ses_parent", title: "Lead" })

    expect(await reportAsked(ports, fresh(), asked())).toEqual(["ses_root"])

    expect(sent[0].sessionID).toBe("ses_root")
    expect(sent[0].text).toBe(
      envelope("ses_child", permissionNotice("Fix the bug", request, "ses_parent"), { asks: "permission", request: "per_1" }),
    )
    expect(sent[0].text).toContain('This session, "Fix the bug", which ses_parent started with courier_spawn, a session started from yours,')
  })

  test("a native child's request, shown by OpenCode in the top session's view: the top is told not to ask the person", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record({ ...child(), native: true })

    await reportAsked(ports, fresh(), asked())

    expect(sent[0].text).toBe(
      envelope("ses_child", permissionNotice("Fix the bug", request, undefined, true), { asks: "permission", request: "per_1", shown: "native" }),
    )
    expect(sent[0].text).toContain("OpenCode already shows this request to the person you are working with")
    expect(sent[0].text).toContain("Do not ask them yourself")
    expect(sent[0].text).not.toContain("Ask the person you are working with")
    expect(sent[0].metadata).toMatchObject({ asks: "permission", requestID: "per_1", shown: "native" })
  })

  test("a native child's child, all native up to the top, is told the same way", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record({ ...child(), native: true })
    await childStore(ports.storage).record({ ...child("ses_root"), sessionID: "ses_parent", title: "Lead", native: true })

    await reportAsked(ports, fresh(), asked())

    expect(sent[0].sessionID).toBe("ses_root")
    expect(sent[0].text).toContain('request="per_1" shown="native">')
  })

  test("a native child under an isolated session, an isolated child, and a child without the option: the top asks the person as before", async () => {
    const cases = [
      [{ ...child(), native: true as const }, { ...child("ses_root"), sessionID: "ses_parent", title: "Lead", isolated: true }],
      [{ ...child(), isolated: true }],
      [child()],
    ]
    for (const entries of cases) {
      const { ports, sent } = fakePorts()
      for (const entry of entries) await childStore(ports.storage).record(entry)

      await reportAsked(ports, fresh(), asked())

      expect(sent[0].text).not.toContain("shown=")
      expect(sent[0].text).toContain("You cannot decide this: the person you are working with does, in OpenCode's own permission prompt")
    }
  })

  test("does not tell anyone about a request answered while its roster was looked up", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    const state = fresh()

    const telling = reportAsked(ports, state, asked())
    await reportReplied(ports, state, replied())
    await telling

    expect(sent).toEqual([])
    expect(state.waiting.size).toBe(0)
  })

  test("ignores a request of a session that courier_spawn did not start, and a repeated event", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
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
    await childStore(ports.storage).record(child())
    const state = fresh()
    await reportAsked(ports, state, asked())

    expect(await reportReplied(ports, state, replied())).toEqual(["ses_parent"])

    expect(sent[1]).toEqual({
      sessionID: "ses_parent",
      text: envelope("ses_child", settledNotice("Fix the bug", "per_1", "once"), { answered: "once", request: "per_1" }),
      description: "Session ses_child no longer asks for permission",
      metadata: { source: "courier", from: "ses_child", answered: "once", requestID: "per_1", resume: false },
      delivery: "steer",
      resume: false,
    })
    expect(state.waiting.size).toBe(0)
  })

  test("sends the settled notice without a wake, and the asked one with it", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    const state = fresh()
    await reportAsked(ports, state, asked())
    await reportReplied(ports, state, replied())

    expect(sent[0].resume).toBeUndefined()
    expect(sent[1].resume).toBe(false)
  })

  test("says nothing about a request the parent was not told about or has answered itself", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())

    expect(await reportReplied(ports, fresh(), replied())).toEqual([])
    expect(sent).toEqual([])
  })
})

describe("reportForm", () => {
  test("tells the parent which form its child shows and that only the person can answer it, waking it", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
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

  test("sends the person to the view OpenCode shows a native child's form in: the top's, or an isolated session's above it", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record({ ...child(), native: true })

    await reportForm(ports, fresh(), shown())
    expect(sent[0].text).toContain(
      "only the person you are working with can, in your own session, where OpenCode shows the forms of the sessions under it.",
    )
    expect(sent[0].text).toContain("Tell them your session shows this form")
    expect(sent[0].text).not.toContain("in session ses_child itself")

    await childStore(ports.storage).record({ ...child("ses_root"), sessionID: "ses_parent", title: "Lead", isolated: true })
    await reportForm(ports, fresh(), shown("evt_g"))
    expect(sent[1].sessionID).toBe("ses_root")
    expect(sent[1].text).toContain("can, in session ses_parent, where OpenCode shows the forms of the sessions under it.")
    expect(sent[1].text).toContain("Tell them session ses_parent shows this form")
  })

  test("tells about another kind of form without the web search note, and shows each kind of field", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
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
    await childStore(ports.storage).record(child())
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
    await childStore(ports.storage).record(child())

    await reportForm(ports, fresh(), shown("evt_f", { ...webForm, metadata: { kind: 'x" y' } }))

    expect(sent[0].text).toStartWith('<courier from="ses_child" asks="form" form="frm_1">')
  })

  test("tells the session at the top about a form of a child's child", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    await childStore(ports.storage).record({ ...child("ses_root"), sessionID: "ses_parent", title: "Lead" })

    expect(await reportForm(ports, fresh(), shown())).toEqual(["ses_root"])
    expect(sent[0].text).toContain("which ses_parent started with courier_spawn, a session started from yours,")
  })

  test("leaves a question's form to the question relay", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    const question = { ...webForm, title: "Questions", metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_1" } } }

    expect(await reportForm(ports, fresh(), shown("evt_f", question))).toEqual([])
    expect(sent).toEqual([])
  })

  test("ignores a form of a session courier_spawn did not start, and tells each form once", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    const state = fresh()

    expect(await reportForm(ports, state, shown("evt_o", { ...webForm, sessionID: "ses_other" }))).toEqual([])
    expect(state.forms.told.size).toBe(0)
    await Promise.all([reportForm(ports, state, shown("evt_f")), reportForm(ports, state, shown("evt_f"))])
    await reportForm(ports, state, shown("evt_g"))
    expect(sent).toHaveLength(1)
  })

  test("does not tell anyone about a form settled while its roster was looked up", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
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
    await childStore(ports.storage).record(child())
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
    expect(sent[2].text).toContain("has been answered, so it no longer waits")
    expect(sent[3].text).toStartWith('<courier from="ses_child" settled="cancelled" form="frm_2">')
    expect(sent[3].text).toContain("has been withdrawn unanswered")
    expect(state.forms.told.size).toBe(0)
  })

  test("says nothing about a form no one was told about, or about one event twice", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
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
    await childStore(ports.storage).record(child())
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
    await childStore(ports.storage).record(child())
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

describe("formsShown", () => {
  test("lists the forms a session shows from their creation to their settling, not a question's or one settled before it was seen", async () => {
    const { ports } = fakePorts()
    await childStore(ports.storage).record(child())
    const state = fresh()
    const question = { ...webForm, id: "frm_q", title: "Questions", metadata: { kind: "question" } }

    await reportForm(ports, state, shown("evt_f"))
    await reportForm(ports, state, shown("evt_g", { ...webForm, id: "frm_2", title: "Choose a web search provider" }))
    await reportForm(ports, state, shown("evt_q", question))
    await reportForm(ports, state, shown("evt_o", { ...webForm, id: "frm_o", sessionID: "ses_other" }))
    expect(formsShown(state.shown, "ses_child")).toEqual([
      { id: "frm_1", title: "Web Search" },
      { id: "frm_2", title: "Choose a web search provider" },
    ])
    expect(formsShown(state.shown, "ses_other")).toEqual([{ id: "frm_o", title: "Web Search" }])

    await reportFormSettled(ports, state, settled("evt_s"))
    await reportFormSettled(ports, state, { ...settled("evt_t", "form.cancelled", "frm_o"), data: { id: "frm_o", sessionID: "ses_other" } })
    expect(formsShown(state.shown, "ses_child")).toEqual([{ id: "frm_2", title: "Choose a web search provider" }])
    expect(formsShown(state.shown, "ses_other")).toEqual([])

    await reportFormSettled(ports, state, settled("evt_u", "form.cancelled", "frm_3"))
    await reportForm(ports, state, shown("evt_h", { ...webForm, id: "frm_3" }))
    expect(formsShown(state.shown, "ses_child")).toHaveLength(1)
  })
})

describe("relayPending", () => {
  test("relays the requests spawned sessions already wait on, once, alongside the events", async () => {
    const other = { ...request, id: "per_2", sessionID: "ses_other" }
    const { ports, sent } = fakePorts([], [request, other])
    await childStore(ports.storage).record(child())
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
    await childStore(ports.storage).record(child())

    await relayPending(ports, fresh())

    expect(sent.map((notice: any) => notice.metadata.requestID).sort()).toEqual(["per_1", "per_2"])
  })
})

describe("relayPending, concurrency", () => {
  test("a notice slow to go out does not hold up the others", async () => {
    const second = { ...request, id: "per_2", sessionID: "ses_child2" }
    const { ports, sent } = fakePorts([], [request, second])
    await childStore(ports.storage).record(child())
    await childStore(ports.storage).record({ ...child(), sessionID: "ses_child2" })
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
