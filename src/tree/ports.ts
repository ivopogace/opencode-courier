import type { Plugin } from "@opencode/plugin"
import type { Status } from "../kernel/protocol.js"
import type { Storage } from "../platform/storage.js"
import type { Limits, Member, ModelRef, RosterEntry } from "./domain.js"

export type { Artifacts, HeldReport, LeftMember, Limits, Member, ModelRef, RosterEntry, Standing } from "./domain.js"

type Context = Plugin.Context

export type RosterStorage = Storage

export type Settled = "report" | "failed" | "interrupted"

export type ReportField = "prompt" | "settled" | "progress" | "told" | "stopped" | "nudged"

export interface ReportNote {
  readonly at: number | undefined
  readonly by: unknown
  readonly status: unknown
  readonly resumesAt: unknown
}

export type Stored = Parameters<Storage["set"]>[1]

export type ReportKeys = ReadonlyMap<string, ReadonlyArray<string>>

export interface Typed {
  readonly at: number
  readonly text: string
}

export interface ChildStore {
  record(entry: RosterEntry): Promise<void>
  remove(parentID: string, sessionID: string): Promise<void>
  entry(parentID: string, sessionID: string): Promise<RosterEntry | undefined>
  children(parentID: string): Promise<RosterEntry[]>
  all(): Promise<RosterEntry[]>
  entriesOf(sessionID: string): Promise<RosterEntry[]>
  indexedParent(sessionID: string): Promise<string | undefined>
  indexedAncestors(sessionID: string): Promise<ReadonlyArray<string>>
  indexedEntry(sessionID: string): Promise<RosterEntry | undefined>
  lineage(sessionID: string): Promise<RosterEntry[]>
  indexedLineage(sessionID: string): Promise<RosterEntry[]>
  backfill(entries: ReadonlyArray<RosterEntry>): Promise<void>
  notes<F extends ReportField>(sessionID: string, fields: ReadonlyArray<F>): Promise<{ readonly [K in F]: ReportNote }>
  prompted(sessionID: string, at: number): Promise<void>
  settled(sessionID: string, by: Settled, at: number, status?: Status, resumesAt?: number): Promise<void>
  progressed(sessionID: string, at: number): Promise<void>
  told(sessionID: string, at: number): Promise<void>
  untold(sessionID: string, at: number): Promise<void>
  stopped(sessionID: string, at: number): Promise<void>
  nudged(sessionID: string, at: number, inboxID?: string): Promise<void>
  nudgeOf(sessionID: string): Promise<{ readonly at: number | undefined; readonly inboxID?: string }>
  peek(sessionID: string, field: "settled" | "progress"): Promise<Stored | undefined>
  restore(sessionID: string, field: "settled" | "progress", value: Stored | undefined): Promise<void>
  forgetReport(sessionID: string): Promise<void>
  reported(): Promise<ReportKeys>
  dropReported(keys: ReadonlyArray<string>): Promise<void>
  typed(sessionID: string, inboxID: string, at: number, text: string): Promise<void>
  typedOf(sessionID: string, inboxID: string): Promise<Typed | undefined>
  forgetTyped(sessionID: string, inboxID?: string): Promise<void>
  typedSessions(): Promise<ReadonlySet<string>>
}

export interface Wake {
  readonly sessionID: string
  readonly inboxID: string
  readonly at: number
  readonly text: string
  readonly description?: string
  readonly running: boolean
  readonly idleAt?: number
  readonly rewoken?: number
  readonly stalled?: number
}

export interface WakeStore {
  put(wake: Wake): Promise<void>
  of(sessionID: string): Promise<Wake[]>
  all(): Promise<Wake[]>
  remove(sessionID: string, inboxID: string): Promise<void>
}

export interface Membership extends Member {
  readonly parentID: string
  readonly group: string
  readonly sessionID: string
}

export interface GroupStore {
  member(parentID: string, group: string, sessionID: string): Promise<Member | undefined>
  all(): Promise<Membership[]>
  ofParent(parentID: string): Promise<Membership[]>
  ofGroup(parentID: string, group: string): Promise<Membership[]>
  put(parentID: string, group: string, sessionID: string, member: Member): Promise<void>
  remove(parentID: string, group: string, sessionID: string): Promise<void>
}

export interface Held {
  readonly group: string
  readonly reported?: number
  readonly members?: number
}

export interface Sent {
  readonly messageID?: string
  readonly status?: Status
  readonly report?: boolean
  readonly held?: Held
  readonly dropped?: Status
}

export interface Role {
  readonly depth: number | null
  readonly entry: boolean
  readonly subagent?: true
}

export type Instructions = Partial<Pick<Context["session"], "instructions">>

export type Lister = Partial<Pick<Context["session"], "list">>

export interface Entry {
  readonly key: string
  readonly value: string
}

