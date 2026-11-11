import { randomInt } from "node:crypto"
import { hostname } from "node:os"
import { num, obj, str } from "./json.js"
import { processWide, type Registry, type Storage } from "./storage.js"

export const HUB_VERSION = 2

export const HUB_KEY = "opencode-courier.hub"

export interface TickPorts {
  readonly storage: Pick<Storage, "get" | "set" | "remove">
  readonly now: () => number
}

export interface Watched {
  readonly seen: Set<string>
  readonly waiting: Set<string>
  readonly answered: Set<string>
}

export interface FormsTold {
  readonly told: Map<string, Promise<unknown>>
  readonly settled: Set<string>
}

export interface Member {
  readonly directory: string
  readonly location?: object
  readonly permission: unknown
  readonly later: TickPorts
  readonly watch: unknown
  readonly questions: unknown
  readonly log: (message: string) => void
}

export interface Tick {
  readonly member: Member
  readonly since: number
  readonly done: Promise<void>
}

export interface Scheduler {
  timer?: unknown
  running?: Tick
  ticking?: Member
  tick?: () => Promise<void>
  nudged?: boolean
}

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

export const TICK_MS = 15_000

export const OWNER_KEY = "scheduler/owner"

export const OWNER_EXPIRY_MS = 4 * TICK_MS

export const OWNER_RENEW_MS = OWNER_EXPIRY_MS / 2

export const OWNER_WAIT_MS = 500

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

export const LEAVE_MS = 2_000

const holds = (at: number, now: number, ms: number) => Math.abs(now - at) < ms

export const WATCHERS = 2

export interface Watcher {
  readonly member: Member
  readonly stop: AbortController
  readonly done: Promise<void>
}

export interface Hub {
  readonly version: typeof HUB_VERSION
  readonly members: Set<Member>
  readonly scheduler: Scheduler
  readonly watchers: Watcher[]
  subscribe?: (member: Member) => Watcher
  readonly claimed: Set<string>
  readonly watched: Watched
  readonly forms: FormsTold
  readonly locations: Map<object, unknown>
  readonly receivers: object
  readonly questions: object
  skewLogged: boolean
}

export type TickJob = (owner: Member, claimed: Set<string>) => Promise<void>

export interface Opened {
  readonly hub: Hub
  readonly join: (member: Member) => () => Promise<void>
  readonly track: (member: Member, work: Promise<unknown>) => void
  readonly nudge: () => void
}

export function sharedState<T>(name: string, create: () => T, registry: Registry = globalThis as Registry): T {
  return processWide(`opencode-courier.${name}`, create, registry)
}

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
    questions: shared<object>("questions", () => ({})),
    skewLogged: false,
  })

  const found = registry[Symbol.for(HUB_KEY)] as { version?: unknown } | null | undefined
  const skew = found != null && found.version !== HUB_VERSION ? { version: found.version } : undefined
  return { hub: processWide(skew ? `${HUB_KEY}@${HUB_VERSION}` : HUB_KEY, create, registry), skew }
}

export function open(registry: Registry, jobs: readonly TickJob[], timers: Timers = realTimers, server = SERVER): Opened {
  const { hub, skew } = find(registry)

  const own = async (ports: TickPorts) => {
    const held = await readOwner(ports)
    const now = ports.now()
    if (held && held.server !== server && holds(held.at, now, OWNER_EXPIRY_MS)) return false
    await ports.storage.set(OWNER_KEY, { server, at: now })
    if (fresh(held, now)) return true
    await timers.wait(randomInt(OWNER_WAIT_MS, 2 * OWNER_WAIT_MS))
    return (await readOwner(ports))?.server === server
  }

  const fresh = (held: Owner | undefined, now: number) => held?.server === server && holds(held.at, now, OWNER_RENEW_MS)

  const renew = async (ports: TickPorts) => {
    const now = ports.now()
    if (fresh(await readOwner(ports), now)) await ports.storage.set(OWNER_KEY, { server, at: now })
  }

  const othersRunning = () =>
    Object.getOwnPropertySymbols(registry).some((key) => {
      const other = registry[key] as { members?: { size?: unknown } } | null | undefined
      const name = key.description ?? ""
      return other !== hub && (name === HUB_KEY || name.startsWith(`${HUB_KEY}@`)) && Number(other?.members?.size) > 0
    })

  const release = async (ports: TickPorts) => {
    const scheduler = hub.scheduler
    const idle = () => scheduler.timer === undefined && !scheduler.running && !scheduler.ticking && !othersRunning()
    if (idle() && (await readOwner(ports))?.server === server && idle()) await ports.storage.remove(OWNER_KEY)
  }

  const busy = () => {
    const { running, ticking } = hub.scheduler
    if (!running) return { busy: ticking !== undefined && hub.members.has(ticking), recent: false }
    const first = hub.members.values().next().value
    if (first && holds(running.since, first.later.now(), OWNER_EXPIRY_MS)) return { busy: true, recent: true }
    return { busy: hub.members.has(running.member), recent: false }
  }

  const underWay = () => {
    const state = busy()
    const first = hub.members.values().next().value
    if (state.recent && first) void renew(first.later).catch((error: unknown) => first.log(`courier_later scheduler: ${String(error)}`))
    return state.busy
  }

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
      if (scheduler.running === run) {
        scheduler.running = undefined
        scheduler.ticking = undefined
      }
    }
    if (scheduler.timer === undefined)
      await release(owner.later).catch((error: unknown) => tell(`courier_later scheduler: owner key not released: ${String(error)}`))
    end()
    if (scheduler.nudged && scheduler.timer !== undefined) void scheduler.tick?.()
  }

  const nudge = () => {
    const scheduler = hub.scheduler
    if (scheduler.timer === undefined) return
    scheduler.nudged = true
    if (!busy().busy) void (scheduler.tick ?? tick)()
  }

  const watch = (leaving?: Member) => {
    const watching = new Set(hub.watchers.map((watcher) => watcher.member))
    for (const member of hub.members) {
      if (hub.watchers.length >= WATCHERS || !hub.subscribe) return
      if (member !== leaving && !watching.has(member)) hub.watchers.push(hub.subscribe(member))
    }
  }

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
      const behind: Array<Promise<unknown>> = [...(work.get(member) ?? [])]
      if (scheduler.running?.member === member) behind.push(scheduler.running.done)
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

export const hub: Hub = find(globalThis as Registry).hub

export const openInProcess = (jobs: readonly TickJob[]) => open(globalThis as Registry, jobs)

export function memberAt(location: object) {
  let found: Member | undefined
  for (const member of hub.members) if (member.location === location) found = member
  return found
}

export const permissions = () => hub.locations.values()
