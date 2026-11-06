import type { Plugin } from "@opencode/plugin"
import type { Storage } from "../../platform/storage.js"

type Context = Plugin.Context

export interface Prompt {
  readonly question: string
  readonly header: string
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>
  readonly multiple?: boolean
}

export type Answers = string[][]

export interface Asked {
  readonly requestID: string
  readonly sessionID: string
  readonly top: string
  readonly title: string
  readonly startedBy?: string
  readonly questions: ReadonlyArray<Prompt>
  readonly askedAt: number
  readonly native?: true
}

export type Elsewhere =
  | { readonly by: "child"; readonly answers: Answers; readonly via?: "inbox" }
  | { readonly by: "dismissed" }
  | { readonly by: "failed"; readonly error: string }

export type Outcome = { readonly answers: Answers } | { readonly dismissed: true }

export type Withdrawal = Elsewhere | { readonly by: "top"; readonly outcome: Outcome }

export interface Question extends Asked {
  directory?: string
  call?: (outcome: Outcome) => Promise<boolean>
  link?: (how: Withdrawal) => void
  relaying?: Promise<boolean>
  settling?: Promise<void>
}

export interface QuestionTiming {
  readonly closingGraceMs: number
  readonly passingWaitMs: number
  readonly relayWaitMs: number
  readonly dismissalGraceMs: number
}

export interface QuestionPorts {
  readonly storage: Storage
  readonly session: Pick<Context["session"], "synthetic">
  readonly directory: string
  readonly now: () => number
  readonly timing: QuestionTiming
  readonly newID: () => string
  readonly log: (message: string) => void
}

export interface QuestionState {
  readonly questions: Map<string, Question>
  readonly noticed: Set<string>
  readonly shown: Map<string, () => void>
  readonly passing: Map<string, Promise<unknown>>
  readonly answered: Set<string>
  readonly loaded: Set<QuestionPorts>
  following: number
  followed: boolean
  readonly shutdowns: Map<string, number>
  readonly closingWaiters: Set<() => void>
}
