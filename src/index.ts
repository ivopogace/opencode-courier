import { Plugin } from "@opencode-ai/plugin"
import { Plugin as EffectPlugin } from "@opencode-ai/plugin/effect"
import { fromPromise } from "@opencode-ai/plugin/promise/adapter"
import { Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import type { Server } from "node:http"
import { describeFailure, listChildren, send, spawn, status, type CourierPorts } from "./courier.js"
import { cleanup, headOf, inspectWorktree, type CleanupPorts, type CleanupResult } from "./cleanup.js"
import { cancel, deliverDue, schedule, TICK_MS, type LaterPorts } from "./later.js"
import { answer, pendingOf, type AnswerPorts, type Permissions } from "./relay.js"
import { answerQuestion, isQuestion, joinRelay, noticeCutOff, pendingQuestions, relayQuestions, type QuestionPorts } from "./question.js"
import { pruneExpired } from "./roster.js"
import { watchChildren, type WatchState } from "./watch.js"
import { listen, readConfig, subscribe, unsubscribe, type WebhookConfig, type WebhookPorts } from "./webhook.js"

const SpawnInput = Schema.Struct({
  task: Schema.String.annotate({ description: "What the new session should do. It is told who started it and how to report back." }),
  title: Schema.optional(Schema.String.annotate({ description: "Session title; defaults to the task's first line." })),
  agent: Schema.optional(Schema.String.annotate({ description: "Agent to run the session with; defaults to the default agent." })),
  isolate: Schema.optional(
    Schema.Boolean.annotate({ description: "Run the session in its own git worktree so parallel sessions don't share files." }),
  ),
})

const SendInput = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The session to deliver to." }),
  message: Schema.String.annotate({ description: "The message text." }),
  queue: Schema.optional(
    Schema.Boolean.annotate({ description: "Wait until the target's current turn ends instead of steering it now." }),
  ),
})

const StatusInput = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The session to look at." }),
})

const ChildrenInput = Schema.Struct({
  sessionID: Schema.optional(
    Schema.String.annotate({ description: "The session whose children to list; defaults to this one." }),
  ),
})

const CleanupInput = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The isolated child whose worktree to remove." }),
  force: Schema.optional(
    Schema.Boolean.annotate({
      description: "Remove it even with uncommitted changes or commits on no branch; that work is lost.",
    }),
  ),
})

