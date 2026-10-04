import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import {
  answeredText,
  answerQuestion,
  forgetQuestions,
  joinRelay,
  formShown,
  locationClosing,
  eventsFollowed,
  eventsLeft,
  MAX_STORED,
  noticeCutOff,
  pendingQuestions,
  questionNotice,
  relayQuestions,
  settledNotice,
  timing,
  type Asked,
  type QuestionPorts,
} from "../src/question.js"
import { record, RETENTION_MS } from "../src/roster.js"

let showForms = true
const formShownOff = () => {
  showForms = false
  return { restore: () => void (showForms = true) }
}
afterEach(() => {
  forgetQuestions()
  timing.closingGraceMs = 30_000
  timing.passingWaitMs = 30_000
  timing.relayWaitMs = 30_000
  timing.dismissalGraceMs = 2_000
  showForms = true
})

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
        if (showForms) formShown({ data: { form: { sessionID: context.sessionID, metadata: { kind: "question", tool: { messageID: "msg", id: context.id } } } } })
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
    session: {
      synthetic: async (input: any) => (told.push(input), { id: `msg_${told.length}` }),
      get: async () => ({ location: { directory: "/repo" } }),
    } as unknown as QuestionPorts["session"],
    directory: "/repo",
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
  // A dismissal is taken at once, unless a test holds it to see a location close.
  timing.dismissalGraceMs = 0
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
    // The location loads again in the same process, or after a restart.
    await noticeCutOff(ports)
    expect(told.at(-1).text).toContain('asks="question" request="question_1" restarted="true"')
  })

  test("a location closing withdraws both forms first and reports its shutdown right after: the question is kept, and the next load tells the parent", async () => {
    const { ports, store, told, tool, ask, unload } = await setUp()
    timing.dismissalGraceMs = 200
    const child = ask("ses_child")
    await settle()
    const parent = ask("ses_parent")
    await settle()

    // What a server shutdown does at 2.0.22: every open form goes, then `location.shutdown`, then the plugin unloads.
    formOf(tool, "ses_child").dismiss()
    formOf(tool, "ses_parent").dismiss()
    await settle()
    locationClosing("/repo")
    unload()
    expect(Exit.isFailure(await exitOf(child))).toBe(true)
    expect(Exit.isFailure(await exitOf(parent))).toBe(true)
    await settle()

    expect(told).toHaveLength(1)
    expect(store.has("question/question_1")).toBe(true)
    await noticeCutOff(ports)
    expect(told.at(-1).text).toContain('asks="question" request="question_1" restarted="true"')
  })

  test("a location's shutdown reported within the grace, before or after the dismissal, makes it a cut-off; another location's does not", async () => {
    const { store, told, tool, ask } = await setUp()
    timing.dismissalGraceMs = 100
    const first = ask("ses_child")
    await settle()
    locationClosing("/repo")
    formOf(tool, "ses_child").dismiss()
    await exitOf(first)
    await settle()
    expect(notices(told, "answered")).toEqual([])
    expect(store.has("question/question_1")).toBe(true)

    forgetQuestions()
    const second = ask("ses_child")
    await settle()
    formOf(tool, "ses_child").dismiss()
    await exitOf(second)
    await settle()
    locationClosing("/elsewhere")
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(notices(told, "answered")[0].text).toContain('answered="dismissed" request="question_2"')
    expect(store.has("question/question_2")).toBe(false)

    const third = ask("ses_child")
    await settle()
    formOf(tool, "ses_child").dismiss()
    await exitOf(third)
    await settle()
    locationClosing("/repo")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(notices(told, "answered")).toHaveLength(1)
    expect(store.has("question/question_3")).toBe(true)
  })

  test("a dismissal that no shutdown follows within the grace is the person's", async () => {
    const { told, tool, ask, store } = await setUp()
    timing.dismissalGraceMs = 50
    const child = ask("ses_child")
    await settle()

    formOf(tool, "ses_child").dismiss()
    await exitOf(child)
    await settle()
    expect(notices(told, "answered")).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(notices(told, "answered")[0].text).toContain('answered="dismissed" request="question_1"')
    expect(store.has("question/question_1")).toBe(false)
  })

  test("a shutdown reported without a location counts for every location", async () => {
    const { store, told, tool, ask } = await setUp()
    timing.dismissalGraceMs = 100
    const child = ask("ses_child")
    await settle()
    formOf(tool, "ses_child").dismiss()
    await exitOf(child)
    await settle()
    locationClosing()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(notices(told, "answered")).toEqual([])
    expect(store.has("question/question_1")).toBe(true)
  })

  test("a location loading again within the grace forgets its shutdown: a dismissal there is the person's", async () => {
    const { ports, store, told, tool, ask } = await setUp()
    timing.dismissalGraceMs = 100
    locationClosing("/repo")
    locationClosing()
    const leave = joinRelay(ports)
    const child = ask("ses_child")
    await settle()
    formOf(tool, "ses_child").dismiss()
    await exitOf(child)
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(notices(told, "answered")[0].text).toContain('answered="dismissed" request="question_1"')
    expect(store.has("question/question_1")).toBe(false)
    leave()
  })

  test("a location closing while OpenCode keeps running: an instance still loaded tells the parent a little later", async () => {
    const { ports, told, tool, ask, unload } = await setUp()
    timing.closingGraceMs = 30
    const elsewhere: any[] = []
    const leave = joinRelay({ ...ports, session: { synthetic: async (input: any) => (elsewhere.push(input), { id: "msg" }) } as any })
    const child = ask("ses_child")
    await settle()

    unload()
    formOf(tool, "ses_child").dismiss()
    await exitOf(child)
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(told).toHaveLength(1)
    expect(elsewhere).toHaveLength(1)
    expect(elsewhere[0]).toMatchObject({ sessionID: "ses_parent" })
    expect(elsewhere[0].text).toContain('request="question_1" restarted="true"')
    leave()
  })

  test("the top session's answer that arrives as the child's turn is stopped still reaches it", async () => {
    const { ports, told, ask } = await setUp()
    const child = ask("ses_child")
    await settle()

    const stopping = Effect.runPromise(Fiber.interrupt(child))
    const answered = await answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] })
    await stopping
    const exit = await exitOf(child)
    await settle()

    // Whichever way it went, the child has the answer, and the parent was told the truth.
    expect(answered).toMatchObject({ answered: true })
    if (answered.answered && answered.by === "result") expect(Exit.isSuccess(exit) && exit.value.output).toEqual({ answers: [["Hi"]] })
    else {
      expect(Exit.isFailure(exit)).toBe(true)
      expect(told.filter((item) => item.sessionID === "ses_child").map((item) => item.text)).toEqual([
        expect.stringContaining('"Which greeting?"="Hi"'),
      ])
    }
  })

  test("on load, a cut-off question this process knows is dropped once its child is off the roster", async () => {
    const { ports, store, told, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    await Effect.runPromise(Fiber.interrupt(child))
    await settle()
    store.delete("roster/ses_parent/ses_child")

    await noticeCutOff(ports)

    expect(store.has("question/question_1")).toBe(false)
    expect(await pendingQuestions(ports.storage, "ses_child")).toEqual([])
    expect(told).toHaveLength(2)
  })

  test("an answer sent whose stored question could not be dropped is not sent again", async () => {
    const { ports, store, told, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    await Effect.runPromise(Fiber.interrupt(child))
    await settle()
    ;(ports.storage as any).remove = async () => {
      throw new Error("disk full")
    }
    const input = { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] }

    expect(await answerQuestion(ports, "ses_parent", input)).toMatchObject({ answered: true, by: "message" })
    expect(store.has("question/question_1")).toBe(true)
    expect(await answerQuestion(ports, "ses_parent", input)).toMatchObject({ answered: false })
    expect(told.filter((item) => item.sessionID === "ses_child")).toHaveLength(1)
  })

  test("a child asking the same while the parent's question is already open: the parent is told how to pass the answer on", async () => {
    const { tool, ask } = await setUp()
    const parent = ask("ses_parent")
    await settle()
    const child = ask("ses_child")
    await settle()

    formOf(tool, "ses_parent").answer([["Hi"]])

    const parentExit = await exitOf(parent)
    expect(Exit.isSuccess(parentExit) && parentExit.value.content).toContain(
      'If you asked this for session ses_child (requestID "question_1"), these answers were not passed on by themselves',
    )
    await Effect.runPromise(Fiber.interrupt(child))
  })

  test("the parent listing the same options in another order is linked all the same", async () => {
    const { tool, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    const reordered = [{ ...greeting[0]!, options: [...greeting[0]!.options].reverse() }]

    const parent = ask("ses_parent", reordered)
    await settle()
    formOf(tool, "ses_parent").answer([["Hey"]])

    const parentExit = await exitOf(parent)
    expect(Exit.isSuccess(parentExit) && parentExit.value.metadata).toMatchObject({ relayed: "question_1", passed: true })
    const childExit = await exitOf(child)
    expect(Exit.isSuccess(childExit) && childExit.value.output).toEqual({ answers: [["Hey"]] })
  })

  test("the parent's own question with the same choices but other words is not linked", async () => {
    const { tool, ask } = await setUp()
    const yesNo = (question: string) => [{ question, header: "Confirm", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }] }]
    const child = ask("ses_child", yesNo("Delete the old branch?"))
    await settle()

    const parent = ask("ses_parent", yesNo("Push to main now?"))
    await settle()
    formOf(tool, "ses_parent").answer([["Yes"]])

    const parentExit = await exitOf(parent)
    // Not linked, but told how to pass the answers on, should it have asked for the child after all.
    expect(Exit.isSuccess(parentExit) && parentExit.value.content).toContain(
      'If you asked this for session ses_child (requestID "question_1"), these answers were not passed on by themselves: pass them on with courier_answer.',
    )
    expect(Exit.isSuccess(parentExit) && parentExit.value.metadata.passed).toBeUndefined()
    expect(formOf(tool, "ses_child")).toBeDefined()
    // Asked again with the same words, differently spaced and cased, it is.
    const again = ask("ses_parent", yesNo("delete  the old branch?"))
    await settle()
    formOf(tool, "ses_parent").answer([["No"]])
    const childExit = await exitOf(child)
    expect(Exit.isSuccess(childExit) && childExit.value.output).toEqual({ answers: [["No"]] })
    await exitOf(again)
  })

  test("answered in the child's session while the parent is being told: the notices keep their order and nothing is left stored", async () => {
    const { ports, store, told, tool, ask } = await setUp()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const synthetic = ports.session.synthetic
    ;(ports.session as any).synthetic = async (input: any) => {
      if (input.text.includes(' asks="question"')) await held
      return synthetic(input)
    }
    const child = ask("ses_child")
    await settle()

    formOf(tool, "ses_child").answer([["Hi"]])
    await settle()
    expect(told).toEqual([])
    release()
    await exitOf(child)
    await settle()

    expect(told.map((item) => (item.text.includes(' asks="question"') ? "asks" : "answered"))).toEqual(["asks", "answered"])
    expect(store.has("question/question_1")).toBe(false)
  })

  test("a cut-off question answered twice at once is passed on once", async () => {
    const { ports, told, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    await Effect.runPromise(Fiber.interrupt(child))
    await settle()
    const input = { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] }

    const both = await Promise.all([answerQuestion(ports, "ses_parent", input), answerQuestion(ports, "ses_parent", input)])

    expect(both.map((result) => result.answered).sort()).toEqual([false, true])
    expect(told.filter((item) => item.sessionID === "ses_child")).toHaveLength(1)
  })

  test("a second answer to a cut-off question waits for the first, and goes on when the first could not be sent", async () => {
    const { ports, told, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    await Effect.runPromise(Fiber.interrupt(child))
    await settle()
    const synthetic = ports.session.synthetic
    let fail!: () => void
    ;(ports.session as any).synthetic = (input: any) =>
      new Promise((_, reject) => (fail = () => reject(new Error("server busy")))).finally(() => ((ports.session as any).synthetic = synthetic)) as any
    const input = { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] }

    const first = answerQuestion(ports, "ses_parent", input)
    await settle()
    const second = answerQuestion(ports, "ses_parent", { ...input, answers: ["Hey"] })
    await settle()
    fail()

    await expect(first).rejects.toThrow("server busy")
    expect(await second).toMatchObject({ answered: true, by: "message" })
    expect(told.filter((item) => item.sessionID === "ses_child").map((item) => item.text)).toEqual([expect.stringContaining('"Which greeting?"="Hey"')])
  })

  test("an answer does not wait for ever behind one that hangs", async () => {
    const { ports, told, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    await Effect.runPromise(Fiber.interrupt(child))
    await settle()
    timing.passingWaitMs = 30
    const synthetic = ports.session.synthetic
    ;(ports.session as any).synthetic = () => {
      ;(ports.session as any).synthetic = synthetic
      return new Promise(() => undefined)
    }
    const input = { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] }

    void answerQuestion(ports, "ses_parent", input)
    await new Promise((resolve) => setTimeout(resolve, 5))
    // Behind it, an answer waits until the hung one gives way, and then goes through.
    expect(await answerQuestion(ports, "ses_parent", { ...input, answers: ["Hey"] })).toMatchObject({ answered: true, by: "message" })
    expect(told.at(-1).text).toContain('"Which greeting?"="Hey"')
  })

  test("a question whose parent could not be told is still listed, and an answer still reaches it", async () => {
    const { ports, store, told, ask } = await setUp()
    const synthetic = ports.session.synthetic
    ;(ports.session as any).synthetic = async () => {
      throw new Error("server busy")
    }
    const child = ask("ses_child")
    await settle()
    ;(ports.session as any).synthetic = synthetic

    expect(told).toEqual([])
    expect(store.has("question/question_1")).toBe(true)
    expect(await pendingQuestions(ports.storage, "ses_child")).toEqual([{ type: "question", requestID: "question_1", questions: greeting }])
    expect(await answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] })).toMatchObject({
      answered: true,
      by: "result",
    })
    const exit = await exitOf(child)
    expect(Exit.isSuccess(exit) && exit.value.output).toEqual({ answers: [["Hi"]] })
  })

  test("on load, a stored question whose answer already went out in this process is dropped, not told about", async () => {
    const { ports, store, told, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    await Effect.runPromise(Fiber.interrupt(child))
    await settle()
    const remove = ports.storage.remove
    ;(ports.storage as any).remove = async () => {
      throw new Error("disk full")
    }
    const set = ports.storage.set
    ;(ports.storage as any).set = async () => {
      throw new Error("disk full")
    }
    await answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] })
    ;(ports.storage as any).remove = remove
    ;(ports.storage as any).set = set
    const before = told.length

    await noticeCutOff(ports)

    expect(store.has("question/question_1")).toBe(false)
    expect(told).toHaveLength(before)
  })

  test("a call whose form.created was missed while no event stream was up is relayed once one is back", async () => {
    const { told, ask } = await setUp()
    expect(eventsFollowed()).toBe(false)
    const other = eventsFollowed()
    eventsLeft()
    formShownOff()
    const child = ask("ses_child")
    await settle()
    // Another instance still follows the events, so nothing was missed.
    expect(eventsFollowed()).toBe(false)
    eventsLeft()
    eventsLeft()
    expect(told).toEqual([])

    expect(eventsFollowed()).toBe(true)
    await settle()

    expect(other).toBe(false)
    expect(told[0].text).toContain('asks="question"')
    await Effect.runPromise(Fiber.interrupt(child))
  })

  test("an answer to a cut-off question that could not be sent can be passed on again", async () => {
    const { ports, store, told, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    await Effect.runPromise(Fiber.interrupt(child))
    await settle()
    const synthetic = ports.session.synthetic
    ;(ports.session as any).synthetic = async () => {
      throw new Error("server busy")
    }
    const input = { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] }

    await expect(answerQuestion(ports, "ses_parent", input)).rejects.toThrow("server busy")
    expect(store.has("question/question_1")).toBe(true)
    ;(ports.session as any).synthetic = synthetic
    expect(await answerQuestion(ports, "ses_parent", input)).toMatchObject({ answered: true, by: "message" })
    expect(told.at(-1).sessionID).toBe("ses_child")
  })

  test("the top session's answer reaches the call while the notice to the parent hangs, and the record goes once that gives way", async () => {
    const { ports, store, tool, ask } = await setUp()
    timing.relayWaitMs = 30
    const synthetic = ports.session.synthetic
    ;(ports.session as any).synthetic = () => new Promise(() => undefined)
    const child = ask("ses_child")
    await settle()
    expect(store.has("question/question_1")).toBe(true)

    const answered = await answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] })

    expect(answered).toMatchObject({ answered: true, by: "result" })
    const exit = await exitOf(child)
    expect(Exit.isSuccess(exit) && exit.value.output).toEqual({ answers: [["Hi"]] })
    expect(tool.cancelled).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(store.has("question/question_1")).toBe(false)
    ;(ports.session as any).synthetic = synthetic
  })

  test("a question whose record could not be stored is answered all the same after its call was cut off", async () => {
    const { ports, store, told, ask } = await setUp()
    const set = ports.storage.set
    ;(ports.storage as any).set = async (key: string, value: unknown) => {
      if (key.startsWith("question/")) throw new Error("disk full")
      return set.call(ports.storage, key, value as never)
    }
    const child = ask("ses_child")
    await settle()
    expect(told).toEqual([])
    expect(store.has("question/question_1")).toBe(false)

    await Effect.runPromise(Fiber.interrupt(child))
    await settle()

    expect(notices(told, "stopped")).toHaveLength(1)
    expect(await pendingQuestions(ports.storage, "ses_child")).toEqual([{ type: "question", requestID: "question_1", questions: greeting, stopped: true }])
    const answered = await answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] })
    expect(answered).toMatchObject({ answered: true, by: "message" })
    expect(told.filter((item) => item.sessionID === "ses_child").map((item) => item.text)).toEqual([expect.stringContaining('"Which greeting?"="Hi"')])
    expect(await pendingQuestions(ports.storage, "ses_child")).toEqual([])
  })

  test("a question the parent could not be told about is not reported settled to it", async () => {
    const { ports, store, told, tool, ask } = await setUp()
    const synthetic = ports.session.synthetic
    ;(ports.session as any).synthetic = async () => {
      throw new Error("server busy")
    }
    const child = ask("ses_child")
    await settle()
    ;(ports.session as any).synthetic = synthetic

    formOf(tool, "ses_child").answer([["Hey"]])
    await exitOf(child)
    await settle()

    expect(told).toEqual([])
    expect(store.has("question/question_1")).toBe(false)
  })

  test("a question whose answer is being passed on is not listed", async () => {
    const { ports, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    await Effect.runPromise(Fiber.interrupt(child))
    await settle()
    const synthetic = ports.session.synthetic
    let release!: () => void
    ;(ports.session as any).synthetic = () => new Promise<void>((resolve) => (release = resolve)).then(() => ({ id: "msg" }))

    const answering = answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] })
    await settle()

    expect(await pendingQuestions(ports.storage, "ses_child")).toEqual([])
    release()
    expect(await answering).toMatchObject({ answered: true, by: "message" })
    ;(ports.session as any).synthetic = synthetic
  })

  test("a cut-off notice that could not be sent is sent on the next load", async () => {
    const { ports, told, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    const synthetic = ports.session.synthetic
    ;(ports.session as any).synthetic = async () => {
      throw new Error("server busy")
    }
    await Effect.runPromise(Fiber.interrupt(child))
    await settle()
    ;(ports.session as any).synthetic = synthetic
    expect(notices(told, "stopped")).toHaveLength(0)

    await noticeCutOff(ports)

    expect(notices(told, "restarted")).toHaveLength(1)
  })

  test("an answer arriving as the child answers in its own session is not sent on while the record is being dropped", async () => {
    const { ports, store, told, tool, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    const remove = ports.storage.remove
    ;(ports.storage as any).remove = (key: string) =>
      new Promise((resolve) => setTimeout(resolve, 30)).then(() => remove.call(ports.storage, key))
    formOf(tool, "ses_child").answer([["Hey"]])
    await exitOf(child)

    const answered = await answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] })

    expect(answered).toMatchObject({ answered: false })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(store.has("question/question_1")).toBe(false)
    expect(told.filter((item) => item.sessionID === "ses_child")).toEqual([])
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
    expect(told[0].text).toContain("when OpenCode restarted, or closed the session's project")
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
