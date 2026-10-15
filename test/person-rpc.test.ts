// The person's RPC, which the TUI's asks inbox reads and answers questions through, and the notices the
// parent gets when the inbox answers a permission request or a form through OpenCode.
import { afterEach, describe, expect, test } from "bun:test"
import { answer, asks, registerPersonRpc, type PersonRpcPorts } from "../src/person/rpc-handlers.js"
import { personRpc } from "../src/person/rpc.js"
import { reportAsked, reportReplied } from "../src/person/events.js"
import { reportForm, reportFormSettled } from "../src/person/form.js"
import { shared as relayState } from "../src/person/question/shared.js"
import { stopRelay } from "../src/person/question/runtime.js"
import type { QuestionPorts } from "../src/person/question/index.js"
import { RETENTION_MS } from "../src/tree/roster.js"
import { childStore } from "../src/tree/store.js"
import { resetHub } from "./fixtures/reset.js"
import { asked, child, fakePorts, fresh, replied, settled, shown } from "./fixtures/events.js"

afterEach(async () => {
  await stopRelay()
  resetHub()
})

const entry = (sessionID: string, parentID: string, title: string, group?: string) => ({
  sessionID,
  parentID,
  title,
  directory: "/repo",
  isolated: false,
  createdAt: 1,
  ...(group ? { group } : {}),
})

const greeting = [{ question: "Which greeting?", header: "Greeting", options: [{ label: "Hi", description: "" }] }]

/** The RPC's ports over a map: a tree ses_root › ses_a › ses_b, with a permission request of ses_b's pending in a second location. */
async function setUp() {
  const store = new Map<string, unknown>()
  const told: any[] = []
  const questions = {
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
    },
    session: { synthetic: async (input: unknown) => (told.push(input), { id: "msg" }) },
    directory: "/repo",
    now: () => 1_000_000,
    timing: { closingGraceMs: 0, passingWaitMs: 1_000, relayWaitMs: 1_000, dismissalGraceMs: 0 },
    newID: () => "question_x",
    log: () => undefined,
  } as unknown as QuestionPorts
  const requests = [{ id: "per_1", sessionID: "ses_b", action: "bash", resources: ["bun test"], save: ["bun *"] }]
  const ports: PersonRpcPorts = {
    questions,
    permissions: () => [
      { list: async () => [], reply: async () => undefined },
      { list: async ({ sessionID }: { sessionID: string }) => requests.filter((item) => item.sessionID === sessionID), reply: async () => undefined },
    ] as never,
  }
  const children = childStore(questions.storage as never)
  await children.record(entry("ses_a", "ses_root", "Fix the bug"))
  await children.record(entry("ses_b", "ses_a", "Write tests", "pair"))
  await children.record(entry("ses_other", "ses_elsewhere", "Not in this tree"))
  store.set("question/question_1", { requestID: "question_1", sessionID: "ses_a", top: "ses_root", title: "Fix the bug", questions: greeting, askedAt: 1 })
  return { ports, store, told }
}

