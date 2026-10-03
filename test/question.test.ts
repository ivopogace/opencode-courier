import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import {
  answeredText,
  answerQuestion,
  forgetQuestions,
  formShown,
  MAX_STORED,
  noticeCutOff,
  pendingQuestions,
  questionNotice,
  relayQuestions,
  settledNotice,
  type Asked,
  type QuestionPorts,
} from "../src/question.js"
import { record, RETENTION_MS } from "../src/roster.js"

afterEach(() => forgetQuestions())

const greeting = [
  {
    question: "Which greeting?",
    header: "Greeting",
    options: ["Hello", "Hi", "Hey"].map((label) => ({ label, description: `Say ${label}` })),
  },
]
const toppings = [
  { question: "Which toppings?", header: "Toppings", options: [{ label: "Ham", description: "" }, { label: "Egg", description: "" }], multiple: true },
]

/**
 * OpenCode's question tool, as far as the relay sees it: the form is shown (form.created) once the
 * call starts, unless the call is refused first, and the call ends when the form is answered or
 * dismissed, or is interrupted, which cancels the form.
 */
function questionTool() {
  const forms = new Map<string, { sessionID: string; answer: (answers: string[][]) => void; dismiss: () => void }>()
  const cancelled: string[] = []
  const refused = new Set<string>()
  const execute = (input: any, context: any) =>
    Effect.gen(function* () {
      if (refused.has(context.sessionID)) return yield* Effect.fail({ _tag: "Tool.Error", message: "Permission denied: question" })
      const state = yield* Effect.callback<{ answers: string[][] } | { dismissed: true }>((resume) => {
        forms.set(context.id, {
          sessionID: context.sessionID,
          answer: (answers) => resume(Effect.succeed({ answers })),
          dismiss: () => resume(Effect.succeed({ dismissed: true as const })),
        })
        formShown({ data: { form: { sessionID: context.sessionID, metadata: { kind: "question", tool: { messageID: "msg", id: context.id } } } } })
      })
      forms.delete(context.id)
      if ("dismissed" in state)
        return yield* Effect.die(Object.assign(new Error("The user dismissed this question"), { _tag: "QuestionTool.CancelledError" }))
      return { output: { answers: state.answers }, content: answeredText(input.questions, state.answers), metadata: { answers: state.answers } }
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          if (forms.delete(context.id)) cancelled.push(context.id)
        }),
      ),
    )
  return { execute, forms, cancelled, refused }
}

let calls = 0
async function setUp() {
  const store = new Map<string, unknown>()
  const told: any[] = []
  let ids = 0
  const ports: QuestionPorts = {
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
    } as unknown as QuestionPorts["storage"],
    session: { synthetic: async (input: any) => (told.push(input), { id: `msg_${told.length}` }) } as unknown as QuestionPorts["session"],
    now: () => 1_000_000,
    newID: () => `question_${++ids}`,
    log: () => undefined,
  }
  await record(ports.storage, { sessionID: "ses_child", parentID: "ses_parent", title: "Fix the bug", directory: "/repo", isolated: false, createdAt: 1 })
  const tool = questionTool()
  const wrapped: { execute: any } = { execute: tool.execute }
  const host = {
    tool: {
      transform: (callback: (editor: any) => void) =>
        Effect.sync(() => {
          callback({ update: (id: string, update: (tool: any) => void) => id === "question" && update(wrapped) })
          return { dispose: Effect.void }
        }),
    },
  }
  let loaded = true
  await Effect.runPromise(relayQuestions(host as any, () => (loaded ? ports : undefined)) as any)
  const ask = (sessionID: string, questions: unknown = greeting) =>
    Effect.runFork(
      wrapped.execute({ questions }, { sessionID, agent: "build", messageID: "msg", id: `call_${++calls}`, progress: () => Effect.void }),
    ) as Fiber.Fiber<any, any>
  return { ports, store, told, tool, ask, unload: () => void (loaded = false) }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const exitOf = (fiber: Fiber.Fiber<any, any>) => Effect.runPromise(Fiber.await(fiber))
const formOf = (tool: ReturnType<typeof questionTool>, sessionID: string) => [...tool.forms.values()].find((form) => form.sessionID === sessionID)!
const notices = (told: any[], attribute: string) => told.filter((item) => item.text.includes(` ${attribute}=`))

