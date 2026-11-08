export const END_TURN = "If nothing else is left to do now, end your turn by replying without calling more tools."

export const STATUSES = ["done", "partial", "blocked", "failed"] as const
export type Status = (typeof STATUSES)[number]

export const isStatus = (value: unknown): value is Status => typeof value === "string" && (STATUSES as readonly string[]).includes(value)

export const SPLIT_LINE =
  "`split: no, because …; considered: <the parts you weighed>` or `split: <n> parts: …` (one phrase per part)"

export const ONE_PART_LINE = "`split: 1 part: <the task>, to keep my context`"

export const ROOT_SPLIT_LINE = `${SPLIT_LINE} or ${ONE_PART_LINE}`

export const SKILL_ID = "courier-orchestrate"

export function envelope(from: string, message: string, attributes: Record<string, string> = {}) {
  const extra = Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("")
  return `<courier from="${from}"${extra}>\n${defuse(message)}\n</courier>`
}

const MAX_TEXT = 1500

const clipped = (text: string, kept: string) => `${kept}… [${text.length - kept.length} more characters]`

export function clipText(text: string, max = MAX_TEXT) {
  return text.length > max ? clipped(text, text.slice(0, max)) : text
}

export function clipWords(text: string, max: number) {
  if (text.length <= max) return text
  const space = text.lastIndexOf(" ", max)
  return clipped(text, (space >= max / 2 ? text.slice(0, space) : text.slice(0, max)).trimEnd())
}

export function defuse(text: string) {
  return text.replace(/<(\/?)(courier)/gi, "&lt;$1$2")
}

export function defuseBlock(text: string) {
  return text.replace(/<(\/?)(context)/gi, "&lt;$1$2")
}

export function describeFailure(tool: string, error: unknown) {
  // OpenCode errors can have an empty message (api-notes)
  const tagged = error as { message?: unknown; _tag?: unknown; sessionID?: unknown }
  const message =
    (typeof tagged?.message === "string" && tagged.message) ||
    [tagged?._tag, tagged?.sessionID].filter((item) => typeof item === "string").join(" ") ||
    String(error)
  return new Error(`${tool} failed: ${message}`)
}
