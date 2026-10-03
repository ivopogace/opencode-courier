import { Plugin } from "@opencode-ai/plugin"
import { Schema } from "effect"
import { randomUUID } from "node:crypto"
import type { Server } from "node:http"
import { describeFailure, listChildren, send, spawn, status, type CourierPorts } from "./courier.js"
import { cancel, deliverDue, schedule, TICK_MS, type LaterPorts } from "./later.js"
import { pruneExpired } from "./roster.js"
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

const LaterInput = Schema.Struct({
  message: Schema.String.annotate({ description: "The message to deliver." }),
  delayMinutes: Schema.optional(
    Schema.Number.annotate({ description: "Deliver this many minutes from now. Give this or at." }),
  ),
  at: Schema.optional(Schema.String.annotate({ description: "Deliver at this ISO 8601 time. Give this or delayMinutes." })),
  sessionID: Schema.optional(Schema.String.annotate({ description: "The session to deliver to; defaults to this one." })),
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

const rethrow =
  (tool: string) =>
  (error: unknown): never => {
    throw describeFailure(tool, error)
  }

export default Plugin.define({
  id: "courier",
  setup: async (ctx) => {
    const ports: CourierPorts = {
      session: ctx.session,
      worktree: ctx.worktree,
      storage: ctx.storage,
      directory: ctx.location.directory,
      now: Date.now,
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
          "Start a new OpenCode session on a task and return immediately. The session reports back with courier_send, " +
          "which wakes this session. DO NOT poll it or call courier_status in a loop; end your turn and wait. For long " +
          "tasks, also courier_later a check-in for yourself in case it never reports, and courier_cancel it when it does.",
        input: SpawnInput,
        execute: async (input, context) => {
          const child = await spawn(ports, context.sessionID, input).catch(rethrow("courier_spawn"))
          const warning = child.rosterError ? ` It is not on your courier_children list: ${child.rosterError}` : ""
          return {
            content: `Started session ${child.sessionID} in ${child.directory}. It will report back with courier_send.${warning}`,
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
        name: "courier_later",
        options: { codemode: false },
        description:
          "Schedule a message for a session (this one by default), delivered when due and waking it if idle. " +
          "Use it as a safety net when you start sessions: schedule a check-in, end your turn, and cancel it with " +
          "courier_cancel if the child reports first. Survives server restarts; may arrive up to ~15 seconds late.",
        input: LaterInput,
        execute: async (input, context) => {
          const entry = await schedule(later, context.sessionID, input).catch(rethrow("courier_later"))
          const fireAt = new Date(entry.fireAt).toISOString()
          return {
            content: `Scheduled ${entry.id} for ${fireAt}, to ${entry.sessionID}. Cancel it with courier_cancel.`,
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
    const leave = webhook ? joinReceiver(webhook, hooks) : undefined
    return async () => {
      clearInterval(timer)
      await leave?.()
    }
  },
})
