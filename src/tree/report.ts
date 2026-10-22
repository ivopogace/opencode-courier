import { isStatus, type Status } from "../kernel/protocol.js"
import type { ChildStore } from "./ports.js"

type Notes = Pick<ChildStore, "notes">

/** Whether `at` is known and no earlier than the prompt at `prompt`. */
const since = (at: number | undefined, prompt: number) => at !== undefined && at >= prompt

/** Whether courier_stop stopped a session after its last prompt, or with none noted, at all. */
export async function stoppedSincePrompt(children: Notes, sessionID: string) {
  const { stopped, prompt } = await children.notes(sessionID, ["stopped", "prompt"])
  return stopped.at !== undefined && (prompt.at === undefined || stopped.at >= prompt.at)
}

/** The status of a spawned session's last report to its parent, if it has reported with one. */
export async function lastStatus(children: Notes, sessionID: string): Promise<Status | undefined> {
  const { status } = (await children.notes(sessionID, ["settled"])).settled
  return isStatus(status) ? status : undefined
}

/**
 * What is known of a spawned session's report: when a prompt last reached it, and whether since then it owes one, has
 * messaged its parent without a status, or failed or was interrupted, and `resumesAt` when a failed turn was a provider
 * limit, the time it lifts. Undefined for one spawned before this was kept.
 */
export async function reportOf(children: Notes, sessionID: string) {
  const { prompt, settled, progress } = await children.notes(sessionID, ["prompt", "settled", "progress"])
  const promptAt = prompt.at
  if (promptAt === undefined) return undefined
  const done = since(settled.at, promptAt)
  const resumesAt = done && settled.by === "failed" && typeof settled.resumesAt === "number" ? settled.resumesAt : undefined
  return {
    prompt: promptAt,
    owes: !done,
    progressed: since(progress.at, promptAt),
    ended: done && settled.by !== "report",
    ...(resumesAt === undefined ? {} : { resumesAt }),
  }
}

/**
 * Whether its parent still waits on a spawned session's report: it owes one, and the parent has not
 * been told since its last prompt that it ended a turn without one.
 */
export async function awaited(children: Notes, sessionID: string) {
  const { prompt, settled, told } = await children.notes(sessionID, ["prompt", "settled", "told"])
  return prompt.at !== undefined && !since(settled.at, prompt.at) && !since(told.at, prompt.at)
}
