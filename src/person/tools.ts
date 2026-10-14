import { Schema } from "effect"
import { rethrow, type ToolEditor } from "../kernel/tool.js"
import { answer, isDeclined, PROPOSALS, type AnswerCall, type AnswerPorts, type Waiting } from "./permission.js"
import { answerQuestion, isQuestion, type QuestionPorts } from "./question/index.js"
import { answerText } from "./text.js"

export const AnswerInput = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The session you started that is waiting, as its notice names it." }),
  requestID: Schema.String.annotate({ description: "The request id from the notice." }),
  reply: Schema.optional(
    Schema.Literals(PROPOSALS).annotate({
      description:
        "For a permission request: the answer you propose, once or reject. With once, OpenCode first asks the person in " +
        "your session, and it is passed on only once they have allowed it; always is not granted through this tool.",
    }),
  ),
  message: Schema.optional(
    Schema.String.annotate({ description: "For a permission request, with reject: the reason, passed on with the refusal." }),
  ),
  answers: Schema.optional(
    Schema.Array(Schema.Union([Schema.String, Schema.Array(Schema.String)])).annotate({
      description:
        "For a question: one entry per question, in order, each the label the person chose or the text they gave, " +
        "or a list of labels where the question allows several.",
    }),
  ),
})

/** What the person's tool runs on. */
export interface PersonToolPorts {
  readonly answer: AnswerPorts
  readonly questions: QuestionPorts
  /** The permission requests sessions were told about and have not answered. */
  readonly waiting: Waiting
}

// One tool answers both: a question's id is the plugin's own, a permission request's OpenCode's.
async function answerRequest(ports: PersonToolPorts, callerID: string, input: typeof AnswerInput.Type, call?: AnswerCall) {
  const { sessionID, requestID } = input
  if (isQuestion(requestID)) {
    if (input.reply !== undefined || input.message !== undefined)
      throw new Error(`${requestID} is a question: pass the person's answers in answers, not reply or message.`)
    if (input.answers === undefined) throw new Error(`${requestID} is a question: answers is required, one entry per question.`)
    return answerQuestion(ports.questions, callerID, { sessionID, requestID, answers: input.answers })
  }
  if (input.answers !== undefined)
    throw new Error(`${requestID} is a permission request: pass the answer you propose in reply (once or reject), not answers.`)
  if (input.reply === undefined) throw new Error(`${requestID} is a permission request: reply is required, once or reject.`)
  return answer(ports.answer, ports.waiting, callerID, {
    sessionID,
    requestID,
    reply: input.reply,
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(call ? { call } : {}),
  })
}

/** Adds `courier_answer`. */
export function addPersonTools(tools: ToolEditor, ports: PersonToolPorts) {
  tools.add({
    name: "courier_answer",
    options: { codemode: false },
    description:
      "Pass on the answer to a permission request or a question that a session you started with courier_spawn (or " +
      "one started from it) waits on, after a notice from it named the request. For a permission request, reply is " +
      "the answer you propose, once or reject: proposing is not deciding. With once, OpenCode asks the person you are " +
      "working with in your session, as its own permission prompt for what that session asked, under your permission " +
      "rules, and the call returns once they have answered; what they allow is passed on, and a refusal with a reason " +
      "fails this call and is passed on with the reason. Do not ask them in your reply or with your question tool first. " +
      "For a question, answers is what the person chose: ask them first, with your question tool if you have one, and " +
      "never answer for them. The session carries on once it has the answer.",
    input: AnswerInput,
    execute: async (input, context) => {
      const call: AnswerCall = { messageID: context.messageID, callID: context.id }
      const result = await answerRequest(ports, context.sessionID, input, call).catch((error: unknown) => {
        // A plain rejection of the caller's prompt ends its step, as OpenCode's own tools do: it goes back as it is.
        if (isDeclined(error)) throw error
        return rethrow("courier_answer")(error)
      })
      return { content: answerText(result), metadata: result }
    },
  })
}
