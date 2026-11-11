import { envelope } from "../kernel/protocol.js"
import { claim, SEEN_MAX, setBounded } from "../platform/bounded.js"
import type { EventModule, EventType, HostEvent } from "../platform/events.js"
import { endsIdle, retryDelay } from "./domain.js"
import { forgetChild, forgetDeleted } from "./forget.js"
import { hasCompleteGroup, leave, outIn } from "./group.js"
import { liveBelow } from "./limits.js"
import type { ChildStore, ExecutionError, Waits, WatchPorts, WatchState } from "./ports.js"
import { owedUnwaited } from "./nudge.js"
import { reportedSincePrompt, stoppedSincePrompt } from "./report.js"
import { syncStanding } from "./standing.js"
import { childStore, groupStore } from "./store.js"
import { forgetTyped, noteTyped, relayTyped } from "./relay.js"
import { lastReply } from "./status.js"
import { failureNotice, silentNotice } from "./text.js"
import { forgetWakes, settleWake, wakeEnded, wakeStarted, watchWake, type Enqueued, type Execution, type InboxSettled } from "./wake.js"

export interface ExecutionFailed {
  readonly id: string
  readonly created?: number
  readonly data: {
    readonly sessionID: string
    readonly error: ExecutionError
  }
}

export interface SessionEvent {
  readonly id: string
  readonly created?: number
  readonly data: { readonly sessionID: string; readonly reason?: string }
}

export async function reportFailure(ports: WatchPorts, seen: Set<string>, event: ExecutionFailed) {
  if (!claim(seen, event.id)) return []
  const { sessionID, error } = event.data
  const children = childStore(ports.storage)
  const entries = await children.entriesOf(sessionID)
  const at = event.created ?? ports.now()
  const wait = retryDelay(error)
  if (entries.length)
    await children.settled(sessionID, "failed", at, undefined, wait === undefined ? undefined : at + wait).catch((error: unknown) =>
      ports.log(`courier watch: could not note the failed turn of ${sessionID}: ${String(error)}`),
    )
  const out = await Promise.all(entries.map((entry) => outIn(ports, entry)))
  const completed = await Promise.all(out.map((member) => (member ? leave(ports, member, "failed", at) : Promise.resolve(false))))
  const quiet = entries.length > 0 && (await stoppedSincePrompt(children, sessionID).catch(() => false))
  try {
    if (quiet) return []
    const below = await liveBelow(ports, sessionID).then(
      (live) => live.map((entry) => entry.title),
      (error: unknown) => {
        ports.log(`courier watch: could not read the sessions under ${sessionID}: ${String(error)}`)
        return []
      },
    )
    await Promise.all(
      entries.map((entry, index) =>
        ports.session.synthetic({
          sessionID: entry.parentID,
          text: envelope(sessionID, failureNotice(entry.title, error, out[index]?.group, at, below), { failed: error.type }),
          description: `Session ${sessionID} failed`,
          metadata: { source: "courier", from: sessionID, failed: true },
          delivery: "steer",
        }),
      ),
    )
  } finally {
    if (completed.includes(true)) ports.nudge()
    await Promise.all(entries.map((entry) => syncStanding(ports, entry.parentID)))
  }
  return entries.map((entry) => entry.parentID)
}

const TYPED = "typed"
const UNOWED = new Set(["user", "compaction", "move", TYPED])
const OWN = "own"
const OWN_SCHEDULED = "own-scheduled:"
const MESSAGE_FROM = "from:"

function kindOf(sessionID: string, item: Enqueued["data"]["item"]) {
  const metadata = item.payload?.metadata
  if (item.type !== "synthetic" || metadata?.source !== "courier") return item.type
  if (metadata.route === "prompt") return TYPED
  if (typeof metadata.group === "string") return OWN
  const ownCheckIn = typeof metadata.scheduled === "string" && metadata.from === sessionID && typeof metadata.scheduledAt === "number"
  if (ownCheckIn) return `${OWN_SCHEDULED}${metadata.scheduledAt}`
  const statusless = typeof metadata.from === "string" && Object.keys(metadata).length === 2
  return statusless ? `${MESSAGE_FROM}${metadata.from}` : item.type
}

