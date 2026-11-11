import type { Plugin as EffectPlugin } from "@opencode/plugin/effect"
import { Deferred, Effect, Exit, Fiber, type Cause } from "effect"
import type { Answers, Elsewhere, Outcome, Prompt, Question, QuestionPorts, Withdrawal } from "./types.js"
import {
  answeredText,
  DISMISSED,
  nativeQuestionNotice,
  passedNote,
  questionNotice,
  questionSettledNotice,
  unlinkedNote,
} from "../text.js"
import { lineage, nativeRootOf } from "../../tree/index.js"
import { deliver, forget, tell, tellCutOff } from "./answer.js"
import { closingSoon } from "./lifecycle.js"
import {
  choices,
  isDismissal,
  normalize,
  promptsOf,
  settledIn,
  withdrawnResult,
  wording,
  type CallExit,
  type Execute,
  type ToolResult,
} from "./pure.js"
import { background, run, within } from "./runtime.js"
import { anyLoaded, isPassing, keyOf, QUESTION_TOOL, shared, storedOf } from "./shared.js"

function tellLater(ports: QuestionPorts, question: Question) {
  const tellNow = Effect.suspend(() => {
    const later = anyLoaded()
    if (!later || question.call || question.link || shared.questions.get(question.requestID) !== question) return Effect.void
    return Effect.promise(() =>
      tellCutOff(later, question, "restarted").catch((error: unknown) =>
        later.log(`courier question: could not tell ${question.top} about ${question.requestID}: ${String(error)}`),
      ),
    )
  })
  void background(Effect.andThen(Effect.sleep(ports.timing.closingGraceMs), tellNow), (error) =>
    ports.log(`courier question: could not tell ${question.top} about ${question.requestID}: ${String(error)}`),
  )
}

async function relay(ports: QuestionPorts, question: Question) {
  shared.questions.set(question.requestID, question)
  try {
    await ports.storage.set(keyOf(question.requestID), storedOf(question) as never)
    if (question.native) await tell(ports, question, nativeQuestionNotice(question), { asks: "question", request: question.requestID, shown: "native" })
    else await tell(ports, question, questionNotice(question), { asks: "question", request: question.requestID })
    return true
  } catch (error) {
    ports.log(`courier question: could not tell ${question.top} about ${question.requestID}: ${String(error)}`)
    return false
  }
}

const settle = (ports: QuestionPorts, question: Question, exit: CallExit, loaded: () => boolean) =>
  Effect.gen(function* () {
    const unloaded = !loaded()
    const dismissed = Exit.isFailure(exit) && isDismissal(exit.cause)
    const held = dismissed && !unloaded ? yield* Effect.forkChild(closingSoon(ports, loaded, question.directory), { startImmediately: true }) : undefined
    const told = (yield* within(question.relaying, ports.timing.relayWaitMs)) === true
    if (Exit.isSuccess(exit) && exit.value.by === "top") {
      if (shared.questions.get(question.requestID) === question) shared.questions.delete(question.requestID)
      return yield* Effect.promise(() => forget(ports, question))
    }
    if (shared.questions.get(question.requestID) !== question) {
      return yield* Effect.promise(() => forget(ports, question))
    }
    const closing = unloaded || !loaded() || (held !== undefined && (yield* Fiber.join(held)))
    if (Exit.isFailure(exit) && (closing || (!dismissed && Exit.hasInterrupts(exit))))
      return closing ? tellLater(ports, question) : yield* Effect.promise(() => stopped(ports, question))
    yield* Effect.promise(() => settledElsewhere(ports, question, settledIn(exit), told))
  })

async function stopped(ports: QuestionPorts, question: Question) {
  if (!question.link) await tellCutOff(ports, question, "stopped")
}

async function settledElsewhere(ports: QuestionPorts, question: Question, how: Elsewhere, told: boolean) {
  await forget(ports, question)
  shared.questions.delete(question.requestID)
  if (question.link) return question.link(how)
  if (!told) return
  await tell(ports, question, questionSettledNotice(question, how), {
    answered: how.by === "child" ? "elsewhere" : how.by,
    request: question.requestID,
  })
}

function startSettling(ports: QuestionPorts, question: Question, exit: CallExit, loaded: () => boolean) {
  question.settling = background(settle(ports, question, exit, loaded), (error) =>
    ports.log(`courier question: could not settle ${question.requestID}: ${String(error)}`),
  ).finally(() => {
    question.settling = undefined
  })
}

