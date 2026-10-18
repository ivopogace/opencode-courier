/**
 * What every module of the plugin shares of the protocol with the models: the envelope a message arrives in,
 * the phrase that ends a turn, the statuses of a report, the split line and the skill's id, and how outside
 * text is clipped and defused.
 */

/** Closes a tool result after which the caller most likely has nothing left to do. */
export const END_TURN = "If nothing else is left to do now, end your turn by replying without calling more tools."

/** The statuses a report carries: the task is done, partly done, waits on the parent, or failed. */
export const STATUSES = ["done", "partial", "blocked", "failed"] as const
export type Status = (typeof STATUSES)[number]

export const isStatus = (value: unknown): value is Status => typeof value === "string" && (STATUSES as readonly string[]).includes(value)

/** The one line a session states its split decision in, so a transcript tells a decision from one never made. */
export const SPLIT_LINE =
  "split: no, because …; considered: <the parts you weighed> or split: <n> parts: … (one phrase per part)"

export const SKILL_ID = "courier-orchestrate"

export function envelope(from: string, message: string, attributes: Record<string, string> = {}) {
  const extra = Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("")
  return `<courier from="${from}"${extra}>\n${message}\n</courier>`
}

/** Longest piece of free text (a review body, a generic payload) copied into a delivered message. */
const MAX_TEXT = 1500

const clipped = (text: string, kept: string) => `${kept}… [${text.length - kept.length} more characters]`

export function clipText(text: string, max = MAX_TEXT) {
  return text.length > max ? clipped(text, text.slice(0, max)) : text
}

/** `clipText` cut at the last space within `max` instead, so no word is cut in two, unless that keeps less than half of `max`. */
export function clipWords(text: string, max: number) {
  if (text.length <= max) return text
  const space = text.lastIndexOf(" ", max)
  return clipped(text, (space >= max / 2 ? text.slice(0, space) : text.slice(0, max)).trimEnd())
}

/** Defuses `<courier` and `</courier>` in outside text, so it cannot close the envelope or forge another. */
export function defuse(text: string) {
  return text.replace(/<(\/?)(courier)/gi, "&lt;$1$2")
}

/** A readable message for a failed courier call; OpenCode's own errors can carry an empty message. */
export function describeFailure(tool: string, error: unknown) {
  const tagged = error as { message?: unknown; _tag?: unknown; sessionID?: unknown }
  const message =
    (typeof tagged?.message === "string" && tagged.message) ||
    [tagged?._tag, tagged?.sessionID].filter((item) => typeof item === "string").join(" ") ||
    String(error)
  return new Error(`${tool} failed: ${message}`)
}
