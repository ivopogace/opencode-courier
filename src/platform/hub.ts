import { randomInt } from "node:crypto"
import { hostname } from "node:os"
import { num, obj, str } from "./json.js"
import { processWide, type Registry, type Storage } from "./storage.js"

/**
 * The plugin's process-wide state on `globalThis`, shared by every loaded copy; only this module puts
 * it there. `HUB_VERSION`, the fixed claim keys and version skew: docs/reference.md, § Several copies.
 */
export const HUB_VERSION = 2

/** The key of the hub; a copy that finds another version there keeps its own under `${HUB_KEY}@<version>`. */
export const HUB_KEY = "opencode-courier.hub"

// The hub types what it owns. What a member carries for the features, and the state it keeps for
// them, are opaque here: the modules that own them type them, and every hub-v2 copy keeps their shape.

/** The ports a member's scheduler keeps the owner key through: what every member's `later` ports have. */
export interface TickPorts {
  readonly storage: Pick<Storage, "get" | "set" | "remove">
  readonly now: () => number
}

/**
 * The events handled, and the permission requests a session was told about or that were answered
 * first: claim sets shared by every subscription and copy, so each event is handled once.
 */
export interface Watched {
  readonly seen: Set<string>
  readonly waiting: Set<string>
  readonly answered: Set<string>
}

/** The forms sessions were told about, kept apart from the permission requests. */
export interface FormsTold {
  /** Forms still shown whose notice went out, or is going out: the notice's delivery. */
  readonly told: Map<string, Promise<unknown>>
  /** Forms settled before anyone was told, so a notice whose roster lookup was overtaken is not sent. */
  readonly settled: Set<string>
}

/**
 * A loaded plugin instance: its location's directory and permission domain, and the ports a job
 * run once for the whole process would run it through.
 */
export interface Member {
  readonly directory: string
  /**
   * The location OpenCode set the instance up with, the very object the instance's Effect half is
   * handed too, which finds its member by it (`portsAt`). A member of a copy before it has none.
   */
  readonly location?: object
  /** The location's permission domain, kept in `locations`. */
  readonly permission: unknown
  /** The ports the scheduler's tick runs through: the owner key's, and the tick jobs'. */
  readonly later: TickPorts
  /** The ports the hub's subscriptions to OpenCode's events run through. */
  readonly watch: unknown
  /** The question relay's ports. */
  readonly questions: unknown
  readonly log: (message: string) => void
}

/**
 * A tick under way: the member it runs through, when it started, by the wall clock every member's
 * `now` reads (the next ticks compare it with another member's), and its end.
 */
export interface Tick {
  readonly member: Member
  readonly since: number
  /** Settles once the tick has ended, the owner key released if its loop stopped meanwhile; never rejects. */
  readonly done: Promise<void>
}

/**
 * The scheduler's loop, one per hub: it runs while the hub has members, and each tick runs the jobs
 * registered with `open` through the ports of the member that joined first and is still loaded.
 */
export interface Scheduler {
  /** The loop's interval, while it runs. */
  timer?: unknown
  /**
   * The tick under way, whichever copy started it: for a minute the key is renewed for it and due
   * ticks skip; past it, one whose member left holds nothing up. Older copies have only `ticking`.
   */
  running?: Tick
  /**
   * The member the tick under way runs through, if any, set and cleared with `running`, for a copy
   * that reads only this: a tick that falls due meanwhile is skipped, unless that member has left.
   */
  ticking?: Member
  /** One tick, by the copy of the plugin that joined last, so a copy loaded after an update runs its own code. */
  tick?: () => Promise<void>
  /** Whether a nudge came since the tick under way started, whichever copy's, so it ticks once more when done. */
  nudged?: boolean
}

/** How the hub starts and stops the scheduler's loop, and waits before re-reading the owner key; tests pass their own. */
export interface Timers {
  readonly every: (run: () => void, ms: number) => unknown
  readonly stop: (timer: unknown) => void
  readonly wait: (ms: number) => Promise<void>
}