describe("the asks method", () => {
  test("lists the permission requests and questions of the whole tree, from the roster, whichever session of it asks", async () => {
    const { ports } = await setUp()
    const expected = {
      top: "ses_root",
      sessions: [
        { sessionID: "ses_a", title: "Fix the bug", parentID: "ses_root", depth: 1 },
        { sessionID: "ses_b", title: "Write tests", parentID: "ses_a", depth: 2, group: "pair" },
      ],
      permissions: [{ sessionID: "ses_b", requestID: "per_1", action: "bash", resources: ["bun test"], save: ["bun *"] }],
      questions: [{ sessionID: "ses_a", requestID: "question_1", questions: greeting, stopped: true }],
    }

    for (const sessionID of ["ses_root", "ses_a", "ses_b"]) expect(await asks(ports, sessionID)).toEqual(expected)
  })

  test("lists the top session's own requests first, a courier_answer prompt with the request it passes on", async () => {
    const { ports } = await setUp()
    const top = [
      { id: "per_top", sessionID: "ses_root", action: "bash", resources: ["bun test"], metadata: { source: "courier", from: "ses_b", asks: "permission", requestID: "per_1" } },
      { id: "per_own", sessionID: "ses_root", action: "edit", resources: ["src/a.ts"], save: ["src/*"], metadata: { source: "other" } },
      { id: "per_alone", sessionID: "ses_alone", action: "edit", resources: ["b.ts"] },
    ]
    const permissions = ports.permissions
    ;(ports as any).permissions = () => [
      ...permissions(),
      { list: async ({ sessionID }: { sessionID: string }) => top.filter((item) => item.sessionID === sessionID), reply: async () => undefined },
    ]

    for (const sessionID of ["ses_root", "ses_b"])
      expect((await asks(ports, sessionID)).permissions).toEqual([
        { sessionID: "ses_root", requestID: "per_top", action: "bash", resources: ["bun test"], passesOn: { sessionID: "ses_b", requestID: "per_1" } },
        { sessionID: "ses_root", requestID: "per_own", action: "edit", resources: ["src/a.ts"], save: ["src/*"] },
        { sessionID: "ses_b", requestID: "per_1", action: "bash", resources: ["bun test"], save: ["bun *"] },
      ])
    expect((await personRpc.methods.asks.output["~standard"].validate(await asks(ports, "ses_root"))).issues).toBeUndefined()
    // A session outside any courier tree lists nothing, its own requests included: OpenCode shows those in it.
    expect((await asks(ports, "ses_alone")).permissions).toEqual([])
  })

  test("a session no courier tree knows has an empty inbox", async () => {
    const { ports } = await setUp()
    expect(await asks(ports, "ses_alone")).toEqual({ top: "ses_alone", sessions: [], permissions: [], questions: [] })
  })

  test("reads every session of a tree past maxTotal, so the newest one's request is listed, and none past retention", async () => {
    const { ports } = await setUp()
    const children = childStore(ports.questions.storage as never)
    for (const index of [1, 2, 3]) await children.record({ ...entry(`ses_more_${index}`, "ses_root", `More ${index}`), createdAt: 2 + index })
    await children.record({ ...entry("ses_old", "ses_root", "Old"), createdAt: ports.questions.now() - RETENTION_MS - 1 })
    ;(ports.permissions as any) = () => [{ list: async ({ sessionID }: { sessionID: string }) => (sessionID === "ses_more_3" ? [{ id: "per_new", sessionID, action: "shell", resources: ["echo"] }] : []), reply: async () => undefined }]

    const read = await asks(ports, "ses_root")
    expect(read.sessions.map((session) => session.sessionID)).toEqual(["ses_a", "ses_b", "ses_more_1", "ses_more_2", "ses_more_3"])
    expect(read.permissions).toEqual([{ sessionID: "ses_more_3", requestID: "per_new", action: "shell", resources: ["echo"] }])
    expect(read).not.toHaveProperty("truncated")
  })

  test("its schemas take the listing, and refuse an input without a session", async () => {
    const { ports } = await setUp()
    const { input, output } = personRpc.methods.asks
    expect((await output["~standard"].validate(await asks(ports, "ses_root"))).issues).toBeUndefined()
    expect((await input["~standard"].validate({ wrong: 1 })).issues).toBeDefined()
  })
})

describe("the answer method", () => {
  test("passes the answers on as courier_answer does, and the parent hears it settled once", async () => {
    const { ports, store, told } = await setUp()

    expect(await answer(ports, { sessionID: "ses_a", requestID: "question_1", answers: [["Hi"]] })).toEqual({ answered: true, by: "message" })

    expect(told.map((item) => item.sessionID)).toEqual(["ses_a", "ses_root"])
    expect(told[1].text).toContain('answered="elsewhere" request="question_1"')
    expect(store.has("question/question_1")).toBe(false)
    expect(relayState.answered.has("question_1")).toBe(true)
    expect(await answer(ports, { sessionID: "ses_a", requestID: "question_1", answers: [["Hi"]] })).toEqual({ answered: false })
    expect(told).toHaveLength(2)
  })

  test("refused answers come back as a problem, not an error", async () => {
    const { ports, told } = await setUp()

    expect(await answer(ports, { sessionID: "ses_a", requestID: "question_1", answers: [] })).toEqual({
      answered: false,
      problem: "answers needs one entry per question, 1 in all, not 0.",
    })
    expect(told).toEqual([])
  })
})

test("registerPersonRpc serves both methods under its own id, beside the tree's", async () => {
  const { ports } = await setUp()
  const registered: { definition: any; handlers: any }[] = []
  await registerPersonRpc({ register: async (definition: any, handlers: any) => void registered.push({ definition, handlers }) } as never, ports)

  expect(registered.map(({ definition }) => [definition.id, Object.keys(definition.methods)])).toEqual([["courier-person", ["asks", "answer"]]])
  expect((await registered[0]!.handlers.asks({ sessionID: "ses_b" })).top).toBe("ses_root")
})

describe("a permission request or a form answered in the inbox, through OpenCode", () => {
  test("the parent told about the request is told once that it is settled", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    const state = fresh()
    await reportAsked(ports, state, asked())

    // OpenCode's permission.replied for the inbox's reply, seen by both of the hub's subscriptions.
    await reportReplied(ports, state, replied())
    await reportReplied(ports, state, replied())

    expect(sent.map((item) => item.text.match(/<courier [^>]*>/)![0])).toEqual([
      '<courier from="ses_child" asks="permission" request="per_1">',
      '<courier from="ses_child" answered="once" request="per_1">',
    ])
  })

  test("the parent told about the form is told once that it was answered", async () => {
    const { ports, sent } = fakePorts()
    await childStore(ports.storage).record(child())
    const state = fresh()
    await reportForm(ports, state, shown())

    await reportFormSettled(ports, state, settled())
    await reportFormSettled(ports, state, settled())

    expect(sent.map((item) => item.text.match(/<courier [^>]*>/)![0])).toEqual([
      '<courier from="ses_child" asks="form" form="frm_1" kind="websearch.provider">',
      '<courier from="ses_child" settled="answered" form="frm_1">',
    ])
  })
})
