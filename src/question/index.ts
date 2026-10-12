// The question relay: what the rest of the plugin uses of it. The relay's state is kept in the hub
// (`../platform/hub.ts`), under a process-wide key of its own; `types.ts` types it.
export { answerQuestion, noticeCutOff, pendingQuestions } from "./answer.js"
export { eventsFollowed, eventsLeft, formShown, formsMayHaveBeenMissed, joinRelay, locationClosing, shutdownReportedAt } from "./lifecycle.js"
export { byCodeUnit, type QuestionAnswerInput } from "./pure.js"
export { relayQuestions } from "./relay.js"
export { isQuestion, MAX_STORED, portsAt, QUESTION_TOOL } from "./shared.js"
export type { Answers, Asked, Elsewhere, Outcome, Prompt, QuestionPorts, QuestionTiming, Withdrawal } from "./types.js"
export type { QuestionAnswered } from "./answer.js"