async function ownAfterReport(children: Pick<ChildStore, "notes" | "indexedParent">, sessionID: string, kind: string | undefined) {
  if (kind === OWN) return reportedSincePrompt(children, sessionID)
  if (kind?.startsWith(MESSAGE_FROM))
    return (await children.indexedParent(kind.slice(MESSAGE_FROM.length))) === sessionID && reportedSincePrompt(children, sessionID)
  if (!kind?.startsWith(OWN_SCHEDULED)) return false
  return reportedSincePrompt(children, sessionID, Number(kind.slice(OWN_SCHEDULED.length)))
}

export async function noteEnqueued(ports: WatchPorts, inbox: Map<string, string>, event: Enqueued) {
  const { sessionID, inboxID, item } = event.data
  if ((await childStore(ports.storage).indexedParent(sessionID)) === undefined) return false
  setBounded(inbox, inboxID, kindOf(sessionID, item), SEEN_MAX)
  return true
}

export async function notePrompt(
  ports: WatchPorts,
  event: SessionEvent & { readonly data: { readonly inboxID?: string } },
  inbox?: Map<string, string>,
) {
  const { sessionID, inboxID } = event.data
  const kind = inboxID === undefined ? undefined : inbox?.get(inboxID)
  if (UNOWED.has(kind ?? "")) return false
  const children = childStore(ports.storage)
  const parentID = await children.indexedParent(sessionID)
  if (parentID === undefined) return false
  if (await ownAfterReport(children, sessionID, kind)) return false
  if (inboxID !== undefined && (await children.nudgeOf(sessionID)).inboxID === inboxID) return false
  await children.prompted(sessionID, event.created ?? ports.now())
  await syncStanding(ports, parentID)
  return true
}

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
  await syncStanding(ports, entry.parentID)
  return true
}

export async function noteDeleted(ports: WatchPorts, event: SessionEvent) {
  const { sessionID } = event.data
  const children = childStore(ports.storage)
  const [parentID, started] = await Promise.all([children.indexedParent(sessionID), children.children(sessionID)])
  const forgotten = [...(parentID === undefined ? [] : [sessionID]), ...started.map((child) => child.sessionID)]
  const entry = parentID === undefined ? undefined : await children.entry(parentID, sessionID)
  const member = entry && (await outIn(ports, entry))
  await forgetDeleted(ports, sessionID, forgotten, member, event.created)
  if (parentID !== undefined && entry && !entry.isolated && started.length === 0) await forgetChild(ports.storage, parentID, sessionID)
  if (parentID !== undefined) await syncStanding(ports, parentID)
  return forgotten
}

export const waitsOn =
  (...suppliers: Waits[]): Waits =>
  async (ports, sessionID, since) => {
    for (const supplier of suppliers) if (await supplier(ports, sessionID, since)) return true
    return false
  }

export async function reportSilent(ports: WatchPorts, seen: Set<string>, event: SessionEvent, outside: Waits) {
  const { sessionID } = event.data
  const children = childStore(ports.storage)
  const entry = await children.indexedEntry(sessionID)
  if (!entry || !claim(seen, event.id)) return []
  const report = await owedUnwaited(ports, children, outside, sessionID)
  if (!report) return []
  const lastText = await ports.session.context({ sessionID }).then(lastReply, () => undefined)
  const group = (await outIn(ports, entry))?.group
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
    await children.untold(sessionID, toldAt).catch(() => undefined)
    throw error
  }
  await syncStanding(ports, entry.parentID)
  return [entry.parentID]
}

