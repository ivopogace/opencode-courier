import type { Plugin } from "@opencode/plugin"
import { setBounded } from "./bounded.js"
import { obj } from "./json.js"
import { childrenRefusal, depthRefusal, ROLE_PREFIX, rolePart, totalRefusal, type Limits } from "./notices.js"
import { allEntries, bySession, children, indexedLineage, lineageBy, type RosterStorage } from "./roster.js"

export type { Limits } from "./notices.js"

type Context = Plugin.Context

export const DEFAULT_LIMITS: Limits = { maxDepth: 3, maxChildren: 5, maxTotal: 20 }

/** The limits in the plugin's options; one that is not a positive integer keeps its default and is named in `problems`. */
export function readLimits(options: unknown) {
  const given = obj(options)
  const problems: string[] = []
  const read = (name: keyof Limits) => {
    const value: unknown = given[name]
    if (value === undefined) return DEFAULT_LIMITS[name]
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
    problems.push(`${name} must be a positive integer, not ${JSON.stringify(value)}; using ${DEFAULT_LIMITS[name]}`)
    return DEFAULT_LIMITS[name]
  }
  const limits: Limits = { maxDepth: read("maxDepth"), maxChildren: read("maxChildren"), maxTotal: read("maxTotal") }
  return { limits, problems }
}

/** A spawn past its limit check: its parent, the top of its tree, and its child once created. */
export interface Reservation {
  readonly parentID: string
  readonly top: string
  sessionID?: string
}

/**
 * The spawns under way in the process, kept by the hub under a fixed key, so spawns in other
 * locations and copies count them; `turn` runs the limit checks one at a time.
 */
export interface SpawnGate {
  readonly reserved: Set<Reservation>
  turn: Promise<unknown>
}

export interface LimitPorts {
  readonly storage: RosterStorage
  readonly session: Pick<Context["session"], "get">
  readonly limits: Limits
  readonly gate: SpawnGate
}

/** Epoch milliseconds from a session time, a `DateTime` in OpenCode's API and a number in tests. */
function millis(value: unknown) {
  if (typeof value === "number") return value
  if (typeof value === "string") return Date.parse(value)
  const epoch: unknown = obj(value).epochMilliseconds
  return typeof epoch === "number" ? epoch : Number.NaN
}

/**
 * Whether a session is running: it has never finished a turn, or something reached it after the last
 * one ended. One OpenCode no longer knows is not.
 */
export async function running(ports: Pick<LimitPorts, "session">, sessionID: string) {
  try {
    const { time } = await ports.session.get({ sessionID })
    return time.idle === undefined || millis(time.updated) > millis(time.idle)
  } catch {
    return false
  }
}

/**
 * Checks the limits for a spawn from `parentID`, then holds its place in `gate` until `release`;
 * throws a refusal naming the limit. Checks run one at a time, so spawns made together count each other.
 */
export async function admit(ports: LimitPorts, parentID: string) {
  const gate = ports.gate
  const checked = gate.turn.then(() => check(ports, parentID))
  gate.turn = checked.catch(() => undefined)
  const { depth, reservation } = await checked
  const release = () => {
    gate.reserved.delete(reservation)
  }
  return { depth, reservation, release }
}

async function check(ports: LimitPorts, parentID: string) {
  const { maxDepth, maxChildren, maxTotal } = ports.limits
  const entries = await allEntries(ports.storage)
  const parents = bySession(entries)
  const chain = lineageBy(parents, parentID)
  if (chain.length >= maxDepth) throw new Error(depthRefusal(chain.length, maxDepth))
  const top = chain.at(-1)?.parentID ?? parentID
  const chains = new Map(entries.map((entry) => [entry.sessionID, lineageBy(parents, entry.sessionID)]))
  const tree = entries.filter((entry) => chains.get(entry.sessionID)!.at(-1)?.parentID === top)
  const runs = await Promise.all(tree.map((entry) => running(ports, entry.sessionID)))
  // A session waiting on a running descendant is live too: the brief tells it to end its turn meanwhile.
  const active = new Set(
    tree.filter((_, i) => runs[i]).flatMap((entry) => [entry.sessionID, ...chains.get(entry.sessionID)!.map((above) => above.parentID)]),
  )
  const live = tree.filter((entry) => active.has(entry.sessionID))
  // A spawn whose child is on the roster already is counted there, if it runs, not by its reservation.
  const recorded = new Set(tree.map((entry) => entry.sessionID))
  const pending = [...ports.gate.reserved].filter((held) => held.top === top && !(held.sessionID && recorded.has(held.sessionID)))
  const mine = live.filter((entry) => entry.parentID === parentID).length + pending.filter((held) => held.parentID === parentID).length
  if (mine >= maxChildren) throw new Error(childrenRefusal(mine, maxChildren))
  if (live.length + pending.length >= maxTotal) throw new Error(totalRefusal(live.length + pending.length, maxTotal))
  const reservation: Reservation = { parentID, top }
  ports.gate.reserved.add(reservation)
  return { depth: chain.length + 1, reservation }
}

/** How many sessions' depths an instance remembers. */
const ROLES_MAX = 1000

export interface ContextPorts {
  readonly storage: RosterStorage
  readonly limits: Limits
  /** Each session's depth once looked up: null for one nobody spawned that has started none. */
  readonly roles: Map<string, number | null>
  readonly log: (message: string) => void
}

/** The part of a session context this hook changes. */
export interface Shaped {
  readonly sessionID: string
  tools: Record<string, unknown>
  system: Array<{ type: "text"; text: string }>
}

/**
 * The `context` hook: names a session's role in its tree in a system part, and hides courier_spawn
 * from one at `maxDepth`. A session nobody spawned that has started none is left as it is.
 */
export async function shapeContext(ports: ContextPorts, event: Shaped) {
  try {
    const depth = await depthOf(ports, event.sessionID)
    if (depth === null) return
    if (depth >= ports.limits.maxDepth) delete event.tools.courier_spawn
    if (!event.system.some((part) => part.text.startsWith(ROLE_PREFIX)))
      event.system.push({ type: "text", text: rolePart(depth, ports.limits) })
  } catch (error) {
    ports.log(`courier: cannot tell the role of session ${event.sessionID}: ${String(error)}`)
  }
}

async function depthOf(ports: ContextPorts, sessionID: string) {
  const known = ports.roles.get(sessionID)
  if (known !== undefined) return known
  // The reverse index alone: a scan here would run for every session's first request, courier or not.
  const chain = await indexedLineage(ports.storage, sessionID)
  const depth = chain.length || ((await children(ports.storage, sessionID)).length ? 0 : null)
  setBounded(ports.roles, sessionID, depth, ROLES_MAX)
  return depth
}
