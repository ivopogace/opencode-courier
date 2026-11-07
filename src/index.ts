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
import { addMemoryTools, lessonsOf, memoryEvents, NOTE_TOOL, readMemory, RECALL_TOOL, registerMemoryRpc, sweepRecords, type MemoryPorts, type MemoryState } from "./memory/index.js"
import { addSkill } from "./skill.js"
import {
  addTreeTools,
  deliverReleased,
  wakeMissed,
  dirtyOf,
  headOf,
  inspectWorktree,
  onIdle,
  pruneExpired,
  readLimits,
  readNativeChildren,
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

const memoryState = sharedState<MemoryState>("memory", () => ({ windows: new Map(), off: new Set(), tops: new Set(), seen: new Set() }))

const jobs: TickJob[] = [
  dueJob,
  (owner, claimed) => deliverReleased(owner.later as LaterPorts, claimed),
  (owner, claimed) => wakeMissed(owner.later as LaterPorts, claimed),
]

const { join, track, nudge } = openInProcess(jobs)

const permissions = domains as () => Iterable<Permissions>

const { watched } = hub
const watchState: WatchState = { seen: watched.seen, inbox }
const personState: PersonState = { ...watched, forms: hub.forms, shown }

const outside = waitsOn(asksPermission, asksQuestion, isScheduled)

const eventModules = [treeEvents(watchState, outside), personEvents(personState), memoryEvents(memoryState)]

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
    const { nativeChildren, problems: nativeProblems } = readNativeChildren(ctx.options)
    const { memory, problems: memoryProblems } = readMemory(ctx.options)
    for (const problem of [...problems, ...nativeProblems, ...memoryProblems]) log(`courier: ${problem}`)
    const roles = new Map<string, Role>()
    const memoryPorts: MemoryPorts = { storage: ctx.storage, session: ctx.session, now: Date.now, log, projectID: ctx.location.project.id, memory, maxDepth: limits.maxDepth }
    const ports: CourierPorts = {
      limits,
      nativeChildren,
      gate,
      roles,
      nudge,
      log,
      entries: () => lessonsOf(memoryPorts),
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
      addMemoryTools(tools, { memory: memoryPorts, state: memoryState })
    })
    await ctx.skill.transform(addSkill)
    await Promise.resolve()
      .then(() => registerTreeRpc(ctx.rpc, stopPorts))
      .then(() => registerPersonRpc(ctx.rpc, { questions: questionPorts, permissions }))
      .then(() => registerMemoryRpc(ctx.rpc, memoryPorts))
      .catch((error: unknown) => log(`courier rpc: not registered, the TUI part shows nothing and cannot stop: ${String(error)}`))
    // a host before 2.2.0 has no instructions entries (api-notes)
    const instructions = (ctx.session as Partial<typeof ctx.session>).instructions
    await ctx.session.hook("context", (event) => shapeContext({ storage: ctx.storage, limits, roles, instructions, hiddenFromLeaf: [RECALL_TOOL, NOTE_TOOL], log }, event))

    const pruned = pruneExpired(ctx.storage, Date.now()).catch((error: unknown) => log(`courier roster prune: ${String(error)}`))
    const swept = sweepRecords(ctx.storage, Date.now()).catch((error: unknown) => log(`courier memory sweep: ${String(error)}`))
    const windowed = ports
      .models()
      .then((models) => models.forEach(({ providerID, id, context }) => memoryState.windows.set(`${providerID}/${id}`, { providerID, id, context })))
      .catch((error: unknown) => log(`courier memory: cannot list the models' context windows: ${String(error)}`))
    if (!memory) memoryState.off.add(ctx.location.directory)
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
    await Promise.resolve()
      // a host before 2.2.4 takes this hook and never runs it (api-notes)
      .then(() => ctx.session.hook("experimental.idle", (event) => onIdle(watchPorts, watchState.seen, outside, event).then(() => undefined)))
      .catch((error: unknown) => log(`courier idle: not registered, a child that ends without a report is not reminded: ${String(error)}`))
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
    track(member, swept)
    track(member, windowed)
    return async () => {
      const leftHub = leaveHub()
      if (!memory) memoryState.off.delete(ctx.location.directory)
      leaveRelay()
      await leftHub
    }
  },
})

// an Effect plugin, so the question call can be interrupted (api-notes)
export default EffectPlugin.define({
  id: "courier",
  effect: (host) =>
    Effect.gen(function* () {
      yield* fromPromise(courier()).effect(host)
      // the adapter hands the promise plugin this same location (api-notes)
      yield* relayQuestions(host, portsAt(host.location))
    }),
})
