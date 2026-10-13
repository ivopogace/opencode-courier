import type { Plugin } from "@opencode/plugin"
import { describeFailure } from "../kernel/protocol.js"
import { standingOf } from "./domain.js"
import type { CourierPorts, RosterEntry } from "./ports.js"
import { current } from "./roster.js"
import { groupStore } from "./store.js"

type Context = Plugin.Context

export interface StatusInput {
  readonly sessionID: string
}

export interface ChildrenInput {
  readonly sessionID?: string
}

/** A one-off look at a session, for check-ins; not meant to be called in a loop. */
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
    lastText,
    pending: pending.length ? pending : undefined,
  })
}

/** The text of a session's last reply, from its context's messages, or undefined when it has none. */
export function lastReply(messages: Awaited<ReturnType<Context["session"]["context"]>>) {
  const last = messages.findLast((message) => message.type === "assistant")
  return last?.type === "assistant"
    ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    : undefined
}

/**
 * The sessions a parent started, each with what courier_status reports, or the error it gave; a child in a
 * group with the group's name and its standing there: `held`, `out`, how it left, `released` or `unknown`.
 */
export async function listChildren(ports: CourierPorts, parentID: string) {
  const entries = await current(ports.storage, parentID, ports.now())
  return Promise.all(entries.map((entry) => described(ports, entry)))
}

/** One roster entry as courier_children shows it: what courier_status reports with its directory and group standing, or the error it gave. */
export async function described(ports: CourierPorts, entry: RosterEntry) {
  const group = entry.group
    ? { group: { name: entry.group, report: await groupStore(ports.storage).member(entry.parentID, entry.group, entry.sessionID).then(standingOf, () => "unknown") } }
    : {}
  const roster = { directory: entry.directory, isolated: entry.isolated, created: entry.createdAt, ...group }
  try {
    return { ...(await status(ports, { sessionID: entry.sessionID })), ...roster }
  } catch (error) {
    return {
      sessionID: entry.sessionID,
      title: entry.title,
      ...roster,
      error: describeFailure("courier_status", error).message,
    }
  }
}

/** OpenCode leaves a tool call hanging when its metadata holds `undefined`, so results drop those keys. */
function withoutUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>
}
