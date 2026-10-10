import type { Plugin } from "@opencode/plugin"
import { groupStanding, holdReport, isGroupName, joinGroup, memberOf, standingOf, unholdReport, type Membership } from "./group.js"
import { admit, type Limits, type SpawnGate } from "./limits.js"
import { childBrief, envelope, isStatus, reportBody, STATUSES, type Artifacts, type Held, type Prompt, type Sent, type Status } from "./notices.js"
import { progressed, progressKey, prompted, settled, settledKey } from "./report.js"
import { current, indexedEntry, record, type RosterEntry, type RosterStorage } from "./roster.js"

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
  readonly limits: Limits
  readonly gate: SpawnGate
  /** The depths the `context` hook remembers; a parent's is dropped when it starts a child. */
  readonly roles: Map<string, number | null>
  /** Has the scheduler deliver what is due now rather than at its next tick: a group a report has just completed. */
  readonly nudge: () => void
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
  readonly group?: string
}

export interface SendInput {
  readonly sessionID: string
  readonly message: string
  readonly status?: Status
  readonly artifacts?: Artifacts
  readonly queue?: boolean
}

export interface StatusInput {
  readonly sessionID: string
}

export interface ChildrenInput {
  readonly sessionID?: string
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

/**
 * Creates a child session, hands it the task and returns at once; the child reports back with
 * courier_send. Refused past a limit, whether or not the `context` hook hid the tool.
 */
export async function spawn(ports: CourierPorts, parentID: string, input: SpawnInput) {
  // Some models send null, or an empty string, for an optional field they leave out.
  const group = typeof input.group === "string" && !input.group.trim() ? undefined : (input.group ?? undefined)
  if (group !== undefined && !isGroupName(group))
    throw new Error(`group must be a name of 1 to 60 letters, digits, dots, dashes or underscores, not ${JSON.stringify(group)}.`)
  const admitted = await admit(ports, parentID)
  try {
    return await start(ports, parentID, input, admitted, group)
  } finally {
    admitted.release()
  }
}

async function start(ports: CourierPorts, parentID: string, input: SpawnInput, admitted: Awaited<ReturnType<typeof admit>>, group: string | undefined) {
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
  admitted.reservation.sessionID = child.id
  // Recorded before the prompt, so a child that exists is on the roster even if prompting fails. A
  // failed write must not keep the child from its task, so it is reported instead of thrown.
  const entry: RosterEntry = {
    sessionID: child.id,
    parentID,
    title,
    directory: directory ?? child.location.directory,
    isolated: directory !== undefined,
    createdAt: ports.now(),
    reports: "status",
    ...(directory ? { source: ports.directory, project: ports.projectID } : {}),
    ...(base ? { base } : {}),
    ...(group ? { group } : {}),
  }
  const rosterError = await record(ports.storage, entry).then(
    () => undefined,
    (error: unknown) => describeFailure("roster", error).message,
  )
  ports.roles.delete(parentID)
  const groupError = group && !rosterError ? await join(ports, entry, group) : undefined
  // A baseline, until OpenCode's event for the prompt's delivery moves it on; written first, so it never overtakes that.
  // Not for a child off the roster: nothing would read or remove it.
  if (!rosterError) await prompted(ports.storage, child.id, ports.now()).catch(() => undefined)
  try {
    await ports.session.prompt({ sessionID: child.id, text: childBrief(parentID, input.task, admitted.depth, ports.limits) })
  } catch (error) {
    // A child that never got its task will never report: it must not count against the limits.
    if (!rosterError) await settled(ports.storage, child.id, "failed", ports.now()).catch(() => undefined)
    throw error
  }
  return {
    sessionID: child.id,
    directory: directory ?? child.location.directory,
    ...(group && !rosterError && !groupError ? { group } : {}),
    ...(rosterError ? { rosterError } : {}),
    ...(groupError ? { groupError } : {}),
  }
}

/**
 * Joins a child to its group; one that cannot be joined is recorded in no group, so it reports on its own,
 * and the result says so. Returns the error's message, if any.
 */
async function join(ports: CourierPorts, entry: RosterEntry, group: string) {
  try {
    await joinGroup(ports.storage, entry.parentID, group, entry.sessionID, entry.title, ports.now())
    return undefined
  } catch (error) {
    const { group: _, ...ungrouped } = entry
    await record(ports.storage, ungrouped).catch(() => undefined)
    return describeFailure("group", error).message
  }
}

/**
 * Drops a message into another session's inbox; OpenCode wakes that session if it is idle. From a spawned session
 * to the one that started it, it is its report or its progress (`noteReport`); a group member's final report is held (`hold`).
 */
export async function send(ports: CourierPorts, from: string, input: SendInput): Promise<Sent> {
  // Some models send null for an optional field they leave out.
  const status = input.status ?? undefined
  if (status !== undefined && !isStatus(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}, not ${JSON.stringify(status)}.`)
  // Noted first: the delivery may wake the parent, whose turn may end before a later note.
  const noted = await noteReport(ports, from, input.sessionID, status).catch(() => undefined)
  if (noted?.member && status) {
    const held = await hold(ports, noted.member, { at: noted.at, status, message: input.message, ...(input.artifacts ? { artifacts: input.artifacts } : {}) })
    if (held) return { status, report: true, held }
  }
  try {
    const delivered = await ports.session.synthetic({
      sessionID: input.sessionID,
      text: envelope(from, reportBody(input.message, input.artifacts), status ? { status } : {}),
      description: `Message from ${from}`,
      metadata: { source: "courier", from, ...(status ? { status } : {}) },
      delivery: input.queue ? "queue" : "steer",
    })
    return { messageID: delivered.id, ...(status ? { status } : {}), ...(noted ? { report: noted.report } : {}) }
  } catch (error) {
    await noted?.undo().catch(() => undefined)
    throw error
  }
}

/**
 * Notes `from`'s message to `to` when `to` started it: as its report when it carries a status, or when an earlier
 * release briefed `from`, else as progress. Returns which, when, how to take the note back, and `from`'s group membership.
 */
async function noteReport(ports: CourierPorts, from: string, to: string, status: Status | undefined) {
  const entry = await indexedEntry(ports.storage, from)
  if (entry?.parentID !== to) return undefined
  const report = status !== undefined || entry.reports !== "status"
  const key = report ? settledKey(from) : progressKey(from)
  const before = await ports.storage.get(key)
  const at = ports.now()
  await (report ? settled(ports.storage, from, "report", at, status) : progressed(ports.storage, from, at))
  // Only its own note: another courier_send of the session's may have noted its report since.
  const undo = async () => {
    const now = (await ports.storage.get(key)) as { at?: unknown; by?: unknown } | undefined
    if (now?.at !== at || (report && now.by !== "report")) return
    await (before === undefined ? ports.storage.remove(key) : ports.storage.set(key, before))
  }
  // A report with a final status may be held with the sender's group; a blocked one reaches the parent at once.
  const held = status !== undefined && status !== "blocked"
  return { report, at, undo, member: held ? await membershipOf(ports, entry).catch(() => undefined) : undefined }
}

/** A child's membership of an open group of its parent's: its roster entry names the group, and the group lists it. */
async function membershipOf(ports: CourierPorts, entry: RosterEntry): Promise<Membership | undefined> {
  if (!entry.group) return undefined
  const member = await memberOf(ports.storage, entry.parentID, entry.group, entry.sessionID)
  return member && { ...member, parentID: entry.parentID, group: entry.group, sessionID: entry.sessionID }
}

/**
 * Holds a member's report with its group, and has the scheduler deliver the group if that completes it. Undefined
 * when it could not be held: the member is dropped from the group, which releases without it, and reports on its own.
 */
async function hold(ports: CourierPorts, member: Membership, report: Parameters<typeof holdReport>[2]): Promise<Held | undefined> {
  try {
    await holdReport(ports.storage, member, report)
  } catch {
    await unholdReport(ports.storage, member).then(() => ports.nudge(), () => undefined)
    return undefined
  }
  // Held whatever the count gives: the scheduler's tick finds a complete group on its own.
  const standing = await groupStanding(ports.storage, member.parentID, member.group).catch(() => undefined)
  if (standing?.complete) ports.nudge()
  return { group: member.group, ...(standing ? { reported: standing.reported, members: standing.members } : {}) }
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
 * group with the group's name and its standing there: `held`, `out`, `failed`, `deleted`, `released` or `unknown`.
 */
export async function listChildren(ports: CourierPorts, parentID: string) {
  const entries = await current(ports.storage, parentID, ports.now())
  return Promise.all(
    entries.map(async (entry) => {
      const group = entry.group
        ? { group: { name: entry.group, report: await memberOf(ports.storage, parentID, entry.group, entry.sessionID).then(standingOf, () => "unknown") } }
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
