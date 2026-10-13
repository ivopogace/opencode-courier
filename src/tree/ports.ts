/**
 * The tree's ports, what it needs of the plugin context and of other modules, and the data types they and
 * its texts take; those its pure rules take are declared in `domain.ts` and re-exported here.
 */
import type { Plugin } from "@opencode/plugin"
import type { Status } from "../kernel/protocol.js"
import type { Storage } from "../platform/storage.js"
import type { Limits, Member, RosterEntry } from "./domain.js"

export type { Artifacts, HeldReport, LeftMember, Limits, Member, RosterEntry, Standing } from "./domain.js"

type Context = Plugin.Context

export type RosterStorage = Storage

/** How a session's wait for a report ended: it reported to its parent, or its turn failed or was interrupted. */
export type Settled = "report" | "failed" | "interrupted"

/** The notes kept of a spawned session's report state; docs/reference.md has each. */
export type ReportField = "prompt" | "settled" | "progress" | "told" | "stopped"

/** A report note as read: when it was made, and for `settled` how the wait ended and the report's status, as stored. */
export interface ReportNote {
  readonly at: number | undefined
  readonly by: unknown
  readonly status: unknown
}

/** A stored value, as `Storage` gives and takes it. */
export type Stored = Parameters<Storage["set"]>[1]

/** The report keys found, by the session they are about. */
export type ReportKeys = ReadonlyMap<string, ReadonlyArray<string>>

/**
 * A spawned session as kept: its roster entry under its parent, the reverse index that finds it, and its report
 * state, which go together. The reverse index is only an index: a session it does not name is looked for in the roster.
 */
export interface ChildStore {
  /** Records a child under its parent, then indexes it; a failed index write is left to a scan and the next load. */
  record(entry: RosterEntry): Promise<void>
  /** Removes a child's entry and, at once and best effort, its reverse key and report state; only the entry's removal can fail it. */
  remove(parentID: string, sessionID: string): Promise<void>
  /** A session's roster entry under a parent, if it is there. */
  entry(parentID: string, sessionID: string): Promise<RosterEntry | undefined>
  /** A parent's children, oldest first. */
  children(parentID: string): Promise<RosterEntry[]>
  /** Every parent's children. */
  all(): Promise<RosterEntry[]>
  /** A session's roster entries: one for the parent that started it, none if courier_spawn did not. */
  entriesOf(sessionID: string): Promise<RosterEntry[]>
  /** The session that started a session, by the reverse index alone, without scanning the roster. */
  indexedParent(sessionID: string): Promise<string | undefined>
  /** A session's roster entry, by the reverse index alone, without scanning the roster. */
  indexedEntry(sessionID: string): Promise<RosterEntry | undefined>
  /**
   * The roster entries from a session up to the top, its own first, ending with the entry whose parent
   * courier_spawn did not start; empty when courier_spawn did not start the session.
   */
  lineage(sessionID: string): Promise<RosterEntry[]>
  /** `lineage` by the reverse index alone: empty, without scanning the roster, when it does not name the session. */
  indexedLineage(sessionID: string): Promise<RosterEntry[]>
  /** Writes the reverse keys missing or stale for the given entries, the whole roster, and drops those whose entry is gone. */
  backfill(entries: ReadonlyArray<RosterEntry>): Promise<void>
  /** The given notes of a session's report state, read at once. */
  notes<F extends ReportField>(sessionID: string, fields: ReadonlyArray<F>): Promise<{ readonly [K in F]: ReportNote }>
  /** Notes that a prompt or message reached a spawned session at `at`, unless a later one is noted. */
  prompted(sessionID: string, at: number): Promise<void>
  /** Notes how a spawned session's wait for a report ended at `at`, with its report's status, unless a later end is noted. */
  settled(sessionID: string, by: Settled, at: number, status?: Status): Promise<void>
  /** Notes that a spawned session messaged its parent without a status at `at`, unless a later one is noted. */
  progressed(sessionID: string, at: number): Promise<void>
  /** Notes that a spawned session's parent was told at `at` that a turn ended without a report, unless a later telling is noted. */
  told(sessionID: string, at: number): Promise<void>
  /** Takes back the note `told` made at `at`; a later one stays, and one that cannot be read goes. */
  untold(sessionID: string, at: number): Promise<void>
  /** Notes that courier_stop stopped a spawned session at `at`. */
  stopped(sessionID: string, at: number): Promise<void>
  /** A `settled` or `progress` note as stored, for `restore` to put back. */
  peek(sessionID: string, field: "settled" | "progress"): Promise<Stored | undefined>
  /** Puts back a note `peek` read; one that was not there is removed. */
  restore(sessionID: string, field: "settled" | "progress", value: Stored | undefined): Promise<void>
  /** Drops a session's report state. */
  forgetReport(sessionID: string): Promise<void>
  /** Every report key, by the session it is about. */
  reported(): Promise<ReportKeys>
  /** Removes report keys `reported` found, each best effort. */
  dropReported(keys: ReadonlyArray<string>): Promise<void>
}

