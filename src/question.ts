import type { Plugin } from "@opencode-ai/plugin"
import type { Plugin as EffectPlugin } from "@opencode-ai/plugin/effect"
import { Cause, Effect, Exit, Result } from "effect"
import { envelope } from "./courier.js"
import { lineage, RETENTION_MS, type RosterStorage } from "./roster.js"
import { scanAll } from "./storage.js"

type Context = Plugin.Context
type ToolEditor = Parameters<Parameters<EffectPlugin.Context["tool"]["transform"]>[0]>[0]
type HostTool = Parameters<Parameters<ToolEditor["update"]>[1]>[0]
type Execute = HostTool["execute"]
type ToolResult = Effect.Success<ReturnType<Execute>>

/** OpenCode's own question tool, which the relay wraps. */
export const QUESTION_TOOL = "question"

const PREFIX = "question/"

/** At most this many questions are kept in storage; the oldest go first. */
export const MAX_STORED = 100

/** One question of OpenCode's question tool, as the asking model wrote it. */
export interface Prompt {
  readonly question: string
  readonly header: string
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>
  readonly multiple?: boolean
}

/** The answers to a question call, as the question tool returns them: one list per question. */
export type Answers = string[][]

/** A question a spawned session asked with its question tool, stored until it is answered. */
export interface Asked {
  readonly requestID: string
  readonly sessionID: string
  /** The session told, at the top of the sessions started with courier_spawn; it alone answers. */
  readonly top: string
  readonly title: string
  /** The session that started the asking one, when that is not the top session itself. */
  readonly startedBy?: string
  readonly questions: ReadonlyArray<Prompt>
  readonly askedAt: number
}

/** How a question was settled without the top session: in the asking session, or not at all. */
export type Elsewhere =
  | { readonly by: "child"; readonly answers: Answers }
  | { readonly by: "dismissed" }
  | { readonly by: "failed"; readonly error: string }

/** What the top session's answer does to a call that waits: answers it, or dismisses it. */
type Outcome = { readonly answers: Answers } | { readonly dismissed: true }

/**
 * A question this process knows: one whose call waits (`call`), or one whose call was cut off,
 * which is answered by message. `link` is the top session's question call passing its answer on.
 */
interface Question extends Asked {
  call?: (outcome: Outcome) => void
  link?: (how: Elsewhere) => void
}

/**
 * Shared by every plugin instance in the process, since a child and the session it asks can be in
 * different locations: the questions told to a top session and not yet settled, the cut-off ones
 * whose top session has been told so, and the question calls waiting for their form to be shown.
 */
interface Shared {
  readonly questions: Map<string, Question>
  readonly noticed: Set<string>
  readonly shown: Map<string, () => void>
}
const shared = ((globalThis as Record<symbol, unknown>)[Symbol.for("opencode-courier.questions")] ??= {
  questions: new Map(),
  noticed: new Set(),
  shown: new Map(),
}) as Shared

export interface QuestionPorts {
  readonly storage: RosterStorage
  readonly session: Pick<Context["session"], "synthetic">
  readonly now: () => number
  readonly newID: () => string
  readonly log: (message: string) => void
}

const keyOf = (requestID: string) => `${PREFIX}${requestID}`

/** Whether a request id is a question's rather than a permission request's. */
export const isQuestion = (requestID: string) => requestID.startsWith("question_")

/** The questions of a call, without anything the tool does not define. */
function promptsOf(input: unknown): Prompt[] {
  const questions = (input as { questions?: ReadonlyArray<Prompt> } | undefined)?.questions ?? []
  return questions.map((prompt) => ({
    question: prompt.question,
    header: prompt.header,
    options: prompt.options.map((option) => ({ label: option.label, description: option.description })),
    ...(prompt.multiple ? { multiple: true } : {}),
  }))
}

