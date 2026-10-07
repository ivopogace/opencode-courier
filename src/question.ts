import type { Plugin } from "@opencode/plugin"
import type { Plugin as EffectPlugin } from "@opencode/plugin/effect"
import { Cause, Effect, Exit, Result } from "effect"
import { addBounded } from "./bounded.js"
import {
  answeredText,
  cutOffAnswer,
  DISMISSED,
  envelope,
  passedNote,
  questionNotice,
  questionSettledNotice,
  unlinkedNote,
  withdrawnText,
  type Answers,
  type Asked,
  type CutOff,
  type Elsewhere,
  type Outcome,
  type Prompt,
  type QuestionAnswered,
  type Withdrawal,
} from "./notices.js"
import { allEntries, answeringTop, lineage, lineageIn, RETENTION_MS, type RosterStorage } from "./roster.js"
import { processWide, scanAll } from "./storage.js"

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

/** A question as stored; `answered` marks one whose answer went out but that could not be dropped. */
type Stored = Asked & { readonly answered?: true }

/**
 * A question this process knows: one whose call waits (`call`), or one whose call was cut off,
 * which is answered by message. `link` withdraws the top session's question call that passes its
 * answer on, once the question is settled without that call.
 */
interface Question extends Asked {
  /** The directory of the location the call runs in, whose shutdown withdraws its form. */
  directory?: string
  /** Hands the waiting call the top session's outcome; true once the call has ended with it. */
  call?: (outcome: Outcome) => Promise<boolean>
  link?: (how: Withdrawal) => void
  /** Storing the question and telling the top session, while that is under way. */
  relaying?: Promise<boolean>
  /** Working out what became of it once its call ended without the top session's answer. */
  settling?: Promise<void>
}

const storedOf = ({ directory: _directory, call: _call, link: _link, relaying: _relaying, settling: _settling, ...asked }: Question): Asked =>
  asked
const isPassing = (requestID: string) => shared.passing.has(requestID) || shared.answered.has(requestID)

/**
 * Shared by every plugin instance in the process, since a child and the session it asks can be in
 * different locations: the questions told to a top session and not yet settled, the cut-off ones
 * whose top session has been told so, and the question calls waiting for their form to be shown.
 */
interface Shared {
  readonly questions: Map<string, Question>
  readonly noticed: Set<string>
  readonly shown: Map<string, () => void>
  /** The questions whose answer is being passed on, each until that is done, and those whose answer went out. */
  readonly passing: Map<string, Promise<unknown>>
  readonly answered: Set<string>
  /** The ports of the loaded instances. */
  readonly loaded: Set<QuestionPorts>
  /** How many instances follow OpenCode's events now, and whether any has since the process started. */
  following: number
  followed: boolean
  /**
   * When OpenCode last reported each location shutting down (`location.shutdown`), by directory
   * in epoch milliseconds by the clock of the watcher that saw it; under `ANYWHERE` when the event named no location.
   */
  readonly shutdowns: Map<string, number>
  /** Woken when a location shuts down or an instance unloads: dismissals held to see whether one follows. */
  readonly closingWaiters: Set<() => void>
}
// Field by field, so a copy of the plugin loaded later in the process gets what an older copy lacks.
const sharedState = processWide<{ -readonly [K in keyof Shared]?: Shared[K] }>("opencode-courier.questions", () => ({}))
sharedState.questions ??= new Map()
sharedState.noticed ??= new Set()
sharedState.shown ??= new Map()
sharedState.passing ??= new Map()
sharedState.answered ??= new Set()
sharedState.loaded ??= new Set()
sharedState.following ??= 0
sharedState.followed ??= false
sharedState.shutdowns ??= new Map()
sharedState.closingWaiters ??= new Set()
const shared = sharedState as Shared

/**
 * The relay's timings, carried by its ports: how long a question cut off by a closing location
 * waits before an instance still loaded tells its top session, how long an answer waits for another
 * one to it that is still being passed on, how long what follows a call's end waits for the notice
 * of the question to go out, and how long a dismissal is held to see whether the location is
 * shutting down.
 */
export interface QuestionTiming {
  readonly closingGraceMs: number
  readonly passingWaitMs: number
  readonly relayWaitMs: number
  readonly dismissalGraceMs: number
}

/** The key of a shutdown reported without a location: it counts for every location. */
const ANYWHERE = ""

