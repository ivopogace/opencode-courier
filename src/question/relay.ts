import type { Plugin as EffectPlugin } from "@opencode/plugin/effect"
import { Effect, Exit, type Cause } from "effect"
import type { Question, QuestionPorts } from "../hub.js"
import {
  answeredText,
  DISMISSED,
  passedNote,
  questionNotice,
  questionSettledNotice,
  unlinkedNote,
  type Answers,
  type Elsewhere,
  type Outcome,
  type Prompt,
  type Withdrawal,
} from "../notices.js"
import { lineage } from "../roster.js"
import { deliver, forget, tell, tellCutOff } from "./answer.js"
import { closingSoon, within } from "./lifecycle.js"
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
import { isPassing, keyOf, QUESTION_TOOL, shared, storedOf } from "./shared.js"

/**
 * Tells the top session about a question its closing location cut off, after the closing grace of
 * `ports` (the instance whose call was cut off), through an instance still loaded then, if any (any will do: a notice reaches a session in any location).
 * Without one, the next load tells it.
 */
function tellLater(ports: QuestionPorts, question: Question) {
  const timer = setTimeout(() => {
    const later = shared.loaded.values().next().value
    if (!later || question.call || question.link || shared.questions.get(question.requestID) !== question) return
    void tellCutOff(later, question, "restarted").catch((error: unknown) =>
      later.log(`courier question: could not tell ${question.top} about ${question.requestID}: ${String(error)}`),
    )
  }, ports.timing.closingGraceMs)
  timer.unref?.()
}

/** Registers a question, stores it and tells the top session; false when storing or telling failed. */
async function relay(ports: QuestionPorts, question: Question) {
  shared.questions.set(question.requestID, question)
  try {
    await ports.storage.set(keyOf(question.requestID), storedOf(question) as never)
    await tell(ports, question, questionNotice(question), { asks: "question", request: question.requestID })
    return true
  } catch (error) {
    // The question stays registered and the call waits on: courier_status lists it, and an answer
    // that comes anyway, through a link or courier_answer, still reaches the call.
    ports.log(`courier question: could not tell ${question.top} about ${question.requestID}: ${String(error)}`)
    return false
  }
}

/**
 * After a relayed call ended: tidies up, and tells the top session if it was settled without it.
 * `loaded` says whether the plugin instance that ran the call is still loaded.
 */
async function settle(ports: QuestionPorts, question: Question, exit: CallExit, loaded: () => boolean) {
  const unloaded = !loaded()
  // A dismissal is held from now, alongside the wait below, so the grace is not spent waiting.
  const dismissed = Exit.isFailure(exit) && isDismissal(exit.cause)
  const held = dismissed && !unloaded ? closingSoon(ports, loaded, question.directory) : undefined
  // Telling the top session first, so what follows does not overtake the notice or come before it
  // is stored; for a while only, so a notice that never returns does not hold everything else up.
  // `told` is false when the top session was not told, or not yet.
  const told = (await within(question.relaying, ports.timing.relayWaitMs)) === true
  // Answered by the top session.
  if (Exit.isSuccess(exit) && exit.value.by === "top") {
    if (shared.questions.get(question.requestID) === question) shared.questions.delete(question.requestID)
    await forget(ports, question)
    return
  }
  // Never relayed, or dropped meanwhile.
  if (shared.questions.get(question.requestID) !== question) {
    await forget(ports, question)
    return
  }
  // Cut off: the turn was stopped, or OpenCode is closing the location, which withdraws every open
  // form there as if the person had dismissed it (on a server shutdown, say), before unloading the
  // plugin there (since 2.0.22) or after (the beta). So a dismissal is held for a moment, to see
  // whether the location's shutdown or this instance's unload follows it. The question stays,
  // answered by message from now on; a top session already asking the person passes their answer
  // on that way. A closing location is not told now: the next load tells it, in this process or
  // after a restart, or an instance still loaded does, a little later, when the process is still
  // running then. The unload is looked at again here: it may have come during the wait above, after
  // a held dismissal had already been taken for the person's.
  const closing = unloaded || !loaded() || (held !== undefined && (await held))
  if (Exit.isFailure(exit) && (closing || (!dismissed && Exit.hasInterrupts(exit)))) return closing ? tellLater(ports, question) : stopped(ports, question)
  await settledElsewhere(ports, question, settledIn(exit), told)
}

