import { Schema } from "effect"
import { rethrow, type ToolEditor } from "../kernel/tool.js"
import { answer, REPLIES, type AnswerPorts, type Waiting } from "./permission.js"
import { answerQuestion, isQuestion, type QuestionPorts } from "./question/index.js"
import { answerText } from "./text.js"

export const AnswerInput = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The session you started that is waiting, as its notice names it." }),
  requestID: Schema.String.annotate({ description: "The request id from the notice." }),
  reply: Schema.optional(
    Schema.Literals(REPLIES).annotate({
      description: "For a permission request: the choice the person made, once, always (only when the notice offers it) or reject.",
    }),
  ),
  message: Schema.optional(
    Schema.String.annotate({ description: "For a permission request, with reject: the person's reason, passed on with the refusal." }),
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
async function answerRequest(ports: PersonToolPorts, callerID: string, input: typeof AnswerInput.Type) {
  const { sessionID, requestID } = input
  if (isQuestion(requestID)) {
    if (input.reply !== undefined || input.message !== undefined)
      throw new Error(`${requestID} is a question: pass the person's answers in answers, not reply or message.`)
    if (input.answers === undefined) throw new Error(`${requestID} is a question: answers is required, one entry per question.`)
    return answerQuestion(ports.questions, callerID, { sessionID, requestID, answers: input.answers })
  }
  if (input.answers !== undefined)
    throw new Error(`${requestID} is a permission request: pass the person's choice in reply (once, always or reject), not answers.`)
  if (input.reply === undefined) throw new Error(`${requestID} is a permission request: reply is required, once, always or reject.`)
  return answer(ports.answer, ports.waiting, callerID, {
    sessionID,
    requestID,
    reply: input.reply,
    ...(input.message !== undefined ? { message: input.message } : {}),
  })
}

/** Adds `courier_answer`. */
export function addPersonTools(tools: ToolEditor, ports: PersonToolPorts) {
  tools.add({
    name: "courier_answer",
    options: { codemode: false },
    description:
      "Pass on the answer to a permission request or a question that a session you started with courier_spawn (or " +
      "one started from it) waits on, after a notice from it named the request. The answer is the person's, not yours: " +
      "first ask the person you are working with, offering the choices the notice lists, then call this with what " +
      "they chose: reply for a permission request, answers for a question. Never choose for them. The session " +
      "carries on once it has the answer.",
    input: AnswerInput,
    execute: async (input, context) => {
      const result = await answerRequest(ports, context.sessionID, input).catch(rethrow("courier_answer"))
      return { content: answerText(result), metadata: result }
    },
  })
}
