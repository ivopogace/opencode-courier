import { Deferred, Effect, Semaphore } from "effect"
import type { Answers, Asked, Outcome, Prompt, Question, QuestionPorts, Withdrawal } from "./types.js"
import { envelope } from "../../kernel/protocol.js"
import { cutOffAnswer, questionNotice, questionSettledNotice, type CutOff } from "../text.js"
import { allEntries, answeringTop, lineageIn, RETENTION_MS, type RosterStorage } from "../../tree/index.js"
import { scanAll } from "../../platform/storage.js"
import { within, run } from "./runtime.js"
import { normalize, type QuestionAnswerInput } from "./pure.js"
import { claim, isPassing, keyOf, MAX_STORED, PREFIX, shared, storedOf, type Stored } from "./shared.js"

export type QuestionAnswered =
  | { readonly sessionID: string; readonly requestID: string; readonly answered: false }
  | {
      readonly sessionID: string
      readonly requestID: string
      readonly answered: true
      readonly by: "result" | "message"
      readonly answers: Answers
    }

export async function tell(ports: QuestionPorts, asked: Asked, text: string, attributes: Record<string, string>) {
  await ports.session.synthetic({
    sessionID: asked.top,
    text: envelope(asked.sessionID, text, attributes),
    description: `Session ${asked.sessionID} asks a question`,
    metadata: { source: "courier", from: asked.sessionID, requestID: asked.requestID, ...attributes },
    delivery: "steer",
  })
}

export async function tellCutOff(ports: QuestionPorts, asked: Asked, cutOff: CutOff) {
  if (shared.noticed.has(asked.requestID) || isPassing(asked.requestID)) return
  claim(shared.noticed, asked.requestID)
  try {
    await tell(ports, asked, questionNotice(asked, cutOff), { asks: "question", request: asked.requestID, [cutOff]: "true" })
  } catch (error) {
    shared.noticed.delete(asked.requestID)
    throw error
  }
}

const busy = (id: string) => new Error(`another answer to ${id} is still being passed on; try again in a while.`)

const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>()

const holding = <A, E>(id: string, ms: number, effect: Effect.Effect<A, E>): Effect.Effect<A, E | Error> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const lock = locks.get(id) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
      lock.users++
      locks.set(id, lock)
      return lock
    }),
    (lock) => {
      const taken = Deferred.makeUnsafe<void>()
      const late = Effect.andThen(
        Effect.sleep(ms),
        Effect.suspend(() => (Deferred.isDoneUnsafe(taken) ? Effect.never : Effect.fail(busy(id)))),
      )
      return Effect.raceFirst(lock.semaphore.withPermit(Effect.andThen(Deferred.succeed(taken, undefined), effect)), late)
    },
    (lock) =>
      Effect.sync(() => {
        if (--lock.users === 0) locks.delete(id)
      }),
  )

export interface Linked {
  readonly withdrawal: Withdrawal
  linked: boolean
}

export const deliver = (
  ports: QuestionPorts,
  asked: Asked,
  outcome: Outcome,
  given?: Linked,
): Effect.Effect<"result" | "message" | undefined, unknown> =>
  Effect.suspend(() => {
    const linked = given ?? { withdrawal: { by: "top", outcome }, linked: false }
    const id = asked.requestID
    const wait = ports.timing.passingWaitMs
    const since = ports.now()
    const left = () => wait - (ports.now() - since)
    const turn = holding(
      id,
      wait,
      Effect.gen(function* () {
        for (let under = shared.passing.get(id); under; under = shared.passing.get(id)) {
          if (left() <= 0) return yield* Effect.fail(busy(id))
          yield* within(under, left())
        }
        if (shared.answered.has(id)) return undefined
        const passing = passOn(ports, asked, outcome, linked)
        shared.passing.set(id, passing)
        yield* within(passing, wait).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (shared.passing.get(id) === passing) shared.passing.delete(id)
            }),
          ),
        )
        return passing
      }),
    )
    return Effect.flatMap(turn, (passing) =>
      passing ? Effect.tryPromise({ try: () => passing, catch: (error) => error }) : Effect.succeed(undefined),
    )
  })

function withdraw(known: Question, linked: Linked) {
  if (!known.link) return
  linked.linked = true
  known.link(linked.withdrawal)
}

async function passOn(ports: QuestionPorts, asked: Asked, outcome: Outcome, linked: Linked) {
  const id = asked.requestID
  let known = shared.questions.get(id)
  if (known?.call && (await known.call(outcome))) {
    claim(shared.answered, id)
    shared.questions.delete(id)
    withdraw(known, linked)
    return "result" as const
  }
  if (known) {
    await known.settling
    if (shared.questions.get(id) !== known) return undefined
  } else {
    const stored = (await ports.storage.get(keyOf(id))) as Stored | undefined
    if (!stored || stored.answered) return undefined
    known = { ...stored }
    shared.questions.set(id, known)
  }
  await sendAnswer(ports, asked, outcome)
  claim(shared.answered, id)
  shared.questions.delete(id)
  withdraw(known, linked)
  await forget(ports, asked)
  return "message" as const
}

