import { isStatus, type Status } from "../kernel/protocol.js"
import type { ChildStore } from "./ports.js"

type Notes = Pick<ChildStore, "notes">

const since = (at: number | undefined, prompt: number) => at !== undefined && at >= prompt

export async function stoppedSincePrompt(children: Notes, sessionID: string) {
  const { stopped, prompt } = await children.notes(sessionID, ["stopped", "prompt"])
  return stopped.at !== undefined && (prompt.at === undefined || stopped.at >= prompt.at)
}

export async function lastStatus(children: Notes, sessionID: string): Promise<Status | undefined> {
  const { status } = (await children.notes(sessionID, ["settled"])).settled
  return isStatus(status) ? status : undefined
}

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

export async function awaited(children: Notes, sessionID: string) {
  const { prompt, settled, told } = await children.notes(sessionID, ["prompt", "settled", "told"])
  return prompt.at !== undefined && !since(settled.at, prompt.at) && !since(told.at, prompt.at)
}