export type Entries = () => Promise<ReadonlyArray<Entry>>

export interface StandingPorts {
  readonly storage: RosterStorage
  readonly now: () => number
  readonly session?: Instructions
  readonly log?: (message: string) => void
}

export interface CourierPorts {
  readonly session: Pick<Context["session"], "create" | "prompt" | "synthetic" | "get" | "context" | "interrupt"> & Instructions & Lister
  readonly entries?: Entries
  readonly agent: Pick<Context["agent"], "get">
  readonly worktree: Pick<Context["worktree"], "create" | "remove">
  readonly projectID: string
  readonly head: (directory: string) => Promise<string | undefined>
  readonly dirty: (directory: string) => Promise<boolean | undefined>
  readonly storage: RosterStorage
  readonly directory: string
  readonly now: () => number
  readonly pending: (sessionID: string) => Promise<ReadonlyArray<Pending>>
  readonly forms: (sessionID: string) => Promise<ReadonlyArray<ShownForm>>
  readonly models: () => Promise<ReadonlyArray<KnownModel>>
  readonly defaultModel: () => Promise<ModelRef | undefined>
  readonly limits: Limits
  readonly nativeChildren?: boolean
  readonly gate: SpawnGate
  readonly roles: Map<string, Role>
  readonly nudge: () => void
  readonly log: (message: string) => void
}

export interface ModelWindow {
  readonly providerID: string
  readonly id: string
  readonly context: number
}

export interface KnownModel extends ModelWindow {
  readonly variants: ReadonlyArray<string>
}

export interface ShownForm {
  readonly id: string
  readonly title: string
}

export interface PendingPrompt {
  readonly question: string
  readonly header: string
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>
  readonly multiple?: boolean
}

export type Pending =
  | {
      readonly type: "permission"
      readonly requestID: string
      readonly action: string
      readonly resources: ReadonlyArray<string>
      readonly save?: ReadonlyArray<string>
    }
  | {
      readonly type: "question"
      readonly requestID: string
      readonly questions: ReadonlyArray<PendingPrompt>
      readonly stopped?: true
    }

export interface Reservation {
  readonly parentID: string
  readonly top: string
  sessionID?: string
}

export interface SpawnGate {
  readonly reserved: Set<Reservation>
  turn: Promise<unknown>
}

export interface LimitPorts {
  readonly storage: RosterStorage
  readonly session: Pick<Context["session"], "get" | "context">
  readonly limits: Limits
  readonly gate: SpawnGate
}

export type CleanupResult =
  | { readonly sessionID: string; readonly directory: string; readonly outcome: "removed" | "gone" | "forgotten"; readonly group?: string }
  | {
      readonly sessionID: string
      readonly directory: string
      readonly outcome: "kept"
      readonly reason: string
      readonly changes: readonly string[]
      readonly commits: readonly string[]
    }

export interface WorktreeState {
  readonly changes: readonly string[]
  readonly commits: readonly string[]
}

export interface CleanupPorts {
  readonly storage: RosterStorage
  readonly worktree: Pick<Context["worktree"], "remove">
  readonly projectID: string
  readonly inspect: (directory: string, base?: string) => Promise<WorktreeState | undefined>
  readonly now: () => number
  readonly nudge: () => void
  readonly session?: Instructions
  readonly log?: (message: string) => void
}

export interface StopPorts {
  readonly courier: CourierPorts
  readonly cancelScheduled: (sessionID: string) => Promise<ReadonlyArray<string>>
  readonly cleanup: CleanupPorts
}

export interface GroupPorts {
  readonly storage: Storage
  readonly session: Pick<Context["session"], "synthetic" | "get" | "context"> & Instructions
  readonly now: () => number
  readonly log: (message: string) => void
}

export interface ExecutionError {
  readonly type: string
  readonly message: string
  readonly status?: number
  readonly retryAfterMs?: number
}

export interface WatchPorts {
  readonly storage: RosterStorage
  readonly session: Pick<Context["session"], "synthetic" | "context" | "get"> & Instructions
  readonly event: Pick<Context["event"], "subscribe">
  readonly permissions: () => Iterable<Pick<Context["permission"], "list">>
  readonly now: () => number
  readonly log: (message: string) => void
  readonly nudge: () => void
}

export interface WatchState {
  readonly seen: Set<string>
  readonly inbox: Map<string, string>
}

export type Waits = (ports: Pick<WatchPorts, "storage" | "permissions">, sessionID: string, since: number) => Promise<boolean>

export interface ContextPorts {
  readonly storage: RosterStorage
  readonly limits: Limits
  readonly roles: Map<string, Role>
  readonly session: Pick<Context["session"], "get">
  readonly instructions?: Context["session"]["instructions"]
  readonly hiddenFromLeaf?: ReadonlyArray<string>
  readonly log: (message: string) => void
}
