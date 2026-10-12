import type { Plugin } from "@opencode/plugin"
import type { Storage } from "../../platform/storage.js"

type Context = Plugin.Context

/** One question of OpenCode's question tool, as the asking model wrote it. */
export interface Prompt {
  readonly question: string
  readonly header: string
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>
  readonly multiple?: boolean
}

/** The answers to a question call, as the question tool returns them: one list per question. */
export type Answers = string[][]

/** A question a spawned session asked with its question tool, stored until it is answered. */
export interface Asked {
  readonly requestID: string
  readonly sessionID: string
  /** The session told, at the top of the sessions started with courier_spawn; it alone answers. */
  readonly top: string
  readonly title: string
  /** The session that started the asking one, when that is not the top session itself. */
  readonly startedBy?: string
  readonly questions: ReadonlyArray<Prompt>
  readonly askedAt: number
}

/** How a question was settled without the top session: in the asking session, or not at all. */
export type Elsewhere =
  | { readonly by: "child"; readonly answers: Answers }
  | { readonly by: "dismissed" }
  | { readonly by: "failed"; readonly error: string }

/** What the top session's answer does to a call that waits: answers it, or dismisses it. */
export type Outcome = { readonly answers: Answers } | { readonly dismissed: true }

/**
 * Why a linked call is withdrawn: its question was settled elsewhere, or the top session's outcome
 * reached it another way (courier_answer, or a dismissal through an earlier call linked to it).
 */
export type Withdrawal = Elsewhere | { readonly by: "top"; readonly outcome: Outcome }

/**
 * A question this process knows: its call waits (`call`), or was cut off and is answered by message.
 * `link` withdraws the top session's call passing the answer on, once settled without that call.
 */
export interface Question extends Asked {
  /** The directory of the location the call runs in, whose shutdown withdraws its form. */
  directory?: string
  /** Hands the waiting call the top session's outcome; true once the call has ended with it. */
  call?: (outcome: Outcome) => Promise<boolean>
  link?: (how: Withdrawal) => void
  /** Storing the question and telling the top session, while that is under way. */
  relaying?: Promise<boolean>
  /** Working out what became of it once its call ended without the top session's answer. */
  settling?: Promise<void>
}

/**
 * The relay's timings, carried by its ports: the closing grace before a cut-off question is told, the
 * wait for an answer still being passed on, the wait for a notice to go out, and the dismissal hold.
 */
export interface QuestionTiming {
  readonly closingGraceMs: number
  readonly passingWaitMs: number
  readonly relayWaitMs: number
  readonly dismissalGraceMs: number
}

export interface QuestionPorts {
  readonly storage: Storage
  readonly session: Pick<Context["session"], "synthetic">
  /** The directory of the instance's location. */
  readonly directory: string
  /** The clock, in epoch milliseconds, as OpenCode's location shutdowns are recorded. */
  readonly now: () => number
  readonly timing: QuestionTiming
  readonly newID: () => string
  readonly log: (message: string) => void
}

/**
 * The question relay's state, shared by every instance, as a child and the session it asks can be in
 * different locations: open questions, cut-off ones already told, and calls waiting for their form.
 */
export interface QuestionState {
  readonly questions: Map<string, Question>
  readonly noticed: Set<string>
  readonly shown: Map<string, () => void>
  /** The questions whose answer is being passed on, each until that is done, and those whose answer went out. */
  readonly passing: Map<string, Promise<unknown>>
  readonly answered: Set<string>
  /**
   * The ports of every loaded instance of every copy. A release before the hub picks one here to tell
   * a cut-off question through, so every copy fills it; this copy reads it only for another copy.
   */
  readonly loaded: Set<QuestionPorts>
  /** How many instances follow OpenCode's events now, and whether any has since the process started. */
  following: number
  followed: boolean
  /**
   * When OpenCode last reported each location shutting down (`location.shutdown`), by directory
   * in epoch milliseconds by the clock of the watcher that saw it; under `""` when the event named no location.
   */
  readonly shutdowns: Map<string, number>
  /** Woken when a location shuts down or an instance unloads: dismissals held to see whether one follows. */
  readonly closingWaiters: Set<() => void>
}
