import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { cleanup, type CleanupPorts } from "./cleanup.js"
import { describeFailure, listChildren, send, spawn, status, type CourierPorts } from "./courier.js"
import { cancel, schedule, type LaterPorts } from "./later.js"
import {
  answerText,
  cancelText,
  childrenText,
  cleanupText,
  laterText,
  sendText,
  spawnText,
  statusText,
  subscribeText,
  unsubscribeText,
} from "./notices.js"
import { answerQuestion, isQuestion, type QuestionPorts } from "./question.js"
import { answer, type AnswerPorts, type Waiting } from "./relay.js"
import { subscribe, unsubscribe, type WebhookPorts } from "./webhook.js"

/**
 * The courier tools: their input schemas, descriptions, and what each returns. The descriptions are
 * model-facing like the texts in `notices.ts`, and snapshotted with them in `test/notices.test.ts`.
 */

export const SpawnInput = Schema.Struct({
  task: Schema.String.annotate({ description: "What the new session should do. It is told who started it and how to report back." }),
  title: Schema.optional(Schema.String.annotate({ description: "Session title; defaults to the task's first line." })),
  agent: Schema.optional(Schema.String.annotate({ description: "Agent to run the session with; defaults to the default agent." })),
  isolate: Schema.optional(
    Schema.Boolean.annotate({ description: "Run the session in its own git worktree so parallel sessions don't share files." }),
  ),
})

export const SendInput = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The session to deliver to." }),
  message: Schema.String.annotate({ description: "The message text." }),
  queue: Schema.optional(
    Schema.Boolean.annotate({ description: "Wait until the target's current turn ends instead of steering it now." }),
  ),
})

export const StatusInput = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The session to look at." }),
})

export const ChildrenInput = Schema.Struct({
  sessionID: Schema.optional(
    Schema.String.annotate({ description: "The session whose children to list; defaults to this one." }),
  ),
})

export const CleanupInput = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The isolated child whose worktree to remove." }),
  force: Schema.optional(
    Schema.Boolean.annotate({
      description: "Remove it even with uncommitted changes or commits on no branch; that work is lost.",
    }),
  ),
})

export const LaterInput = Schema.Struct({
  message: Schema.String.annotate({ description: "The message to deliver." }),
  delayMinutes: Schema.optional(
    // Some models send the number as a string ("3", "3.0") whatever the schema says, and resend it
    // unchanged after the error, so a string is accepted and schedule reads it as a number.
    Schema.Union([Schema.Number, Schema.String]).annotate({
      description: "Deliver this many minutes from now. Give this or at.",
    }),
  ),
  at: Schema.optional(Schema.String.annotate({ description: "Deliver at this ISO 8601 time. Give this or delayMinutes." })),
  sessionID: Schema.optional(Schema.String.annotate({ description: "The session to deliver to; defaults to this one." })),
})

