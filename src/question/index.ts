// The question relay: what the rest of the plugin uses of it. The relay's state is kept in the hub
// (`../hub.ts`), shared by every plugin instance in the process.
export { answerQuestion, noticeCutOff, pendingQuestions } from "./answer.js"
export { eventsFollowed, eventsLeft, formShown, formsMayHaveBeenMissed, joinRelay, locationClosing, shutdownReportedAt } from "./lifecycle.js"
export { byCodeUnit, type QuestionAnswerInput } from "./pure.js"
export { relayQuestions } from "./relay.js"
export { isQuestion, MAX_STORED, QUESTION_TOOL } from "./shared.js"
export type { QuestionPorts, QuestionTiming } from "../hub.js"