/** A relayed call cut off by its stopped turn: the top session is told now, unless it asks the person. */
async function stopped(ports: QuestionPorts, question: Question) {
  if (!question.link) await tellCutOff(ports, question, "stopped")
}

/** A relayed call settled in the asking session: `told` says whether the top session was told about it. */
async function settledElsewhere(ports: QuestionPorts, question: Question, how: Elsewhere, told: boolean) {
  // Its record goes before its registration, so an answer that finds the question gone does not
  // find the record still there and send it on.
  await forget(ports, question)
  shared.questions.delete(question.requestID)
  if (question.link) return question.link(how)
  // A top session never told about the question is not told that it is settled either.
  if (!told) return
  await tell(ports, question, questionSettledNotice(question, how), {
    answered: how.by === "child" ? "elsewhere" : how.by,
    request: question.requestID,
  })
}

/**
 * Starts settling a relayed call that ended, kept on the question until it is through: an answer
 * the call did not take waits for it.
 */
function startSettling(ports: QuestionPorts, question: Question, exit: CallExit, loaded: () => boolean) {
  question.settling = settle(ports, question, exit, loaded)
    .catch((error: unknown) => ports.log(`courier question: could not settle ${question.requestID}: ${String(error)}`))
    .finally(() => {
      question.settling = undefined
    })
}

/**
 * The question call of a session started with courier_spawn: once its form is shown, the session at
 * the top is told, and whichever answer comes first ends the call, the other side's question being
 * withdrawn. Other sessions' calls run unchanged.
 */
