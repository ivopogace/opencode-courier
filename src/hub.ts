import type { Plugin } from "@opencode/plugin"
import type { Server } from "node:http"
import { deliverDue, TICK_MS, type LaterPorts } from "./later.js"
import type { Asked, Outcome, Withdrawal } from "./notices.js"
import type { Permissions, Waiting } from "./relay.js"
import type { RosterStorage } from "./roster.js"
import { processWide, type Registry } from "./storage.js"
import type { WebhookConfig, WebhookPorts } from "./webhook.js"

type Context = Plugin.Context

/**
 * The plugin's process-wide state, in one place. OpenCode sets the plugin up once per location
 * (project or worktree), all in one process, and after an update loads the new copy of the package
 * next to the old one until the old one unloads; so the state every instance shares lives on
 * `globalThis`, outside the module graph, and this is the only module that puts it there.
 *
 * The hub is versioned by `HUB_VERSION`, not by the package's version: copies whose hub has the
 * same shape share one hub, however far apart their releases, and only a change to the hub's shape
 * (the ports a `Member` carries included) or to the meaning of one of its fields bumps it.
 *
 * Version skew: a copy that finds a hub of another version under `opencode-courier.hub` logs that
 * once and runs its own hub under `opencode-courier.hub@<version>`. Whatever its version, a hub
 * takes the claim sets and the other shared objects of the copies before the hub from their own
 * keys (`opencode-courier.claimed`, `.watched`, `.forms`, `.questions`, `.receiver`, `.locations`),
 * making each when it is missing, so every copy in the process, with a hub or without, claims an
 * event or a delivery in the same set, and an old and a new copy never both act on it. Those keys'
 * shapes and meanings are therefore fixed: a hub version that needs other ones makes new keys, and
 * keeps claiming in the old ones too while a copy that uses them may still be loaded. `members` is
 * the one thing each version keeps to itself, so a job a hub runs once for its members runs once
 * per hub version, and still claims what it acts on in the shared sets, which keep it from acting
 * twice.
 */
export const HUB_VERSION = 1

/** The key of the hub; a copy that finds another version there keeps its own under `${HUB_KEY}@<version>`. */
export const HUB_KEY = "opencode-courier.hub"

// The ports an instance joins with, and the state the hub keeps for the question relay and the
// event watcher. Declared here rather than in `question.ts` and `watch.ts`, which use the hub.

/**
 * A question this process knows: one whose call waits (`call`), or one whose call was cut off,
 * which is answered by message. `link` withdraws the top session's question call that passes its
 * answer on, once the question is settled without that call.
 */
export interface Question extends Asked {
  /** The directory of the location the call runs in, whose shutdown withdraws its form. */
  directory?: string
  /** Hands the waiting call the top session's outcome; true once the call has ended with it. */
  call?: (outcome: Outcome) => Promise<boolean>
  link?: (how: Withdrawal) => void
  /** Storing the question and telling the top session, while that is under way. */
  relaying?: Promise<boolean>
  /** Working out what became of it once its call ended without the top session's answer. */
  settling?: Promise<void>
}

/**
 * The relay's timings, carried by its ports: how long a question cut off by a closing location
 * waits before an instance still loaded tells its top session, how long an answer waits for another
 * one to it that is still being passed on, how long what follows a call's end waits for the notice
 * of the question to go out, and how long a dismissal is held to see whether the location is
 * shutting down.
 */
export interface QuestionTiming {
  readonly closingGraceMs: number
  readonly passingWaitMs: number
  readonly relayWaitMs: number
  readonly dismissalGraceMs: number
}

export interface QuestionPorts {
  readonly storage: RosterStorage
  readonly session: Pick<Context["session"], "synthetic">
  /** The directory of the instance's location. */
  readonly directory: string
  /** The clock, in epoch milliseconds, as OpenCode's location shutdowns are recorded. */
  readonly now: () => number
  readonly timing: QuestionTiming
  readonly newID: () => string
  readonly log: (message: string) => void
}

export interface WatchPorts {
  readonly storage: RosterStorage
  readonly session: Pick<Context["session"], "synthetic">
  readonly event: Pick<Context["event"], "subscribe">
  /**
   * The permission domains of every loaded location, whose pending requests are relayed when the
   * watcher (re)subscribes: one watcher serves them all, and an isolated child's are in its worktree's.
   */
  readonly permissions: () => Iterable<Pick<Context["permission"], "list">>
  /** The clock a location shutdown is recorded by: the question relay's, which judges it. */
  readonly now: () => number
  readonly log: (message: string) => void
}

/**
 * What every plugin instance in the process shares. A hub follows OpenCode's events once for all its
 * members, but a copy of another hub version, or one from before the hub, follows them too and is
 * sent the same events, and a hand-over overlaps the old subscription with the new one; so an event
 * id is claimed synchronously and handled once. `waiting` holds the permission requests a session was
 * told about and has not answered; `answered`, requests answered before anyone was told, so a
 * notice whose roster lookup was overtaken by the answer is not sent. `forms` does the same for
 * the forms of spawned sessions.
 */
