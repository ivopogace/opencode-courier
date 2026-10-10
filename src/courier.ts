import type { Plugin } from "@opencode/plugin"
import { groupStanding, holdReport, isGroupName, joinGroup, leaveGroup, memberKey, memberOf, membershipOf, standingOf, unholdForBlocked, unholdReport, type Membership } from "./group.js"
import { admit, type Limits, type SpawnGate } from "./limits.js"
import { childBrief, envelope, isStatus, reportBody, STATUSES, type Artifacts, type Held, type HeldReport, type Prompt, type Sent, type Status } from "./notices.js"
import { progressed, progressKey, prompted, settled, settledKey } from "./report.js"
import { current, indexedEntry, record, type RosterEntry, type RosterStorage } from "./roster.js"

type Context = Plugin.Context

/** The slice of the plugin context the courier tools use; tests pass a fake. */
export interface CourierPorts {
  readonly session: Pick<Context["session"], "create" | "prompt" | "synthetic" | "get" | "context" | "interrupt">
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
  readonly log: (message: string) => void
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
  const group = typeof input.group === "string" ? input.group.trim() || undefined : (input.group ?? undefined)
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
  const { worktree, ...child } = await create(ports, parentID, input)
  admitted.reservation.sessionID = child.sessionID
  const entry: RosterEntry = {
    ...child,
    parentID,
    isolated: worktree !== undefined,
    createdAt: ports.now(),
    reports: "status",
    ...(worktree ? { source: ports.directory, project: ports.projectID } : {}),
    ...(group ? { group } : {}),
  }
  const { rosterError, groupError } = await enrol(ports, entry, group)
  ports.roles.delete(parentID)
  await handOver(ports, entry, admitted.depth, input.task, !rosterError, !rosterError && !groupError)
  return {
    sessionID: entry.sessionID,
    directory: entry.directory,
    ...(group && !rosterError && !groupError ? { group } : {}),
    ...(rosterError ? { rosterError } : {}),
    ...(groupError ? { groupError } : {}),
  }
}

/** Creates the child's session, in a worktree of its own if asked, which goes again if the session cannot be created. */
async function create(ports: CourierPorts, parentID: string, input: SpawnInput) {
  // A failed lookup must not keep the child from starting; it then runs on OpenCode's default.
  const model = await inheritedModel(ports, parentID, input.agent).catch(() => undefined)
  const worktree = input.isolate ? (await ports.worktree.create({ projectID: ports.projectID })).directory : undefined
  const base = worktree ? await ports.head(worktree) : undefined
  const title = input.title ?? titleOf(input.task)
  const child = await ports.session
    .create({
      title,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(model ? { model } : {}),
      ...(worktree ? { location: { directory: worktree } } : {}),
      metadata: { courier: { parentID } },
    })
    .catch(async (error: unknown) => {
      // No session will ever use the fresh worktree, and nothing records it, so it goes now.
      if (worktree) await dropWorktree(ports, worktree)
      throw error
    })
  return { sessionID: child.id, title, directory: worktree ?? child.location.directory, worktree, ...(base ? { base } : {}) }
}

/**
 * Records the child on the roster, before the prompt, so a child that exists is on the roster even if prompting
 * fails, then in its group. A failed write must not keep the child from its task: each is reported, not thrown.
 */
async function enrol(ports: CourierPorts, entry: RosterEntry, group: string | undefined) {
  const rosterError = await record(ports.storage, entry).then(
    () => undefined,
    (error: unknown) => describeFailure("roster", error).message,
  )
  const groupError = group && !rosterError ? await join(ports, entry, group) : undefined
  return { rosterError, groupError }
}

/**
 * Hands the child its task. `rostered` says whether its report state is kept, which a child off the roster has none
 * of, and `grouped` whether it is in its group; a child that never got its task leaves both, as it will never report.
 */
