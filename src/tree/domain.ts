/**
 * The tree's pure rules, on plain data: the limits, a session's lineage, whether it runs, and a group
 * member's standing. Imports nothing of the plugin's but `kernel/` and `platform/json.ts`.
 */
import type { Plugin } from "@opencode/plugin"
import type { Status } from "../kernel/protocol.js"
import { millis, obj } from "../platform/json.js"

type Context = Plugin.Context

/** The limits on the tree of sessions courier_spawn builds, from the plugin's options. */
export interface Limits {
  readonly maxDepth: number
  readonly maxChildren: number
  readonly maxTotal: number
}

export const DEFAULT_LIMITS: Limits = { maxDepth: 5, maxChildren: 5, maxTotal: 30 }

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

/** The `nativeChildren` option: whether a child started without isolate gets OpenCode's own `parentID`; off unless `true`. */
export function readNativeChildren(options: unknown) {
  const value: unknown = obj(options).nativeChildren
  if (value === undefined || typeof value === "boolean") return { nativeChildren: value === true, problems: [] }
  return { nativeChildren: false, problems: [`nativeChildren must be true or false, not ${JSON.stringify(value)}; using false`] }
}

/** A session's times, as `session.get` gives them. */
type Times = Awaited<ReturnType<Context["session"]["get"]>>["time"]

/** A session's times as `busy` reads them. */
export type BusyTimes = Pick<Times, "updated" | "idle">

/**
 * Whether a session may run by its times: it has never finished a turn, or `updated` was stamped after the last one ended, as
 * a step does, and as much that is no activity does (a rename, an archive, a waiting inbox item), so only its transcript tells.
 */
export const busy = (time: BusyTimes) => time.idle === undefined || millis(time.updated) > millis(time.idle)

/** The messages the person's switch of agent or model, move or shell command appends, at rest or mid-turn alike. */
const ASIDES = new Set(["agent-switched", "model-switched", "location-switched", "shell"])

/** A stored message as `turnEnd` reads it: an assistant message's `error` says how its step ended. */
type Stored = { readonly type: string; readonly error?: { readonly type: string }; readonly time?: { readonly created?: unknown; readonly completed?: unknown } }

/**
 * The message a transcript's last turn ended on, unless one runs, past asides made since: an `idle` message, or a step
 * interrupted with none after it, as a declined permission or dismissed question ends a turn, recording no `idle` (#326).
 */
export function turnEnd<M extends Stored>(messages: ReadonlyArray<M>): M | undefined {
  const last = messages.findLast((message) => !ASIDES.has(message.type))
  return last?.type === "idle" || (last?.type === "assistant" && last.error?.type === "aborted") ? last : undefined
}

export const endsIdle = (messages: ReadonlyArray<Stored>) => turnEnd(messages) !== undefined

/** When the turn `end` ended: the session's idle time for an `idle` message, else when its interrupted step ended. */
export function endedAt(end: Stored, time: BusyTimes) {
  const at = end.type === "idle" ? millis(time.idle) : millis(end.time?.completed ?? end.time?.created)
  return Number.isFinite(at) ? at : undefined
}

/**
 * Whether a session of a tree read is live, for a cut listing's order: it runs (its turn not failed or interrupted since its last
 * prompt), waits on a request or form, or owes a report, but not, unlike for the limits, for a message waiting in its inbox.
 */
export const isLive = (running: boolean | undefined, waits: number, report: { readonly owes: boolean; readonly ended: boolean } | undefined) =>
  running !== undefined && ((running && !report?.ended) || waits > 0 || (report?.owes ?? false))

/** A session of a tree read, as `cut` takes it: where it is in the tree, when it was started, and whether it is live. */
export interface Cuttable {
  readonly sessionID: string
  readonly parentID: string
  readonly createdAt: number
  readonly live: boolean
}

/**
 * Which sessions a listing of at most `max` keeps, of a tree read in the order it is drawn: the live ones first, then
 * the newest, each with the sessions above it so the tree still draws; `leftOut` counts the rest.
 */
export function cut<T extends Cuttable>(nodes: ReadonlyArray<T>, max: number) {
  const byID = new Map(nodes.map((node) => [node.sessionID, node]))
  const ranked = nodes
    .map((node, order) => ({ node, order }))
    .sort((a, b) => Number(b.node.live) - Number(a.node.live) || b.node.createdAt - a.node.createdAt || a.order - b.order)
  const kept = new Set<string>()
  for (const { node } of ranked) {
    const chain: string[] = []
    for (let above: T | undefined = node; above && !kept.has(above.sessionID); above = byID.get(above.parentID)) chain.push(above.sessionID)
    if (kept.size + chain.length > max) continue
    for (const sessionID of chain) kept.add(sessionID)
  }
  return { kept: nodes.filter((node) => kept.has(node.sessionID)), leftOut: nodes.length - kept.size }
}

