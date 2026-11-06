import type { Plugin as EffectPlugin } from "@opencode/plugin/effect"
import { Cause, Exit, Result, type Effect } from "effect"
import type { Answers, Asked, Elsewhere, Prompt, Question, Withdrawal } from "./types.js"
import { withdrawnText } from "../text.js"

type ToolEditor = Parameters<Parameters<EffectPlugin.Context["tool"]["transform"]>[0]>[0]
type HostTool = Parameters<Parameters<ToolEditor["update"]>[1]>[0]
export type Execute = HostTool["execute"]
export type ToolResult = Effect.Success<ReturnType<Execute>>

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
  readonly answers: ReadonlyArray<string | ReadonlyArray<string>>
}

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
export const isDismissal = (cause: Cause.Cause<unknown>) => defectTag(cause) === "QuestionTool.CancelledError"

export type CallExit = Exit.Exit<{ by: "child"; result: ToolResult } | { by: "top" }, unknown>

export function settledIn(exit: CallExit): Elsewhere {
  if (Exit.isSuccess(exit))
    return {
      by: "child",
      answers: ((exit.value as { result?: ToolResult }).result?.output as { answers?: Answers } | undefined)?.answers ?? [],
    }
  if (isDismissal(exit.cause)) return { by: "dismissed" }
  return { by: "failed", error: String(Cause.squash(exit.cause)) }
}

export function byCodeUnit(a: string, b: string) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

export const choices = (questions: ReadonlyArray<Prompt>) =>
  JSON.stringify(questions.map((prompt) => [!!prompt.multiple, prompt.options.map((option) => option.label).sort(byCodeUnit)]))
export const wording = (questions: ReadonlyArray<Prompt>) =>
  JSON.stringify(questions.map((prompt) => prompt.question.trim().replace(/\s+/g, " ").toLowerCase()))

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

export function withdrawnResult(linked: Question, how: Withdrawal) {
  return {
    output: { answers: withdrawnAnswers(linked, how) },
    content: withdrawnText(linked, how),
    metadata: { relayed: linked.requestID, withdrawn: true },
  }
}