export async function forget(ports: QuestionPorts, asked: Asked) {
  try {
    await ports.storage.remove(keyOf(asked.requestID))
  } catch (error) {
    ports.log(`courier question: could not forget ${asked.requestID}: ${String(error)}`)
    const marked: Stored = { ...storedOf(asked), answered: true }
    await ports.storage.set(keyOf(asked.requestID), marked as never).catch(() => undefined)
  }
}

async function sendAnswer(ports: QuestionPorts, asked: Asked, outcome: Outcome) {
  await ports.session.synthetic({
    sessionID: asked.sessionID,
    text: envelope(asked.top, cutOffAnswer(asked, outcome), { answers: asked.requestID, ...("answers" in outcome ? {} : { dismissed: "true" }) }),
    description: `Answer from ${asked.top}`,
    metadata: { source: "courier", from: asked.top, answers: asked.requestID },
    delivery: "steer",
  })
}

export async function answerQuestion(ports: QuestionPorts, callerID: string, input: QuestionAnswerInput): Promise<QuestionAnswered> {
  const { sessionID, requestID } = input
  await answeringTop(ports.storage, sessionID, callerID, "questions")
  const asked: Stored | undefined = shared.questions.get(requestID) ?? ((await ports.storage.get(keyOf(requestID))) as Stored | undefined)
  if (asked?.sessionID !== sessionID || asked.answered) return { sessionID, requestID, answered: false }
  const answers = normalize(asked, input.answers)
  const by = await run(deliver(ports, asked, { answers }))
  return by ? { sessionID, requestID, answered: true, by, answers } : { sessionID, requestID, answered: false }
}

export async function answerForPerson(ports: QuestionPorts, input: QuestionAnswerInput): Promise<QuestionAnswered> {
  const { sessionID, requestID } = input
  const known = shared.questions.get(requestID)
  const asked: Stored | undefined = known ?? ((await ports.storage.get(keyOf(requestID))) as Stored | undefined)
  if (asked?.sessionID !== sessionID || asked.answered) return { sessionID, requestID, answered: false }
  const answers = normalize(asked, input.answers)
  const settled = { by: "child", answers, via: "inbox" } as const
  const linked: Linked = { withdrawal: settled, linked: false }
  const by = await run(deliver(ports, asked, { answers }, linked))
  if (!by) return { sessionID, requestID, answered: false }
  const told = !known?.relaying || (await run(within(known.relaying, ports.timing.relayWaitMs))) === true
  if (!linked.linked && told)
    await tell(ports, asked, questionSettledNotice(asked, settled), { answered: "elsewhere", request: requestID }).catch((error: unknown) =>
      ports.log(`courier question: could not tell ${asked.top} that ${requestID} is settled: ${String(error)}`),
    )
  return { sessionID, requestID, answered: true, by, answers }
}

export async function asksQuestion(ports: { readonly storage: RosterStorage }, sessionID: string) {
  return (await pendingQuestions(ports.storage, sessionID)).length > 0
}

export async function pendingQuestions(storage: RosterStorage, sessionID: string) {
  const found = new Map<string, { type: "question"; requestID: string; questions: Prompt[]; stopped?: true }>()
  const add = (asked: Asked, stopped: boolean) =>
    found.set(asked.requestID, {
      type: "question",
      requestID: asked.requestID,
      questions: [...asked.questions],
      ...(stopped ? { stopped: true as const } : {}),
    })
  for (const question of shared.questions.values())
    if (question.sessionID === sessionID && !isPassing(question.requestID)) add(question, !question.call)
  for (const asked of await scanAll<Stored>(storage, PREFIX))
    if (asked.sessionID === sessionID && !asked.answered && !isPassing(asked.requestID) && !found.has(asked.requestID))
      add(asked, true)
  return [...found.values()]
}

export async function noticeCutOff(ports: QuestionPorts) {
  const stored = (await scanAll<Stored>(ports.storage, PREFIX)).sort((a, b) => b.askedAt - a.askedAt)
  if (!stored.length) return
  const roster = await allEntries(ports.storage)
  const now = ports.now()
  let kept = 0
  const work: Promise<unknown>[] = []
  for (const asked of stored) {
    const known = shared.questions.get(asked.requestID)
    if (known?.call || known?.link || known?.settling || shared.passing.has(asked.requestID)) {
      kept++
      continue
    }
    const current =
      !asked.answered &&
      !shared.answered.has(asked.requestID) &&
      kept < MAX_STORED &&
      now - asked.askedAt <= RETENTION_MS &&
      lineageIn(roster, asked.sessionID).length > 0
    if (!current) {
      shared.questions.delete(asked.requestID)
      work.push(
        ports.storage
          .remove(keyOf(asked.requestID))
          .catch((error: unknown) => ports.log(`courier question: could not drop ${asked.requestID}: ${String(error)}`)),
      )
      continue
    }
    if (!known) shared.questions.set(asked.requestID, { ...asked })
    kept++
    work.push(
      tellCutOff(ports, known ?? asked, "restarted").catch((error: unknown) =>
        ports.log(`courier question: could not tell ${asked.top} about ${asked.requestID}: ${String(error)}`),
      ),
    )
  }
  await Promise.all(work)
}