/** A member of a join group with where it is kept. */
export interface Membership extends Member {
  readonly parentID: string
  readonly group: string
  readonly sessionID: string
}

/** The members of parents' join groups, each with its held report or how it left; a value that is not a member reads as none. */
export interface GroupStore {
  /** A session's member in a parent's group, if it is one. */
  member(parentID: string, group: string, sessionID: string): Promise<Member | undefined>
  /** The members of every group. */
  all(): Promise<Membership[]>
  /** The members of a parent's groups. */
  ofParent(parentID: string): Promise<Membership[]>
  /** The members of one group. */
  ofGroup(parentID: string, group: string): Promise<Membership[]>
  /** Writes a member in place of what was kept for it. */
  put(parentID: string, group: string, sessionID: string, member: Member): Promise<void>
  /** Removes a member whatever it holds. */
  remove(parentID: string, group: string, sessionID: string): Promise<void>
}

/** A report held with its group: which group, and how many of its members have reported so far, when that could be read. */
export interface Held {
  readonly group: string
  readonly reported?: number
  readonly members?: number
}

/**
 * What courier_send did; `report` says whether the message was noted as the sender's report to the session
 * that started it, and `held` that it was held with the sender's group rather than delivered, with no `messageID`.
 */
export interface Sent {
  readonly messageID?: string
  readonly status?: Status
  readonly report?: boolean
  readonly held?: Held
}

/** The slice of the plugin context the courier tools use; tests pass a fake. */
export interface CourierPorts {
  readonly session: Pick<Context["session"], "create" | "prompt" | "synthetic" | "get" | "context" | "interrupt">
  readonly agent: Pick<Context["agent"], "get">
  readonly worktree: Pick<Context["worktree"], "create" | "remove">
  /** The project of the plugin's location; an isolated child's worktree is made in it, and removed from it. */
  readonly projectID: string
  /** The commit a directory's checkout is on, or undefined; recorded as an isolated child's base. */
  readonly head: (directory: string) => Promise<string | undefined>
  /** Whether a directory's checkout has uncommitted changes, or undefined when git cannot tell. */
  readonly dirty: (directory: string) => Promise<boolean | undefined>
  readonly storage: RosterStorage
  readonly directory: string
  readonly now: () => number
  /** The permission requests and questions a session waits on, wherever they are pending. */
  readonly pending: (sessionID: string) => Promise<ReadonlyArray<Pending>>
  readonly limits: Limits
  readonly gate: SpawnGate
  /** The depths the `context` hook remembers; a parent's is dropped when it starts a child. */
  readonly roles: Map<string, number | null>
  /** Has the scheduler deliver what is due now rather than at its next tick: a group a report has just completed. */
  readonly nudge: () => void
  readonly log: (message: string) => void
}

/** One question a session waits on, as `Pending` shows it; `person/`'s `Prompt` has these fields. */
export interface PendingPrompt {
  readonly question: string
  readonly header: string
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>
  readonly multiple?: boolean
}

