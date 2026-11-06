import type { Plugin } from "@opencode/plugin"
import type { FormsTold } from "../platform/hub.js"
import type { RosterEntry, RosterStorage } from "../tree/index.js"
import type { Waiting } from "./permission.js"

export type { PermissionAnswered, PermissionRequest, Reply } from "./permission.js"
export type { Asked, Elsewhere, Outcome, Prompt, QuestionAnswered, Withdrawal } from "./question/index.js"

type Context = Plugin.Context

export interface PersonPorts {
  readonly storage: RosterStorage
  readonly session: Pick<Context["session"], "synthetic">
  readonly event: Pick<Context["event"], "subscribe">
  readonly permissions: () => Iterable<Pick<Context["permission"], "list">>
  readonly now: () => number
  readonly log: (message: string) => void
}

export type FormsShown = Map<string, { readonly sessionID: string; readonly title: string }>

export interface PersonState {
  readonly seen: Set<string>
  readonly waiting: Waiting
  readonly answered: Set<string>
  readonly forms: FormsTold
  readonly shown: FormsShown
}

export const topOf = (chain: RosterEntry[]) => chain.at(-1)!.parentID

export interface FormField {
  readonly key: string
  readonly type: string
  readonly title?: string
  readonly description?: string
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string; readonly description?: string }>
  readonly url?: string
  readonly hidden?: boolean
  readonly when?: ReadonlyArray<unknown>
}

export interface Form {
  readonly id: string
  readonly sessionID: string
  readonly title: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly fields: ReadonlyArray<FormField>
}
