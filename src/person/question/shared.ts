import { addBounded } from "../../platform/bounded.js"
import { hub, memberAt, sharedState } from "../../platform/hub.js"
import type { Registry } from "../../platform/storage.js"
import type { Asked, Question, QuestionPorts, QuestionState } from "./types.js"

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

/**
 * The relay's state in `registry`, the hub's `questions`, with the fields it lacks made: field by
 * field, since a copy before the hub may have made it without the fields added later.
 */
export function questionState(registry?: Registry) {
  const state = sharedState<{ -readonly [K in keyof QuestionState]?: QuestionState[K] }>("questions", () => ({}), registry)
  state.questions ??= new Map()
  state.noticed ??= new Set()
  state.shown ??= new Map()
  state.passing ??= new Map()
  state.answered ??= new Set()
  state.loaded ??= new Set()
  state.following ??= 0
  state.followed ??= false
  state.shutdowns ??= new Map()
  state.closingWaiters ??= new Set()
  return state as QuestionState
}

// Shared by every plugin instance in the process, since a child and the session it asks can be in
// different locations.
export const shared = questionState()

/** A member's question ports: every hub-v2 member's `questions` are its instance's, whichever copy joined it. */
const portsOf = (member: { readonly questions: unknown } | undefined) => member?.questions as QuestionPorts | undefined

/**
 * The ports of an instance still loaded, if any: a member of this copy's hub, or else one that a
 * copy of another hub version, or a release before the hub, keeps in `loaded`.
 */
export const anyLoaded = (): QuestionPorts | undefined => portsOf(hub.members.values().next().value) ?? shared.loaded.values().next().value

/**
 * The question ports of the member that just joined at `location`, while it is loaded: resolved once,
 * so a later instance at the same location does not take its place while this one is still loaded.
 */
export function portsAt(location: object): () => QuestionPorts | undefined {
  const own = memberAt(location)
  return () => (own && hub.members.has(own) ? portsOf(own) : undefined)
}

export const keyOf = (requestID: string) => `${PREFIX}${requestID}`

/** Whether a request id is a question's rather than a permission request's. */
export const isQuestion = (requestID: string) => requestID.startsWith("question_")

/** How many noticed and answered questions are remembered. */
const REMEMBERED = 1_000

/** Adds to one of the shared bounded sets. */
export const claim = (set: Set<string>, value: string) => addBounded(set, value, REMEMBERED)