/** A session started with courier_spawn, recorded under the session that started it. */
export interface RosterEntry {
  readonly sessionID: string
  readonly parentID: string
  readonly title: string
  readonly directory: string
  readonly isolated: boolean
  readonly createdAt: number
  /** For an isolated child, the directory its worktree was made from; for the record, nothing acts on it. */
  readonly source?: string
  /** For an isolated child, the project its worktree belongs to; courier_cleanup removes it from there. */
  readonly project?: string
  /** For an isolated child, the commit its worktree was made from; its own work is what came after. */
  readonly base?: string
  /** `"status"` when its brief asked for a report with a status; absent for a child an earlier release briefed. */
  readonly reports?: "status"
  /** The join group courier_spawn put it in, whose release holds its report; absent for a child in none. */
  readonly group?: string
  /** Created with OpenCode's own `parentID` (the `nativeChildren` option), so OpenCode shows its asks in its parent's view. */
  readonly native?: true
  /** The model it was started on, as `modelName` writes it, when that is not the model its parent was on. */
  readonly model?: string
}

/** A model as a session names it: its provider, its id, and its variant, which `"default"` and none both leave to the provider. */
export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

/** `provider/model` as `courier_spawn` takes it: one slash, nothing empty on either side. */
export function parseModelName(text: string): Pick<ModelRef, "providerID" | "id"> | undefined {
  const slash = text.indexOf("/")
  if (slash <= 0 || slash === text.length - 1) return undefined
  return { providerID: text.slice(0, slash), id: text.slice(slash + 1) }
}

/** A model as the roster, the panel and the results name it: `provider/model`, with `#variant` for a variant that is not the default. */
export const modelName = (model: ModelRef) => `${model.providerID}/${model.id}${model.variant && model.variant !== "default" ? `#${model.variant}` : ""}`

/** `lineage` over roster entries already read. */
export function lineageIn(entries: ReadonlyArray<RosterEntry>, sessionID: string) {
  return lineageBy(bySession(entries), sessionID)
}

/** Roster entries by their session, for `lineageBy`. */
export function bySession(entries: ReadonlyArray<RosterEntry>) {
  return new Map(entries.map((entry) => [entry.sessionID, entry]))
}

/** `lineage` over roster entries already read and mapped by `bySession`. */
export function lineageBy(bySession: ReadonlyMap<string, RosterEntry>, sessionID: string) {
  const chain: RosterEntry[] = []
  for (let entry = bySession.get(sessionID); entry && !chain.includes(entry); entry = bySession.get(entry.parentID)) chain.push(entry)
  return chain
}

/**
 * The session whose view OpenCode shows the asks of a lineage's first session in: up its native parents, to the
 * first session that is not a native child (an isolated one, or the top). The session itself when it is not native.
 */
export function nativeRootOf(chain: ReadonlyArray<RosterEntry>) {
  let root = chain[0]!.sessionID
  for (const entry of chain) {
    if (!entry.native) break
    root = entry.parentID
  }
  return root
}

/** What a report lists besides its text; `checks` are the commands the session ran and what each gave. */
export interface Artifacts {
  readonly branch?: string
  readonly commits?: ReadonlyArray<string>
  readonly files?: ReadonlyArray<string>
  readonly checks?: ReadonlyArray<{ readonly command: string; readonly result: string }>
}

/** A report held with its group: its status, text and artifacts, as courier_send was given them, and when. */
export interface HeldReport {
  readonly at: number
  readonly status: Status
  readonly message: string
  readonly artifacts?: Artifacts
}

/** A member of a group that left it without a report, and why: its turn failed or was interrupted, it was deleted, or courier_cleanup dropped it. */
export interface LeftMember {
  readonly sessionID: string
  readonly title: string
  readonly by: "failed" | "interrupted" | "deleted" | "dropped"
}

/** What a group may be called: short, and with no `/`, which separates the parts of its keys, or `"`, which closes an attribute. */
const NAME = /^[\w.-]{1,60}$/

export const isGroupName = (value: unknown): value is string => typeof value === "string" && NAME.test(value)

/** A member of a group, as stored: its title for the release notice, and its report or how it left. */
export interface Member {
  readonly title: string
  readonly joinedAt: number
  readonly report?: HeldReport
  readonly left?: { readonly at: number; readonly by: LeftMember["by"] }
}

/** What is known of a member's standing: its report is held, still out, or it left, or it is no longer in an open group. */
export type Standing = "held" | "out" | LeftMember["by"] | "released"

/** A member's standing from its stored value, or `released` when there is none. */
export function standingOf(member: Member | undefined): Standing {
  if (!member) return "released"
  if (member.report) return "held"
  return member.left?.by ?? "out"
}

/** Whether every member of a group has a held report or has left: released once the parent's turn has ended. */
export const complete = (members: ReadonlyArray<Member>) => members.every((member) => member.report || member.left)

/** Longer than this is no wait a notice can plan around; OpenCode clamps a header to 2^53 ms, past what a `Date` holds. */
const RETRY_MAX_MS = 30 * 24 * 3_600_000

/** How long the provider asked to wait after a failed turn, if it did: a positive number of milliseconds, at most `RETRY_MAX_MS`. */
export function retryDelay(error: { readonly retryAfterMs?: unknown }) {
  const wait = error.retryAfterMs
  return typeof wait === "number" && Number.isFinite(wait) && wait > 0 && wait <= RETRY_MAX_MS ? wait : undefined
}
