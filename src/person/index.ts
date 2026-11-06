import type { PendingPrompt, WatchPorts } from "../tree/index.js"
import type { PersonPorts } from "./ports.js"
import type { Prompt } from "./question/index.js"

export { personEvents } from "./events.js"
export { formsShown } from "./form.js"
export { asksPermission, pendingOf } from "./permission.js"
export type { AnswerPorts, Permissions, Waiting } from "./permission.js"
export type { FormsShown, PersonPorts, PersonState } from "./ports.js"
export { registerPersonRpc } from "./rpc-handlers.js"
export { asksQuestion, joinRelay, noticeCutOff, pendingQuestions, portsAt, relayQuestions } from "./question/index.js"
export type { QuestionPorts } from "./question/index.js"
export { addPersonTools } from "./tools.js"
export type { PersonToolPorts } from "./tools.js"

type Satisfies<T extends U, U> = T

export type PromptMatchesPending = [Satisfies<Prompt, PendingPrompt>, Satisfies<PendingPrompt, Prompt>]

export type WatchPortsArePersonPorts = Satisfies<WatchPorts, PersonPorts>
