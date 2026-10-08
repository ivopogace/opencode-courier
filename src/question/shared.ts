import { addBounded } from "../bounded.js"
import { hub, type Question, type QuestionPorts } from "../hub.js"
import type { Asked } from "../notices.js"

/** OpenCode's own question tool, which the relay wraps. */
export const QUESTION_TOOL = "question"

export const PREFIX = "question/"

/** At most this many questions are kept in storage; the oldest go first. */
export const MAX_STORED = 100

/** A question as stored; `answered` marks one whose answer went out but that could not be dropped. */
export type Stored = Asked & { readonly answered?: true }

export const storedOf = ({ directory: _directory, call: _call, link: _link, relaying: _relaying, settling: _settling, ...asked }: Question): Asked =>
  asked
export const isPassing = (requestID: string) => shared.passing.has(requestID) || shared.answered.has(requestID)

// Shared by every plugin instance in the process, since a child and the session it asks can be in
// different locations.
export const shared = hub.questions

/**
 * The ports of an instance still loaded, if any: a member of this copy's hub, or else one that a
 * copy of another hub version, or a release before the hub, keeps in `loaded`.
 */
export const anyLoaded = (): QuestionPorts | undefined =>
  hub.members.values().next().value?.questions ?? shared.loaded.values().next().value

export const keyOf = (requestID: string) => `${PREFIX}${requestID}`

/** Whether a request id is a question's rather than a permission request's. */
export const isQuestion = (requestID: string) => requestID.startsWith("question_")

/** How many noticed and answered questions are remembered. */
const REMEMBERED = 1_000

/** Adds to one of the shared bounded sets. */
export const claim = (set: Set<string>, value: string) => addBounded(set, value, REMEMBERED)
