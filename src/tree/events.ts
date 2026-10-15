import { envelope } from "../kernel/protocol.js"
import { claim, SEEN_MAX, setBounded } from "../platform/bounded.js"
import type { EventModule, HostEvent } from "../platform/events.js"
import { forgetChild, forgetDeleted } from "./forget.js"
import { hasCompleteGroup, leave, outIn } from "./group.js"
import type { ExecutionError, Waits, WatchPorts, WatchState } from "./ports.js"
import { awaited, reportOf, stoppedSincePrompt } from "./report.js"
import { childStore, groupStore } from "./store.js"
import { lastReply } from "./status.js"
import { failureNotice, silentNotice } from "./text.js"
import { forgetWakes, settleWake, wakeEnded, wakeStarted, watchWake, type Enqueued, type Execution, type InboxSettled } from "./wake.js"

/** The part of OpenCode's `session.execution.failed` event the notice is made from. */
export interface ExecutionFailed {
  readonly id: string
  /** When OpenCode published it, in epoch milliseconds. */
  readonly created?: number
  readonly data: {
    readonly sessionID: string
    readonly error: ExecutionError
  }
}

/** OpenCode's events that concern one session's turns and inbox: `session.execution.succeeded` and the like. */
export interface SessionEvent {
  readonly id: string
  readonly created?: number
  readonly data: { readonly sessionID: string; readonly reason?: string }
}

/**
 * Tells the parent of a child whose turn failed, since a child that cannot reach its model cannot
 * call courier_send. Returns the parents told.
 */
export async function reportFailure(ports: WatchPorts, seen: Set<string>, event: ExecutionFailed) {
  if (!claim(seen, event.id)) return []
  const { sessionID, error } = event.data
  const children = childStore(ports.storage)
  const entries = await children.entriesOf(sessionID)
  const at = event.created ?? ports.now()
  // Not in the way of the notice: kept only so the limits stop counting the child.
  if (entries.length)
    await children.settled(sessionID, "failed", at).catch((error: unknown) =>
      ports.log(`courier watch: could not note the failed turn of ${sessionID}: ${String(error)}`),
    )
  const out = await Promise.all(entries.map((entry) => outIn(ports, entry)))
  // Left before the notice, so the parent waits on the group meanwhile; nudged after it, so the group's
  // message does not overtake the notice, short of an interval tick falling in between.
  const completed = await Promise.all(out.map((member) => (member ? leave(ports, member, "failed", at) : Promise.resolve(false))))
  // A session courier_stop stopped is not a failure to tell: its parent was told of the stop, or ordered it.
  const quiet = entries.length > 0 && (await stoppedSincePrompt(children, sessionID).catch(() => false))
  try {
    if (quiet) return []
    await Promise.all(
      entries.map((entry, index) =>
        ports.session.synthetic({
          sessionID: entry.parentID,
          text: envelope(sessionID, failureNotice(entry.title, error, out[index]?.group), { failed: error.type }),
          description: `Session ${sessionID} failed`,
          metadata: { source: "courier", from: sessionID, failed: true },
          delivery: "steer",
        }),
      ),
    )
  } finally {
    if (completed.includes(true)) ports.nudge()
  }
  return entries.map((entry) => entry.parentID)
}

/** OpenCode's `session.inbox.enqueued`: the item's type, which its `session.inbox.delivered` does not carry. */
export interface InboxEnqueued {
  readonly data: { readonly sessionID: string; readonly inboxID: string; readonly item: { readonly type: string } }
}

/** Inbox items that are not courier's or the parent's business: the person's own prompts, compactions and moves. */
const UNOWED = new Set(["user", "compaction", "move"])

/** Remembers the type of an item enqueued for a spawned session, for `notePrompt`; other sessions cost one read. */
export async function noteEnqueued(ports: WatchPorts, inbox: Map<string, string>, event: InboxEnqueued) {
  const { sessionID, inboxID, item } = event.data
  if ((await childStore(ports.storage).indexedParent(sessionID)) === undefined) return false
  setBounded(inbox, inboxID, item.type, SEEN_MAX)
  return true
}

/**
 * Notes that a message reached a spawned session, which then owes its parent a report, unless `inbox` knows it for one of
 * `UNOWED` (`spawn` notes the task itself); reads the reverse index alone, and claims nothing: the note is the same twice.
 */