const realTimers: Timers = {
  every: (run, ms) => setInterval(run, ms),
  stop: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** How often the hub's scheduler ticks: what a job delivers, a `courier_later` message, can be this late. */
export const TICK_MS = 15_000

/**
 * The storage key, shared by every server on one data directory, naming the server whose scheduler
 * delivers `courier_later` messages: `{ server, at }`, its id and when it last wrote (epoch ms).
 */
export const OWNER_KEY = "scheduler/owner"

/** How long the owner key holds without being renewed; the owner renews it every tick, four times as often. */
export const OWNER_EXPIRY_MS = 4 * TICK_MS

/**
 * How old the owner's own key may be for it to renew the key and deliver at once. An older one,
 * which it may no longer hold by the time it writes, is taken again like a free one, with the wait.
 */
export const OWNER_RENEW_MS = OWNER_EXPIRY_MS / 2

/** The wait between writing the owner key and reading it back, at least `OWNER_WAIT_MS` and up to twice that. */
export const OWNER_WAIT_MS = 500

/**
 * This server's id in the owner key: the same for every copy of the plugin in the process, and
 * different in every other process, a restart of this one included.
 */
export const SERVER = `${hostname()}:${process.pid}:${performance.timeOrigin}`

interface Owner {
  readonly server: string
  readonly at: number
}

async function readOwner(ports: TickPorts): Promise<Owner | undefined> {
  const value = obj(await ports.storage.get(OWNER_KEY))
  const server = str(value.server)
  const at = num(value.at)
  return server !== undefined && at !== undefined ? { server, at } : undefined
}

/**
 * How long an unloading instance waits for the work it leaves behind: what it started itself, a tick
 * or a notice under way through it, and on the last leave the owner key's release.
 */
export const LEAVE_MS = 2_000

/** Whether a key written at `at` still holds at `now`; one from the future, after the clock went back, holds as long. */
const holds = (at: number, now: number, ms: number) => Math.abs(now - at) < ms

/** How many subscriptions to OpenCode's events a hub keeps, each through another member: one, and a standby. */
export const WATCHERS = 2

/** One of the hub's subscriptions to OpenCode's events: the member whose ports it runs through, and how it ends. */
export interface Watcher {
  readonly member: Member
  readonly stop: AbortController
  /** Settles once the subscription has ended, after `stop`: after the event it is handling, not the stream's close. */
  readonly done: Promise<void>
}

export interface Hub {
  readonly version: typeof HUB_VERSION
  /** The instances loaded now, in the order they joined. */
  readonly members: Set<Member>
  readonly scheduler: Scheduler
  /**
   * The hub's subscriptions to OpenCode's events, each through another member: two while two members
   * are loaded, so one is always connected when the other's member leaves.
   */
  readonly watchers: Watcher[]
  /**
   * Starts a subscription through a member, by the copy of the plugin that set it last; until one
   * has, the hub follows no events.
   */
  subscribe?: (member: Member) => Watcher
  /** The ids of the `courier_later` messages being delivered. */
  readonly claimed: Set<string>
  /** The events handled, and the permission requests a session was told about or that were answered first. */
  readonly watched: Watched
  /** The forms sessions were told about, and those settled first. */
  readonly forms: FormsTold
  /**
   * The permission domain of every loaded instance, by instance. OpenCode keeps a request where its
   * session runs, so a request of an isolated child is answered through the instance loaded in its worktree.
   */
  readonly locations: Map<object, unknown>
  /** The webhook receiver's state: the object every copy shares under the key `receiver`. */
  readonly receivers: object
  /** The question relay's state: the object every copy shares under the key `questions`. */
  readonly questions: object
  /** Whether the hub of another version found under `HUB_KEY` has been logged. */
  skewLogged: boolean
}

/**
 * A job each tick runs, in its turn, through the first loaded member, which may be another copy's:
 * it uses only the ports every hub-v2 member has. `claimed` is the hub's claim set; a throw ends the tick.
 */
export type TickJob = (owner: Member, claimed: Set<string>) => Promise<void>

/** A hub, as `open` finds or makes it, and how instances join it. */
export interface Opened {
  readonly hub: Hub
  /**
   * Adds a loaded instance to the hub and `locations`; returns its leave. The first join starts the
   * scheduler and watchers, the last leave stops them; a leave waits `LEAVE_MS` for the member's work.
   */
  readonly join: (member: Member) => () => Promise<void>
  /** Hands the hub work a member started, which its leave waits for; the member's own background work. */
  readonly track: (member: Member, work: Promise<unknown>) => void
  /**
   * Runs a tick now, or once the tick under way has ended, so what has just fallen due (a released
   * group) is delivered at once rather than at the next tick; nothing while no instance is loaded.
   */
  readonly nudge: () => void
}

/**
 * The value under `opencode-courier.<name>` every copy in the process shares, made by `create` the first
 * time; another version, or a copy before the hub, may have made it, so its shape is kept for good.
 */
export function sharedState<T>(name: string, create: () => T, registry: Registry = globalThis as Registry): T {
  return processWide(`opencode-courier.${name}`, create, registry)
}

/**
 * Finds or makes this copy's hub in `registry`: the one under `HUB_KEY`, or its own under a versioned
 * key when another version holds that; its claim sets are the pre-hub keys', made when missing.
 */
function find(registry: Registry) {
  const shared = <T>(name: string, create: () => T) => sharedState(name, create, registry)
  const create = (): Hub => ({
    version: HUB_VERSION,
    members: new Set(),
    scheduler: {},
    watchers: [],
    claimed: shared("claimed", () => new Set<string>()),
    watched: shared<Watched>("watched", () => ({ seen: new Set(), waiting: new Set(), answered: new Set() })),
    forms: shared<FormsTold>("forms", () => ({ told: new Map(), settled: new Set() })),
    locations: shared("locations", () => new Map<object, unknown>()),
    receivers: shared<object>("receiver", () => ({})),
    // Filled in by `question/`, field by field, since a copy before the hub may have made it without them.
    questions: shared<object>("questions", () => ({})),
    skewLogged: false,
  })

  const found = registry[Symbol.for(HUB_KEY)] as { version?: unknown } | null | undefined
  // The version of the hub of another copy found under `HUB_KEY`, if one is there.
  const skew = found != null && found.version !== HUB_VERSION ? { version: found.version } : undefined
  return { hub: processWide(skew ? `${HUB_KEY}@${HUB_VERSION}` : HUB_KEY, create, registry), skew }
}

/**
 * This copy's hub in `registry`, and how its instances join it. Its ticks run `jobs` in order, kept in
 * this copy's tick, which the hub runs once this copy has joined last, never in the hub itself.
 */
export function open(registry: Registry, jobs: readonly TickJob[], timers: Timers = realTimers, server = SERVER): Opened {
  const { hub, skew } = find(registry)

  /**
   * Whether this server holds the owner key, taking or renewing it through `ports`. A free, expired
   * or stalled key is written and read back after a random wait: the last of two writers holds it.
   */
  const own = async (ports: TickPorts) => {
    const held = await readOwner(ports)
    const now = ports.now()
    if (held && held.server !== server && holds(held.at, now, OWNER_EXPIRY_MS)) return false
    await ports.storage.set(OWNER_KEY, { server, at: now })
    if (fresh(held, now)) return true
    await timers.wait(randomInt(OWNER_WAIT_MS, 2 * OWNER_WAIT_MS))
    return (await readOwner(ports))?.server === server
  }

  /** Whether `held` is this server's key, recent enough to renew without reading it back. */
  const fresh = (held: Owner | undefined, now: number) => held?.server === server && holds(held.at, now, OWNER_RENEW_MS)

  /** Renews the owner key if this server holds it fresh: what a tick does, for a tick still delivering. */
  const renew = async (ports: TickPorts) => {
    const now = ports.now()
    if (fresh(await readOwner(ports), now)) await ports.storage.set(OWNER_KEY, { server, at: now })
  }

  /** Whether a hub of another version in the process has instances, so its loop, under the same server id, still holds the key. */
  const othersRunning = () =>
    Object.getOwnPropertySymbols(registry).some((key) => {
      const other = registry[key] as { members?: { size?: unknown } } | null | undefined
      const name = key.description ?? ""
      return other !== hub && (name === HUB_KEY || name.startsWith(`${HUB_KEY}@`)) && Number(other?.members?.size) > 0
    })

  /**
   * Removes the owner key if this server holds it, so another takes over at its next tick: once the
   * loop has stopped, no tick is under way and no other hub version here runs a loop under this id.
   */
  const release = async (ports: TickPorts) => {
    const scheduler = hub.scheduler
    const idle = () => scheduler.timer === undefined && !scheduler.running && !scheduler.ticking && !othersRunning()
    if (idle() && (await readOwner(ports))?.server === server && idle()) await ports.storage.remove(OWNER_KEY)
  }

  /**
   * Whether the tick under way still holds the next up: within a minute of its start it does; past
   * that it is taken to hang, holding up only while its member is loaded. `recent` says which.
   */
  const busy = () => {
    const { running, ticking } = hub.scheduler
    if (!running) return { busy: ticking !== undefined && hub.members.has(ticking), recent: false }
    const first = hub.members.values().next().value
    if (first && holds(running.since, first.later.now(), OWNER_EXPIRY_MS)) return { busy: true, recent: true }
    return { busy: hub.members.has(running.member), recent: false }
  }

  /** `busy`, renewing the key for a recent tick under way, as each tick falling due meanwhile does. */
  const underWay = () => {
    const state = busy()
    const first = hub.members.values().next().value
    if (state.recent && first) void renew(first.later).catch((error: unknown) => first.log(`courier_later scheduler: ${String(error)}`))
    return state.busy
  }

  // One tick, through the first loaded member, by the server holding the owner key. The claim on each
  // delivery stays, as a second line of defence against a pre-hub copy running its own interval.
  const tick = async () => {
    const scheduler = hub.scheduler
    if (underWay()) return
    scheduler.nudged = false
    const owner = hub.members.values().next().value
    if (!owner) return
    let since: number
    try {
      since = owner.later.now()
    } catch (error) {
      owner.log(`courier_later scheduler: ${String(error)}`)
      return
    }
    let end = () => {}
    const run: Tick = { member: owner, since, done: new Promise((resolve) => (end = resolve)) }
    scheduler.running = run
    scheduler.ticking = owner
    // `done` settles however the tick ends, and the key is given back, a log that throws included:
    // leaves wait for it. A log that throws is not logged again; there is nowhere left to tell.
    const tell = (message: string) => {
      try {
        owner.log(message)
      } catch {}
    }
    try {
      if ((await own(owner.later)) && scheduler.timer !== undefined && hub.members.has(owner)) {
        for (const job of jobs) await job(owner, hub.claimed)
      }
    } catch (error) {
      tell(`courier_later scheduler: ${String(error)}`)
    } finally {
      // A tick past its minute may have been followed by another, whose record stays.
      if (scheduler.running === run) {
        scheduler.running = undefined
        scheduler.ticking = undefined
      }
    }
    // A loop stopped meanwhile, its members gone, gives back the key this tick may have written.
    if (scheduler.timer === undefined)
      await release(owner.later).catch((error: unknown) => tell(`courier_later scheduler: owner key not released: ${String(error)}`))
    end()
    if (scheduler.nudged && scheduler.timer !== undefined) void scheduler.tick?.()
  }

  // Through the hub's tick, the copy loaded last's, like the loop's; this copy's only before one joined. A
  // tick under way runs once more when it ends, so nothing is started here meanwhile.
  const nudge = () => {
    const scheduler = hub.scheduler
    if (scheduler.timer === undefined) return
    scheduler.nudged = true
    if (!busy().busy) void (scheduler.tick ?? tick)()
  }

  // Subscriptions through the earliest members without one, the longest loaded, until there are
  // `WATCHERS`; never through `leaving`.
  const watch = (leaving?: Member) => {
    const watching = new Set(hub.watchers.map((watcher) => watcher.member))
    for (const member of hub.members) {
      if (hub.watchers.length >= WATCHERS || !hub.subscribe) return
      if (member !== leaving && !watching.has(member)) hub.watchers.push(hub.subscribe(member))
    }
  }

  // The work each member of this copy started and handed over, until it settles.
  const work = new WeakMap<Member, Set<Promise<unknown>>>()
  const track = (member: Member, started: Promise<unknown>) => {
    const set = work.get(member) ?? new Set()
    work.set(member, set)
    const settled: Promise<unknown> = started.catch(() => {}).finally(() => set.delete(settled))
    set.add(settled)
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
    watch()
    return () => {
      hub.members.delete(member)
      hub.locations.delete(member)
      // What this member leaves behind: the work it handed over, and a tick under way through it,
      // which keeps using its storage and session until it ends.
      const behind: Array<Promise<unknown>> = [...(work.get(member) ?? [])]
      if (scheduler.running?.member === member) behind.push(scheduler.running.done)
      // The other subscription, already connected, follows the events meanwhile; this one is replaced
      // before it ends, after its current event, so the relay's watcher count never drops to none.
      const index = hub.watchers.findIndex((watcher) => watcher.member === member)
      if (index >= 0) {
        const [leaving] = hub.watchers.splice(index, 1)
        watch(member)
        leaving!.stop.abort()
        behind.push(leaving!.done)
      }
      if (hub.members.size === 0 && scheduler.timer !== undefined) {
        timers.stop(scheduler.timer)
        scheduler.timer = undefined
        // After the tick under way, whichever copy started it, which may be writing the key.
        behind.push(
          (async () => {
            await scheduler.running?.done
            await release(member.later)
          })().catch((error: unknown) => member.log(`courier_later scheduler: owner key not released: ${String(error)}`)),
        )
      }
      if (behind.length === 0) return Promise.resolve()
      return Promise.race([Promise.allSettled(behind).then(() => {}), timers.wait(LEAVE_MS)])
    }
  }
  return {
    hub,
    join,
    track,
    nudge,
  }
}

/** This copy's hub, in the process. */
export const hub: Hub = find(globalThis as Registry).hub

/** Opens this copy's hub in the process, with its tick jobs; see `open`. */
export const openInProcess = (jobs: readonly TickJob[]) => open(globalThis as Registry, jobs)

/** The member of this copy's hub set up with `location` that joined last, while it is loaded. */
export function memberAt(location: object) {
  let found: Member | undefined
  for (const member of hub.members) if (member.location === location) found = member
  return found
}

/** The permission domains of the loaded instances. */
export const permissions = () => hub.locations.values()