describe("questionNotice", () => {
  const asked: Asked = { requestID: "question_1", sessionID: "ses_child", top: "ses_parent", title: "Fix the bug", questions: greeting, askedAt: 1 }

  test("lists the questions, tells the parent to ask the person, and gives them as the question tool takes them", () => {
    const notice = questionNotice(asked)

    expect(notice).toContain('This session, "Fix the bug", which you started with courier_spawn, asks the question below and waits')
    expect(notice).toContain("1. Greeting: Which greeting? (one of, or an answer of their own:)\n   - Hello: Say Hello\n")
    expect(notice).toContain("Do not answer it yourself. Ask the person you are working with, using your question tool with exactly these questions:")
    expect(notice).toContain(JSON.stringify({ questions: greeting }))
    expect(notice).toContain("What they choose there is passed on to the session.")
    expect(notice).toContain('call courier_answer with sessionID "ses_child", requestID "question_1" and answers')
  })

  test("says when the question was cut off, and names the session that started a child's child", () => {
    const notice = questionNotice({ ...asked, startedBy: "ses_mid" }, "stopped")

    expect(notice).toContain('"Fix the bug", which ses_mid started with courier_spawn, a session started from yours, was asking the question below when its turn was stopped')
    expect(notice).toContain("ended by OpenCode after an hour without activity")
    expect(notice).toContain("passed on to the session as a message, which wakes it")
  })

  test("a settled question says how, and that a dismissal ends the session's turn", () => {
    expect(settledNotice(asked, { by: "child", answers: [["Hi"]] })).toContain(
      'was answered in its own session (User has answered your questions: "Which greeting?"="Hi".',
    )
    const dismissed = settledNotice(asked, { by: "dismissed" })
    expect(dismissed).toContain("was dismissed in its own session, without an answer, so it no longer waits on you")
    expect(dismissed).toContain("message it with courier_send to have it carry on")
  })
})

