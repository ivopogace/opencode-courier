import type { Plugin as EffectPlugin } from "@opencode/plugin/effect"
import { Cause, Exit, Result, type Effect } from "effect"
import type { Question } from "../hub.js"
import { withdrawnText, type Answers, type Asked, type Elsewhere, type Prompt, type Withdrawal } from "../notices.js"

type ToolEditor = Parameters<Parameters<EffectPlugin.Context["tool"]["transform"]>[0]>[0]
type HostTool = Parameters<Parameters<ToolEditor["update"]>[1]>[0]
export type Execute = HostTool["execute"]
export type ToolResult = Effect.Success<ReturnType<Execute>>

/** The questions of a call, without anything the tool does not define. */
export function promptsOf(input: unknown): Prompt[] {
  const questions = (input as { questions?: ReadonlyArray<Prompt> } | undefined)?.questions ?? []
  return questions.map((prompt) => ({
    question: prompt.question,
    header: prompt.header,
    options: prompt.options.map((option) => ({ label: option.label, description: option.description })),
    ...(prompt.multiple ? { multiple: true } : {}),
  }))
}

export interface QuestionAnswerInput {
  readonly sessionID: string
  readonly requestID: string
  /** One entry per question: a label or the text the person gave, or a list of them. */
  readonly answers: ReadonlyArray<string | ReadonlyArray<string>>
}

/** The answers in the question tool's shape, checked against the questions. */
export function normalize(asked: Asked, answers: QuestionAnswerInput["answers"]): Answers {
  if (answers.length !== asked.questions.length)
    throw new Error(`answers needs one entry per question, ${asked.questions.length} in all, not ${answers.length}.`)
  return answers.map((answer, index) => {
    const list = typeof answer === "string" ? [answer] : [...answer]
    const prompt = asked.questions[index]!
    if (!prompt.multiple && list.length > 1)
      throw new Error(`question ${index + 1} ("${prompt.header}") takes one answer, not ${list.length}.`)
    return list
  })
}

const defectTag = (cause: Cause.Cause<unknown>) => {
  const defect = Cause.findDefect(cause)
  return Result.isSuccess(defect) ? (defect.success as { _tag?: unknown } | undefined)?._tag : undefined
}
/** OpenCode's question tool dies with this when the person dismisses the question. */
export const isDismissal = (cause: Cause.Cause<unknown>) => defectTag(cause) === "QuestionTool.CancelledError"

/** How a relayed call ended. */
export type CallExit = Exit.Exit<{ by: "child"; result: ToolResult } | { by: "top" }, unknown>

/** How a relayed call that the top session did not answer was settled in the asking session. */
export function settledIn(exit: CallExit): Elsewhere {
  if (Exit.isSuccess(exit))
    return {
      by: "child",
      answers: ((exit.value as { result?: ToolResult }).result?.output as { answers?: Answers } | undefined)?.answers ?? [],
    }
  if (isDismissal(exit.cause)) return { by: "dismissed" }
  return { by: "failed", error: String(Cause.squash(exit.cause)) }
}

/**
 * Orders strings by UTF-16 code units, the default sort's order, stated: it only has to come out the
 * same on both sides of a comparison; a locale-aware compare may rank two different labels as equal.
 */
export function byCodeUnit(a: string, b: string) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

// The labels in any order: the answers are labels, so a top session listing them differently still asks the same.
export const choices = (questions: ReadonlyArray<Prompt>) =>
  JSON.stringify(questions.map((prompt) => [!!prompt.multiple, prompt.options.map((option) => option.label).sort(byCodeUnit)]))
export const wording = (questions: ReadonlyArray<Prompt>) =>
  JSON.stringify(questions.map((prompt) => prompt.question.trim().replace(/\s+/g, " ").toLowerCase()))

/** The answers that count once a linked call's question was settled without it: none unless it was answered. */
function withdrawnAnswers(linked: Question, how: Withdrawal): Answers {
  const none = () => linked.questions.map(() => [])
  switch (how.by) {
    case "top":
      return "answers" in how.outcome ? how.outcome.answers : none()
    case "child":
      return how.answers
    case "dismissed":
    case "failed":
      return none()
  }
}

/** The result of a linked call withdrawn because its question was settled without it. */
export function withdrawnResult(linked: Question, how: Withdrawal) {
  return {
    output: { answers: withdrawnAnswers(linked, how) },
    content: withdrawnText(linked, how),
    metadata: { relayed: linked.requestID, withdrawn: true },
  }
}
