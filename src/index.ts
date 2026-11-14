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
  formsShown,
  joinRelay,
  noticeCutOff,
  pendingOf,
  pendingQuestions,
  personEvents,
  portsAt,
  registerPersonRpc,
  relayQuestions,
  type AnswerPorts,
  type FormsShown,
  type Permissions,
  type PersonState,
  type QuestionPorts,
} from "./person/index.js"
import { addSkill } from "./skill.js"
import {
  addTreeTools,
  wakeMissed,
  dirtyOf,
  headOf,
  inspectWorktree,
  onFork,
  onIdle,
  pruneExpired,
  readLimits,
  readRemovedOptions,
  registerTreeRpc,
  shapeContext,
  treeEvents,
  waitsOn,
  type CleanupPorts,
  type CourierPorts,
  type Role,
  type SpawnGate,
  type WatchPorts,
  type WatchState,
} from "./tree/index.js"

const gate = sharedState<SpawnGate>("spawning", () => ({ reserved: new Set(), turn: Promise.resolve() }))

const inbox = sharedState("inbox", () => new Map<string, string>())

const shown = sharedState<FormsShown>("formsShown", () => new Map())

const jobs: TickJob[] = [
  dueJob,
  (owner, claimed) => wakeMissed(owner.later as LaterPorts, claimed),
]

const { join, track } = openInProcess(jobs)

const permissions = domains as () => Iterable<Permissions>

const { watched } = hub
const watchState: WatchState = { seen: watched.seen, inbox }
const personState: PersonState = { ...watched, forms: hub.forms, shown }

const outside = waitsOn(asksPermission, asksQuestion, isScheduled)

const eventModules = [treeEvents(watchState, outside), personEvents(personState)]

export const courier = () => Plugin.define({
  id: "courier",
  setup: async (ctx) => {
    const log = (message: string) => console.error(message)
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
    for (const problem of [...problems, ...readRemovedOptions(ctx.options)]) log(`courier: ${problem}`)
    const roles = new Map<string, Role>()
    const ports: CourierPorts = {
      limits,
      gate,
      roles,
      log,
      session: ctx.session,
      agent: ctx.agent,
      worktree: ctx.worktree,
      storage: ctx.storage,
      directory: ctx.location.directory,
      projectID: ctx.location.project.id,
      now: Date.now,
      models: async () =>
        (await ctx.model.list()).data.map((model) => ({
          providerID: model.providerID,
          id: model.id,
          context: model.limit.context,
          variants: model.variants.map((variant) => variant.id),
        })),
      defaultModel: async () => {
        const { data } = await ctx.model.default()
        return data ? { providerID: data.providerID, id: data.id } : undefined
      },
      head: headOf,
      dirty: dirtyOf,
      pending: async (sessionID) => {
        const [requests, questions] = await Promise.all([
          pendingOf(permissions(), sessionID),
          pendingQuestions(ctx.storage, sessionID),
        ])
        return [...requests, ...questions]
      },
      forms: (sessionID) => Promise.resolve(formsShown(shown, sessionID)),
    }
    const cleanupPorts: CleanupPorts = { ...ports, inspect: inspectWorktree }
    const answerPorts: AnswerPorts = { storage: ctx.storage, permissions, assert: (input) => ctx.permission.assert(input) }
    const later: LaterPorts = {
      storage: ctx.storage,
      session: ctx.session,
      now: Date.now,
      newID: () => `later_${randomUUID()}`,
      log,
    }

    const stopPorts = { courier: ports, cancelScheduled: (sessionID: string) => cancelScheduled(later, sessionID), cleanup: cleanupPorts }
    await ctx.tool.transform((tools) => {
      addTreeTools(tools, { courier: ports, cleanup: cleanupPorts, stop: stopPorts })
      addPersonTools(tools, { answer: answerPorts, questions: questionPorts, waiting: watched.waiting })
      addSchedulingTools(tools, later)
    })
    await ctx.skill.transform(addSkill)
    await Promise.resolve()
      .then(() => registerTreeRpc(ctx.rpc, stopPorts))
      .then(() => registerPersonRpc(ctx.rpc, { questions: questionPorts, permissions }))
      .catch((error: unknown) => log(`courier rpc: not registered, the TUI part shows nothing and cannot stop: ${String(error)}`))
    const instructions = (ctx.session as Partial<typeof ctx.session>).instructions
    await ctx.session.hook("context", (event) => shapeContext({ storage: ctx.storage, session: ctx.session, limits, roles, instructions, log }, event))

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
    }
    await Promise.resolve()
      .then(() => ctx.session.hook("experimental.idle", (event) => onIdle(watchPorts, watchState.seen, outside, event).then(() => undefined)))
      .catch((error: unknown) => log(`courier idle: not registered, a child that ends without a report is not reminded: ${String(error)}`))
    await Promise.resolve()
      .then(() => ctx.session.hook("fork", (event) => onFork({ storage: ctx.storage, session: ctx.session, log }, watchState.seen, event).then(() => undefined)))
      .catch((error: unknown) => log(`courier fork: not registered, a fork of a session in a tree is not told that courier did not start it: ${String(error)}`))
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
    track(member, pruned)
    track(member, noticed)
    return async () => {
      const leftHub = leaveHub()
      leaveRelay()
      await leftHub
    }
  },
})

export default EffectPlugin.define({
  id: "courier",
  effect: (host) =>
    Effect.gen(function* () {
      yield* fromPromise(courier()).effect(host)
      yield* relayQuestions(host, portsAt(host.location))
    }),
})
