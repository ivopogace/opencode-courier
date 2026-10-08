import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import {
  byCodeUnit,
  answerQuestion,
  joinRelay,
  formShown,
  locationClosing,
  eventsFollowed,
  eventsLeft,
  MAX_STORED,
  noticeCutOff,
  pendingQuestions,
  relayQuestions,
  type QuestionPorts,
  type QuestionTiming,
} from "../src/question/index.js"
import { hub, join, resetHub, type Member } from "../src/hub.js"
import { anyLoaded } from "../src/question/shared.js"
import { background, run, stopRelay, useClock } from "../src/question/runtime.js"
import { answeredText, questionNotice, questionSettledNotice as settledNotice, type Asked } from "../src/notices.js"
import { record, RETENTION_MS } from "../src/roster.js"

let showForms = true
const formShownOff = () => {
  showForms = false
  return { restore: () => void (showForms = true) }
}
afterEach(async () => {
  await stopRelay()
  resetHub()
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
  const forms = new Map<string, { sessionID: string; answer: (answers: string[][]) => void; dismiss: () => void; fail: (message: string) => void }>()
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
          fail: (message) => {
            forms.delete(context.id)
            resume(Effect.die(new Error(message)))
          },
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
/**
 * A relay in one location, with its own timings, and a `TestClock`, which only a test moves
 * (`advance`), read by the relay's ports and run by its fibers alike: a dismissal is taken at once,
 * unless a test holds it to see a location close.
 */
async function setUp(timings: Partial<QuestionTiming> = {}) {
  const clock = Effect.runSync(Effect.scoped(TestClock.make()))
  await Effect.runPromise(clock.setTime(1_000_000))
  useClock(clock)
  const timing: QuestionTiming = { closingGraceMs: 30_000, passingWaitMs: 30_000, relayWaitMs: 30_000, dismissalGraceMs: 0, ...timings }
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
    directory: "/repo",
    now: () => clock.currentTimeMillisUnsafe(),
    timing,
    newID: () => `question_${++ids}`,
    log: () => undefined,
  }
  await record(ports.storage, { sessionID: "ses_child", parentID: "ses_parent", title: "Fix the bug", directory: "/repo", isolated: false, createdAt: 1 })
  const tool = questionTool()
  const wrapped: { execute: any } = { execute: tool.execute }
  const host = {
    location: { directory: "/repo" },
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
  // OpenCode's `location.shutdown` for `directory`, as the watcher reports it, by this clock.
  const shutDown = (directory?: string) => locationClosing(clock.currentTimeMillisUnsafe(), directory)
  // Moves the clock on, which ends the relay's waits that fall due, and lets what follows them run.
  const advance = async (ms: number) => {
    await Effect.runPromise(clock.adjust(ms))
    await settle()
  }
  return { ports, advance, store, told, tool, ask, shutDown, unload: () => void (loaded = false) }
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
    expect([...store.keys()].sort()).toEqual(["roster-by-child/ses_child", "roster/ses_parent/ses_child"])
    expect(notices(told, "answered")).toEqual([])
  })

  test("dismissed in the child's own session while the parent asks the person: the parent's linked question is withdrawn", async () => {
    const { told, tool, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    const parent = ask("ses_parent")
    await settle()

    formOf(tool, "ses_child").dismiss()

    expect(Exit.isFailure(await exitOf(child))).toBe(true)
    const parentExit = await exitOf(parent)
    expect(Exit.isSuccess(parentExit) && parentExit.value).toMatchObject({
      output: { answers: [[]] },
      content: expect.stringContaining(
        "Session ses_child no longer waits on this question: it was dismissed in its own session, which ends its turn; message it with courier_send if it should carry on.",
      ),
      metadata: { relayed: "question_1", withdrawn: true },
    })
    await settle()
    expect(notices(told, "answered")).toEqual([])
  })

  test("a child's question call that fails: the parent's linked question is withdrawn, or the parent is told", async () => {
    const { told, tool, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    const parent = ask("ses_parent")
    await settle()

    formOf(tool, "ses_child").fail("form lost")

    expect(Exit.isFailure(await exitOf(child))).toBe(true)
    const parentExit = await exitOf(parent)
    expect(Exit.isSuccess(parentExit) && parentExit.value.content).toContain(
      "Session ses_child no longer waits on this question: it was ended: its question call failed (Error: form lost).",
    )

    const again = ask("ses_child")
    await settle()
    formOf(tool, "ses_child").fail("form lost")
    expect(Exit.isFailure(await exitOf(again))).toBe(true)
    await settle()
    const settled = notices(told, "answered")
    expect(settled).toHaveLength(1)
    expect(settled[0].text).toContain('answered="failed" request="question_2"')
    expect(settled[0].text).toContain("was ended without an answer: its question call failed (Error: form lost)")
  })

  test("courier_answer while the parent asks the person: the parent's linked question is withdrawn, naming the answers", async () => {
    const { ports, store, told, tool, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    const parent = ask("ses_parent")
    await settle()

    const answered = await answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] })

    expect(answered).toMatchObject({ answered: true, by: "result", answers: [["Hi"]] })
    const childExit = await exitOf(child)
    expect(Exit.isSuccess(childExit) && childExit.value.output).toEqual({ answers: [["Hi"]] })
    const parentExit = await exitOf(parent)
    expect(Exit.isSuccess(parentExit) && parentExit.value).toMatchObject({
      output: { answers: [["Hi"]] },
      content:
        'Session ses_child no longer waits on this question: it was already answered with courier_answer (User has answered your questions: "Which greeting?"="Hi". You can now continue with the user\'s answers in mind.). There is nothing to pass on; tell the person it is settled.',
      metadata: { relayed: "question_1", withdrawn: true },
    })
    // Both forms are gone, and nothing more is said or kept.
    expect(tool.cancelled).toHaveLength(2)
    expect(tool.forms.size).toBe(0)
    await settle()
    expect(store.has("question/question_1")).toBe(false)
    expect(told).toHaveLength(1)
    expect((await answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hey"] })).answered).toBe(false)
  })

  test("courier_answer to a cut-off question while the parent asks the person: the parent's question is withdrawn, and the child gets one message", async () => {
    const { ports, told, tool, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    const parent = ask("ses_parent")
    await settle()
    await Effect.runPromise(Fiber.interrupt(child))
    await settle()

    const answered = await answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hey"] })

    expect(answered).toMatchObject({ answered: true, by: "message" })
    const parentExit = await exitOf(parent)
    expect(Exit.isSuccess(parentExit) && parentExit.value).toMatchObject({
      output: { answers: [["Hey"]] },
      content: expect.stringContaining("it was already answered with courier_answer ("),
      metadata: { relayed: "question_1", withdrawn: true },
    })
    expect(tool.forms.size).toBe(0)
    await settle()
    const messages = told.filter((item) => item.sessionID === "ses_child")
    expect(messages).toHaveLength(1)
    expect(messages[0].text).toContain('"Which greeting?"="Hey"')
    expect(notices(told, "stopped")).toEqual([])
    expect((await answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] })).answered).toBe(false)
  })

  test("a pick in the parent's question that lands while courier_answer's answer is still going out is not passed on, and the note says so", async () => {
    const { ports, told, tool, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    const parent = ask("ses_parent")
    await settle()
    await Effect.runPromise(Fiber.interrupt(child))
    await settle()
    const synthetic = ports.session.synthetic
    let release!: () => void
    ;(ports.session as any).synthetic = (input: any) =>
      new Promise<void>((resolve) => (release = resolve)).then(() => ((ports.session as any).synthetic = synthetic)(input))

    const answering = answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] })
    await settle()
    // The person picks in the parent's session just then: OpenCode takes their pick before the withdrawal.
    formOf(tool, "ses_parent").answer([["Hey"]])
    await settle()
    release()

    expect(await answering).toMatchObject({ answered: true, by: "message" })
    const parentExit = await exitOf(parent)
    expect(Exit.isSuccess(parentExit) && parentExit.value.content).toContain(
      "Session ses_child no longer waits on this question: it had already been answered or settled, so these answers were not passed on; tell the person so.",
    )
    expect(Exit.isSuccess(parentExit) && parentExit.value.metadata).toMatchObject({ relayed: "question_1", passed: false })
    const messages = told.filter((item) => item.sessionID === "ses_child")
    expect(messages).toHaveLength(1)
    expect(messages[0].text).toContain('"Which greeting?"="Hi"')
  })

  test("a dismissal in the parent's question that lands after courier_answer answered it is dropped, and logged", async () => {
    const { advance, ports, told, tool, ask } = await setUp({ dismissalGraceMs: 50 })
    const logged: string[] = []
    ;(ports as any).log = (message: string) => logged.push(message)
    const child = ask("ses_child")
    await settle()
    const parent = ask("ses_parent")
    await settle()

    formOf(tool, "ses_parent").dismiss()
    expect(Exit.isFailure(await exitOf(parent))).toBe(true)
    // Within the grace the dismissal is held for, courier_answer answers the question.
    const answered = await answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] })
    await advance(80)

    expect(answered).toMatchObject({ answered: true, by: "result" })
    const childExit = await exitOf(child)
    expect(Exit.isSuccess(childExit) && childExit.value.output).toEqual({ answers: [["Hi"]] })
    expect(logged).toEqual(["courier question: the dismissal of question_1 was not passed on: it had already been answered or settled"])
    expect(told).toHaveLength(1)
  })

  test("a dismissal held while the parent asks again: the second question is withdrawn, since the child carries on without the answers", async () => {
    const { advance, tool, ask } = await setUp({ dismissalGraceMs: 50 })
    const child = ask("ses_child")
    await settle()
    const first = ask("ses_parent")
    await settle()

    formOf(tool, "ses_parent").dismiss()
    expect(Exit.isFailure(await exitOf(first))).toBe(true)
    const second = ask("ses_parent")
    await settle()
    expect(formOf(tool, "ses_parent")).toBeDefined()
    // The grace passes without a shutdown: the dismissal was the person's.
    await advance(50)

    const childExit = await exitOf(child)
    expect(Exit.isSuccess(childExit) && childExit.value.output).toEqual({ answers: [[]] })
    const secondExit = await exitOf(second)
    expect(Exit.isSuccess(secondExit) && secondExit.value).toMatchObject({
      output: { answers: [[]] },
      content: expect.stringContaining(
        "Session ses_child no longer waits on this question: it was already dismissed in your session, so it carries on without the answers.",
      ),
      metadata: { relayed: "question_1", withdrawn: true },
    })
    expect(tool.forms.size).toBe(0)
  })

  test("the parent's linked question answered in a way the child's does not take: the parent is told to pass it on itself", async () => {
    const { tool, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    const parent = ask("ses_parent")
    await settle()

    formOf(tool, "ses_parent").answer([["Hi", "Hey"]])

    const parentExit = await exitOf(parent)
    expect(Exit.isSuccess(parentExit) && parentExit.value.content).toContain(
      'Passing these answers on to session ses_child failed (question 1 ("Greeting") takes one answer, not 2.); call courier_answer with requestID "question_1" to pass them on.',
    )
    expect(Exit.isSuccess(parentExit) && parentExit.value.metadata).toMatchObject({ relayed: "question_1", passed: false })
    formOf(tool, "ses_child").answer([["Hi"]])
    expect(Exit.isSuccess(await exitOf(child))).toBe(true)
  })

  test("stopped on both sides while the parent cannot be told: that is logged", async () => {
    const { ports, told, ask } = await setUp()
    const logged: string[] = []
    ;(ports as any).log = (message: string) => logged.push(message)
    const child = ask("ses_child")
    await settle()
    const parent = ask("ses_parent")
    await settle()
    let attempts = 0
    ;(ports.session as any).synthetic = async () => {
      attempts++
      throw new Error("server busy")
    }

    await Effect.runPromise(Fiber.interrupt(child))
    await settle()
    // The child's own cut-off is not told while the parent asks the person.
    expect(attempts).toBe(0)
    await Effect.runPromise(Fiber.interrupt(parent))
    await settle()

    expect(attempts).toBe(1)
    expect(told).toHaveLength(1)
    expect(logged).toEqual(["courier question: could not pass on what happened to question_1: Error: server busy"])
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
    const { advance, ports, store, told, tool, ask, unload, shutDown } = await setUp({ dismissalGraceMs: 200 })
    const child = ask("ses_child")
    await settle()
    const parent = ask("ses_parent")
    await settle()

    // What a server shutdown does at 2.0.22: every open form goes, then `location.shutdown`, then the plugin unloads.
    formOf(tool, "ses_child").dismiss()
    formOf(tool, "ses_parent").dismiss()
    await settle()
    shutDown("/repo")
    unload()
    expect(Exit.isFailure(await exitOf(child))).toBe(true)
    expect(Exit.isFailure(await exitOf(parent))).toBe(true)
    await settle()
    expect(hub.questions.closingWaiters.size).toBe(0)
    // No instance is loaded once the closing grace is over to tell the parent.
    await advance(30_000)

    expect(told).toHaveLength(1)
    expect(store.has("question/question_1")).toBe(true)
    await noticeCutOff(ports)
    expect(told.at(-1).text).toContain('asks="question" request="question_1" restarted="true"')
  })

  test("a location's shutdown reported within the grace, before or after the dismissal, makes it a cut-off; another location's does not", async () => {
    const { advance, store, told, tool, ask, shutDown } = await setUp({ dismissalGraceMs: 100 })
    const first = ask("ses_child")
    await settle()
    shutDown("/repo")
    formOf(tool, "ses_child").dismiss()
    await exitOf(first)
    await settle()
    expect(notices(told, "answered")).toEqual([])
    expect(store.has("question/question_1")).toBe(true)

    resetHub()
    const second = ask("ses_child")
    await settle()
    formOf(tool, "ses_child").dismiss()
    await exitOf(second)
    await settle()
    shutDown("/elsewhere")
    await advance(150)
    expect(notices(told, "answered")[0].text).toContain('answered="dismissed" request="question_2"')
    expect(store.has("question/question_2")).toBe(false)

    const third = ask("ses_child")
    await settle()
    formOf(tool, "ses_child").dismiss()
    await exitOf(third)
    await settle()
    shutDown("/repo")
    await advance(150)
    expect(notices(told, "answered")).toHaveLength(1)
    expect(store.has("question/question_3")).toBe(true)
  })

  test("a dismissal that no shutdown follows within the grace is the person's", async () => {
    const { advance, told, tool, ask, store } = await setUp({ dismissalGraceMs: 50 })
    const child = ask("ses_child")
    await settle()

    formOf(tool, "ses_child").dismiss()
    await exitOf(child)
    await settle()
    expect(notices(told, "answered")).toEqual([])
    expect(hub.questions.closingWaiters.size).toBe(1)
    await advance(49)
    expect(notices(told, "answered")).toEqual([])
    await advance(1)

    expect(notices(told, "answered")[0].text).toContain('answered="dismissed" request="question_1"')
    expect(store.has("question/question_1")).toBe(false)
    expect(hub.questions.closingWaiters.size).toBe(0)
  })

  test("a shutdown is judged by the clock in the relay's ports: one reported longer than the grace before a dismissal does not count, one within it does", async () => {
    const { advance, store, told, tool, ask, shutDown } = await setUp({ dismissalGraceMs: 50 })
    shutDown("/repo")
    await advance(51)
    const first = ask("ses_child")
    await settle()
    formOf(tool, "ses_child").dismiss()
    await exitOf(first)
    await advance(80)
    expect(notices(told, "answered")[0].text).toContain('answered="dismissed" request="question_1"')
    expect(store.has("question/question_1")).toBe(false)

    shutDown("/repo")
    await advance(50)
    const second = ask("ses_child")
    await settle()
    formOf(tool, "ses_child").dismiss()
    await exitOf(second)
    await advance(80)
    expect(notices(told, "answered")).toHaveLength(1)
    expect(store.has("question/question_2")).toBe(true)
  })

  test("a shutdown reported without a location counts for every location", async () => {
    const { advance, store, told, tool, ask, shutDown } = await setUp({ dismissalGraceMs: 100 })
    const child = ask("ses_child")
    await settle()
    formOf(tool, "ses_child").dismiss()
    await exitOf(child)
    await settle()
    shutDown()
    await advance(150)

    expect(notices(told, "answered")).toEqual([])
    expect(store.has("question/question_1")).toBe(true)
  })

  test("the location a dismissal is judged by is the one the call runs in, not the one recorded for the session", async () => {
    const { advance, ports, store, told, tool, ask, shutDown } = await setUp({ dismissalGraceMs: 100 })
    await record(ports.storage, { sessionID: "ses_child", parentID: "ses_parent", title: "Fix the bug", directory: "/worktree", isolated: true, createdAt: 1 })
    const first = ask("ses_child")
    await settle()
    formOf(tool, "ses_child").dismiss()
    await exitOf(first)
    await settle()
    shutDown("/worktree")
    await advance(150)
    expect(notices(told, "answered")[0].text).toContain('answered="dismissed" request="question_1"')
    expect(store.has("question/question_1")).toBe(false)

    const second = ask("ses_child")
    await settle()
    formOf(tool, "ses_child").dismiss()
    await exitOf(second)
    await settle()
    shutDown("/repo")
    await advance(150)
    expect(notices(told, "answered")).toHaveLength(1)
    expect(store.has("question/question_2")).toBe(true)
  })

  test("an unload after the grace, while the notice to the top session hangs, still makes the dismissal a cut-off", async () => {
    const { advance, ports, store, told, tool, ask, unload } = await setUp({ dismissalGraceMs: 30, relayWaitMs: 200 })
    const synthetic = ports.session.synthetic
    ;(ports.session as any).synthetic = () => new Promise(() => undefined)
    const child = ask("ses_child")
    await settle()
    expect(store.has("question/question_1")).toBe(true)

    formOf(tool, "ses_child").dismiss()
    await exitOf(child)
    await advance(60)
    unload()
    await advance(250)

    expect(told).toEqual([])
    expect(store.has("question/question_1")).toBe(true)
    ;(ports.session as any).synthetic = synthetic
  })

  test("a location loading again within the grace forgets its shutdown: a dismissal there is the person's", async () => {
    const { advance, ports, store, told, tool, ask, shutDown } = await setUp({ dismissalGraceMs: 100 })
    shutDown("/repo")
    const leave = joinRelay(ports)
    const child = ask("ses_child")
    await settle()
    formOf(tool, "ses_child").dismiss()
    await exitOf(child)
    await advance(150)

    expect(notices(told, "answered")[0].text).toContain('answered="dismissed" request="question_1"')
    expect(store.has("question/question_1")).toBe(false)
    leave()
  })

  test("a location closing while OpenCode keeps running: an instance still loaded tells the parent a little later", async () => {
    const { advance, ports, told, tool, ask, unload } = await setUp({ closingGraceMs: 30 })
    const elsewhere: any[] = []
    const leave = joinRelay({ ...ports, session: { synthetic: async (input: any) => (elsewhere.push(input), { id: "msg" }) } as any })
    const child = ask("ses_child")
    await settle()

    unload()
    formOf(tool, "ses_child").dismiss()
    await exitOf(child)
    await advance(80)

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

  test("labels a locale would rank as equal still match in any order", async () => {
    const { tool, ask } = await setUp()
    // "é" written as one character and as "e" with a combining accent: localeCompare ranks them equal.
    const accents = (labels: string[]) => [{ question: "Which spelling?", header: "Spelling", options: labels.map((label) => ({ label, description: "" })) }]
    const labels = ["Zebra", "apple", "\u00e9", "e\u0301"]
    const child = ask("ses_child", accents(labels))
    await settle()

    const parent = ask("ses_parent", accents([...labels].reverse()))
    await settle()
    formOf(tool, "ses_parent").answer([["apple"]])

    const childExit = await exitOf(child)
    expect(Exit.isSuccess(childExit) && childExit.value.output).toEqual({ answers: [["apple"]] })
    await exitOf(parent)
    expect([...labels].sort(byCodeUnit)).toEqual(["Zebra", "apple", "e\u0301", "\u00e9"])
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

  test("an answer waits for one that another copy of the plugin passes on, and is not passed on again when that one went through", async () => {
    const { ports, told, ask } = await setUp()
    const child = ask("ses_child")
    await settle()
    // A copy loaded beside this one, a release before the hub say, passes an answer on: it shows in the shared state only.
    let passed!: () => void
    hub.questions.passing.set("question_1", new Promise<void>((resolve) => (passed = resolve)))
    let answered: unknown
    void answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] })
      .then((result) => (answered = result))
      .catch((error) => (answered = error))
    await settle()
    expect(answered).toBeUndefined()

    hub.questions.answered.add("question_1")
    hub.questions.passing.delete("question_1")
    passed()
    await settle()

    expect(answered).toMatchObject({ answered: false })
    expect(told.filter((item) => item.sessionID === "ses_child")).toEqual([])
    await Effect.runPromise(Fiber.interrupt(child))
  })

  test("an answer gives up after the wait behind one that another copy passes on and that hangs", async () => {
    const { ports, ask, advance } = await setUp({ passingWaitMs: 30 })
    const child = ask("ses_child")
    await settle()
    hub.questions.passing.set("question_1", new Promise(() => undefined))
    let failed: unknown
    void answerQuestion(ports, "ses_parent", { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] }).catch((error) => (failed = error))
    await advance(29)
    expect(failed).toBeUndefined()

    await advance(1)
    expect(String(failed)).toBe("Error: another answer to question_1 is still being passed on; try again in a while.")
    hub.questions.passing.delete("question_1")
    await Effect.runPromise(Fiber.interrupt(child))
  })

  test("an answer does not wait for ever behind one that hangs", async () => {
    const { ports, told, ask, advance } = await setUp({ passingWaitMs: 30 })
    const child = ask("ses_child")
    await settle()
    await Effect.runPromise(Fiber.interrupt(child))
    await settle()
    const synthetic = ports.session.synthetic
    ;(ports.session as any).synthetic = () => {
      ;(ports.session as any).synthetic = synthetic
      return new Promise(() => undefined)
    }
    const input = { sessionID: "ses_child", requestID: "question_1", answers: ["Hi"] }

    // Never returns: its notice hangs.
    void answerQuestion(ports, "ses_parent", input).catch(() => undefined)
    await advance(5)
    // Behind it, an answer waits until the hung one gives way, and then goes through.
    const second = answerQuestion(ports, "ses_parent", { ...input, answers: ["Hey"] })
    await advance(25)
    expect(await second).toMatchObject({ answered: true, by: "message" })
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
    const { advance, ports, store, tool, ask } = await setUp({ relayWaitMs: 30 })
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
    await advance(60)
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

  test("a notice slow to go out does not hold up the others", async () => {
    const { ports, store, told } = await setUp()
    const stored = (requestID: string, askedAt: number) => ({ requestID, sessionID: "ses_child", top: "ses_parent", title: "t", questions: greeting, askedAt })
    // Newest first: question_new is told before question_older.
    store.set("question/question_new", stored("question_new", 1_000_000))
    store.set("question/question_older", stored("question_older", 999_999))
    let olderSent: () => void = () => undefined
    const older = new Promise<void>((resolve) => (olderSent = resolve))
    ;(ports.session as any).synthetic = async (input: any) => {
      // Waits for the other notice, or gives up after a while when there is none.
      if (input.text.includes('request="question_new"')) await Promise.race([older, new Promise((resolve) => setTimeout(resolve, 200))])
      told.push(input)
      if (input.text.includes('request="question_older"')) olderSent()
      return { id: `msg_${told.length}` }
    }

    await noticeCutOff(ports)

    expect(told.map((item) => /request="(\w+)"/.exec(item.text)?.[1])).toEqual(["question_older", "question_new"])
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

describe("the relay's runtime", () => {
  test("run settles as the effect ends, by the system clock unless a test sets another", async () => {
    const started = Date.now()
    expect(await run(Effect.as(Effect.sleep(5), "slept"))).toBe("slept")
    expect(Date.now() - started).toBeGreaterThanOrEqual(4)
    expect(await run(Effect.as(Effect.sleep(0), "at once"))).toBe("at once")
    await expect(run(Effect.fail(new Error("failed")))).rejects.toThrow("failed")
  })

  test("background reports a failure, and not an interruption by stopRelay", async () => {
    const failed: unknown[] = []
    await background(Effect.fail(new Error("failed")), (error) => failed.push(error))
    const pending = background(Effect.never, (error) => failed.push(error))
    await stopRelay()
    await pending
    expect(failed.map(String)).toEqual(["Error: failed"])
  })

  test("a sleep longer than a timer takes starts without building every part first, and is not cut short at once", async () => {
    const failed: unknown[] = []
    let woke = false
    const pending = background(Effect.andThen(Effect.sleep(1e15), Effect.sync(() => (woke = true))), (error) => failed.push(error))
    await settle()
    await stopRelay()
    await pending
    expect({ woke, failed }).toEqual({ woke: false, failed: [] })
  })
})


test("a cut-off question is told through a member of this copy's hub first, else through any copy's loaded instance", () => {
  const subscribe = hub.subscribe
  hub.subscribe = undefined
  const elsewhere = { directory: "/old" } as never
  hub.questions.loaded.add(elsewhere)
  expect(anyLoaded()).toBe(elsewhere)
  const questions = { directory: "/a" } as never
  const later = { storage: { get: async () => undefined, set: async () => {}, scan: async () => ({ entries: [] }) }, now: () => 0, log: () => {} }
  const leave = join({ directory: "/a", permission: {}, later, watch: {}, questions, log: () => {} } as unknown as Member)
  expect(anyLoaded()).toBe(questions)
  void leave()
  hub.questions.loaded.delete(elsewhere)
  hub.subscribe = subscribe
})