function asking(ports: () => QuestionPorts | undefined, directory: string, original: Execute): Execute {
  return (input, context) =>
    Effect.gen(function* () {
      const current = ports()
      const chain = current ? yield* Effect.promise(() => lineage(current.storage, context.sessionID).catch(() => [])) : []
      if (!current || !chain.length) return yield* original(input, context)
      let answered!: (outcome: Outcome) => void
      const byTop = new Promise<Outcome>((resolve) => (answered = resolve))
      let accept!: (taken: boolean) => void
      const accepted = new Promise<boolean>((resolve) => (accept = resolve))
      // Handed one outcome only: a second, while the first still ends the call, is not taken.
      let handed = false
      const question: Question = {
        requestID: current.newID(),
        sessionID: context.sessionID,
        top: chain.at(-1)!.parentID,
        title: chain[0]!.title,
        ...(chain.length > 1 ? { startedBy: chain[0]!.parentID } : {}),
        questions: promptsOf(input),
        askedAt: current.now(),
        directory,
        call: (outcome) => {
          if (handed) return accepted.then(() => false)
          handed = true
          answered(outcome)
          return accepted
        },
      }
      // The form is shown only once OpenCode's permission check for the call has passed; a call
      // refused there never reaches the top session.
      const key = `${context.sessionID} ${context.id}`
      const loaded = () => ports() === current
      const shown = new Promise<void>((resolve) => shared.shown.set(key, resolve))
      const fromTop = Effect.gen(function* () {
        yield* Effect.promise(() => shown)
        // Started, not waited for: a store or a notice that hangs must not keep the top session's
        // answer from the call. Kept on the question, so settle can wait for it.
        question.relaying = relay(current, question)
        return { by: "top" as const, outcome: yield* Effect.promise(() => byTop) }
      })
      const ended = yield* Effect.raceFirst(
        original(input, context).pipe(Effect.map((result) => ({ by: "child" as const, result }))),
        fromTop,
      ).pipe(
        // Not waited for, so storing or a notice that hangs cannot hold the call up.
        Effect.onExit((exit) =>
          Effect.sync(() => {
            shared.shown.delete(key)
            // The call no longer waits, whatever settle makes of it: an answer from now on waits for settle.
            const byTopSession = Exit.isSuccess(exit) && exit.value.by === "top"
            if (!byTopSession) question.call = undefined
            startSettling(current, question, exit, loaded)
            // After settling is set, which an answer the call did not take then waits for.
            accept(byTopSession)
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

/**
 * The waiting question a top session's call asks again, the oldest if several: the same questions
 * with the same choices, in any order. Matching choices alone are not enough, or an unrelated
 * yes-or-no question of the top session would answer a child's.
 */
function linkFor(sessionID: string, questions: ReadonlyArray<Prompt>) {
  const asked = { choices: choices(questions), wording: wording(questions) }
  return [...shared.questions.values()]
    .filter(
      (question) =>
        question.top === sessionID &&
        !question.link &&
        !isPassing(question.requestID) &&
        choices(question.questions) === asked.choices &&
        wording(question.questions) === asked.wording,
    )
    .sort((a, b) => a.askedAt - b.askedAt)[0]
}

/**
 * The result of a top session's question call that no waiting question was linked to: when one
 * waits with the same choices, reworded or asked before that session asked, it says how to pass
 * the answers on.
 */
function unlinkedResult(result: ToolResult, sessionID: string, questions: ReadonlyArray<Prompt>): ToolResult {
  if (typeof result.content !== "string") return result
  const asked = choices(questions)
  const similar = [...shared.questions.values()].filter(
    (question) => question.top === sessionID && !question.link && !isPassing(question.requestID) && choices(question.questions) === asked,
  )
  if (!similar.length) return result
  return { ...result, content: `${result.content}\n${unlinkedNote(similar)}` }
}

/**
 * After a linked call failed, its location still loaded: a dismissal by the person, unless the
 * location is closing (see settle), dismisses the question they were asked for too, or is logged
 * when the question was answered meanwhile; a call stopped while the asking call was cut off as
 * well tells the top session, which nobody has told yet.
 */
async function linkedCallFailed(
  ports: QuestionPorts,
  linked: Question,
  cause: Cause.Cause<unknown>,
  loaded: () => boolean,
  directory: string,
) {
  try {
    if (isDismissal(cause)) {
      if (await closingSoon(ports, loaded, directory)) return
      if ((await deliver(ports, linked, { dismissed: true })) === undefined)
        ports.log(`courier question: the dismissal of ${linked.requestID} was not passed on: it had already been answered or settled`)
    } else if (!linked.call && shared.questions.get(linked.requestID) === linked) await tellCutOff(ports, linked, "stopped")
  } catch (error) {
    ports.log(`courier question: could not pass on what happened to ${linked.requestID}: ${String(error)}`)
  }
}

/**
 * The question call of a session that a waiting question was relayed to, asking the person the
 * same: what they choose is passed on, and the call is withdrawn if the question is settled first.
 */
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
      let settled!: (how: Withdrawal) => void
      const elsewhere = new Promise<Withdrawal>((resolve) => (settled = resolve))
      linked.link = settled
      const ended = yield* Effect.raceFirst(
        ask(input, context).pipe(Effect.map((result) => ({ by: "person" as const, result }))),
        Effect.promise(() => elsewhere).pipe(Effect.map((how) => ({ by: "elsewhere" as const, how }))),
      ).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (linked.link === settled) linked.link = undefined
            // Unloaded: OpenCode is closing the location, which withdraws the form; nobody dismissed it.
            if (Exit.isSuccess(exit) || !loaded()) return
            // Not waited for, as in asking.
            void linkedCallFailed(current, linked, exit.cause, loaded, directory)
          }),
        ),
      )
      if (ended.by === "elsewhere") return withdrawnResult(linked, ended.how)
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
      const note = passedNote(linked, passed)
      return {
        ...result,
        content: typeof result.content === "string" ? `${result.content}\n${note}` : note,
        metadata: { ...result.metadata, relayed: linked.requestID, passed: passed === "result" || passed === "message" },
      }
    }) as ReturnType<Execute>
}

/** Wraps OpenCode's question tool for the relay. A tool by that id that is missing is left alone. */
export function relayQuestions(host: Pick<EffectPlugin.Context, "tool" | "location">, ports: () => QuestionPorts | undefined) {
  // The wrapped tool runs the calls of the host's location: its shutdown is what withdraws their forms.
  const { directory } = host.location
  return host.tool.transform((editor) => {
    editor.update(QUESTION_TOOL, (tool) => {
      tool.execute = linking(ports, directory, asking(ports, directory, tool.execute))
    })
  })
}