/** When the location at `directory` (any location, with none) was last reported shutting down; 0 if never. */
const shutdownAt = (directory: string | undefined) =>
  directory === undefined
    ? Math.max(0, ...shared.shutdowns.values())
    : Math.max(shared.shutdowns.get(directory) ?? 0, shared.shutdowns.get(ANYWHERE) ?? 0)

/**
 * For tests: when the location at `directory` was last reported shutting down, if at all; a shutdown
 * reported without a location counts for every directory, and with none given, any location's counts.
 */
export const shutdownReportedAt = (directory?: string) => shutdownAt(directory) || undefined

/**
 * Called for OpenCode's `location.shutdown`: the location at `directory` is closing, which
 * withdraws its open forms as if the person had dismissed them (before unloading the plugin
 * there, since OpenCode 2.0.22). The event's location is optional in the schema; without it,
 * the shutdown counts for every location. `at` is when, by the watcher's clock (epoch milliseconds).
 */
export function locationClosing(at: number, directory?: string) {
  shared.shutdowns.set(directory ?? ANYWHERE, at)
  for (const wake of shared.closingWaiters) wake()
}

/**
 * Whether a dismissal just seen in the location at `directory` was that location closing rather
 * than the person: true when it shut down within the dismissal grace before, or does so, or this
 * instance unloads, within the grace from now, by the clock of `ports`. A shutdown reported without a location counts for every
 * location, and with the directory unknown, any location's shutdown counts.
 */
function closingSoon(ports: QuestionPorts, loaded: () => boolean, directory: string | undefined): Promise<boolean> {
  const ms = ports.timing.dismissalGraceMs
  const closing = () => !loaded() || ports.now() - shutdownAt(directory) <= ms
  if (closing()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = (result: boolean) => {
      clearTimeout(timer)
      shared.closingWaiters.delete(wake)
      resolve(result)
    }
    // Woken by any shutdown or unload: only one that answers the question ends the wait.
    const wake = () => {
      if (closing()) done(true)
    }
    const timer = setTimeout(() => done(false), ms)
    timer.unref?.()
    shared.closingWaiters.add(wake)
  })
}

/** The promise's value, or undefined once `ms` have passed or it failed. */
function within<T>(promise: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!promise) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

