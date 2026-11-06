import type { Plugin } from "@opencode/plugin"
import type { Status } from "../kernel/protocol.js"
import { millis, obj } from "../platform/json.js"

type Context = Plugin.Context

export interface Limits {
  readonly maxDepth: number
  readonly maxChildren: number
  readonly maxTotal: number
}

export const DEFAULT_LIMITS: Limits = { maxDepth: 5, maxChildren: 5, maxTotal: 30 }

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

export function readNativeChildren(options: unknown) {
  const value: unknown = obj(options).nativeChildren
  if (value === undefined || typeof value === "boolean") return { nativeChildren: value === true, problems: [] }
  return { nativeChildren: false, problems: [`nativeChildren must be true or false, not ${JSON.stringify(value)}; using false`] }
}

type Times = Awaited<ReturnType<Context["session"]["get"]>>["time"]

export type BusyTimes = Pick<Times, "updated" | "idle" | "busy">

// time.busy exists since 2.2.2; time.updated is no sign of activity (api-notes)
export const busy = (time: BusyTimes) => time.idle === undefined || millis(time.busy ?? time.updated) > millis(time.idle)

// a person's switches and shell commands append these, at rest or mid-turn
const ASIDES = new Set(["agent-switched", "model-switched", "location-switched", "shell"])

type Stored = { readonly type: string; readonly error?: { readonly type: string }; readonly time?: { readonly created?: unknown; readonly completed?: unknown } }

// a decline or dismissed question ends on an aborted step, no idle (api-notes)
export function turnEnd<M extends Stored>(messages: ReadonlyArray<M>): M | undefined {
  const last = messages.findLast((message) => !ASIDES.has(message.type))
  return last?.type === "idle" || (last?.type === "assistant" && last.error?.type === "aborted") ? last : undefined
}

export const endsIdle = (messages: ReadonlyArray<Stored>) => turnEnd(messages) !== undefined

export function endedAt(end: Stored, time: BusyTimes) {
  const at = end.type === "idle" ? millis(time.idle) : millis(end.time?.completed ?? end.time?.created)
  return Number.isFinite(at) ? at : undefined
}

export const isLive = (running: boolean | undefined, waits: number, report: { readonly owes: boolean; readonly ended: boolean } | undefined) =>
  running !== undefined && ((running && !report?.ended) || waits > 0 || (report?.owes ?? false))

export interface Cuttable {
  readonly sessionID: string
  readonly parentID: string
  readonly createdAt: number
  readonly live: boolean
}

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

export const RETENTION_MS = 14 * 24 * 60 * 60_000

export type Exists = (directory: string) => boolean

export const isExpired = (entry: RosterEntry, now: number, exists: Exists) =>
  now - entry.createdAt > RETENTION_MS && !(entry.isolated && exists(entry.directory))

export interface RosterEntry {
  readonly sessionID: string
  readonly parentID: string
  readonly title: string
  readonly directory: string
  readonly isolated: boolean
  readonly createdAt: number
  readonly source?: string
  readonly project?: string
  readonly base?: string
  readonly reports?: "status"
  readonly group?: string
  readonly native?: true
  readonly model?: string
}

export function startedAs(entry: RosterEntry) {
  return { isolated: entry.isolated, ...(entry.native ? { native: true as const } : {}), ...(entry.model ? { model: entry.model } : {}) }
}

export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

export function parseModelName(text: string): Pick<ModelRef, "providerID" | "id"> | undefined {
  const slash = text.indexOf("/")
  if (slash <= 0 || slash === text.length - 1) return undefined
  return { providerID: text.slice(0, slash), id: text.slice(slash + 1) }
}

export function modelName(model: ModelRef) {
  const variant = model.variant && model.variant !== "default" ? `#${model.variant}` : ""
  return `${model.providerID}/${model.id}${variant}`
}

export function lineageIn(entries: ReadonlyArray<RosterEntry>, sessionID: string) {
  return lineageBy(bySession(entries), sessionID)
}

export function bySession(entries: ReadonlyArray<RosterEntry>) {
  return new Map(entries.map((entry) => [entry.sessionID, entry]))
}

export function lineageBy(bySession: ReadonlyMap<string, RosterEntry>, sessionID: string) {
  const chain: RosterEntry[] = []
  for (let entry = bySession.get(sessionID); entry && !chain.includes(entry); entry = bySession.get(entry.parentID)) chain.push(entry)
  return chain
}

// OpenCode shows a native child's asks in its root's view (api-notes)
export function nativeRootOf(chain: ReadonlyArray<RosterEntry>) {
  let root = chain[0]!.sessionID
  for (const entry of chain) {
    if (!entry.native) break
    root = entry.parentID
  }
  return root
}

export interface Artifacts {
  readonly branch?: string
  readonly commits?: ReadonlyArray<string>
  readonly files?: ReadonlyArray<string>
  readonly checks?: ReadonlyArray<{ readonly command: string; readonly result: string }>
}

export interface HeldReport {
  readonly at: number
  readonly status: Status
  readonly message: string
  readonly artifacts?: Artifacts
}

export interface LeftMember {
  readonly sessionID: string
  readonly title: string
  readonly by: "failed" | "interrupted" | "deleted" | "dropped"
}

const GROUP_NAME = /^[\w.-]{1,60}$/

export const isGroupName = (value: unknown): value is string => typeof value === "string" && GROUP_NAME.test(value)

export interface Member {
  readonly title: string
  readonly joinedAt: number
  readonly report?: HeldReport
  readonly left?: { readonly at: number; readonly by: LeftMember["by"] }
}

export type Standing = "held" | "out" | LeftMember["by"] | "released"

export function standingOf(member: Member | undefined): Standing {
  if (!member) return "released"
  if (member.report) return "held"
  return member.left?.by ?? "out"
}

export const complete = (members: ReadonlyArray<Member>) => members.every((member) => member.report || member.left)

// OpenCode clamps retry-after to 2^53 ms, past what a Date holds
const RETRY_MAX_MS = 30 * 24 * 3_600_000

export function retryDelay(error: { readonly retryAfterMs?: unknown }) {
  const wait = error.retryAfterMs
  return typeof wait === "number" && Number.isFinite(wait) && wait > 0 && wait <= RETRY_MAX_MS ? wait : undefined
}
