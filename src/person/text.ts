import { END_TURN } from "../kernel/protocol.js"
import type {
  Asked,
  Elsewhere,
  Form,
  FormField,
  Outcome,
  PermissionAnswered,
  PermissionRequest,
  Prompt,
  QuestionAnswered,
  Reply,
  Withdrawal,
} from "./ports.js"

export type AnswerResult = PermissionAnswered | QuestionAnswered

export function answerText(result: AnswerResult) {
  if (!result.answered && "reply" in result)
    return (
      `Nothing was passed on: no request ${result.requestID} of ${result.sessionID} is pending in this OpenCode server. ` +
      "It was answered some other way, or the session stopped waiting, or it waits in another OpenCode server on the " +
      "same data directory, which this one cannot reach; only the person can see which. Tell them: \"Your answer was " +
      "not passed on. If the session still waits, its request is in another OpenCode server: answer it there, in that " +
      `session." Do not message the session about it or answer it again from here. ${END_TURN}`
    )
  if (!result.answered)
    return (
      `${result.sessionID} no longer waits on question ${result.requestID}: it was answered some other way, or the ` +
      "session stopped waiting. Nothing was passed on; tell the person their answer is not needed."
    )
  if ("reply" in result && result.reply === "reject")
    return `Passed on reject for request ${result.requestID} of ${result.sessionID}; its call fails and it carries on, and reports back with courier_send. ${END_TURN}`
  if ("reply" in result)
    return `Allowed in your session, by the person in OpenCode's prompt or by your rules, and passed on ${result.reply} for request ${result.requestID} of ${result.sessionID}, which carries on and reports back with courier_send. ${END_TURN}`
  const how = result.by === "message" ? " as a message, since its question had been cut off" : ""
  return `Passed the answers to question ${result.requestID} on to ${result.sessionID}${how}; it carries on and reports back with courier_send. ${END_TURN}`
}

export const REJECTED = "Refused by the person or the top session of the tree. Do without it, or report back why you cannot."

export function refusedText(sessionID: string, requestID: string, reason: string) {
  return `not allowed in your session (${reason}). The refusal was passed on with that reason to request ${requestID} of ${sessionID}, so its call fails and it carries on; it reports back with courier_send. Tell the person, and do not propose it again unless they ask.`
}

const MAX_RESOURCES = 20
const MAX_RESOURCE_LENGTH = 300

const clip = (text: string) => (text.length > MAX_RESOURCE_LENGTH ? `${text.slice(0, MAX_RESOURCE_LENGTH - 3)}...` : text)

export const origin = (startedBy?: string) =>
  startedBy ? `which ${startedBy} started with courier_spawn, a session started from yours,` : "which you started with courier_spawn,"

export const STAYS_QUIET =
  "and then it does not report back on its own: if it stays quiet, message it with courier_send to have it carry on."

export function permissionNotice(title: string, request: PermissionRequest, startedBy?: string, native = false) {
  const resources = request.resources.slice(0, MAX_RESOURCES).map((resource) => `- ${clip(resource)}`)
  if (request.resources.length > MAX_RESOURCES) resources.push(`- and ${request.resources.length - MAX_RESOURCES} more`)
  return [
    `This session, "${title}", ${origin(startedBy)} is waiting for permission and does nothing until it is answered.`,
    `It asks for: ${request.action}`,
    ...(resources.length ? ["On:", ...resources] : []),
    ...(request.message ? [`Note: ${request.message}`] : []),
    "",
    ...(native ? nativePermission(request) : permissionAsk(request)),
  ].join("\n")
}

const permissionAsk = (request: PermissionRequest) => [
  "You cannot decide this: the person you are working with does, in OpenCode's own permission prompt, which opens in your session when you propose once. Do not ask them in your reply or with your question tool first; propose one of these:",
  "- once: allow this request only; OpenCode first asks the person in your session, under your permission rules, and it is passed on only once they have allowed it",
  "- reject: refuse it, with a reason if the person gave one; the session's call fails and it carries on",
  `Call courier_answer with sessionID "${request.sessionID}", requestID "${request.id}", reply set to the choice and, with reject, message set to the reason.`,
  "Propose once unless the person has told you to refuse it, or the request plainly goes against what they asked of you; with once, the call returns when they have answered the prompt (or your rules allow the action without one). A refusal there with a reason fails the call with it, which the session is given; one without a reason ends your turn, and the session waits on.",
]

const nativePermission = (request: PermissionRequest) => [
  "OpenCode already shows this request to the person you are working with, as its own permission prompt in your session (and in the paired app's request dock), where they answer it; you will be told once it is answered.",
  "Do not ask them yourself, with your question tool or in your reply, and do not call courier_answer for it, which would only ask them a second time: at most tell them in one line that this session waits on their permission, then end your turn.",
  `Only if they tell you to answer it for them, call courier_answer with sessionID "${request.sessionID}", requestID "${request.id}" and reply set to once or reject (with reject, message set to the reason); with once, OpenCode asks them again in your session before it is passed on.`,
]

