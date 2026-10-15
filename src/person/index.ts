// What the rest of the plugin uses of the person: the permission, form and question relays and the RPC
// of its TUI part. The question relay stays behind its own index.
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

/** The tree declares the question shape its `Pending` needs; this fails to compile once `Prompt` and it differ. */
export type PromptMatchesPending = [Satisfies<Prompt, PendingPrompt>, Satisfies<PendingPrompt, Prompt>]

/** The watcher's ports are the ones the person events run on; this fails to compile once `WatchPorts` stops satisfying `PersonPorts`. */
export type WatchPortsArePersonPorts = Satisfies<WatchPorts, PersonPorts>