export interface WatchState {
  readonly seen: Set<string>
  readonly waiting: Waiting
  readonly answered: Set<string>
  readonly forms: FormsTold
}

/** The forms sessions were told about, kept apart from the permission requests. */
export interface FormsTold {
  /** Forms still shown whose notice went out, or is going out: the notice's delivery. */
  readonly told: Map<string, Promise<unknown>>
  /** Forms settled before anyone was told, so a notice whose roster lookup was overtaken is not sent. */
  readonly settled: Set<string>
}

/**
 * The webhook receiver, one per process: every instance configured with a `webhook` option joins
 * `instances`, the first one starts the server, and the last one to unload stops it.
 */
export interface Receiver {
  readonly config: WebhookConfig
  readonly instances: Set<WebhookPorts>
  readonly server: Promise<Server | undefined>
}

/** The current receiver, if any, and the previous one while it closes, which a new one waits for. */
export interface Receivers {
  current?: Receiver
  closing?: Promise<void>
}

/**
 * The question relay's state, shared by every instance, since a child and the session it asks can
 * be in different locations: the questions told to a top session and not yet settled, the cut-off
 * ones whose top session has been told so, and the question calls waiting for their form to be shown.
 */
export interface QuestionState {
  readonly questions: Map<string, Question>
  readonly noticed: Set<string>
  readonly shown: Map<string, () => void>
  /** The questions whose answer is being passed on, each until that is done, and those whose answer went out. */
  readonly passing: Map<string, Promise<unknown>>
  readonly answered: Set<string>
  /** The ports of the loaded instances. */
  readonly loaded: Set<QuestionPorts>
  /** How many instances follow OpenCode's events now, and whether any has since the process started. */
  following: number
  followed: boolean
  /**
   * When OpenCode last reported each location shutting down (`location.shutdown`), by directory
   * in epoch milliseconds by the clock of the watcher that saw it; under `""` when the event named no location.
   */
  readonly shutdowns: Map<string, number>
  /** Woken when a location shuts down or an instance unloads: dismissals held to see whether one follows. */
  readonly closingWaiters: Set<() => void>
}

/**
 * A loaded plugin instance: its location's directory and permission domain, and the ports a job
 * run once for the whole process would run it through.
 */
export interface Member {
  readonly directory: string
  readonly permission: Permissions
  readonly later: LaterPorts
  readonly watch: WatchPorts
  readonly questions: QuestionPorts
  readonly log: (message: string) => void
}

/**
 * The scheduler's loop, one per hub: it runs while the hub has members, and each tick delivers the
 * due `courier_later` messages through the ports of the member that joined first and is still loaded.
 */
export interface Scheduler {
  /** The loop's interval, while it runs. */
  timer?: unknown
  /**
   * The member the tick under way runs through, if any. A tick that falls due meanwhile is skipped,
   * unless that member has left: a tick that never ends through an unloaded instance holds up nothing.
   */
  ticking?: Member
  /** One tick, by the copy of the plugin that joined last, so a copy loaded after an update runs its own code. */
  tick?: () => Promise<void>
}

/** How the hub starts and stops the scheduler's loop; tests pass their own. */
export interface Timers {
  readonly every: (run: () => void, ms: number) => unknown
  readonly stop: (timer: unknown) => void
}

const realTimers: Timers = {
  every: (run, ms) => setInterval(run, ms),
  stop: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
}

/** The one subscription to OpenCode's events a hub runs: the member whose ports it runs through, and how it ends. */
export interface Watcher {
  readonly member: Member
  readonly stop: AbortController
  /** Settles once the subscription has ended, after `stop`. */
  readonly done: Promise<void>
}

export interface Hub {
  readonly version: typeof HUB_VERSION
  /** The instances loaded now, in the order they joined. */
  readonly members: Set<Member>
  readonly scheduler: Scheduler
  /** The hub's subscription to OpenCode's events, while a member is loaded to run it. */
  watcher?: Watcher
  /** The ids of the `courier_later` messages being delivered. */
  readonly claimed: Set<string>
  /** The events handled, and the permission requests a session was told about or that were answered first. */
  readonly watched: Omit<WatchState, "forms">
  /** The forms sessions were told about, and those settled first. */
  readonly forms: FormsTold
  /**
   * The permission domain of every loaded instance, by instance. OpenCode keeps a request where its
   * session runs, so a request of an isolated child is answered through the instance loaded in its worktree.
   */
  readonly locations: Map<object, Permissions>
  readonly receivers: Receivers
  readonly questions: QuestionState
  /** Whether the hub of another version found under `HUB_KEY` has been logged. */
  skewLogged: boolean
}