const LaterInput = Schema.Struct({
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

const AnswerInput = Schema.Struct({
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

const CancelInput = Schema.Struct({
  id: Schema.String.annotate({ description: "The id courier_later returned." }),
})

const SubscribeInput = Schema.Struct({
  topic: Schema.String.annotate({
    description:
      "owner/repo for every event of a GitHub repository, owner/repo#<number> for one pull request or issue " +
      "(reviews, comments, completed CI runs), or a plain name for deliveries posted to /hook/<name>.",
  }),
  sessionID: Schema.optional(Schema.String.annotate({ description: "The session to subscribe; defaults to this one." })),
})

const UnsubscribeInput = Schema.Struct({
  topic: Schema.optional(Schema.String.annotate({ description: "The topic to drop; all of this session's when omitted." })),
  sessionID: Schema.optional(Schema.String.annotate({ description: "The session to unsubscribe; defaults to this one." })),
})

/**
 * The webhook receiver, one per process like the claim set: every instance configured with a
 * `webhook` option joins `instances`, the first one starts the server, and the last one to unload
 * stops it. Requests are served with any live instance's ports; sessions and storage are shared.
 * A receiver that could not listen is dropped, so the next instance to load tries again, and a new
 * one waits for the previous one to finish closing, as on a plugin reload.
 */
interface Receiver {
  readonly config: WebhookConfig
  readonly instances: Set<WebhookPorts>
  readonly server: Promise<Server | undefined>
}
const receivers = ((globalThis as Record<symbol, unknown>)[Symbol.for("opencode-courier.receiver")] ??= {}) as {
  current?: Receiver
  closing?: Promise<void>
}

const sameSettings = (a: WebhookConfig, b: WebhookConfig) =>
  a.port === b.port && a.host === b.host && a.secret === b.secret && a.maxBytes === b.maxBytes

function startReceiver(config: WebhookConfig, log: (message: string) => void) {
  const instances = new Set<WebhookPorts>()
  const receiver: Receiver = {
    config,
    instances,
    server: (receivers.closing ?? Promise.resolve())
      .then(() => listen(config, () => instances.values().next().value))
      .then(
        (server) => {
          log(`courier webhook: listening on http://${config.host}:${(server.address() as { port: number }).port}`)
          return server
        },
        (error: unknown) => {
          log(`courier webhook: cannot listen on ${config.host}:${config.port}: ${String(error)}`)
          if (receivers.current === receiver) receivers.current = undefined
          return undefined
        },
      ),
  }
  return (receivers.current = receiver)
}

function joinReceiver(config: WebhookConfig, ports: WebhookPorts) {
  const receiver = receivers.current ?? startReceiver(config, ports.log)
  if (!sameSettings(receiver.config, config))
    ports.log(
      `courier webhook: already running on ${receiver.config.host}:${receiver.config.port} with other settings ` +
        "(port, host, secret or maxBytes); this location's are ignored. Set the webhook option once, in the global config.",
    )
  receiver.instances.add(ports)
  return async () => {
    receiver.instances.delete(ports)
    if (receiver.instances.size > 0 || receivers.current !== receiver) return
    receivers.current = undefined
    const closing = receiver.server.then(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server) return resolve()
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    )
    receivers.closing = closing
    await closing
    if (receivers.closing === closing) receivers.closing = undefined
  }
}

// One claim set for every instance in the process: OpenCode sets the plugin up once per project
// location, and those instances share one storage.
const claimed: Set<string> = ((globalThis as Record<symbol, unknown>)[Symbol.for("opencode-courier.claimed")] ??=
  new Set<string>()) as Set<string>

// Likewise one set of handled events, since every instance may be sent the same event, and the
// permission requests sessions were told about and have not answered.
const watched: WatchState = ((globalThis as Record<symbol, unknown>)[Symbol.for("opencode-courier.watched")] ??= {
  seen: new Set<string>(),
  waiting: new Set<string>(),
  answered: new Set<string>(),
}) as WatchState

// The permission domain of every loaded instance, under a key of its own. OpenCode keeps a request
// where its session runs, so a request of an isolated child is answered through the instance loaded
// in its worktree.
const locations: Map<object, Permissions> = ((globalThis as Record<symbol, unknown>)[Symbol.for("opencode-courier.locations")] ??=
  new Map<object, Permissions>()) as Map<object, Permissions>
const permissions = () => locations.values()

const rethrow =
  (tool: string) =>
  (error: unknown): never => {
    throw describeFailure(tool, error)
  }

function describeCleanup(result: CleanupResult) {
  if (result.outcome === "removed") return `Removed the worktree ${result.directory} of ${result.sessionID}.`
  if (result.outcome === "gone")
    return `The worktree ${result.directory} of ${result.sessionID} was already gone; dropped it from courier_children.`
  return `Kept the worktree ${result.directory} of ${result.sessionID}: it has ${result.reason}. Commit or branch what you want to keep, or call courier_cleanup again with force: true to discard it.`
}

const END_TURN = "If nothing else is left to do now, end your turn by replying without calling more tools."

function describeAnswer(result: Awaited<ReturnType<typeof answer>> | Awaited<ReturnType<typeof answerQuestion>>) {
  const kind = isQuestion(result.requestID) ? "question" : "request"
  if (!result.answered)
    return (
      `${result.sessionID} no longer waits on ${kind} ${result.requestID}: it was answered some other way, or the ` +
      "session stopped waiting. Nothing was passed on; tell the person their answer is not needed."
    )
  if ("reply" in result)
    return `Passed on ${result.reply} for request ${result.requestID} of ${result.sessionID}, which carries on and reports back with courier_send. ${END_TURN}`
  const how = "by" in result && result.by === "message" ? " as a message, since its question had been cut off" : ""
  return `Passed the answers to question ${result.requestID} on to ${result.sessionID}${how}; it carries on and reports back with courier_send. ${END_TURN}`
}

/** What a question relay needs from the plugin instance that wraps the question tool. */
export interface RelaySlot {
  ports?: QuestionPorts
}

/**
 * The courier tools, scheduler, webhook receiver and event watcher, as a promise plugin. `relay`
 * receives this instance's ports for the question relay while it is loaded.
 */
export const courier = (relay: RelaySlot = {}) => Plugin.define({
  id: "courier",
  setup: async (ctx) => {
    const questionPorts: QuestionPorts = {
      storage: ctx.storage,
      session: ctx.session,
      now: Date.now,
      newID: () => `question_${randomUUID()}`,
      log: (message) => console.error(message),
    }
    const ports: CourierPorts = {
      session: ctx.session,
      agent: ctx.agent,
      worktree: ctx.worktree,
      storage: ctx.storage,
      directory: ctx.location.directory,
      now: Date.now,
      head: headOf,
      pending: async (sessionID) => {
        const [requests, questions] = await Promise.all([
          pendingOf(permissions(), sessionID),
          pendingQuestions(ctx.storage, sessionID),
        ])
        return [...requests, ...questions]
      },
    }
    const cleanupPorts: CleanupPorts = { ...ports, inspect: inspectWorktree }
    const answerPorts: AnswerPorts = { storage: ctx.storage, permissions }
    // One tool answers both: a question's id is the plugin's own, a permission request's OpenCode's.
    const answerRequest = async (callerID: string, input: typeof AnswerInput.Type) => {
      const { sessionID, requestID } = input
      if (isQuestion(requestID)) {
        if (input.reply !== undefined || input.message !== undefined)
          throw new Error(`${requestID} is a question: pass the person's answers in answers, not reply or message.`)
        if (input.answers === undefined) throw new Error(`${requestID} is a question: answers is required, one entry per question.`)
        return answerQuestion(questionPorts, callerID, { sessionID, requestID, answers: input.answers })
      }
      if (input.answers !== undefined)
        throw new Error(`${requestID} is a permission request: pass the person's choice in reply (once, always or reject), not answers.`)
      if (input.reply === undefined) throw new Error(`${requestID} is a permission request: reply is required, once, always or reject.`)
      return answer(answerPorts, watched.waiting, callerID, {
        sessionID,
        requestID,
        reply: input.reply,
        ...(input.message !== undefined ? { message: input.message } : {}),
      })
    }
    const later: LaterPorts = {
      storage: ctx.storage,
      session: ctx.session,
      now: Date.now,
      newID: () => `later_${randomUUID()}`,
      log: (message) => console.error(message),
    }
    const hooks: WebhookPorts = { storage: ctx.storage, session: ctx.session, now: Date.now, log: later.log }
    let webhook: WebhookConfig | undefined
    try {
      webhook = readConfig(ctx.options)
    } catch (error) {
      later.log(`courier webhook: not started: ${error instanceof Error ? error.message : String(error)}`)
    }

    await ctx.tool.transform((tools) => {
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
          const child = await spawn(ports, context.sessionID, input).catch(rethrow("courier_spawn"))
          const warning = child.rosterError ? ` It is not on your courier_children list: ${child.rosterError}` : ""
          return {
            content:
              `Started session ${child.sessionID} in ${child.directory}. It will report back with courier_send, which ` +
              "starts a new turn for you. Once you have started every session you need, end your turn: reply without " +
              `calling more tools. That does not drop the task; you carry on with it when the reports arrive.${warning}`,
            metadata: child,
          }
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
          const delivered = await send(ports, context.sessionID, input).catch(rethrow("courier_send"))
          return { content: `Delivered to ${input.sessionID}.`, metadata: delivered }
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
          const result = await status(ports, input).catch(rethrow("courier_status"))
          return { content: JSON.stringify(result, null, 2), metadata: result }
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
          const listed = await listChildren(ports, input.sessionID || context.sessionID).catch(rethrow("courier_children"))
          return {
            content: listed.length ? JSON.stringify(listed, null, 2) : "No sessions started with courier_spawn.",
            metadata: { children: listed },
          }
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
          const result = await cleanup(cleanupPorts, context.sessionID, input).catch(rethrow("courier_cleanup"))
          return { content: describeCleanup(result), metadata: result }
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
          const result = await answerRequest(context.sessionID, input).catch(rethrow("courier_answer"))
          return { content: describeAnswer(result), metadata: result }
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
          const entry = await schedule(later, context.sessionID, input).catch(rethrow("courier_later"))
          const fireAt = new Date(entry.fireAt).toISOString()
          const next =
            entry.sessionID === context.sessionID
              ? "It arrives when due, after your current turn if one is running, so do not wait for it: once nothing " +
                "else is left to do now, end your turn by replying without calling more tools. If what it checks on " +
                "reports first, cancel it then with courier_cancel."
              : "Cancel it with courier_cancel if it is no longer needed."
          return {
            content: `Scheduled ${entry.id} for ${fireAt}, to ${entry.sessionID}. ${next}`,
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
          const cancelled = await cancel(later, input.id).catch(rethrow("courier_cancel"))
          return {
            content: cancelled ? `Cancelled ${input.id}.` : `Nothing pending under ${input.id}; it may have been delivered.`,
            metadata: { id: input.id, cancelled },
          }
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
          const subscription = await subscribe(hooks, sessionID, input.topic).catch(rethrow("courier_subscribe"))
          const receiving = (await receivers.current?.server) !== undefined
          const note = receiving
            ? ""
            : " Note: no webhook receiver runs in this OpenCode server (see the plugin's webhook option), so nothing will arrive yet."
          return {
            content: `Subscribed ${sessionID} to ${subscription.topic}.${note}`,
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
          const dropped = await unsubscribe(hooks, sessionID, input.topic).catch(rethrow("courier_unsubscribe"))
          return {
            content: dropped.length ? `Unsubscribed ${sessionID} from ${dropped.join(", ")}.` : `${sessionID} had no matching subscription.`,
            metadata: { sessionID, dropped },
          }
        },
      })
    })

    void pruneExpired(ctx.storage, Date.now()).catch((error: unknown) => console.error(`courier roster prune: ${String(error)}`))
    relay.ports = questionPorts
    const leaveRelay = joinRelay(questionPorts)
    void noticeCutOff(questionPorts).catch((error: unknown) => questionPorts.log(`courier question: stored questions: ${String(error)}`))

    let ticking = false
    const tick = async () => {
      if (ticking) return
      ticking = true
      await deliverDue(later, claimed)
        .catch((error: unknown) => later.log(`courier_later scheduler: ${String(error)}`))
        .finally(() => (ticking = false))
    }
    void tick()
    const timer = setInterval(tick, TICK_MS)
    const watching = new AbortController()
    const location = {}
    locations.set(location, ctx.permission)
    void watchChildren(
      { storage: ctx.storage, session: ctx.session, event: ctx.event, permission: ctx.permission, log: later.log },
      watched,
      watching.signal,
    )
    const leave = webhook ? joinReceiver(webhook, hooks) : undefined
    return async () => {
      clearInterval(timer)
      watching.abort()
      locations.delete(location)
      if (relay.ports === questionPorts) relay.ports = undefined
      leaveRelay()
      await leave?.()
    }
  },
})

/**
 * The plugin OpenCode loads. It is an Effect plugin, because the question relay wraps OpenCode's own
 * question tool, whose execute the promise API hands out only as a promise that cannot be
 * interrupted, so a child's question could not be withdrawn once its parent answered. Everything
 * else is the promise plugin above, run through the plugin package's own adapter, as OpenCode runs
 * a promise plugin.
 */
export default EffectPlugin.define({
  id: "courier",
  effect: (host) =>
    Effect.gen(function* () {
      const relay: RelaySlot = {}
      yield* fromPromise(courier(relay)).effect(host)
      yield* relayQuestions(host, () => relay.ports)
    }),
})
