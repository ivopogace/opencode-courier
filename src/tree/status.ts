import type { Plugin } from "@opencode/plugin"
import { describeFailure } from "../kernel/protocol.js"
import { standingOf, startedAs } from "./domain.js"
import type { CourierPorts, RosterEntry } from "./ports.js"
import { groupStore } from "./store.js"

type Context = Plugin.Context

export interface StatusInput {
  readonly sessionID: string
}

export async function status(ports: CourierPorts, input: StatusInput) {
  const [info, messages, pending] = await Promise.all([
    ports.session.get({ sessionID: input.sessionID }),
    ports.session.context({ sessionID: input.sessionID }),
    ports.pending(input.sessionID),
  ])
  const lastText = lastReply(messages)
  return withoutUndefined({
    sessionID: info.id,
    title: info.title,
    parentID: info.parentID,
    outcome: info.outcome,
    updated: info.time.updated,
    idle: info.time.idle,
    archived: info.time.archived,
    lastText,
    pending: pending.length ? pending : undefined,
  })
}

export function lastReply(messages: Awaited<ReturnType<Context["session"]["context"]>>) {
  const last = messages.findLast((message) => message.type === "assistant")
  return last?.type === "assistant"
    ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    : undefined
}

export async function described(ports: CourierPorts, entry: RosterEntry) {
  const group = entry.group ? { group: { name: entry.group, report: await standingIn(ports, entry, entry.group) } } : {}
  const roster = { directory: entry.directory, ...startedAs(entry), created: entry.createdAt, ...group }
  try {
    return { ...(await status(ports, { sessionID: entry.sessionID })), ...roster }
  } catch (error) {
    return {
      sessionID: entry.sessionID,
      title: entry.title,
      ...roster,
      error: describeFailure("reading the session", error).message,
    }
  }
}

export function standingIn(ports: Pick<CourierPorts, "storage">, entry: RosterEntry, group: string) {
  return groupStore(ports.storage).member(entry.parentID, group, entry.sessionID).then(standingOf, () => "unknown" as const)
}

function withoutUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>
}