export async function reportDeclined(ports: WatchPorts, seen: Set<string>, event: SessionEvent, outside: Waits) {
  if (event.data.reason !== "shutdown" || (await childStore(ports.storage).indexedParent(event.data.sessionID)) === undefined) return []
  if (!endsIdle(await ports.session.context({ sessionID: event.data.sessionID }).catch(() => []))) return []
  return reportSilent(ports, seen, event, outside)
}

const TURN_ENDS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

const TREE_TYPES = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.deleted",
] as const satisfies readonly EventType[]

async function sealGroups(ports: WatchPorts, event: SessionEvent) {
  try {
    if (event.data.reason === "shutdown" && !endsIdle(await ports.session.context({ sessionID: event.data.sessionID }).catch(() => []))) return
    if (await hasCompleteGroup(groupStore(ports.storage), event.data.sessionID)) ports.nudge()
  } catch (error) {
    ports.log(`courier watch: could not read the groups of ${event.data.sessionID}: ${String(error)}`)
  }
}

async function inboxEnqueued(ports: WatchPorts, state: WatchState, event: Enqueued) {
  const noted = await noteEnqueued(ports, state.inbox, event)
  await noteTyped(ports, event).catch((error: unknown) => ports.log(`courier fan-up: could not note text typed into ${event.data.sessionID}: ${String(error)}`))
  return noted
}

async function inboxDelivered(ports: WatchPorts, state: WatchState, event: SessionEvent & InboxSettled) {
  await relayTyped(ports, state.seen, event).catch((error: unknown) => ports.log(`courier fan-up: could not pass on text typed into ${event.data.sessionID}: ${String(error)}`))
  return notePrompt(ports, event, state.inbox)
}

function routeTree(ports: WatchPorts, state: WatchState, outside: Waits, event: HostEvent) {
  if (event.type === "session.execution.failed") return reportFailure(ports, state.seen, event as unknown as ExecutionFailed)
  if (event.type === "session.execution.succeeded") return reportSilent(ports, state.seen, event as unknown as SessionEvent, outside)
  if (event.type === "session.execution.interrupted") {
    const interrupted = event as unknown as SessionEvent
    return interrupted.data.reason === "shutdown" ? reportDeclined(ports, state.seen, interrupted, outside) : noteInterrupted(ports, interrupted)
  }
  if (event.type === "session.inbox.enqueued") return inboxEnqueued(ports, state, event as unknown as Enqueued)
  if (event.type === "session.inbox.delivered") return inboxDelivered(ports, state, event as unknown as SessionEvent & InboxSettled)
  if (event.type === "session.inbox.cancelled") return forgetTyped(ports, event as unknown as InboxSettled)
  if (event.type === "session.deleted") return noteDeleted(ports, event as unknown as SessionEvent)
  return undefined
}

function routeWake(ports: WatchPorts, event: HostEvent) {
  if (event.type === "session.inbox.enqueued") return watchWake(ports, event as unknown as Enqueued)
  if (event.type === "session.inbox.delivered" || event.type === "session.inbox.cancelled") return settleWake(ports, event as unknown as InboxSettled)
  if (event.type === "session.execution.started") return wakeStarted(ports, event as unknown as Execution)
  if (TURN_ENDS.has(event.type)) return wakeEnded(ports, event as unknown as Execution)
  if (event.type === "session.deleted") return forgetWakes(ports, (event as unknown as SessionEvent).data.sessionID)
  return undefined
}

async function route(ports: WatchPorts, state: WatchState, outside: Waits, event: HostEvent) {
  const watched = routeWake(ports, event)?.catch((error: unknown) => ports.log(`courier watch: wake of ${event.type}: ${String(error)}`))
  try {
    return await routeTree(ports, state, outside, event)
  } finally {
    await watched
  }
}

export function treeEvents(state: WatchState, outside: Waits): EventModule<WatchPorts> {
  return {
    types: TREE_TYPES,
    handle: (ports, event) => route(ports, state, outside, event),
    after: (ports, event) => (TURN_ENDS.has(event.type) ? sealGroups(ports, event as unknown as SessionEvent) : undefined),
  }
}
