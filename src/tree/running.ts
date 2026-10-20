import type { Plugin } from "@opencode/plugin"
import { millis } from "../platform/json.js"
import { setBounded } from "../platform/bounded.js"
import { archivedSinceTurn, busy, endsIdle, type BusyTimes } from "./domain.js"

type Session = Pick<Plugin.Context["session"], "context">

/** How many archived sessions' answers each session port remembers. */
const ANSWERS_MAX = 500

/** Each session port's answers, by session and the times they were read at, which nothing changes without a new stamp. */
const answers = new WeakMap<Session, Map<string, Promise<boolean>>>()

/**
 * Whether a session runs: by its times (`busy`), unless its archive stamped them since its last turn ended, when its transcript
 * says (#324), its answer kept until the next stamp; one unread or empty is read again and leaves it running, as its times say.
 */
export function runs(session: Session, sessionID: string, time: BusyTimes): Promise<boolean> {
  if (!archivedSinceTurn(time)) return Promise.resolve(busy(time))
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
