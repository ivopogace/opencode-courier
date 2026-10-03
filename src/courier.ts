import type { Plugin } from "@opencode-ai/plugin"
import { current, record, type RosterStorage } from "./roster.js"

type Context = Plugin.Context

/** The slice of the plugin context the courier tools use; tests pass a fake. */
export interface CourierPorts {
  readonly session: Pick<Context["session"], "create" | "prompt" | "synthetic" | "get" | "context">
  readonly worktree: Pick<Context["worktree"], "create">
  readonly storage: RosterStorage
  readonly directory: string
  readonly now: () => number
}

export interface SpawnInput {
  readonly task: string
  readonly title?: string
  readonly agent?: string
  readonly isolate?: boolean
}

export interface SendInput {
  readonly sessionID: string
  readonly message: string
  readonly queue?: boolean
}

export interface StatusInput {
  readonly sessionID: string
}

export interface ChildrenInput {
  readonly sessionID?: string
}

export function childBrief(parentID: string, task: string) {
  return [
    `You were started by session ${parentID} through opencode-courier.`,
    "",
    `When you finish, or need a decision you cannot make yourself, call courier_send with sessionID "${parentID}" and a short report.`,
    "That message wakes the parent. It is the only way the parent hears from you, so do not end without sending it.",
    "",
    "Task:",
    task,
  ].join("\n")
}

export function envelope(from: string, message: string, attributes: Record<string, string> = {}) {
  const extra = Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("")
  return `<courier from="${from}"${extra}>\n${message}\n</courier>`
}

function titleOf(task: string) {
  const line = task.trim().split("\n")[0] ?? ""
  return line.length > 60 ? `${line.slice(0, 57)}...` : line
}

/** Creates a child session, hands it the task and returns at once; the child reports back with courier_send. */
export async function spawn(ports: CourierPorts, parentID: string, input: SpawnInput) {
  const directory = input.isolate
    ? (await ports.worktree.create({ location: { directory: ports.directory } })).directory
    : undefined
  const title = input.title ?? titleOf(input.task)
  const child = await ports.session.create({
    title,
    ...(input.agent ? { agent: input.agent } : {}),
    ...(directory ? { location: { directory } } : {}),
    metadata: { courier: { parentID } },
  })
  // Recorded before the prompt, so a child that exists is on the roster even if prompting fails.
  await record(ports.storage, {
    sessionID: child.id,
    parentID,
    title,
    directory: directory ?? child.location.directory,
    isolated: directory !== undefined,
    createdAt: ports.now(),
  })
  await ports.session.prompt({ sessionID: child.id, text: childBrief(parentID, input.task) })
  return { sessionID: child.id, directory: directory ?? child.location.directory }
}

/** Drops a message into another session's inbox; OpenCode wakes that session if it is idle. */
export async function send(ports: CourierPorts, from: string, input: SendInput) {
  const delivered = await ports.session.synthetic({
    sessionID: input.sessionID,
    text: envelope(from, input.message),
    description: `Message from ${from}`,
    metadata: { source: "courier", from },
    delivery: input.queue ? "queue" : "steer",
  })
  return { messageID: delivered.id }
}

/** A one-off look at a session, for check-ins; not meant to be called in a loop. */
export async function status(ports: CourierPorts, input: StatusInput) {
  const info = await ports.session.get({ sessionID: input.sessionID })
  const messages = await ports.session.context({ sessionID: input.sessionID })
  const last = messages.findLast((message) => message.type === "assistant")
  const lastText =
    last?.type === "assistant"
      ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
      : undefined
  return withoutUndefined({
    sessionID: info.id,
    title: info.title,
    parentID: info.parentID,
    outcome: info.outcome,
    updated: info.time.updated,
    idle: info.time.idle,
    lastText,
  })
}

/** The sessions a parent started, each with what courier_status reports, or the error it gave. */
export async function listChildren(ports: CourierPorts, parentID: string) {
  const entries = await current(ports.storage, parentID, ports.now())
  return Promise.all(
    entries.map(async (entry) => {
      const roster = { directory: entry.directory, isolated: entry.isolated, created: entry.createdAt }
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
    }),
  )
}

/** OpenCode leaves a tool call hanging when its metadata holds `undefined`, so results drop those keys. */
function withoutUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>
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