/** A request a session waits on until someone answers it: a permission request, or a question it asked. */
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
      /** Its question call was cut off; the answer reaches it as a message. */
      readonly stopped?: true
    }

/** A spawn past its limit check: its parent, the top of its tree, and its child once created. */
export interface Reservation {
  readonly parentID: string
  readonly top: string
  sessionID?: string
}

/**
 * The spawns under way in the process, under a fixed process-wide key outside the hub, so spawns in
 * other locations and copies count them; `turn` runs the limit checks one at a time.
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

/** What courier_cleanup did: removed the worktree, found it gone, kept it and why, or forgot a child with none; `group`, one it dropped the child from. */
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

/** What would be lost by removing a worktree. */
export interface WorktreeState {
  /** Paths with uncommitted changes, untracked files included, as `git status --porcelain` lists them. */
  readonly changes: readonly string[]
  /**
   * Commits reachable from the worktree's HEAD but from no branch, tag or remote-tracking ref, nor
   * from the commit the worktree was made from, newest first.
   */
  readonly commits: readonly string[]
}

export interface CleanupPorts {
  readonly storage: RosterStorage
  readonly worktree: Pick<Context["worktree"], "remove">
  /** The project of the plugin's location, for roster entries recorded before they carried their project. */
  readonly projectID: string
  /** The worktree's state, or undefined when its directory no longer exists; `base` is the commit it was made from. */
  readonly inspect: (directory: string, base?: string) => Promise<WorktreeState | undefined>
  /** When a member still out is dropped from its group. */
  readonly now: () => number
  /** Has the scheduler deliver what is due now: a group the forgotten child may have been the last member out of. */
  readonly nudge: () => void
}

export interface StopPorts {
  readonly courier: CourierPorts
  /** Cancels the messages scheduled for a session; the ids of those cancelled. */
  readonly cancelScheduled: (sessionID: string) => Promise<ReadonlyArray<string>>
  readonly cleanup: CleanupPorts
}

export interface GroupPorts {
  readonly storage: Storage
  readonly session: Pick<Context["session"], "synthetic" | "get">
  readonly log: (message: string) => void
}

/** The error of OpenCode's `session.execution.failed` event. */
export interface ExecutionError {
  readonly type: string
  readonly message: string
  readonly status?: number
}

export interface WatchPorts {
  readonly storage: RosterStorage
  /** `context` reads the last reply of a session that ended its turn without reporting. */
  readonly session: Pick<Context["session"], "synthetic" | "context">
  readonly event: Pick<Context["event"], "subscribe">
  /** The permission domains of every loaded location, which the `Waits` suppliers ask; an isolated child's are in its worktree's. */
  readonly permissions: () => Iterable<Pick<Context["permission"], "list">>
  /** The clock, in epoch milliseconds, for an event that carries no `created`. */
  readonly now: () => number
  readonly log: (message: string) => void
  /** Has the scheduler deliver what is due now rather than at its next tick: a group completed, or its parent's turn ended. */
  readonly nudge: () => void
}

/**
 * What every plugin instance in the process shares. Several subscriptions and copies see the same
 * events, so each is claimed synchronously and handled once.
 */
export interface WatchState {
  readonly seen: Set<string>
  /** The type of each item enqueued for a spawned session, by inbox id, for its delivery to look up. */
  readonly inbox: Map<string, string>
}

/**
 * Whether a session waits, since `since`, on what the tree does not keep: asked by the silent-turn
 * rule after the tree's own checks, through the watcher's ports; `src/index.ts` composes it.
 */
export type Waits = (ports: Pick<WatchPorts, "storage" | "permissions">, sessionID: string, since: number) => Promise<boolean>

export interface ContextPorts {
  readonly storage: RosterStorage
  readonly limits: Limits
  /** Each session's depth once looked up: null for one nobody spawned that has started none, until it starts one. */
  readonly roles: Map<string, number | null>
  readonly log: (message: string) => void
}