export const AnswerInput = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The session you started that is waiting, as its notice names it." }),
  requestID: Schema.String.annotate({ description: "The request id from the notice." }),
  reply: Schema.optional(
    Schema.Literals(["once", "always", "reject"]).annotate({
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

export const CancelInput = Schema.Struct({
  id: Schema.String.annotate({ description: "The id courier_later returned." }),
})

export const SubscribeInput = Schema.Struct({
  topic: Schema.String.annotate({
    description:
      "owner/repo for every event of a GitHub repository, owner/repo#<number> for one pull request or issue " +
      "(reviews, comments, completed CI runs), or a plain name for deliveries posted to /hook/<name>.",
  }),
  sessionID: Schema.optional(Schema.String.annotate({ description: "The session to subscribe; defaults to this one." })),
})

export const UnsubscribeInput = Schema.Struct({
  topic: Schema.optional(Schema.String.annotate({ description: "The topic to drop; all of this session's when omitted." })),
  sessionID: Schema.optional(Schema.String.annotate({ description: "The session to unsubscribe; defaults to this one." })),
})

/** The editor OpenCode hands a tool transform. */
export type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]

/** What the tools run on: one plugin instance's ports. */
export interface ToolPorts {
  readonly courier: CourierPorts
  readonly cleanup: CleanupPorts
  readonly later: LaterPorts
  readonly answer: AnswerPorts
  readonly questions: QuestionPorts
  readonly hooks: WebhookPorts
  /** The permission requests sessions were told about and have not answered. */
  readonly waiting: Waiting
  /** Whether a webhook receiver runs in this server. */
  readonly receiving: () => Promise<boolean>
}

const rethrow =
  (tool: string) =>
  (error: unknown): never => {
    throw describeFailure(tool, error)
  }

// One tool answers both: a question's id is the plugin's own, a permission request's OpenCode's.
async function answerRequest(ports: ToolPorts, callerID: string, input: typeof AnswerInput.Type) {
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

/** Adds the courier tools, each a direct tool rather than a code-mode one. */
export function addTools(tools: ToolEditor, ports: ToolPorts) {
  tools.add({
    name: "courier_spawn",
    options: { codemode: false },
    description:
      "Start a new OpenCode session on a task and return immediately. It runs on your model. The session reports " +
      "back with courier_send, which wakes this session, and you are told if its turn fails instead, it waits for a " +
      "permission or it asks a question. DO NOT poll it or call courier_status in a loop: once you have started the sessions " +
      "you need, end your turn by replying without calling more tools; each report starts a new turn in which you " +
      "carry on. For long tasks, also courier_later a check-in for yourself in case it never reports, and " +
      "courier_cancel it when it does.",
    input: SpawnInput,
    execute: async (input, context) => {
      const child = await spawn(ports.courier, context.sessionID, input).catch(rethrow("courier_spawn"))
      return { content: spawnText(child), metadata: child }
    },
  })

  tools.add({
    name: "courier_send",
    options: { codemode: false },
    description:
      "Deliver a message to another OpenCode session. If that session is idle, OpenCode starts a new turn for it. " +
      "Use it to report back to the session that started you, or to steer a session you started.",
    input: SendInput,
    execute: async (input, context) => {
      const delivered = await send(ports.courier, context.sessionID, input).catch(rethrow("courier_send"))
      return { content: sendText(input.sessionID), metadata: delivered }
    },
  })

  tools.add({
    name: "courier_status",
    options: { codemode: false },
    description:
      "Look once at a session's state and its last reply, e.g. on a scheduled check-in. Not for waiting: " +
      "sessions you started report back on their own.",
    input: StatusInput,
    execute: async (input) => {
      const result = await status(ports.courier, input).catch(rethrow("courier_status"))
      return { content: statusText(result), metadata: result }
    },
  })

  tools.add({
    name: "courier_children",
    options: { codemode: false },
    description:
      "List the sessions this one started with courier_spawn, with each one's state and last reply, e.g. after a " +
      "compaction or restart. Like courier_status, for a one-off look, not for waiting.",
    input: ChildrenInput,
    execute: async (input, context) => {
      const listed = await listChildren(ports.courier, input.sessionID || context.sessionID).catch(rethrow("courier_children"))
      return { content: childrenText(listed), metadata: { children: listed } }
    },
  })

  tools.add({
    name: "courier_cleanup",
    options: { codemode: false },
    description:
      "Remove the git worktree of a session you started with isolate: true, once you have what you need from it, " +
      "and drop it from courier_children. A worktree with uncommitted changes or commits on no branch is kept and " +
      "the result lists them; commit or branch what you want, or pass force: true to discard it.",
    input: CleanupInput,
    execute: async (input, context) => {
      const result = await cleanup(ports.cleanup, context.sessionID, input).catch(rethrow("courier_cleanup"))
      return { content: cleanupText(result), metadata: result }
    },
  })

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
      return { content: answerText(result, isQuestion(result.requestID) ? "question" : "request"), metadata: result }
    },
  })

  tools.add({
    name: "courier_later",
    options: { codemode: false },
    description:
      "Schedule a message for a session (this one by default), delivered when due and waking it if idle. " +
      "Use it as a safety net when you start sessions: schedule one check-in, end your turn by replying without " +
      "calling more tools, and cancel it with courier_cancel if the child reports first. Survives server restarts; " +
      "may arrive up to ~15 seconds late.",
    input: LaterInput,
    execute: async (input, context) => {
      const entry = await schedule(ports.later, context.sessionID, input).catch(rethrow("courier_later"))
      const fireAt = new Date(entry.fireAt).toISOString()
      return {
        content: laterText(entry, fireAt, entry.sessionID === context.sessionID),
        metadata: { id: entry.id, fireAt, sessionID: entry.sessionID },
      }
    },
  })

  tools.add({
    name: "courier_cancel",
    options: { codemode: false },
    description: "Cancel a message scheduled with courier_later, e.g. because the child it was waiting for reported.",
    input: CancelInput,
    execute: async (input) => {
      const cancelled = await cancel(ports.later, input.id).catch(rethrow("courier_cancel"))
      return { content: cancelText(input.id, cancelled), metadata: { id: input.id, cancelled } }
    },
  })

  tools.add({
    name: "courier_subscribe",
    options: { codemode: false },
    description:
      "Wake a session (this one by default) when a webhook arrives for a topic: a GitHub repository, one of its " +
      "pull requests or issues (reviews, comments, completed CI runs), or a named generic hook. Each matching " +
      "delivery arrives as a message, queued behind any running turn. End your turn and wait; do not poll.",
    input: SubscribeInput,
    execute: async (input, context) => {
      const sessionID = input.sessionID ?? context.sessionID
      const subscription = await subscribe(ports.hooks, sessionID, input.topic).catch(rethrow("courier_subscribe"))
      const receiving = await ports.receiving()
      return {
        content: subscribeText(sessionID, subscription.topic, receiving),
        metadata: { sessionID, topic: subscription.topic, receiver: receiving },
      }
    },
  })

  tools.add({
    name: "courier_unsubscribe",
    options: { codemode: false },
    description: "Stop webhook deliveries for a topic, or all of a session's topics, e.g. once its pull request is merged.",
    input: UnsubscribeInput,
    execute: async (input, context) => {
      const sessionID = input.sessionID ?? context.sessionID
      const dropped = await unsubscribe(ports.hooks, sessionID, input.topic).catch(rethrow("courier_unsubscribe"))
      return { content: unsubscribeText(sessionID, dropped), metadata: { sessionID, dropped } }
    },
  })
}