describe("the question tool of a spawned session", () => {
  test("a session not started with courier_spawn asks as before, and nobody is told", async () => {
    const { tool, told, ask } = await setUp()

    const fiber = ask("ses_other")
    await settle()
    formOf(tool, "ses_other").answer([["Hi"]])

    const exit = await exitOf(fiber)
    expect(Exit.isSuccess(exit) && exit.value.content).toContain('"Which greeting?"="Hi"')
    expect(told).toEqual([])
  })

  test("a call refused before its form is shown is not relayed", async () => {
    const { tool, told, ask } = await setUp()
    tool.refused.add("ses_child")

    const exit = await exitOf(ask("ses_child"))
    await settle()

    expect(Exit.isFailure(exit)).toBe(true)
    expect(told).toEqual([])
  })

  test("the parent is told, and its courier_answer ends the child's call and withdraws the child's form", async () => {
    const { ports, store, told, tool, ask } = await setUp()

    const fiber = ask("ses_child")
    await settle()
    expect(told).toHaveLength(1)
    expect(told[0].sessionID).toBe("ses_parent")
    expect(told[0].delivery).toBe("steer")
    expect(told[0].text).toContain('<courier from="ses_child" asks="question" request="question_1">')
    expect(store.get("question/question_1")).toMatchObject({ sessionID: "ses_child", top: "ses_parent", questions: greeting })
    expect(await pendingQuestions(ports.storage, "ses_child")).toEqual([{ type: "question", requestID: "question_1", questions: greeting }])

    const answered = await answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] })
    expect(answered).toEqual({ sessionID: "ses_child", requestID: "question_1", answered: true, by: "result", answers: [["Hi"]] })
    const exit = await exitOf(fiber)
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      output: { answers: [["Hi"]] },
      content: 'User has answered your questions: "Which greeting?"="Hi". You can now continue with the user\'s answers in mind.',
    })
    expect(tool.cancelled).toHaveLength(1)
    await settle()
    expect(store.has("question/question_1")).toBe(false)
    expect(told).toHaveLength(1)
    expect(await pendingQuestions(ports.storage, "ses_child")).toEqual([])
    expect((await answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] })).answered).toBe(false)
  })

  test("courier_answer checks the caller and the answers", async () => {
    const { ports, ask } = await setUp()
    ask("ses_child", [...greeting, ...toppings])
    await settle()
    const input = { sessionID: "ses_child", requestID: "question_1" }

    await expect(answerQuestion(ports, "ses_x", { ...input, answers: ["Hi", []] })).rejects.toThrow(
      "ses_child's questions go to ses_parent, the session at the top",
    )
    await expect(answerQuestion(ports, "ses_parent", { ...input, answers: ["Hi"] })).rejects.toThrow(
      "answers needs one entry per question, 2 in all, not 1.",
    )
    await expect(answerQuestion(ports, "ses_parent", { ...input, answers: [["Hi", "Hey"], []] })).rejects.toThrow(
      'question 1 ("Greeting") takes one answer, not 2.',
    )
    await expect(answerQuestion(ports, "ses_parent", { sessionID: "ses_other", requestID: "question_1", answers: [] })).rejects.toThrow(
      "ses_other was not started with courier_spawn",
    )
    const answered = await answerQuestion(ports, "ses_parent", { ...input, answers: ["Something else", ["Ham", "Egg"]] })
    expect(answered.answered && answered.answers).toEqual([["Something else"], ["Ham", "Egg"]])
  })

  test("the parent asking the person the same is linked: their choice reaches the child, and the parent is told so", async () => {
    const { store, told, tool, ask } = await setUp()
    const child = ask("ses_child", toppings)
    await settle()

    const parent = ask("ses_parent", toppings)
    await settle()
    formOf(tool, "ses_parent").answer([["Ham", "Egg"]])

    const parentExit = await exitOf(parent)
    expect(Exit.isSuccess(parentExit) && parentExit.value.content).toContain(
      "These answers were passed on to session ses_child, which carries on with them; do not call courier_answer for question_1.",
    )
    expect(Exit.isSuccess(parentExit) && parentExit.value.metadata).toMatchObject({ answers: [["Ham", "Egg"]], relayed: "question_1", passed: true })
    const childExit = await exitOf(child)
    expect(Exit.isSuccess(childExit) && childExit.value.output).toEqual({ answers: [["Ham", "Egg"]] })
    expect(tool.cancelled).toHaveLength(1)
    await settle()
    expect(store.has("question/question_1")).toBe(false)
    expect(told).toHaveLength(1)
  })

  test("a parent that asks something else is not linked, and two children asking the same are linked one each", async () => {
    const { told, tool, ask } = await setUp()
    const first = ask("ses_child")
    await settle()
    const second = ask("ses_child")
    await settle()
    expect(notices(told, "asks")).toHaveLength(2)

    const other = ask("ses_parent", toppings)
    const one = ask("ses_parent")
    const two = ask("ses_parent")
    await settle()
    const parentForms = [...tool.forms.values()].filter((form) => form.sessionID === "ses_parent")
    parentForms[1]!.answer([["Hi"]])
    parentForms[2]!.answer([["Hey"]])

    expect([await exitOf(first), await exitOf(second)].map((exit) => Exit.isSuccess(exit) && exit.value.output)).toEqual([
      { answers: [["Hi"]] },
      { answers: [["Hey"]] },
    ])
    for (const fiber of [one, two]) expect((await exitOf(fiber)).toString()).toContain("passed on")
    parentForms[0]!.answer([["Ham"]])
    const unlinked = await exitOf(other)
    expect(Exit.isSuccess(unlinked) && unlinked.value.content).not.toContain("passed on")
  })

  test("answered in the child's own session: the parent's linked question is withdrawn", async () => {
    const { told, tool, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    const parent = ask("ses_parent")
    await settle()

    formOf(tool, "ses_child").answer([["Hey"]])

    expect(Exit.isSuccess(await exitOf(child))).toBe(true)
    const parentExit = await exitOf(parent)
    expect(Exit.isSuccess(parentExit) && parentExit.value.content).toContain(
      'Session ses_child no longer waits on this question: it was answered in its own session (User has answered your questions: "Which greeting?"="Hey".',
    )
    expect(tool.cancelled).toHaveLength(1)
    expect(tool.forms.size).toBe(0)
    await settle()
    expect(notices(told, "answered")).toEqual([])
  })

  test("answered in the child's own session with no question open in the parent: the parent is told it is settled", async () => {
    const { told, tool, ask, store } = await setUp()
    const child = ask("ses_child")
    await settle()

    formOf(tool, "ses_child").answer([["Hey"]])
    await exitOf(child)
    await settle()

    const settled = notices(told, "answered")
    expect(settled).toHaveLength(1)
    expect(settled[0].text).toContain('<courier from="ses_child" answered="elsewhere" request="question_1">')
    expect(store.has("question/question_1")).toBe(false)
  })

  test("dismissed in the child's own session: the child's turn ends as OpenCode's does, and the parent is told", async () => {
    const { told, tool, ask } = await setUp()
    const child = ask("ses_child")
    await settle()

    formOf(tool, "ses_child").dismiss()
    const exit = await exitOf(child)
    await settle()

    expect(Exit.isFailure(exit)).toBe(true)
    expect(notices(told, "answered")[0].text).toContain('answered="dismissed" request="question_1"')
  })

  test("dismissed in the parent's linked question: the child is told so and carries on, and the parent's call fails as OpenCode's does", async () => {
    const { told, tool, ask, store } = await setUp()
    const child = ask("ses_child")
    await settle()
    const parent = ask("ses_parent")
    await settle()

    formOf(tool, "ses_parent").dismiss()

    expect(Exit.isFailure(await exitOf(parent))).toBe(true)
    const childExit = await exitOf(child)
    expect(Exit.isSuccess(childExit) && childExit.value).toMatchObject({
      output: { answers: [[]] },
      content: expect.stringContaining("The person dismissed this question without answering it. Carry on without the answers"),
    })
    await settle()
    expect(store.size).toBe(1)
    expect(notices(told, "answered")).toEqual([])
  })

  test("a child whose turn is stopped while it asks: the question stays, the parent is told, and the answer goes as a message", async () => {
    const { ports, store, told, tool, ask } = await setUp()
    const child = ask("ses_child")
    await settle()

    // What an interrupt does, from the person or from OpenCode's sweep after an hour without activity.
    await Effect.runPromise(Fiber.interrupt(child))
    await settle()

    expect(tool.cancelled).toHaveLength(1)
    expect(store.has("question/question_1")).toBe(true)
    const stopped = notices(told, "stopped")
    expect(stopped).toHaveLength(1)
    expect(stopped[0].text).toContain('<courier from="ses_child" asks="question" request="question_1" stopped="true">')
    expect(await pendingQuestions(ports.storage, "ses_child")).toEqual([{ type: "question", requestID: "question_1", questions: greeting, stopped: true }])

    // A new instance loading in the same process does not tell the parent again.
    await noticeCutOff(ports)
    expect(told).toHaveLength(2)

    const answered = await answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] })
    expect(answered).toMatchObject({ answered: true, by: "message" })
    expect(told.at(-1)).toMatchObject({ sessionID: "ses_child", delivery: "steer" })
    expect(told.at(-1).text).toContain('<courier from="ses_parent" answers="question_1">\nYour question question_1 was cut off before it was answered')
    expect(told.at(-1).text).toContain('"Which greeting?"="Hi"')
    expect(store.has("question/question_1")).toBe(false)
  })

  test("a child stopped while the parent asks the person: their answer still goes on, as a message", async () => {
    const { told, tool, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    const parent = ask("ses_parent")
    await settle()

    await Effect.runPromise(Fiber.interrupt(child))
    await settle()
    expect(notices(told, "stopped")).toEqual([])
    formOf(tool, "ses_parent").answer([["Hello"]])

    const parentExit = await exitOf(parent)
    expect(Exit.isSuccess(parentExit) && parentExit.value.content).toContain(
      "passed on to session ses_child as a message, since its question had been cut off",
    )
    expect(told.at(-1).text).toContain('answers="question_1"')
  })

  test("stopped on both sides, as OpenCode's sweep does to one location: the parent is told once both have stopped", async () => {
    const { told, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    const parent = ask("ses_parent")
    await settle()

    await Effect.runPromise(Fiber.interrupt(child))
    await Effect.runPromise(Fiber.interrupt(parent))
    await settle()

    expect(notices(told, "stopped")).toHaveLength(1)
  })

  test("a location closing withdraws both forms as if dismissed: the question is kept, and the next load tells the parent", async () => {
    const { ports, store, told, tool, ask, unload } = await setUp()
    const child = ask("ses_child")
    await settle()
    const parent = ask("ses_parent")
    await settle()

    // What a server shutdown does at 0.0.0-beta-19271: the plugin unloads, then every open form goes.
    unload()
    formOf(tool, "ses_child").dismiss()
    formOf(tool, "ses_parent").dismiss()
    await exitOf(child)
    await exitOf(parent)
    await settle()

    expect(told).toHaveLength(1)
    expect(store.has("question/question_1")).toBe(true)
    forgetQuestions()
    await noticeCutOff(ports)
    expect(told.at(-1).text).toContain('asks="question" request="question_1" restarted="true"')
  })

  test("a question of a child's child goes to the session at the top, which alone answers it", async () => {
    const { ports, told, tool, ask } = await setUp()
    await record(ports.storage, { sessionID: "ses_grandchild", parentID: "ses_child", title: "Sub task", directory: "/repo", isolated: false, createdAt: 2 })
    const grandchild = ask("ses_grandchild")
    await settle()

    expect(told[0].sessionID).toBe("ses_parent")
    expect(told[0].text).toContain('"Sub task", which ses_child started with courier_spawn, a session started from yours')
    await expect(
      answerQuestion(ports, "ses_child", { sessionID: "ses_grandchild", requestID: "question_1", answers: ["Hi"] }),
    ).rejects.toThrow("ses_grandchild's questions go to ses_parent")
    // The middle session asking the same is itself relayed to the top, not linked to its child's question.
    const middle = ask("ses_child")
    await settle()
    expect(told.filter((item) => item.text.includes(' asks="question"')).map((item) => item.sessionID)).toEqual(["ses_parent", "ses_parent"])

    const parent = ask("ses_parent")
    await settle()
    formOf(tool, "ses_parent").answer([["Hey"]])
    const grandchildExit = await exitOf(grandchild)
    expect(Exit.isSuccess(grandchildExit) && grandchildExit.value.output).toEqual({ answers: [["Hey"]] })
    await exitOf(parent)
    await Effect.runPromise(Fiber.interrupt(middle))
  })
})

