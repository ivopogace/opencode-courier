import type { Plugin } from "@opencode/plugin"
import { millis } from "../platform/json.js"
import { setBounded } from "../platform/bounded.js"
import { busy, endsIdle, type BusyTimes } from "./domain.js"

type Session = Pick<Plugin.Context["session"], "context">

/** How many answers, each a session's at one stamp, each session port remembers. */
const ANSWERS_MAX = 500

/** Each session port's answers, by session and the times they were read at, which nothing changes without a new stamp. */
const answers = new WeakMap<Session, Map<string, Promise<boolean>>>()

/**
 * Whether a session runs: not when its last turn ended after its last stamp, else as its transcript says (#324, #326), the answer
 * kept until the next stamp; one unread or empty is read again and leaves it running, as its times say.
 */
export function runs(session: Session, sessionID: string, time: BusyTimes): Promise<boolean> {
  if (!busy(time)) return Promise.resolve(false)
  const known = answers.get(session) ?? new Map<string, Promise<boolean>>()
  answers.set(session, known)
  const key = `${sessionID} ${millis(time.updated)} ${millis(time.idle)}`
  const found = known.get(key)
  if (found) return found
  // Only its own answer: one evicted meanwhile may have made way for a newer read of the same stamp.
  const forget = () => {
    if (known.get(key) === read) known.delete(key)
    return true
  }
  const read: Promise<boolean> = session.context({ sessionID }).then((messages) => (messages.length ? !endsIdle(messages) : forget()), forget)
  setBounded(known, key, read, ANSWERS_MAX)
  return read
}
