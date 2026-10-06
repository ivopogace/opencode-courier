import type { Plugin } from "@opencode/plugin"
import type { Prompt } from "./question.js"
import { current, record, type RosterStorage } from "./roster.js"

type Context = Plugin.Context

/** The slice of the plugin context the courier tools use; tests pass a fake. */
export interface CourierPorts {
  readonly session: Pick<Context["session"], "create" | "prompt" | "synthetic" | "get" | "context">
  readonly agent: Pick<Context["agent"], "get">
  readonly worktree: Pick<Context["worktree"], "create" | "remove">
  /** The project of the plugin's location; an isolated child's worktree is made in it, and removed from it. */
  readonly projectID: string
  /** The commit a directory's checkout is on, or undefined; recorded as an isolated child's base. */
  readonly head: (directory: string) => Promise<string | undefined>
  readonly storage: RosterStorage
  readonly directory: string
  readonly now: () => number
  /** The permission requests and questions a session waits on, wherever they are pending. */
  readonly pending: (sessionID: string) => Promise<ReadonlyArray<Pending>>
}

/** A request a session waits on until someone answers it: a permission request, or a question it asked. */
export type Pending =
  | {
      readonly type: "permission"
      readonly requestID: string
      readonly action: string
      readonly resources: ReadonlyArray<string>
      readonly save?: ReadonlyArray<string>
    }
  | {
      readonly type: "question"
      readonly requestID: string
      readonly questions: ReadonlyArray<Prompt>
      /** Its question call was cut off; the answer reaches it as a message. */
      readonly stopped?: true
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

/** Closes a tool result after which the caller most likely has nothing left to do. */
export const END_TURN = "If nothing else is left to do now, end your turn by replying without calling more tools."

export function childBrief(parentID: string, task: string) {
  return [
    `You were started by session ${parentID} through opencode-courier.`,
    "",
    `When you finish, or need a decision you cannot make yourself, call courier_send with sessionID "${parentID}" and a short report.`,
    "That message wakes the parent. It is the only way the parent hears from you, so do not end without sending it.",
    "If you need the person to decide something, use your question tool; it reaches them through the session that started you.",
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

/**
 * The model a child runs on: its parent's, so it does not fall back to OpenCode's default, which
 * the parent may have been moved off for a reason. An agent that names its own model keeps it.
 */
async function inheritedModel(ports: CourierPorts, parentID: string, agent: string | undefined) {
  const parent = await ports.session.get({ sessionID: parentID })
  if (!parent.model || !agent) return parent.model
  const named = await ports.agent.get({ agentID: agent, location: { directory: ports.directory } })
  return named.data.model ? undefined : parent.model
}

/** Removes a worktree made for a child that was never created; one that cannot be removed stays. */
async function dropWorktree(ports: CourierPorts, directory: string) {
  try {
    await ports.worktree.remove({ projectID: ports.projectID, directory, force: false })
  } catch {
    // The spawn's own failure is the one to report.
  }
}

/** Creates a child session, hands it the task and returns at once; the child reports back with courier_send. */
export async function spawn(ports: CourierPorts, parentID: string, input: SpawnInput) {
  // A failed lookup must not keep the child from starting; it then runs on OpenCode's default.
  const model = await inheritedModel(ports, parentID, input.agent).catch(() => undefined)
  const directory = input.isolate
    ? (await ports.worktree.create({ projectID: ports.projectID })).directory
    : undefined
  const base = directory ? await ports.head(directory) : undefined
  const title = input.title ?? titleOf(input.task)
  const child = await ports.session
    .create({
      title,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(model ? { model } : {}),
      ...(directory ? { location: { directory } } : {}),
      metadata: { courier: { parentID } },
    })
    .catch(async (error: unknown) => {
      // No session will ever use the fresh worktree, and nothing records it, so it goes now.
      if (directory) await dropWorktree(ports, directory)
      throw error
    })
  // Recorded before the prompt, so a child that exists is on the roster even if prompting fails. A
  // failed write must not keep the child from its task, so it is reported instead of thrown.
  const rosterError = await record(ports.storage, {
    sessionID: child.id,
    parentID,
    title,
    directory: directory ?? child.location.directory,
    isolated: directory !== undefined,
    createdAt: ports.now(),
    ...(directory ? { source: ports.directory, project: ports.projectID } : {}),
    ...(base ? { base } : {}),
  }).then(
    () => undefined,
    (error: unknown) => describeFailure("roster", error).message,
  )
  await ports.session.prompt({ sessionID: child.id, text: childBrief(parentID, input.task) })
  return {
    sessionID: child.id,
    directory: directory ?? child.location.directory,
    ...(rosterError ? { rosterError } : {}),
  }
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
  const [info, messages, pending] = await Promise.all([
    ports.session.get({ sessionID: input.sessionID }),
    ports.session.context({ sessionID: input.sessionID }),
    ports.pending(input.sessionID),
  ])
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
    pending: pending.length ? pending : undefined,
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
