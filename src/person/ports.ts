import type { Plugin } from "@opencode/plugin"
import type { FormsTold } from "../platform/hub.js"
import type { RosterEntry, RosterStorage } from "../roster.js"
import type { Waiting } from "./permission.js"

type Context = Plugin.Context

/** What the person events need of a member's `watch` ports, which are a `WatchPorts` at runtime. */
export interface PersonPorts {
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
 * What every plugin instance in the process shares of the person events: the handled event ids, shared
 * with the tree's, and the requests and forms the top sessions were told about or that were answered first.
 */
export interface PersonState {
  readonly seen: Set<string>
  readonly waiting: Waiting
  readonly answered: Set<string>
  readonly forms: FormsTold
}

/** The session at the top of a lineage: where its permission requests go, since that is where the person is. */
export const topOf = (chain: RosterEntry[]) => chain.at(-1)!.parentID
