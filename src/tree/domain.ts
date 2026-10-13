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

/** The `nativeChildren` option: whether a child started without isolate gets OpenCode's own `parentID`; off unless `true`. */
export function readNativeChildren(options: unknown) {
  const value: unknown = obj(options).nativeChildren
  if (value === undefined || typeof value === "boolean") return { nativeChildren: value === true, problems: [] }
  return { nativeChildren: false, problems: [`nativeChildren must be true or false, not ${JSON.stringify(value)}; using false`] }
}

/** A session's times, as `session.get` gives them. */
type Times = Awaited<ReturnType<Context["session"]["get"]>>["time"]

/** Whether a session with these times runs: it has never finished a turn, or something reached it after the last one ended. */
export const busy = (time: Pick<Times, "updated" | "idle">) => time.idle === undefined || millis(time.updated) > millis(time.idle)

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
}

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
