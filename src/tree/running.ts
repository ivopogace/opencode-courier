import type { Plugin } from "@opencode/plugin"
import { millis } from "../platform/json.js"
import { setBounded } from "../platform/bounded.js"
import { busy, endedAt, turnEnd, type BusyTimes } from "./domain.js"

type Session = Pick<Plugin.Context["session"], "context">

/** Whether a session runs and, when it does not, when its last turn ended, where known. */
export interface Turn {
  readonly running: boolean
  readonly endedAt?: number
}

/** How many sessions' answers each session port remembers. */
const ANSWERS_MAX = 500

/** How long after its stamp an answer of rest is read again: an item enqueued then may be delivered, stamping nothing until its step. */
const FRESH_MS = 10_000

/** How long an answer of rest is kept: an item waiting since a lost wake is delivered on the wake sent again, which stamps nothing. */
const REST_MS = 30_000

const RUNNING: Turn = { running: true }

const rest = (at: number | undefined): Turn => (at === undefined ? { running: false } : { running: false, endedAt: at })

/** A session's last answer read, the times it was read at, and until when an answer of rest holds. */
type Answer = { readonly stamp: string; readonly turn: Promise<Turn>; until: number }

/** Each session port's last answer per session, which holds until the next stamp, but for those `turnOf` drops or keeps `until`. */
const answers = new WeakMap<Session, Map<string, Answer>>()

/**
 * Whether a session runs and, at rest, when its last turn ended: by its times when they show rest, else by its transcript
 * (#324, #326), kept until the next stamp, a rest for `REST_MS` and not within `FRESH_MS` of it; one unread or empty runs.
 */
export function turnOf(session: Session, sessionID: string, time: BusyTimes, now = Date.now()): Promise<Turn> {
  if (!busy(time)) return Promise.resolve(rest(millis(time.idle)))
  const known = answers.get(session) ?? new Map<string, Answer>()
  answers.set(session, known)
  const stamp = `${millis(time.updated)} ${millis(time.idle)}`
  const found = known.get(sessionID)
  if (found?.stamp === stamp && now < found.until) return found.turn
  // Only its own answer: a newer read of the session may have taken its place meanwhile.
  const forget = () => {
    if (known.get(sessionID) === answer) known.delete(sessionID)
  }
  const turn = session.context({ sessionID }).then(
    (messages): Turn => {
      const end = turnEnd(messages)
      if (!messages.length) forget()
      if (!end) return RUNNING
      if (now - millis(time.updated) < FRESH_MS) forget()
      answer.until = now + REST_MS
      return rest(endedAt(end, time))
    },
    (): Turn => {
      forget()
      return RUNNING
    },
  )
  const answer: Answer = { stamp, turn, until: Number.POSITIVE_INFINITY }
  known.delete(sessionID)
  setBounded(known, sessionID, answer, ANSWERS_MAX)
  return turn
}

/** Whether a session runs (`turnOf`). */
export const runs = (session: Session, sessionID: string, time: BusyTimes, now?: number) =>
  turnOf(session, sessionID, time, now).then((turn) => turn.running)