export function permissionSettledNotice(title: string, requestID: string, reply: Reply) {
  return [
    `The permission request ${requestID} of this session, "${title}", has been answered (${reply}) without courier_answer, so it no longer waits on you.`,
    "If you asked someone about it, tell them it is settled; there is nothing to pass on.",
    ...(reply === "reject"
      ? [`A refusal without a reason ends the session's turn, ${STAYS_QUIET}`]
      : []),
  ].join("\n")
}

export const WEBSEARCH_FORM = "websearch.provider"

export const kindOf = (form: Form) => {
  const kind = form.metadata?.kind
  return typeof kind === "string" && /^[\w.-]{1,60}$/.test(kind) ? kind : undefined
}

function fieldLines(field: FormField) {
  const label = [field.title, field.description].filter(Boolean).join(": ") || field.key
  const options = (field.options ?? []).slice(0, MAX_RESOURCES).map((option) => `  - ${clip(option.label)}`)
  if ((field.options?.length ?? 0) > MAX_RESOURCES) options.push(`  - and ${field.options!.length - MAX_RESOURCES} more`)
  let kind = ` (${field.type})`
  if (field.type === "external" && field.url) kind = `, opens ${clip(field.url)}`
  else if (field.options?.length) kind = ""
  const when = field.when?.length ? " (only for some earlier answers)" : ""
  return [`- ${clip(label)}${kind}${when}`, ...options]
}

function formLines(fields: ReadonlyArray<FormField>) {
  const shown = fields.filter((field) => !field.hidden)
  const lines = shown.slice(0, MAX_RESOURCES).flatMap(fieldLines)
  if (shown.length > MAX_RESOURCES) lines.push(`- and ${shown.length - MAX_RESOURCES} more fields`)
  return lines
}

const WEBSEARCH_NOTE = [
  "This is OpenCode asking whether to search the web, and through which provider.",
  'It waits at most a minute; then the session\'s search fails with "Web search cancelled" and it carries on without it.',
  "The choice is kept for every session: once it is made, in any session, no session is asked again.",
  'Besides answering the form, the person can make it by running a web search in their own session, or under OpenCode\'s "Third-party search" setting.',
]

function formPlace(sessionID: string, shownIn: string, top: string) {
  if (shownIn === sessionID) return { where: `in session ${sessionID} itself`, which: "that session" }
  const lists = "where OpenCode shows the forms of the sessions under it"
  if (shownIn === top) return { where: `in your own session, ${lists}`, which: "your session" }
  return { where: `in session ${shownIn}, ${lists}`, which: `session ${shownIn}` }
}

export function formNotice(title: string, form: Form, startedBy?: string, shownIn = form.sessionID, top = "") {
  const { where, which } = formPlace(form.sessionID, shownIn, top)
  return [
    `This session, "${title}", ${origin(startedBy)} shows a form, "${clip(form.title)}", and waits until it is answered.`,
    ...formLines(form.fields),
    ...(kindOf(form) === WEBSEARCH_FORM ? ["", ...WEBSEARCH_NOTE] : []),
    "",
    `Neither you nor courier_answer can answer it: only the person you are working with can, ${where}.`,
    `Do not choose for them. Tell them ${which} shows this form and waits on them, then carry on.`,
  ].join("\n")
}

export function formSettledNotice(title: string, formID: string, settled: "answered" | "cancelled") {
  return [
    settled === "answered"
      ? `The form ${formID} of this session, "${title}", has been answered, so it no longer waits on it.`
      : `The form ${formID} of this session, "${title}", has been withdrawn unanswered: dismissed, given up on or cut off, so it no longer waits on it.`,
    "If you told someone about it, tell them it is settled; there is nothing to pass on.",
  ].join("\n")
}

