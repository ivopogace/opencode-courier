import type { QuestionPorts } from "../hub.js"
import { cutOffAnswer, envelope, questionNotice, type Asked, type CutOff, type Outcome, type Prompt, type QuestionAnswered } from "../notices.js"
import { allEntries, answeringTop, lineageIn, RETENTION_MS, type RosterStorage } from "../roster.js"
import { scanAll } from "../storage.js"
import { within } from "./lifecycle.js"
import { normalize, type QuestionAnswerInput } from "./pure.js"
import { claim, isPassing, keyOf, MAX_STORED, PREFIX, shared, storedOf, type Stored } from "./shared.js"

export async function tell(ports: QuestionPorts, asked: Asked, text: string, attributes: Record<string, string>) {
  await ports.session.synthetic({
    sessionID: asked.top,
    text: envelope(asked.sessionID, text, attributes),
    description: `Session ${asked.sessionID} asks a question`,
    metadata: { source: "courier", from: asked.sessionID, requestID: asked.requestID, ...attributes },
    delivery: "steer",
  })
}

/** Tells the top session that a question's call was cut off, once per question and process. */
export async function tellCutOff(ports: QuestionPorts, asked: Asked, cutOff: CutOff) {
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

/**
 * Passes the top session's answer, or the person's dismissal, to a question: as the result of the
 * call that waits on it, or as a message when that call was cut off. False when it was settled.
 */
export async function deliver(ports: QuestionPorts, asked: Asked, outcome: Outcome) {
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