function asking(ports: () => QuestionPorts | undefined, directory: string, original: Execute): Execute {
  return (input, context) =>
    Effect.gen(function* () {
      const current = ports()
      const chain = current ? yield* Effect.promise(() => lineage(current.storage, context.sessionID).catch(() => [])) : []
      if (!current || !chain.length) return yield* original(input, context)
      const byTop = Deferred.makeUnsafe<Outcome>()
      const accepted = Deferred.makeUnsafe<boolean>()
      let acceptancePromise: Promise<boolean> | undefined
      const acceptance = () => (acceptancePromise ??= Effect.runPromise(Deferred.await(accepted)))
      let handed = false
      const top = chain.at(-1)!.parentID
      const question: Question = {
        requestID: current.newID(),
        sessionID: context.sessionID,
        top,
        title: chain[0]!.title,
        ...(chain.length > 1 ? { startedBy: chain[0]!.parentID } : {}),
        questions: promptsOf(input),
        askedAt: current.now(),
        ...(nativeRootOf(chain) === top ? { native: true as const } : {}),
        directory,
        call: (outcome) => {
          if (handed) return acceptance().then(() => false)
          handed = true
          Deferred.doneUnsafe(byTop, Exit.succeed(outcome))
          return acceptance()
        },
      }
      const key = `${context.sessionID} ${context.id}`
      const loaded = () => ports() === current
      const shown = Deferred.makeUnsafe<void>()
      shared.shown.set(key, () => Deferred.doneUnsafe(shown, Exit.void))
      const fromTop = Effect.gen(function* () {
        yield* Deferred.await(shown)
        question.relaying = relay(current, question)
        return { by: "top" as const, outcome: yield* Deferred.await(byTop) }
      })
      const ended = yield* Effect.raceFirst(
        original(input, context).pipe(Effect.map((result) => ({ by: "child" as const, result }))),
        fromTop,
      ).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            shared.shown.delete(key)
            const byTopSession = Exit.isSuccess(exit) && exit.value.by === "top"
            if (!byTopSession) question.call = undefined
            startSettling(current, question, exit, loaded)
            Deferred.doneUnsafe(accepted, Exit.succeed(byTopSession))
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

const linkable = (question: Question, sessionID: string) =>
  question.top === sessionID && !question.link && !isPassing(question.requestID) && !(question.native && question.call)

function linkFor(sessionID: string, questions: ReadonlyArray<Prompt>) {
  const asked = { choices: choices(questions), wording: wording(questions) }
  return [...shared.questions.values()]
    .filter(
      (question) =>
        linkable(question, sessionID) &&
        choices(question.questions) === asked.choices &&
        wording(question.questions) === asked.wording,
    )
    .sort((a, b) => a.askedAt - b.askedAt)[0]
}

function unlinkedResult(result: ToolResult, sessionID: string, questions: ReadonlyArray<Prompt>): ToolResult {
  if (typeof result.content !== "string") return result
  const asked = choices(questions)
  const similar = [...shared.questions.values()].filter((question) => linkable(question, sessionID) && choices(question.questions) === asked)
  if (!similar.length) return result
  return { ...result, content: `${result.content}\n${unlinkedNote(similar)}` }
}

const linkedCallFailed = (ports: QuestionPorts, linked: Question, cause: Cause.Cause<unknown>, loaded: () => boolean, directory: string) =>
  Effect.gen(function* () {
    if (isDismissal(cause)) {
      if (yield* closingSoon(ports, loaded, directory)) return
      if ((yield* deliver(ports, linked, { dismissed: true })) === undefined)
        ports.log(`courier question: the dismissal of ${linked.requestID} was not passed on: it had already been answered or settled`)
    } else if (!linked.call && shared.questions.get(linked.requestID) === linked) yield* Effect.promise(() => tellCutOff(ports, linked, "stopped"))
  })

const notPassedOn = (ports: QuestionPorts, linked: Question) => (error: unknown) =>
  ports.log(`courier question: could not pass on what happened to ${linked.requestID}: ${String(error)}`)

function linking(ports: () => QuestionPorts | undefined, directory: string, ask: Execute): Execute {
  return (input, context) =>
    Effect.gen(function* () {
      const current = ports()
      const questions = promptsOf(input)
      const linked = current ? linkFor(context.sessionID, questions) : undefined
      if (!current || !linked) {
        const result = yield* ask(input, context)
        return current ? unlinkedResult(result, context.sessionID, questions) : result
      }
      const loaded = () => ports() === current
      const elsewhere = Deferred.makeUnsafe<Withdrawal>()
      const settled = (how: Withdrawal) => void Deferred.doneUnsafe(elsewhere, Exit.succeed(how))
      linked.link = settled
      const ended = yield* Effect.raceFirst(
        ask(input, context).pipe(Effect.map((result) => ({ by: "person" as const, result }))),
        Deferred.await(elsewhere).pipe(Effect.map((how) => ({ by: "elsewhere" as const, how }))),
      ).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (linked.link === settled) linked.link = undefined
            if (Exit.isSuccess(exit) || !loaded()) return
            void background(linkedCallFailed(current, linked, exit.cause, loaded, directory), notPassedOn(current, linked))
          }),
        ),
      )
      if (ended.by === "elsewhere") return withdrawnResult(linked, ended.how)
      const result = ended.result
      const answers = (result.output as { answers?: Answers } | undefined)?.answers ?? []
      const passed = yield* Effect.promise(() =>
        Promise.resolve()
          .then(() => run(deliver(current, linked, { answers: normalize(linked, answers) })))
          .catch((error: unknown) => {
            current.log(`courier question: could not pass on the answer to ${linked.requestID}: ${String(error)}`)
            return `error: ${error instanceof Error ? error.message : String(error)}`
          }),
      )
      const note = passedNote(linked, passed)
      return {
        ...result,
        content: typeof result.content === "string" ? `${result.content}\n${note}` : note,
        metadata: { ...result.metadata, relayed: linked.requestID, passed: passed === "result" || passed === "message" },
      }
    }) as ReturnType<Execute>
}

export function relayQuestions(host: Pick<EffectPlugin.Context, "tool" | "location">, ports: () => QuestionPorts | undefined) {
  const { directory } = host.location
  return host.tool.transform((editor) => {
    editor.update(QUESTION_TOOL, (tool) => {
      tool.execute = linking(ports, directory, asking(ports, directory, tool.execute))
    })
  })
}