async function handOver(ports: CourierPorts, entry: RosterEntry, depth: number, task: string, rostered: boolean, grouped: boolean) {
  // A baseline, until OpenCode's event for the prompt's delivery moves it on; written first, so it never overtakes that.
  if (rostered) await prompted(ports.storage, entry.sessionID, ports.now()).catch(() => undefined)
  try {
    await ports.session.prompt({ sessionID: entry.sessionID, text: childBrief(entry.parentID, task, depth, ports.limits) })
  } catch (error) {
    if (rostered) await settled(ports.storage, entry.sessionID, "failed", ports.now()).catch(() => undefined)
    if (grouped && entry.group)
      await leaveGroup(ports.storage, entry.parentID, entry.group, entry.sessionID, "failed", ports.now()).then(
        (complete) => complete && ports.nudge(),
        (leaveError: unknown) => ports.log(`courier_spawn: ${entry.sessionID} could not leave group ${entry.group}: ${String(leaveError)}`),
      )
    throw error
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
    // A write that failed may have landed all the same: a member left there would hold its group up for good.
    await Promise.all([
      record(ports.storage, ungrouped).catch(() => undefined),
      ports.storage.remove(memberKey(entry.parentID, group, entry.sessionID)).catch(() => undefined),
    ])
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
  try {
    const held = noted?.member && status && status !== "blocked" ? await hold(ports, noted.member, { at: noted.at, status, message: input.message, ...(input.artifacts ? { artifacts: input.artifacts } : {}) }) : undefined
    if (held) return { status, report: true, held }
    const delivered = await ports.session.synthetic({
      sessionID: input.sessionID,
      text: envelope(from, reportBody(input.message, input.artifacts), status ? { status } : {}),
      description: `Message from ${from}`,
      metadata: { source: "courier", from, ...(status ? { status } : {}) },
      delivery: input.queue ? "queue" : "steer",
    })
    // A blocked report, once delivered, is the member's latest word: an earlier report held for it would be stale.
    if (noted?.member && status === "blocked") await unholdForBlocked(ports.storage, noted.member).catch(() => undefined)
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
  return { report, at, undo, member: status !== undefined ? await memberIn(ports, entry) : undefined }
}

/**
 * A child's membership of an open group of its parent's, by its roster entry. One that cannot be read is dropped
 * from the group, best effort, as the report then goes on its own and the group must not wait for it.
 */
async function memberIn(ports: CourierPorts, entry: RosterEntry): Promise<Membership | undefined> {
  if (!entry.group) return undefined
  try {
    return await membershipOf(ports.storage, entry.parentID, entry.group, entry.sessionID)
  } catch (error) {
    ports.log(`courier_send: ${entry.sessionID}'s place in group ${entry.group} could not be read, so its report goes on its own: ${String(error)}`)
    await ports.storage.remove(memberKey(entry.parentID, entry.group, entry.sessionID)).then(() => ports.nudge(), () => undefined)
    return undefined
  }
}

/**
 * Holds a member's report with its group, and nudges the scheduler if that completes the group. Undefined
 * when it could not be held: the member is dropped from the group, which releases without it, and reports on its own.
 */
async function hold(ports: CourierPorts, member: Membership, report: HeldReport): Promise<Held | undefined> {
  try {
    await holdReport(ports.storage, member, report)
  } catch (error) {
    // Neither held nor dropped, the group would wait for ever: the call fails, and the sender sends it again.
    await unholdReport(ports.storage, member).catch((dropError: unknown) => {
      throw new Error(`the report could not be held with group ${member.group} (${String(error)}), nor the member dropped from it (${String(dropError)}); send it again.`)
    })
    ports.nudge()
    return undefined
  }
  // Held whatever the count gives; a count that cannot be read gets the nudge, as a tick that finds nothing due is cheap.
  const standing = await groupStanding(ports.storage, member.parentID, member.group).catch(() => undefined)
  if (standing?.complete !== false) ports.nudge()
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
 * group with the group's name and its standing there: `held`, `out`, how it left, `released` or `unknown`.
 */
export async function listChildren(ports: CourierPorts, parentID: string) {
  const entries = await current(ports.storage, parentID, ports.now())
  return Promise.all(entries.map((entry) => described(ports, entry)))
}

/** One roster entry as courier_children shows it: what courier_status reports with its directory and group standing, or the error it gave. */
export async function described(ports: CourierPorts, entry: RosterEntry) {
  const group = entry.group
    ? { group: { name: entry.group, report: await memberOf(ports.storage, entry.parentID, entry.group, entry.sessionID).then(standingOf, () => "unknown") } }
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

/** A readable message for a failed courier call; OpenCode's own errors can carry an empty message. */
export function describeFailure(tool: string, error: unknown) {
  const tagged = error as { message?: unknown; _tag?: unknown; sessionID?: unknown }
  const message =
    (typeof tagged?.message === "string" && tagged.message) ||
    [tagged?._tag, tagged?.sessionID].filter((item) => typeof item === "string").join(" ") ||
    String(error)
  return new Error(`${tool} failed: ${message}`)
}
