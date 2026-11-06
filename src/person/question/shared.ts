import { addBounded } from "../../platform/bounded.js"
import { hub, memberAt, sharedState } from "../../platform/hub.js"
import type { Registry } from "../../platform/storage.js"
import type { Asked, Question, QuestionPorts, QuestionState } from "./types.js"

export const QUESTION_TOOL = "question"

export const PREFIX = "question/"

export const MAX_STORED = 100

export type Stored = Asked & { readonly answered?: true }

export const storedOf = ({ directory: _directory, call: _call, link: _link, relaying: _relaying, settling: _settling, ...asked }: Question): Asked =>
  asked
export const isPassing = (requestID: string) => shared.passing.has(requestID) || shared.answered.has(requestID)

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

export const shared = questionState()

const portsOf = (member: { readonly questions: unknown } | undefined) => member?.questions as QuestionPorts | undefined

export const anyLoaded = (): QuestionPorts | undefined => portsOf(hub.members.values().next().value) ?? shared.loaded.values().next().value

export function portsAt(location: object): () => QuestionPorts | undefined {
  const own = memberAt(location)
  return () => (own && hub.members.has(own) ? portsOf(own) : undefined)
}

export const keyOf = (requestID: string) => `${PREFIX}${requestID}`

export const isQuestion = (requestID: string) => requestID.startsWith("question_")

const REMEMBERED = 1_000

export const claim = (set: Set<string>, value: string) => addBounded(set, value, REMEMBERED)