/** What OpenCode's question tool tells the asking model once it has the answers. */
export function answeredText(questions: ReadonlyArray<Prompt>, answers: ReadonlyArray<ReadonlyArray<string>>) {
  const formatted = questions
    .map((prompt, index) => `"${prompt.question}"="${answers[index]?.length ? answers[index].join(", ") : "Unanswered"}"`)
    .join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

const describeQuestions = (questions: ReadonlyArray<Prompt>) =>
  questions.flatMap((prompt, index) => [
    `${index + 1}. ${prompt.header}: ${prompt.question} (${prompt.multiple ? "any of" : "one of"}, or an answer of their own:)`,
    ...prompt.options.map((option) => `   - ${option.label}${option.description ? `: ${option.description}` : ""}`),
  ])

const origin = (asked: Asked) =>
  asked.startedBy ? `which ${asked.startedBy} started with courier_spawn, a session started from yours,` : "which you started with courier_spawn,"

const CUT_OFF = {
  stopped: "its turn was stopped (interrupted, or ended by OpenCode after an hour without activity)",
  restarted: "the OpenCode server restarted",
}

/** What the top session is told about a question, when it is asked or after its call was cut off. */
export function questionNotice(asked: Asked, cutOff?: keyof typeof CUT_OFF) {
  return [
    cutOff
      ? `This session, "${asked.title}", ${origin(asked)} was asking the question below when ${CUT_OFF[cutOff]}. The question is no longer shown anywhere, and the session does nothing until it gets the answer.`
      : `This session, "${asked.title}", ${origin(asked)} asks the question below and waits for the answer.`,
    ...describeQuestions(asked.questions),
    "",
    "Do not answer it yourself. Ask the person you are working with, using your question tool with exactly these questions:",
    JSON.stringify({ questions: asked.questions }),
    `What they choose there is passed on to the session${cutOff ? " as a message, which wakes it" : ""}. If you cannot use your question tool, or they answer some other way, call courier_answer with sessionID "${asked.sessionID}", requestID "${asked.requestID}" and answers: one entry per question, in order, each the label they chose or the text they gave (a list of labels where a question allows several).`,
  ].join("\n")
}

/** What the top session is told about a question settled without it. */
export function settledNotice(asked: Asked, how: Elsewhere) {
  const what =
    how.by === "child"
      ? `answered in its own session (${answeredText(asked.questions, how.answers)})`
      : how.by === "dismissed"
        ? "dismissed in its own session, without an answer"
        : `ended without an answer: its question call failed (${how.error})`
  return [
    `The question ${asked.requestID} of this session, "${asked.title}", was ${what}, so it no longer waits on you.`,
    "If you asked someone about it, tell them it is settled; there is nothing to pass on.",
    ...(how.by === "child"
      ? []
      : ["That ends the session's turn, and then it does not report back on its own: if it stays quiet, message it with courier_send to have it carry on."]),
  ].join("\n")
}

const DISMISSED =
  "The person dismissed this question without answering it. Carry on without the answers, or report back with courier_send to the session that started you why you cannot."

async function tell(ports: QuestionPorts, asked: Asked, text: string, attributes: Record<string, string>) {
  await ports.session.synthetic({
    sessionID: asked.top,
    text: envelope(asked.sessionID, text, attributes),
    description: `Session ${asked.sessionID} asks a question`,
    metadata: { source: "courier", from: asked.sessionID, requestID: asked.requestID, ...attributes },
    delivery: "steer",
  })
}

/** Tells the top session that a question's call was cut off, once per question and process. */
async function tellCutOff(ports: QuestionPorts, asked: Asked, cutOff: keyof typeof CUT_OFF) {
  if (shared.noticed.has(asked.requestID)) return
  shared.noticed.add(asked.requestID)
  if (shared.noticed.size > 1_000) shared.noticed.delete(shared.noticed.values().next().value!)
  await tell(ports, asked, questionNotice(asked, cutOff), { asks: "question", request: asked.requestID, [cutOff]: "true" })
}

export interface QuestionAnswerInput {
  readonly sessionID: string
  readonly requestID: string
  /** One entry per question: a label or the text the person gave, or a list of them. */
  readonly answers: ReadonlyArray<string | ReadonlyArray<string>>
}

/** The answers in the question tool's shape, checked against the questions. */
function normalize(asked: Asked, answers: QuestionAnswerInput["answers"]): Answers {
  if (answers.length !== asked.questions.length)
    throw new Error(`answers needs one entry per question, ${asked.questions.length} in all, not ${answers.length}.`)
  return answers.map((answer, index) => {
    const list = typeof answer === "string" ? [answer] : [...answer]
    const prompt = asked.questions[index]!
    if (!prompt.multiple && list.length > 1)
      throw new Error(`question ${index + 1} ("${prompt.header}") takes one answer, not ${list.length}.`)
    return list
  })
}

/**
 * Passes the top session's answer, or the person's dismissal, to a question: as the result of the
 * call that waits on it, or as a message when that call was cut off. False when it was settled.
 */
async function deliver(ports: QuestionPorts, asked: Asked, outcome: Outcome) {
  const known = shared.questions.get(asked.requestID)
  // Off the list first, synchronously, so a second answer finds nothing to pass on.
  if (known) shared.questions.delete(asked.requestID)
  if (known?.call) {
    known.call(outcome)
    return "result" as const
  }
  if ((await ports.storage.get(keyOf(asked.requestID))) === undefined) return undefined
  await ports.storage.remove(keyOf(asked.requestID))
  const text =
    "answers" in outcome
      ? `Your question ${asked.requestID} was cut off before it was answered; here is the answer. ${answeredText(asked.questions, outcome.answers)}`
      : `Your question ${asked.requestID} was cut off before it was answered, and then dismissed without an answer. Carry on without the answers, or report back with courier_send why you cannot.`
  await ports.session.synthetic({
    sessionID: asked.sessionID,
    text: envelope(asked.top, text, { answers: asked.requestID, ...("answers" in outcome ? {} : { dismissed: "true" }) }),
    description: `Answer from ${asked.top}`,
    metadata: { source: "courier", from: asked.top, answers: asked.requestID },
    delivery: "steer",
  })
  return "message" as const
}

/**
 * Answers a question of a session started, directly or through others, from the caller, which must
 * be the session at the top, as for permission requests. `answered` is false when it no longer waits.
 */
export async function answerQuestion(ports: QuestionPorts, callerID: string, input: QuestionAnswerInput) {
  const { sessionID, requestID } = input
  const chain = await lineage(ports.storage, sessionID)
  if (!chain.length) throw new Error(`${sessionID} was not started with courier_spawn, so courier_answer cannot answer for it.`)
  const top = chain.at(-1)!.parentID
  if (top !== callerID)
    throw new Error(
      `${sessionID}'s questions go to ${top}, the session at the top of the sessions started from it with courier_spawn; ${callerID} cannot answer them.`,
    )
  const asked = shared.questions.get(requestID) ?? ((await ports.storage.get(keyOf(requestID))) as Asked | undefined)
  if (!asked || asked.sessionID !== sessionID) return { sessionID, requestID, answered: false }
  const answers = normalize(asked, input.answers)
  const by = await deliver(ports, asked, { answers })
  return by ? { sessionID, requestID, answered: true, by, answers } : { sessionID, requestID, answered: false }
}

/** The questions a session waits on, for courier_status; `stopped` when its call was cut off. */
export async function pendingQuestions(storage: RosterStorage, sessionID: string) {
  const found = new Map<string, { type: "question"; requestID: string; questions: Prompt[]; stopped?: true }>()
  const add = (asked: Asked, stopped: boolean) =>
    found.set(asked.requestID, {
      type: "question",
      requestID: asked.requestID,
      questions: [...asked.questions],
      ...(stopped ? { stopped: true as const } : {}),
    })
  for (const question of shared.questions.values()) if (question.sessionID === sessionID) add(question, !question.call)
  for (const asked of await scanAll<Asked>(storage, PREFIX))
    if (asked.sessionID === sessionID && !found.has(asked.requestID)) add(asked, true)
  return [...found.values()]
}

/**
 * On loading: drops stored questions that are too old, whose session is no longer on a roster, or
 * beyond the newest `MAX_STORED`, and tells the top session about the rest, which a restart cut off.
 */
export async function noticeCutOff(ports: QuestionPorts) {
  const stored = (await scanAll<Asked>(ports.storage, PREFIX)).sort((a, b) => b.askedAt - a.askedAt)
  const now = ports.now()
  let kept = 0
  for (const asked of stored) {
    if (shared.questions.has(asked.requestID)) {
      kept++
      continue
    }
    const current =
      kept < MAX_STORED && now - asked.askedAt <= RETENTION_MS && (await lineage(ports.storage, asked.sessionID)).length > 0
    if (!current) {
      await ports.storage.remove(keyOf(asked.requestID))
      continue
    }
    kept++
    if (shared.noticed.has(asked.requestID)) continue
    shared.questions.set(asked.requestID, { ...asked })
    await tellCutOff(ports, asked, "restarted").catch((error: unknown) =>
      ports.log(`courier question: could not tell ${asked.top} about ${asked.requestID}: ${String(error)}`),
    )
  }
}

/** Called for OpenCode's `form.created`: a question call's form is shown, so its question can be relayed. */
export function formShown(event: { readonly data: { readonly form: { readonly sessionID: string; readonly metadata?: unknown } } }) {
  const call = (event.data.form.metadata as { tool?: { id?: unknown } } | undefined)?.tool?.id
  if (typeof call !== "string") return
  const key = `${event.data.form.sessionID} ${call}`
  shared.shown.get(key)?.()
  shared.shown.delete(key)
}

const defectTag = (cause: Cause.Cause<unknown>) => {
  const defect = Cause.findDefect(cause)
  return Result.isSuccess(defect) ? (defect.success as { _tag?: unknown } | undefined)?._tag : undefined
}
/** OpenCode's question tool dies with this when the person dismisses the question. */
const isDismissal = (cause: Cause.Cause<unknown>) => defectTag(cause) === "QuestionTool.CancelledError"

/** Registers a told question, stores it and tells the top session; false when that failed. */
async function relay(ports: QuestionPorts, question: Question) {
  shared.questions.set(question.requestID, question)
  try {
    const { call: _call, link: _link, ...asked } = question
    await ports.storage.set(keyOf(question.requestID), asked as never)
    await tell(ports, question, questionNotice(question), { asks: "question", request: question.requestID })
    return true
  } catch (error) {
    shared.questions.delete(question.requestID)
    await ports.storage.remove(keyOf(question.requestID)).catch(() => undefined)
    ports.log(`courier question: could not tell ${question.top} about ${question.requestID}: ${String(error)}`)
    return false
  }
}

/** After a relayed call ended: tidies up, and tells the top session if it was settled without it. */
async function settle(ports: QuestionPorts, question: Question, exit: Exit.Exit<{ by: "child"; result: ToolResult } | { by: "top" }, unknown>) {
  const outcome = Exit.isSuccess(exit) ? `answered by ${exit.value.by}` : isDismissal(exit.cause) ? "dismissed" : Exit.hasInterrupts(exit) ? "interrupted" : "failed"
  ports.log(`courier question: ${question.requestID} of ${question.sessionID}: call ended, ${outcome}${question.link ? ", linked" : ""}`)
  // Answered through the top session, which took it off the list, or never relayed at all.
  if (shared.questions.get(question.requestID) !== question) {
    await ports.storage.remove(keyOf(question.requestID))
    return
  }
  if (Exit.isFailure(exit) && !isDismissal(exit.cause) && Exit.hasInterrupts(exit)) {
    // Cut off: the turn was stopped. The question stays, answered by message from now on; a top
    // session already asking the person passes their answer on that way.
    question.call = undefined
    if (!question.link) await tellCutOff(ports, question, "stopped")
    return
  }
  shared.questions.delete(question.requestID)
  await ports.storage.remove(keyOf(question.requestID))
  const how: Elsewhere = Exit.isSuccess(exit)
    ? {
        by: "child",
        answers: ((exit.value as { result?: ToolResult }).result?.output as { answers?: Answers } | undefined)?.answers ?? [],
      }
    : isDismissal(exit.cause)
      ? { by: "dismissed" }
      : { by: "failed", error: String(Cause.squash(exit.cause)) }
  if (question.link) return question.link(how)
  await tell(ports, question, settledNotice(question, how), {
    answered: how.by === "child" ? "elsewhere" : how.by,
    request: question.requestID,
  })
}

/**
 * The question call of a session started with courier_spawn: once its form is shown, the session at
 * the top is told, and whichever answer comes first ends the call, the other side's question being
 * withdrawn. Other sessions' calls run unchanged.
 */
function asking(ports: () => QuestionPorts | undefined, original: Execute): Execute {
  return (input, context) =>
    Effect.gen(function* () {
      const current = ports()
      const chain = current ? yield* Effect.promise(() => lineage(current.storage, context.sessionID).catch(() => [])) : []
      if (!current || !chain.length) return yield* original(input, context)
      let answered!: (outcome: Outcome) => void
      const byTop = new Promise<Outcome>((resolve) => (answered = resolve))
      const question: Question = {
        requestID: current.newID(),
        sessionID: context.sessionID,
        top: chain.at(-1)!.parentID,
        title: chain[0]!.title,
        ...(chain.length > 1 ? { startedBy: chain[0]!.parentID } : {}),
        questions: promptsOf(input),
        askedAt: current.now(),
        call: answered,
      }
      // The form is shown only once OpenCode's permission check for the call has passed; a call
      // refused there never reaches the top session.
      const key = `${context.sessionID} ${context.id}`
      const shown = new Promise<void>((resolve) => shared.shown.set(key, resolve))
      const fromTop = Effect.gen(function* () {
        yield* Effect.promise(() => shown)
        if (!(yield* Effect.promise(() => relay(current, question)))) return yield* Effect.never
        return { by: "top" as const, outcome: yield* Effect.promise(() => byTop) }
      })
      const ended = yield* Effect.raceFirst(
        original(input, context).pipe(Effect.map((result) => ({ by: "child" as const, result }))),
        fromTop,
      ).pipe(
        Effect.onExit((exit) =>
          Effect.promise(async () => {
            shared.shown.delete(key)
            await settle(current, question, exit).catch((error: unknown) =>
              current.log(`courier question: could not settle ${question.requestID}: ${String(error)}`),
            )
          }),
        ),
      )
      if (ended.by === "child") return ended.result
      const outcome = ended.outcome
      if ("dismissed" in outcome)
        return {
          output: { answers: question.questions.map(() => []) },
          content: DISMISSED,
          metadata: { answers: question.questions.map(() => []), relayed: question.requestID, dismissed: true },
        }
      return {
        output: { answers: outcome.answers },
        content: answeredText(question.questions, outcome.answers),
        metadata: { answers: outcome.answers, relayed: question.requestID, answeredIn: question.top },
      }
    }) as ReturnType<Execute>
}

const choices = (questions: ReadonlyArray<Prompt>) =>
  JSON.stringify(questions.map((prompt) => [!!prompt.multiple, prompt.options.map((option) => option.label)]))
const wording = (questions: ReadonlyArray<Prompt>) => JSON.stringify(questions.map((prompt) => prompt.question))

/** The waiting question a top session's call asks again: the same choices, preferably the same words, oldest first. */
function linkFor(sessionID: string, questions: ReadonlyArray<Prompt>) {
  const candidates = [...shared.questions.values()].filter(
    (question) => question.top === sessionID && !question.link && choices(question.questions) === choices(questions),
  )
  return candidates.find((question) => wording(question.questions) === wording(questions)) ?? candidates[0]
}

/**
 * The question call of a session that a waiting question was relayed to, asking the person the
 * same: what they choose is passed on, and the call is withdrawn if the question is settled first.
 */
function linking(ports: () => QuestionPorts | undefined, ask: Execute): Execute {
  return (input, context) =>
    Effect.gen(function* () {
      const current = ports()
      const linked = current ? linkFor(context.sessionID, promptsOf(input)) : undefined
      if (!current || !linked) return yield* ask(input, context)
      let settled!: (how: Elsewhere) => void
      const elsewhere = new Promise<Elsewhere>((resolve) => (settled = resolve))
      linked.link = settled
      const ended = yield* Effect.raceFirst(
        ask(input, context).pipe(Effect.map((result) => ({ by: "person" as const, result }))),
        Effect.promise(() => elsewhere).pipe(Effect.map((how) => ({ by: "elsewhere" as const, how }))),
      ).pipe(
        Effect.onExit((exit) =>
          Effect.promise(async () => {
            if (linked.link === settled) linked.link = undefined
            if (Exit.isSuccess(exit)) return
            current.log(
              `courier question: ${linked.requestID}: the linked call of ${context.sessionID} ended, ${isDismissal(exit.cause) ? "dismissed" : Exit.hasInterrupts(exit) ? "interrupted" : "failed"}`,
            )
            try {
              // Dismissed by the person: so is the question they were asked for.
              if (isDismissal(exit.cause)) await deliver(current, linked, { dismissed: true })
              // Stopped while the asking call was cut off as well: nobody has been told yet.
              else if (!linked.call && shared.questions.get(linked.requestID) === linked) await tellCutOff(current, linked, "stopped")
            } catch (error) {
              current.log(`courier question: could not pass on what happened to ${linked.requestID}: ${String(error)}`)
            }
          }),
        ),
      )
      if (ended.by === "elsewhere") {
        const how = ended.how
        const what =
          how.by === "child"
            ? `answered in its own session (${answeredText(linked.questions, how.answers)})`
            : how.by === "dismissed"
              ? "dismissed in its own session, which ends its turn; message it with courier_send if it should carry on"
              : `ended: its question call failed (${how.error})`
        return {
          output: { answers: how.by === "child" ? how.answers : linked.questions.map(() => []) },
          content: `Session ${linked.sessionID} no longer waits on this question: it was ${what}. There is nothing to pass on; tell the person it is settled.`,
          metadata: { relayed: linked.requestID, withdrawn: true },
        }
      }
      const result = ended.result
      const answers = (result.output as { answers?: Answers } | undefined)?.answers ?? []
      const passed = yield* Effect.promise(() =>
        Promise.resolve()
          .then(() => deliver(current, linked, { answers: normalize(linked, answers) }))
          .catch((error: unknown) => {
            current.log(`courier question: could not pass on the answer to ${linked.requestID}: ${String(error)}`)
            return `error: ${error instanceof Error ? error.message : String(error)}`
          }),
      )
      const note =
        passed === "result"
          ? `These answers were passed on to session ${linked.sessionID}, which carries on with them; do not call courier_answer for ${linked.requestID}.`
          : passed === "message"
            ? `These answers were passed on to session ${linked.sessionID} as a message, since its question had been cut off; it carries on with them. Do not call courier_answer for ${linked.requestID}.`
            : passed === undefined
              ? `Session ${linked.sessionID} no longer waits on this question; nothing was passed on.`
              : `Passing these answers on to session ${linked.sessionID} failed (${passed.slice(7)}); call courier_answer with requestID "${linked.requestID}" to pass them on.`
      return {
        ...result,
        content: typeof result.content === "string" ? `${result.content}\n${note}` : note,
        metadata: { ...result.metadata, relayed: linked.requestID, passed: passed === "result" || passed === "message" },
      }
    }) as ReturnType<Execute>
}

/** Wraps OpenCode's question tool for the relay. A tool by that id that is missing is left alone. */
export function relayQuestions(host: Pick<EffectPlugin.Context, "tool">, ports: () => QuestionPorts | undefined) {
  return host.tool.transform((editor) => {
    editor.update(QUESTION_TOOL, (tool) => {
      tool.execute = linking(ports, asking(ports, tool.execute))
    })
  })
}

/** For tests: forgets every question this process knows. */
export function forgetQuestions() {
  shared.questions.clear()
  shared.noticed.clear()
  shared.shown.clear()
}
