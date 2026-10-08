import { Plugin } from "@opencode/plugin"
import { Plugin as EffectPlugin } from "@opencode/plugin/effect"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import type { CourierPorts } from "./courier.js"
import { headOf, inspectWorktree, type CleanupPorts } from "./cleanup.js"
import { hub, join, permissions, type Receiver } from "./hub.js"
import type { LaterPorts } from "./later.js"
import { pendingOf, type AnswerPorts } from "./relay.js"
import { joinRelay, noticeCutOff, pendingQuestions, relayQuestions, type QuestionPorts } from "./question/index.js"
import { pruneExpired } from "./roster.js"
import { addTools, type ToolPorts } from "./tools.js"
import { watchFromHub, type WatchPorts, type WatchState } from "./watch.js"
import { builtVersions, versionNotice } from "./version.js"
import { listen, readConfig, type WebhookConfig, type WebhookPorts } from "./webhook.js"

/**
 * The webhook receiver, one per process like the claim set: every instance configured with a
 * `webhook` option joins `instances`, the first one starts the server, and the last one to unload
 * stops it. Requests are served with any live instance's ports; sessions and storage are shared.
 * A receiver that could not listen is dropped, so the next instance to load tries again, and a new
 * one waits for the previous one to finish closing, as on a plugin reload.
 */
const receivers = hub.receivers

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
  receivers.current = receiver
  return receiver
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

// One set of handled events for every instance in the process, since the hub's two subscriptions,
// and a copy of another hub version or one from before the hub, are sent the same events, and of
// the permission requests sessions were told about. The scheduler's claim set is the hub's
// own business: the hub runs the scheduler once for its members.
const { watched } = hub
const watchState: WatchState = { ...watched, forms: hub.forms }

/** What a question relay needs from the plugin instance that wraps the question tool. */
export interface RelaySlot {
  ports?: QuestionPorts
}

/**
 * The courier tools and webhook receiver, as a promise plugin, which joins the hub that runs the
 * scheduler and the event watcher. `relay` receives this instance's ports for the question relay
 * while it is loaded.
 */
export const courier = (relay: RelaySlot = {}) => Plugin.define({
  id: "courier",
  setup: async (ctx) => {
    const log = (message: string) => console.error(message)
    // One line per load when this OpenCode is not the version the plugin was built against; the
    // tools are registered all the same, and no tool result says so.
    try {
      const notice = versionNotice(builtVersions(), ctx.app)
      if (notice) log(notice)
    } catch (error) {
      log(`courier: cannot compare the OpenCode version with the one it was built against: ${String(error)}`)
    }
    const questionPorts: QuestionPorts = {
      storage: ctx.storage,
      session: ctx.session,
      directory: ctx.location.directory,
      now: Date.now,
      timing: { closingGraceMs: 30_000, passingWaitMs: 30_000, relayWaitMs: 30_000, dismissalGraceMs: 2_000 },
      newID: () => `question_${randomUUID()}`,
      log,
    }
    const ports: CourierPorts = {
      session: ctx.session,
      agent: ctx.agent,
      worktree: ctx.worktree,
      storage: ctx.storage,
      directory: ctx.location.directory,
      projectID: ctx.location.project.id,
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
    const later: LaterPorts = {
      storage: ctx.storage,
      session: ctx.session,
      now: Date.now,
      newID: () => `later_${randomUUID()}`,
      log,
    }
    const hooks: WebhookPorts = { storage: ctx.storage, session: ctx.session, now: Date.now, log: later.log }
    let webhook: WebhookConfig | undefined
    try {
      webhook = readConfig(ctx.options)
    } catch (error) {
      later.log(`courier webhook: not started: ${error instanceof Error ? error.message : String(error)}`)
    }

    const toolPorts: ToolPorts = {
      courier: ports,
      cleanup: cleanupPorts,
      later,
      answer: answerPorts,
      questions: questionPorts,
      hooks,
      waiting: watched.waiting,
      receiving: async () => (await receivers.current?.server) !== undefined,
    }
    await ctx.tool.transform((tools) => addTools(tools, toolPorts))

    void pruneExpired(ctx.storage, Date.now()).catch((error: unknown) => log(`courier roster prune: ${String(error)}`))
    relay.ports = questionPorts
    const leaveRelay = joinRelay(questionPorts)
    void noticeCutOff(questionPorts).catch((error: unknown) => questionPorts.log(`courier question: stored questions: ${String(error)}`))

    const watchPorts: WatchPorts = {
      storage: ctx.storage,
      session: ctx.session,
      event: ctx.event,
      permissions,
      now: questionPorts.now,
      log: later.log,
    }
    // The hub's subscriptions to OpenCode's events, one and a standby, start with this copy's watcher.
    watchFromHub(hub, watchState)
    const leaveHub = join({
      directory: ctx.location.directory,
      permission: ctx.permission,
      later,
      watch: watchPorts,
      questions: questionPorts,
      log,
    })
    const leave = webhook ? joinReceiver(webhook, hooks) : undefined
    return async () => {
      leaveHub()
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