/** A hub, as `open` finds or makes it, and how instances join it. */
export interface Opened {
  readonly hub: Hub
  /**
   * Adds a loaded instance to the hub and its permission domain to `locations`; returns its leave,
   * which takes both out again. The first instance to join logs a hub of another version found
   * under `HUB_KEY`. An instance joining a hub without members starts the scheduler's loop, with a
   * tick at once; the last one to leave stops it.
   */
  readonly join: (member: Member) => () => void
}

/**
 * Finds or makes this copy's hub in `registry`: the one under `HUB_KEY`, or its own under a
 * versioned key when a hub of another version holds that. Either way, its claim sets and shared
 * objects are the ones under the keys of the copies before the hub, made when missing.
 */
export function open(registry: Registry, timers: Timers = realTimers): Opened {
  const shared = <T>(name: string, create: () => T) => processWide(`opencode-courier.${name}`, create, registry)
  const questionState = () => {
    // Field by field, since a copy before the hub may have made it without the fields added later.
    const state = shared<{ -readonly [K in keyof QuestionState]?: QuestionState[K] }>("questions", () => ({}))
    state.questions ??= new Map()
    state.noticed ??= new Set()
    state.shown ??= new Map()
    state.passing ??= new Map()
    state.answered ??= new Set()
    state.loaded ??= new Set()
    state.following ??= 0
    state.followed ??= false
    state.shutdowns ??= new Map()
    state.closingWaiters ??= new Set()
    return state as QuestionState
  }
  const create = (): Hub => ({
    version: HUB_VERSION,
    members: new Set(),
    scheduler: {},
    claimed: shared("claimed", () => new Set<string>()),
    watched: shared<Omit<WatchState, "forms">>("watched", () => ({ seen: new Set(), waiting: new Set(), answered: new Set() })),
    forms: shared<FormsTold>("forms", () => ({ told: new Map(), settled: new Set() })),
    locations: shared("locations", () => new Map<object, Permissions>()),
    receivers: shared<Receivers>("receiver", () => ({})),
    questions: questionState(),
    skewLogged: false,
  })

  const found = registry[Symbol.for(HUB_KEY)] as { version?: unknown } | null | undefined
  // The version of the hub of another copy found under `HUB_KEY`, if one is there.
  const skew = found != null && found.version !== HUB_VERSION ? { version: found.version } : undefined
  const hub = processWide(skew ? `${HUB_KEY}@${HUB_VERSION}` : HUB_KEY, create, registry)

  // One tick, through the first member still loaded. The claim on each delivery stays, as the second
  // line of defence against a copy before the hub, which runs its own interval until it unloads.
  const tick = async () => {
    const scheduler = hub.scheduler
    const owner = hub.members.values().next().value
    if (!owner || (scheduler.ticking && hub.members.has(scheduler.ticking))) return
    scheduler.ticking = owner
    try {
      await deliverDue(owner.later, hub.claimed)
    } catch (error) {
      owner.log(`courier_later scheduler: ${String(error)}`)
    } finally {
      if (scheduler.ticking === owner) scheduler.ticking = undefined
    }
  }

  const join = (member: Member) => {
    if (skew && !hub.skewLogged) {
      hub.skewLogged = true
      member.log(
        `courier: another copy of the plugin with hub version ${String(skew.version)} has been loaded in this process; ` +
          `this copy (hub version ${HUB_VERSION}) keeps its own under ${HUB_KEY}@${HUB_VERSION} and shares the claim sets with it`,
      )
    }
    hub.members.add(member)
    hub.locations.set(member, member.permission)
    const scheduler = hub.scheduler
    scheduler.tick = tick
    if (scheduler.timer === undefined) {
      scheduler.timer = timers.every(() => void hub.scheduler.tick?.(), TICK_MS)
      void tick()
    }
    return () => {
      hub.members.delete(member)
      hub.locations.delete(member)
      if (hub.members.size > 0 || scheduler.timer === undefined) return
      timers.stop(scheduler.timer)
      scheduler.timer = undefined
    }
  }
  return { hub, join }
}

const opened = open(globalThis as Registry)

/** This copy's hub, in the process. */
export const hub: Hub = opened.hub

/** Joins this copy's hub; see `Opened.join`. */
export const join = opened.join

/** The permission domains of the loaded instances. */
export const permissions = () => hub.locations.values()

/**
 * For tests: forgets every remembered id and the question relay's state, the relay's loaded
 * instances and its count of watchers included. The hub's members, the locations and the webhook
 * receiver are left alone; leaving and unloading take them out.
 */
export function resetHub() {
  hub.claimed.clear()
  hub.watched.seen.clear()
  hub.watched.waiting.clear()
  hub.watched.answered.clear()
  hub.forms.told.clear()
  hub.forms.settled.clear()
  const questions = hub.questions
  questions.questions.clear()
  questions.noticed.clear()
  questions.shown.clear()
  questions.passing.clear()
  questions.answered.clear()
  questions.loaded.clear()
  questions.following = 0
  questions.followed = false
  questions.shutdowns.clear()
  questions.closingWaiters.clear()
}