export interface QuestionPorts {
  readonly storage: RosterStorage
  readonly session: Pick<Context["session"], "synthetic">
  /** The directory of the instance's location. */
  readonly directory: string
  /** The clock, in epoch milliseconds, as OpenCode's location shutdowns are recorded. */
  readonly now: () => number
  readonly timing: QuestionTiming
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
async function tellCutOff(ports: QuestionPorts, asked: Asked, cutOff: CutOff) {
  // Not while an answer to it is being passed on, which makes the notice moot.
  if (shared.noticed.has(asked.requestID) || isPassing(asked.requestID)) return
  // Claimed first, so two tellers at once send one notice; given back if it did not go out.
  claim(shared.noticed, asked.requestID)
  try {
    await tell(ports, asked, questionNotice(asked, cutOff), { asks: "question", request: asked.requestID, [cutOff]: "true" })
  } catch (error) {
    shared.noticed.delete(asked.requestID)
    throw error
  }
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
  const id = asked.requestID
  // One answer at a time, and once, per question in this process: storage cannot be claimed
  // atomically. A second answer waits for the first, and is passed on if the first was not.
  // While one is under way, nobody is told that the question was cut off, nor links to it.
  const since = ports.now()
  for (let under = shared.passing.get(id); under; under = shared.passing.get(id)) {
    const left = ports.timing.passingWaitMs - (ports.now() - since)
    if (left <= 0) throw new Error(`another answer to ${id} is still being passed on; try again in a while.`)
    await within(under, left)
  }
  if (shared.answered.has(id)) return undefined
  const passing = passOn(ports, asked, outcome)
  shared.passing.set(id, passing)
  // One that hangs, on a notice that never returns, gives way after a while, so the question can be
  // answered again; should it still go through, the child is told twice.
  const release = setTimeout(() => shared.passing.get(id) === passing && shared.passing.delete(id), ports.timing.passingWaitMs)
  release.unref?.()
  try {
    return await passing
  } finally {
    clearTimeout(release)
    if (shared.passing.get(id) === passing) shared.passing.delete(id)
  }
}

async function passOn(ports: QuestionPorts, asked: Asked, outcome: Outcome) {
  const id = asked.requestID
  let known = shared.questions.get(id)
  // Taken only if the call ends with it: one already ending some other way, its turn being
  // stopped or the person answering in its session, does not.
  if (known?.call && (await known.call(outcome))) {
    claim(shared.answered, id)
    shared.questions.delete(id)
    // A call of the top session linked to it, asking the person, is withdrawn: it is settled.
    known.link?.({ by: "top", outcome })
    return "result" as const
  }
  // Its call has just ended: whether it was cut off, and so stays registered, or was settled, and
  // so is dropped, is known once settle is through. The registry decides, not storage, which a
  // question whose record could not be written is missing from.
  if (known) {
    await known.settling
    if (shared.questions.get(id) !== known) return undefined
  } else {
    // Not known to this process: stored by one before it, and not yet loaded here.
    const stored = (await ports.storage.get(keyOf(id))) as Stored | undefined
    if (!stored || stored.answered) return undefined
    known = { ...stored }
    shared.questions.set(id, known)
  }
  await sendAnswer(ports, asked, outcome)
  // Dropped only once the message is out, so a failed send leaves it to be answered again; the
  // linked call, if any, goes then too, not before the answer is out.
  claim(shared.answered, id)
  shared.questions.delete(id)
  known.link?.({ by: "top", outcome })
  await forget(ports, asked)
  return "message" as const
}

/**
 * Drops a stored question whose answer went out. If that fails, it is marked answered instead, so
 * it is neither listed nor answered again, nor told about after a restart.
 */
async function forget(ports: QuestionPorts, asked: Asked) {
  try {
    await ports.storage.remove(keyOf(asked.requestID))
  } catch (error) {
    ports.log(`courier question: could not forget ${asked.requestID}: ${String(error)}`)
    const marked: Stored = { ...storedOf(asked), answered: true }
    await ports.storage.set(keyOf(asked.requestID), marked as never).catch(() => undefined)
  }
}

/** How many noticed and answered questions are remembered. */
const REMEMBERED = 1_000

/** Adds to one of the shared bounded sets. */
const claim = (set: Set<string>, value: string) => addBounded(set, value, REMEMBERED)

async function sendAnswer(ports: QuestionPorts, asked: Asked, outcome: Outcome) {
  await ports.session.synthetic({
    sessionID: asked.sessionID,
    text: envelope(asked.top, cutOffAnswer(asked, outcome), { answers: asked.requestID, ...("answers" in outcome ? {} : { dismissed: "true" }) }),
    description: `Answer from ${asked.top}`,
    metadata: { source: "courier", from: asked.top, answers: asked.requestID },
    delivery: "steer",
  })
}

/**
 * Answers a question of a session started, directly or through others, from the caller, which must
 * be the session at the top, as for permission requests. `answered` is false when it no longer waits.
 */
export async function answerQuestion(ports: QuestionPorts, callerID: string, input: QuestionAnswerInput): Promise<QuestionAnswered> {
  const { sessionID, requestID } = input
  await answeringTop(ports.storage, sessionID, callerID, "questions")
  const asked: Stored | undefined = shared.questions.get(requestID) ?? ((await ports.storage.get(keyOf(requestID))) as Stored | undefined)
  if (asked?.sessionID !== sessionID || asked.answered) return { sessionID, requestID, answered: false }
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
  for (const question of shared.questions.values())
    if (question.sessionID === sessionID && !isPassing(question.requestID)) add(question, !question.call)
  for (const asked of await scanAll<Stored>(storage, PREFIX))
    if (asked.sessionID === sessionID && !asked.answered && !isPassing(asked.requestID) && !found.has(asked.requestID))
      add(asked, true)
  return [...found.values()]
}

/**
 * On loading: drops stored questions that are too old, whose session is no longer on a roster, or
 * beyond the newest `MAX_STORED`, and tells the top session about the rest, which a restart cut off.
 */
export async function noticeCutOff(ports: QuestionPorts) {
  const stored = (await scanAll<Stored>(ports.storage, PREFIX)).sort((a, b) => b.askedAt - a.askedAt)
  if (!stored.length) return
  const roster = await allEntries(ports.storage)
  const now = ports.now()
  let kept = 0
  // Which to keep is decided here, newest first; the drops and the notices, one per question, then
  // go out together.
  const work: Promise<unknown>[] = []
  for (const asked of stored) {
    const known = shared.questions.get(asked.requestID)
    // Its call waits, or its top session is asking the person: nothing to tell.
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

/**
 * A plugin instance whose ports the relay may use, until the returned function is called. A
 * location loading again forgets the shutdown recorded for it, so a dismissal there is not
 * mistaken for that shutdown. One recorded for every location is left alone, since a dismissal
 * held in another location may still need it; it ages out with the grace.
 */
export function joinRelay(ports: QuestionPorts) {
  shared.loaded.add(ports)
  shared.shutdowns.delete(ports.directory)
  return () => {
    shared.loaded.delete(ports)
    for (const wake of shared.closingWaiters) wake()
  }
}

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

/** Called for OpenCode's `form.created`: a question call's form is shown, so its question can be relayed. */
export function formShown(event: { readonly data: { readonly form: { readonly sessionID: string; readonly metadata?: unknown } } }) {
  const call = (event.data.form.metadata as { tool?: { id?: unknown } } | undefined)?.tool?.id
  if (typeof call !== "string") return
  const key = `${event.data.form.sessionID} ${call}`
  shared.shown.get(key)?.()
  shared.shown.delete(key)
}

/**
 * Called when an event stream may have missed forms being shown: every call still waiting for its
 * form is taken as shown. One still waiting for its permission check is relayed early, which is the
 * lesser harm.
 */
export function formsMayHaveBeenMissed() {
  for (const shown of shared.shown.values()) shown()
  shared.shown.clear()
}

/**
 * Called when an instance starts following OpenCode's events. Every instance is sent every event,
 * so a form shown is missed only while none follows them; then the calls waiting are released, and
 * true is returned, for the caller to release them again on its first event, once it is connected.
 */
export function eventsFollowed() {
  const missed = shared.following === 0 && shared.followed
  shared.following++
  shared.followed = true
  if (missed) formsMayHaveBeenMissed()
  return missed
}

/** Called when an instance's event stream ended or broke. */
export function eventsLeft() {
  shared.following = Math.max(0, shared.following - 1)
}

const defectTag = (cause: Cause.Cause<unknown>) => {
  const defect = Cause.findDefect(cause)
  return Result.isSuccess(defect) ? (defect.success as { _tag?: unknown } | undefined)?._tag : undefined
}
/** OpenCode's question tool dies with this when the person dismisses the question. */
const isDismissal = (cause: Cause.Cause<unknown>) => defectTag(cause) === "QuestionTool.CancelledError"

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

/** How a relayed call ended. */
type CallExit = Exit.Exit<{ by: "child"; result: ToolResult } | { by: "top" }, unknown>

/** How a relayed call that the top session did not answer was settled in the asking session. */
function settledIn(exit: CallExit): Elsewhere {
  if (Exit.isSuccess(exit))
    return {
      by: "child",
      answers: ((exit.value as { result?: ToolResult }).result?.output as { answers?: Answers } | undefined)?.answers ?? [],
    }
  if (isDismissal(exit.cause)) return { by: "dismissed" }
  return { by: "failed", error: String(Cause.squash(exit.cause)) }
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
 * Orders strings by their UTF-16 code units, the default sort's order, stated. The order is never
 * shown; it only has to come out the same on both sides of a comparison, which a locale-aware
 * compare would not promise: it can rank two different labels as equal and leave them as listed.
 */
export function byCodeUnit(a: string, b: string) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

// The labels in any order: the answers are labels, so a top session listing them differently still asks the same.
const choices = (questions: ReadonlyArray<Prompt>) =>
  JSON.stringify(questions.map((prompt) => [!!prompt.multiple, prompt.options.map((option) => option.label).sort(byCodeUnit)]))
const wording = (questions: ReadonlyArray<Prompt>) =>
  JSON.stringify(questions.map((prompt) => prompt.question.trim().replace(/\s+/g, " ").toLowerCase()))

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

/** The answers that count once a linked call's question was settled without it: none unless it was answered. */
function withdrawnAnswers(linked: Question, how: Withdrawal): Answers {
  const none = () => linked.questions.map(() => [])
  switch (how.by) {
    case "top":
      return "answers" in how.outcome ? how.outcome.answers : none()
    case "child":
      return how.answers
    case "dismissed":
    case "failed":
      return none()
  }
}

/** The result of a linked call withdrawn because its question was settled without it. */
function withdrawnResult(linked: Question, how: Withdrawal) {
  return {
    output: { answers: withdrawnAnswers(linked, how) },
    content: withdrawnText(linked, how),
    metadata: { relayed: linked.requestID, withdrawn: true },
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

/** For tests: forgets every question this process knows. */
export function forgetQuestions() {
  shared.questions.clear()
  shared.noticed.clear()
  shared.shown.clear()
  shared.passing.clear()
  shared.answered.clear()
  shared.loaded.clear()
  shared.following = 0
  shared.followed = false
  shared.shutdowns.clear()
  shared.closingWaiters.clear()
}
