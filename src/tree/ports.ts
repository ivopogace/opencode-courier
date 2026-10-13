/**
 * The tree's ports, what it needs of the plugin context and of other modules, and the data types they and
 * its texts take; those its pure rules take are declared in `domain.ts` and re-exported here.
 */
import type { Plugin } from "@opencode/plugin"
import type { Status } from "../kernel/protocol.js"
import type { Storage } from "../platform/storage.js"
import type { Limits } from "./domain.js"

export type { Artifacts, HeldReport, LeftMember, Limits, Member, RosterEntry, Standing } from "./domain.js"

type Context = Plugin.Context

export type RosterStorage = Storage

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
