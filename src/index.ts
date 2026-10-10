import { Plugin } from "@opencode/plugin"
import { Plugin as EffectPlugin } from "@opencode/plugin/effect"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import type { CourierPorts } from "./courier.js"
import { dirtyOf, headOf, inspectWorktree, type CleanupPorts } from "./cleanup.js"
import { gate, hub, inbox, join, nudge, permissions, portsAt, track, type Member, type Receiver } from "./hub.js"
import type { LaterPorts } from "./later.js"
import { readLimits, shapeContext } from "./limits.js"
import { pendingOf, type AnswerPorts } from "./relay.js"
import { joinRelay, noticeCutOff, pendingQuestions, relayQuestions, type QuestionPorts } from "./question/index.js"
import { pruneExpired } from "./roster.js"
import { addTools, type ToolPorts } from "./tools.js"
import { watchFromHub, type WatchPorts, type WatchState } from "./watch.js"
import { builtVersions, versionNotice } from "./version.js"
import { listen, readConfig, type WebhookConfig, type WebhookPorts } from "./webhook.js"

/**
 * The webhook receiver, one per process: instances with a `webhook` option join `instances`, the first
 * starts the server and the last to unload stops it; one that could not listen is dropped for a retry.
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

// One set of handled events and of told permission requests for every instance in the process, since
// several subscriptions and copies see the same events. The scheduler's claim set is the hub's own.
const { watched } = hub
const watchState: WatchState = { ...watched, forms: hub.forms, inbox }

/**
 * The courier tools and webhook receiver, as a promise plugin joining the hub that runs the scheduler
 * and the watcher; its member carries the location by which the question relay finds its ports.
 */
export const courier = () => Plugin.define({
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
    const { limits, problems } = readLimits(ctx.options)
    for (const problem of problems) log(`courier: ${problem}`)
    const roles = new Map<string, number | null>()
    const ports: CourierPorts = {
      limits,
      gate,
      roles,
      nudge,
      log,
      session: ctx.session,
      agent: ctx.agent,
      worktree: ctx.worktree,
      storage: ctx.storage,
      directory: ctx.location.directory,
      projectID: ctx.location.project.id,
      now: Date.now,
      head: headOf,
      dirty: dirtyOf,
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
      stop: { courier: ports, later, cleanup: cleanupPorts },
      later,
      answer: answerPorts,
      questions: questionPorts,
      hooks,
      waiting: watched.waiting,
      receiving: async () => (await receivers.current?.server) !== undefined,
    }
    await ctx.tool.transform((tools) => addTools(tools, toolPorts))
    await ctx.session.hook("context", (event) => shapeContext({ storage: ctx.storage, limits, roles, log }, event))

    const pruned = pruneExpired(ctx.storage, Date.now()).catch((error: unknown) => log(`courier roster prune: ${String(error)}`))
    const leaveRelay = joinRelay(questionPorts)
    const noticed = noticeCutOff(questionPorts).catch((error: unknown) =>
      questionPorts.log(`courier question: stored questions: ${String(error)}`),
    )

    const watchPorts: WatchPorts = {
      storage: ctx.storage,
      session: ctx.session,
      event: ctx.event,
      permissions,
      now: questionPorts.now,
      log: later.log,
      nudge,
    }
    // The hub's subscriptions to OpenCode's events, one and a standby, start with this copy's watcher.
    watchFromHub(hub, watchState)
    const member: Member = {
      directory: ctx.location.directory,
      location: ctx.location,
      permission: ctx.permission,
      later,
      watch: watchPorts,
      questions: questionPorts,
      log,
    }
    const leaveHub = join(member)
    // The leave waits for them, so they do not run on against a location that is closing.
    track(member, pruned)
    track(member, noticed)
    const leave = webhook ? joinReceiver(webhook, hooks) : undefined
    return async () => {
      // Waits, for a moment at most, for the work this instance leaves behind, and on the last
      // leave for the scheduler's owner key to be released, so another server takes over at once.
      const leftHub = leaveHub()
      leaveRelay()
      await leave?.()
      await leftHub
    }
  },
})

/**
 * The plugin OpenCode loads: an Effect plugin, since the question relay wraps OpenCode's question tool
 * and only the Effect API makes its call interruptible; the rest is the promise plugin, adapted.
 */
export default EffectPlugin.define({
  id: "courier",
  effect: (host) =>
    Effect.gen(function* () {
      yield* fromPromise(courier()).effect(host)
      // The promise plugin's instance is handed this same location and has just joined with it: its
      // member, bound now, while it stays loaded.
      yield* relayQuestions(host, portsAt(host.location))
    }),
})