export function answeredText(questions: ReadonlyArray<Prompt>, answers: ReadonlyArray<ReadonlyArray<string>>) {
  const formatted = questions
    .map((prompt, index) => `"${prompt.question}"="${answers[index]?.length ? answers[index].join(", ") : "Unanswered"}"`)
    .join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

const describeOption = (option: Prompt["options"][number]) =>
  option.description ? `   - ${option.label}: ${option.description}` : `   - ${option.label}`

const describeQuestions = (questions: ReadonlyArray<Prompt>) =>
  questions.flatMap((prompt, index) => [
    `${index + 1}. ${prompt.header}: ${prompt.question} (${prompt.multiple ? "any of" : "one of"}, or an answer of their own:)`,
    ...prompt.options.map(describeOption),
  ])

const CUT_OFF = {
  stopped: "its turn was stopped (interrupted, or ended by OpenCode after an hour without activity)",
  restarted: "OpenCode restarted, or closed the session's project",
}

export type CutOff = keyof typeof CUT_OFF

export function questionNotice(asked: Asked, cutOff?: CutOff) {
  return [
    cutOff
      ? `This session, "${asked.title}", ${origin(asked.startedBy)} was asking the question below when ${CUT_OFF[cutOff]}. The question is no longer shown anywhere, and the session does nothing until it gets the answer.`
      : `This session, "${asked.title}", ${origin(asked.startedBy)} asks the question below and waits for the answer.`,
    ...describeQuestions(asked.questions),
    "",
    "Do not answer it yourself. Ask the person you are working with, using your question tool with exactly these questions:",
    JSON.stringify({ questions: asked.questions }),
    `What they choose there is passed on to the session${cutOff ? " as a message, which wakes it" : ""}. If you cannot use your question tool, or they answer some other way, call courier_answer with sessionID "${asked.sessionID}", requestID "${asked.requestID}" and answers: one entry per question, in order, each the label they chose or the text they gave (a list of labels where a question allows several).`,
  ].join("\n")
}

export function nativeQuestionNotice(asked: Asked) {
  return [
    `This session, "${asked.title}", ${origin(asked.startedBy)} asks the question below and waits for the answer.`,
    ...describeQuestions(asked.questions),
    "",
    "OpenCode shows this question to the person you are working with in your own session, and they answer it there; you will be told once it is answered.",
    "Do not ask them yourself, with your question tool or in your reply, and do not answer it: at most tell them in one line that this session's question waits for them, then end your turn.",
    `If they give you the answer some other way, call courier_answer with sessionID "${asked.sessionID}", requestID "${asked.requestID}" and answers: one entry per question, in order, each the label they chose or the text they gave (a list of labels where a question allows several).`,
  ].join("\n")
}

function settledHow(asked: Asked, how: Elsewhere) {
  const where = asked.native || (how.by === "child" && how.via === "inbox") ? "by the person" : "in its own session"
  if (how.by === "child") return `answered ${where} (${answeredText(asked.questions, how.answers)})`
  if (how.by === "dismissed") return `dismissed ${where}, without an answer`
  return `ended without an answer: its question call failed (${how.error})`
}

export function questionSettledNotice(asked: Asked, how: Elsewhere) {
  const what = settledHow(asked, how)
  return [
    `The question ${asked.requestID} of this session, "${asked.title}", was ${what}, so it no longer waits on you.`,
    "If you asked someone about it, tell them it is settled; there is nothing to pass on.",
    ...(how.by === "child"
      ? []
      : [`That ends the session's turn, ${STAYS_QUIET}`]),
  ].join("\n")
}

export const DISMISSED =
  "The person dismissed this question without answering it. Carry on without the answers, or report back with courier_send to the session that started you why you cannot."

export function cutOffAnswer(asked: Asked, outcome: Outcome) {
  return "answers" in outcome
    ? `Your question ${asked.requestID} was cut off before it was answered; here is the answer. ${answeredText(asked.questions, outcome.answers)}`
    : `Your question ${asked.requestID} was cut off before it was answered, and then dismissed without an answer. Carry on without the answers, or report back with courier_send why you cannot.`
}

export function unlinkedNote(waiting: ReadonlyArray<Pick<Asked, "sessionID" | "requestID">>) {
  const which = waiting.map((question) => `session ${question.sessionID} (requestID "${question.requestID}")`).join(", ")
  return `If you asked this for ${which}, these answers were not passed on by themselves: pass them on with courier_answer.`
}

function withdrawnHow(linked: Asked, how: Withdrawal): string {
  switch (how.by) {
    case "top":
      return "answers" in how.outcome
        ? `already answered with courier_answer (${answeredText(linked.questions, how.outcome.answers)})`
        : "already dismissed in your session, so it carries on without the answers"
    case "child":
      return `answered ${how.via === "inbox" ? "by the person" : "in its own session"} (${answeredText(linked.questions, how.answers)})`
    case "dismissed":
      return "dismissed in its own session, which ends its turn; message it with courier_send if it should carry on"
    case "failed":
      return `ended: its question call failed (${how.error})`
  }
}

export function withdrawnText(linked: Asked, how: Withdrawal) {
  return `Session ${linked.sessionID} no longer waits on this question: it was ${withdrawnHow(linked, how)}. There is nothing to pass on; tell the person it is settled.`
}

export function passedNote(linked: Asked, passed: string | undefined) {
  if (passed === "result")
    return `These answers were passed on to session ${linked.sessionID}, which carries on with them; do not call courier_answer for ${linked.requestID}. ${END_TURN}`
  if (passed === "message")
    return `These answers were passed on to session ${linked.sessionID} as a message, since its question had been cut off; it carries on with them. Do not call courier_answer for ${linked.requestID}. ${END_TURN}`
  if (passed === undefined)
    return `Session ${linked.sessionID} no longer waits on this question: it had already been answered or settled, so these answers were not passed on; tell the person so.`
  return `Passing these answers on to session ${linked.sessionID} failed (${passed.slice(7)}); call courier_answer with requestID "${linked.requestID}" to pass them on.`
}