export async function notePrompt(
  ports: WatchPorts,
  event: SessionEvent & { readonly data: { readonly inboxID?: string } },
  inbox?: Map<string, string>,
) {
  const { sessionID, inboxID } = event.data
  // Kept, not deleted: the hub's other subscription looks it up for the same delivery.
  if (inboxID !== undefined && UNOWED.has(inbox?.get(inboxID) ?? "")) return false
  const children = childStore(ports.storage)
  if ((await children.indexedParent(sessionID)) === undefined) return false
  await children.prompted(sessionID, event.created ?? ports.now())
  return true
}

/**
 * Notes that a spawned session's turn was stopped, which takes it out of its group without a report; one
 * stopped by a shutdown resumes on the next start.
 */
export async function noteInterrupted(ports: WatchPorts, event: SessionEvent) {
  if (event.data.reason === "shutdown") return false
  const { sessionID } = event.data
  const children = childStore(ports.storage)
  const entry = await children.indexedEntry(sessionID)
  if (entry === undefined) return false
  const at = event.created ?? ports.now()
  await children.settled(sessionID, "interrupted", at)
  const member = await outIn(ports, entry)
  if (member && (await leave(ports, member, "interrupted", at))) ports.nudge()
  return true
}

/**
 * Forgets what a deleted session leaves (report state, groups) and, unless isolated or a parent on the roster, its
 * entry. Returns the sessions forgotten.
 */
export async function noteDeleted(ports: WatchPorts, event: SessionEvent) {
  const { sessionID } = event.data
  const children = childStore(ports.storage)
  const [parentID, started] = await Promise.all([children.indexedParent(sessionID), children.children(sessionID)])
  const forgotten = [...(parentID === undefined ? [] : [sessionID]), ...started.map((child) => child.sessionID)]
  const entry = parentID === undefined ? undefined : await children.entry(parentID, sessionID)
  const member = entry && (await outIn(ports, entry))
  await forgetDeleted(ports, sessionID, forgotten, member, event.created)
  if (parentID !== undefined && entry && !entry.isolated && started.length === 0) await forgetChild(ports.storage, parentID, sessionID)
  return forgotten
}

/** A `Waits` asking `suppliers` one after another, cheapest first: the first that waits answers. */
export const waitsOn =
  (...suppliers: Waits[]): Waits =>
  async (ports, sessionID, since) => {
    for (const supplier of suppliers) if (await supplier(ports, sessionID, since)) return true
    return false
  }

/** A `Waits` asking `suppliers` at once, as cheap as each other: it waits when one does, and fails when one fails. */
export const together =
  (...suppliers: Waits[]): Waits =>
  async (ports, sessionID, since) =>
    (await Promise.all(suppliers.map((supplier) => supplier(ports, sessionID, since)))).includes(true)

/**
 * Whether a session prompted at `prompt` waits: on an untold report of a session it started, a complete group of
 * its about to be delivered, or what `outside` says it waits on. Cheapest first.
 */
async function waits(ports: WatchPorts, outside: Waits, sessionID: string, prompt: number) {
  const children = childStore(ports.storage)
  const started = await children.children(sessionID)
  if ((await Promise.all(started.map((entry) => awaited(children, entry.sessionID)))).includes(true)) return true
  // A group with a member still out is waited on through that member, above; one whose every out member was told of is not.
  if (started.some((entry) => entry.group) && (await hasCompleteGroup(groupStore(ports.storage), sessionID))) return true
  return outside(ports, sessionID, prompt)
}

/**
 * Tells the parent of a spawned session whose turn ended without reporting to it since its last
 * prompt, unless it waits; finds the session by the reverse index alone. Returns the parents told.
 */
