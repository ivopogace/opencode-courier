import type { Plugin } from "@opencode/plugin"
import { millis } from "../platform/json.js"
import { setBounded } from "../platform/bounded.js"
import { busy, endedAt, turnEnd, type BusyTimes } from "./domain.js"

type Session = Pick<Plugin.Context["session"], "context">

export interface Turn {
  readonly running: boolean
  readonly endedAt?: number
}

const ANSWERS_MAX = 500

// a delivered item stamps nothing until its first step (api-notes)
const FRESH_MS = 10_000

// a re-sent wake's delivery stamps nothing until its step (api-notes)
const REST_MS = 30_000

const RUNNING: Turn = { running: true }

const rest = (at: number | undefined): Turn => (at === undefined ? { running: false } : { running: false, endedAt: at })

type Answer = { readonly stamp: string; readonly turn: Promise<Turn>; until: number }

const answers = new WeakMap<Session, Map<string, Answer>>()

type Messages = Awaited<ReturnType<Session["context"]>>

export function turnOf(session: Session, sessionID: string, time: BusyTimes, now = Date.now()): Promise<Turn> {
  return resolve(session, sessionID, time, now, () => session.context({ sessionID }), true)
}

export function turnIn(session: Session, sessionID: string, time: BusyTimes, messages: Promise<Messages>, now = Date.now()): Promise<Turn> {
  return resolve(session, sessionID, time, now, () => messages, false)
}

function resolve(session: Session, sessionID: string, time: BusyTimes, now: number, load: () => Promise<Messages>, cached: boolean): Promise<Turn> {
  if (!busy(time)) return Promise.resolve(rest(millis(time.idle)))
  const known = answers.get(session) ?? new Map<string, Answer>()
  answers.set(session, known)
  const stamp = [time.updated, time.idle, time.busy].map(millis).join(" ")
  const found = known.get(sessionID)
  if (cached && found?.stamp === stamp && now < found.until) return found.turn
  const forget = () => {
    if (known.get(sessionID) === answer) known.delete(sessionID)
  }
  const turn = load().then(
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

export const runs = (session: Session, sessionID: string, time: BusyTimes, now?: number) =>
  turnOf(session, sessionID, time, now).then((turn) => turn.running)
