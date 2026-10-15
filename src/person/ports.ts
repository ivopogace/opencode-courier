import type { Plugin } from "@opencode/plugin"
import type { FormsTold } from "../platform/hub.js"
import type { RosterEntry, RosterStorage } from "../tree/index.js"
import type { Waiting } from "./permission.js"

// What `text.ts` takes of the files that own it, so it reads its module's types from here alone.
export type { PermissionAnswered, PermissionRequest, Reply } from "./permission.js"
export type { Asked, Elsewhere, Outcome, Prompt, QuestionAnswered, Withdrawal } from "./question/index.js"

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

/** The forms spawned sessions and others show, which only the person can answer, by form id; not the question tool's. */
export type FormsShown = Map<string, { readonly sessionID: string; readonly title: string }>

/**
 * What every plugin instance in the process shares of the person events: the handled event ids (the tree's too),
 * the requests and forms told about or answered first, and the forms shown now.
 */
export interface PersonState {
  readonly seen: Set<string>
  readonly waiting: Waiting
  readonly answered: Set<string>
  readonly forms: FormsTold
  readonly shown: FormsShown
}

/** The session at the top of a lineage: where its permission requests go, since that is where the person is. */
export const topOf = (chain: RosterEntry[]) => chain.at(-1)!.parentID

/** One field of an OpenCode form, as much of it as a notice shows. */
export interface FormField {
  readonly key: string
  readonly type: string
  readonly title?: string
  readonly description?: string
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string; readonly description?: string }>
  readonly url?: string
  /** Not shown to the person. */
  readonly hidden?: boolean
  /** Conditions on earlier answers; the field is shown only when they hold. */
  readonly when?: ReadonlyArray<unknown>
}

/** An OpenCode form, as its `form.created` event carries it. */
export interface Form {
  readonly id: string
  readonly sessionID: string
  readonly title: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly fields: ReadonlyArray<FormField>
}