export async function reportSilent(ports: WatchPorts, seen: Set<string>, event: SessionEvent, outside: Waits) {
  const { sessionID } = event.data
  const children = childStore(ports.storage)
  const entry = await children.indexedEntry(sessionID)
  // Claimed after the lookup, so other sessions' turns do not crowd `seen`, and before anything is told.
  if (!entry || !claim(seen, event.id)) return []
  const report = await reportOf(children, sessionID)
  if (!report?.owes || (await waits(ports, outside, sessionID, report.prompt))) return []
  if (await stoppedSincePrompt(children, sessionID).catch(() => false)) return []
  // The notice goes out without the reply rather than not at all.
  const lastText = await ports.session.context({ sessionID }).then(lastReply, () => undefined)
  const group = (await outIn(ports, entry))?.group
  // Before the notice, which may end the parent's turn at once: once told, it no longer waits for this one.
  const toldAt = event.created ?? ports.now()
  await children.told(sessionID, toldAt).catch((error: unknown) =>
    ports.log(`courier watch: could not note that the parent of ${sessionID} was told: ${String(error)}`),
  )
  try {
    await ports.session.synthetic({
      sessionID: entry.parentID,
      text: envelope(sessionID, silentNotice(entry.title, lastText, report.progressed, group), { ended: "without-report" }),
      description: `Session ${sessionID} ended without a report`,
      metadata: { source: "courier", from: sessionID, ended: "without-report" },
      delivery: "steer",
    })
  } catch (error) {
    // Not told after all: the parent still waits for it.
    await children.untold(sessionID, toldAt).catch(() => undefined)
    throw error
  }
  return [entry.parentID]
}

const TURN_ENDS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

/** A session's turn ended, sealing its groups: one that is complete has the scheduler deliver it now. */
async function sealGroups(ports: WatchPorts, event: SessionEvent) {
  if (event.data.reason === "shutdown") return
  try {
    if (await hasCompleteGroup(groupStore(ports.storage), event.data.sessionID)) ports.nudge()
  } catch (error) {
    ports.log(`courier watch: could not read the groups of ${event.data.sessionID}: ${String(error)}`)
  }
}

/** The events of spawned sessions' turns and inboxes, and their deletion: the tree's. */
function routeTree(ports: WatchPorts, state: WatchState, outside: Waits, event: HostEvent) {
  if (event.type === "session.execution.failed") return reportFailure(ports, state.seen, event as unknown as ExecutionFailed)
  if (event.type === "session.execution.succeeded") return reportSilent(ports, state.seen, event as unknown as SessionEvent, outside)
  if (event.type === "session.execution.interrupted") return noteInterrupted(ports, event as unknown as SessionEvent)
  if (event.type === "session.inbox.enqueued") return noteEnqueued(ports, state.inbox, event as unknown as InboxEnqueued)
  if (event.type === "session.inbox.delivered") return notePrompt(ports, event as unknown as SessionEvent, state.inbox)
  if (event.type === "session.deleted") return noteDeleted(ports, event as unknown as SessionEvent)
  return undefined
}

/** The events that move a courier message waiting in a session's inbox: enqueued, taken, cancelled, and the turns around it. */
function routeWake(ports: WatchPorts, event: HostEvent) {
  if (event.type === "session.inbox.enqueued") return watchWake(ports, event as unknown as Enqueued)
  if (event.type === "session.inbox.delivered" || event.type === "session.inbox.cancelled") return settleWake(ports, event as unknown as InboxSettled)
  if (event.type === "session.execution.started") return wakeStarted(ports, event as unknown as Execution)
  if (TURN_ENDS.has(event.type)) return wakeEnded(ports, event as unknown as Execution)
  if (event.type === "session.deleted") return forgetWakes(ports, (event as unknown as SessionEvent).data.sessionID)
  return undefined
}

/** The tree's handling of an event alongside the wake watch's, which touches other keys and never fails the tree's. */
async function route(ports: WatchPorts, state: WatchState, outside: Waits, event: HostEvent) {
  const watched = routeWake(ports, event)?.catch((error: unknown) => ports.log(`courier watch: wake of ${event.type}: ${String(error)}`))
  try {
    return await routeTree(ports, state, outside, event)
  } finally {
    await watched
  }
}

/**
 * Tells parents of a child's failed or silent turn, unless it waits on what `outside` says, and notes
 * its prompts, interruptions and deletion; `after` a turn's end, seals the groups of its session.
 */
export function treeEvents(state: WatchState, outside: Waits): EventModule<WatchPorts> {
  return {
    handle: (ports, event) => route(ports, state, outside, event),
    // After: a silent end is judged while the group the nudge may deliver is still there to wait on.
    after: (ports, event) => (TURN_ENDS.has(event.type) ? sealGroups(ports, event as unknown as SessionEvent) : undefined),
  }
}
