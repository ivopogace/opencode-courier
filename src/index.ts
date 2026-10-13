import { Plugin } from "@opencode/plugin"
import { Plugin as EffectPlugin } from "@opencode/plugin/effect"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { watchFromHub } from "./platform/events.js"
import { hub, openInProcess, permissions as domains, sharedState, type Member, type TickJob } from "./platform/hub.js"
import { builtVersions, versionNotice } from "./platform/version.js"
import { addSchedulingTools, cancelScheduled, dueJob, isScheduled, type LaterPorts } from "./scheduling/index.js"
import {
  addPersonTools,
  asksPermission,
  asksQuestion,
  joinRelay,
  noticeCutOff,
  pendingOf,
  pendingQuestions,
  personEvents,
  portsAt,
  registerPersonRpc,
  relayQuestions,
  type AnswerPorts,
  type Permissions,
  type PersonState,
  type QuestionPorts,
} from "./person/index.js"
import { addSkill } from "./skill.js"
import {
  addTreeTools,
  deliverReleased,
  dirtyOf,
  headOf,
  inspectWorktree,
  pruneExpired,
  readLimits,
  readNativeChildren,
  registerTreeRpc,
  shapeContext,
  together,
  treeEvents,
  waitsOn,
  type CleanupPorts,
  type CourierPorts,
  type SpawnGate,
  type WatchPorts,
  type WatchState,
} from "./tree/index.js"
import {
  addWebhookTools,
  joinReceiver,
  readConfig,
  receiving,
  subscribedSince,
  type WebhookConfig,
  type WebhookPorts,
} from "./webhook/index.js"

/** The spawns under way in the process, outside the hub, so spawns in other locations, copies and hub versions count them. */
const gate = sharedState<SpawnGate>("spawning", () => ({ reserved: new Set(), turn: Promise.resolve() }))

/** The type of each item enqueued for a spawned session, outside the hub like the gate. */
const inbox = sharedState("inbox", () => new Map<string, string>())

/**
 * What each tick of the scheduler does, in order, through the first loaded member, of whichever copy:
 * due `courier_later` messages, then released join groups. Every hub-v2 member's `later` is its LaterPorts.
 */
const jobs: TickJob[] = [
  dueJob,
  (owner, claimed) => deliverReleased(owner.later as LaterPorts, claimed),
]

const { join, track, nudge } = openInProcess(jobs)

/** The permission domains of the loaded instances: every member's is its location's, whichever copy joined it. */
const permissions = domains as () => Iterable<Permissions>

// One set of handled events and of told permission requests for every instance in the process, since
// several subscriptions and copies see the same events. The scheduler's claim set is the hub's own.
const { watched } = hub
const watchState: WatchState = { seen: watched.seen, inbox }
const personState: PersonState = { ...watched, forms: hub.forms }

/**
 * What a session waits on outside the tree, for the silent-turn rule, cheapest first: a request of its
 * own to the person, then a scheduled message or a webhook it subscribed to since its last prompt.
 */
const outside = waitsOn(asksPermission, asksQuestion, together(isScheduled, subscribedSince))

/** What the hub's subscriptions do with each event of OpenCode's, module by module, in this order. */
const eventModules = [treeEvents(watchState, outside), personEvents(personState)]

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
    const { nativeChildren, problems: nativeProblems } = readNativeChildren(ctx.options)
    for (const problem of [...problems, ...nativeProblems]) log(`courier: ${problem}`)
    const roles = new Map<string, number | null>()
    const ports: CourierPorts = {
      limits,
      nativeChildren,
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

    const stopPorts = { courier: ports, cancelScheduled: (sessionID: string) => cancelScheduled(later, sessionID), cleanup: cleanupPorts }
    // The tools in a fixed order: the tree's, then the person's, the scheduled messages' and the webhooks'.
    await ctx.tool.transform((tools) => {
      addTreeTools(tools, { courier: ports, cleanup: cleanupPorts, stop: stopPorts })
      addPersonTools(tools, { answer: answerPorts, questions: questionPorts, waiting: watched.waiting })
      addSchedulingTools(tools, later)
      addWebhookTools(tools, { hooks, receiving })
    })
    await ctx.skill.transform(addSkill)
    // What the TUI part reads; only a view, so a host that cannot register it still gets the rest.
    await Promise.resolve()
      .then(() => registerTreeRpc(ctx.rpc, ports))
      .then(() => registerPersonRpc(ctx.rpc, { questions: questionPorts, permissions, maxTotal: limits.maxTotal }))
      .catch((error: unknown) => log(`courier rpc: not registered, the TUI part shows nothing: ${String(error)}`))
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
    // The hub's subscriptions to OpenCode's events, one and a standby, start with this copy's modules.
    watchFromHub(hub, eventModules)
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