describe("noticeCutOff", () => {
  test("tells the parent about a question a restart cut off, once, and drops stale ones", async () => {
    const { ports, store, told } = await setUp()
    const asked = (requestID: string, extra: Partial<Asked> = {}): Asked => ({
      requestID,
      sessionID: "ses_child",
      top: "ses_parent",
      title: "Fix the bug",
      questions: greeting,
      askedAt: 1_000_000,
      ...extra,
    })
    store.set("question/question_a", asked("question_a"))
    store.set("question/question_old", asked("question_old", { askedAt: 1_000_000 - RETENTION_MS - 1 }))
    store.set("question/question_gone", asked("question_gone", { sessionID: "ses_unknown" }))

    await noticeCutOff(ports)
    await noticeCutOff(ports)

    expect(told).toHaveLength(1)
    expect(told[0].sessionID).toBe("ses_parent")
    expect(told[0].text).toContain('<courier from="ses_child" asks="question" request="question_a" restarted="true">')
    expect(told[0].text).toContain("when the OpenCode server restarted")
    expect([...store.keys()].filter((key) => key.startsWith("question/"))).toEqual(["question/question_a"])
    const answered = await answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_a", answers: [["Hi"]] })
    expect(answered).toMatchObject({ answered: true, by: "message" })
  })

  test(`keeps at most ${MAX_STORED} questions, the newest`, async () => {
    const { ports, store } = await setUp()
    for (let i = 0; i < MAX_STORED + 5; i++)
      store.set(`question/question_${i}x`, { requestID: `question_${i}x`, sessionID: "ses_child", top: "ses_parent", title: "t", questions: greeting, askedAt: 1_000_000 - i })

    await noticeCutOff(ports)

    const kept = [...store.keys()].filter((key) => key.startsWith("question/"))
    expect(kept).toHaveLength(MAX_STORED)
    expect(kept).not.toContain(`question/question_${MAX_STORED}x`)
  })
})
