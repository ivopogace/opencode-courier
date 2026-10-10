import { addBounded, setBounded } from "./bounded.js"
import { lastReply } from "./courier.js"
import type { Hub, Member, WatchPorts, WatchState } from "./hub.js"
import {
  envelope,
  failureNotice,
  formNotice,
  formSettledNotice,
  kindOf,
  permissionNotice,
  permissionSettledNotice,
  silentNotice,
  type ExecutionError,
} from "./notices.js"
import { eventsFollowed, eventsLeft, formShown, formsMayHaveBeenMissed, locationClosing, pendingQuestions } from "./question/index.js"
import {
  listEverywhere,
  QUESTION_FORM,
  type FormCreated,
  type FormSettled,
  type PermissionAsked,
  type PermissionReplied,
} from "./relay.js"
import { scheduledFor } from "./later.js"
import { awaited, forgetReport, prompted, reportOf, settled, told, untold } from "./report.js"
import { allEntries, children, entriesOf, indexedEntry, indexedParent, lineage, type RosterEntry } from "./roster.js"
import { subscriptions } from "./webhook.js"

export type { FormsTold, WatchPorts, WatchState } from "./hub.js"

/** How long to wait before subscribing again after the event stream ended or broke. */
export const RESUBSCRIBE_MS = 5_000

/** How many handled event ids, and waiting or answered requests, are remembered. */
const SEEN_MAX = 1_000

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

/** Claims a value in one of the shared sets; false when it was claimed already. */
const claim = (set: Set<string>, value: string) => addBounded(set, value, SEEN_MAX)

/**
 * Tells the parent of a child whose turn failed, since a child that cannot reach its model cannot
 * call courier_send. Returns the parents told.
 */
export async function reportFailure(ports: WatchPorts, seen: Set<string>, event: ExecutionFailed) {
  if (!claim(seen, event.id)) return []
  const { sessionID, error } = event.data
  const entries = await entriesOf(ports.storage, sessionID)
  // Not in the way of the notice: kept only so the limits stop counting the child.
  if (entries.length)
    await settled(ports.storage, sessionID, "failed", event.created ?? ports.now()).catch((error: unknown) =>
      ports.log(`courier watch: could not note the failed turn of ${sessionID}: ${String(error)}`),
    )
  await Promise.all(
    entries.map((entry) =>
      ports.session.synthetic({
        sessionID: entry.parentID,
        text: envelope(sessionID, failureNotice(entry.title, error), { failed: error.type }),
        description: `Session ${sessionID} failed`,
        metadata: { source: "courier", from: sessionID, failed: true },
        delivery: "steer",
      }),
    ),
  )
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
  if ((await indexedParent(ports.storage, sessionID)) === undefined) return false
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
  if ((await indexedParent(ports.storage, sessionID)) === undefined) return false
  await prompted(ports.storage, sessionID, event.created ?? ports.now())
  return true
}

/** Notes that a spawned session's turn was stopped; one stopped by a shutdown resumes on the next start. */
export async function noteInterrupted(ports: WatchPorts, event: SessionEvent) {
  if (event.data.reason === "shutdown") return false
  const { sessionID } = event.data
  if ((await indexedParent(ports.storage, sessionID)) === undefined) return false
  await settled(ports.storage, sessionID, "interrupted", event.created ?? ports.now())
  return true
}

/**
 * Drops the report state of a session OpenCode deleted, and of the sessions it started, whose reports
 * can no longer be delivered: neither will report. Returns the sessions forgotten.
 */
export async function noteDeleted(ports: WatchPorts, event: SessionEvent) {
  const { sessionID } = event.data
  const [parentID, started] = await Promise.all([indexedParent(ports.storage, sessionID), children(ports.storage, sessionID)])
  const forgotten = [...(parentID === undefined ? [] : [sessionID]), ...started.map((entry) => entry.sessionID)]
  await Promise.all(forgotten.map((id) => forgetReport(ports.storage, id)))
  return forgotten
}

/**
 * Whether a session prompted at `prompt` waits: on an untold report of a session it started, a request
 * of its own, a scheduled message, or a webhook it subscribed to since. Cheapest first.
 */
async function waits(ports: WatchPorts, sessionID: string, prompt: number) {
  const started = await children(ports.storage, sessionID)
  if ((await Promise.all(started.map((entry) => awaited(ports.storage, entry.sessionID)))).includes(true)) return true
  if ((await listEverywhere([...ports.permissions()], sessionID)).some((found) => found.requests.length)) return true
  if ((await pendingQuestions(ports.storage, sessionID)).length) return true
  const [scheduled, subscribed] = await Promise.all([scheduledFor(ports.storage, sessionID), subscriptions(ports)])
  // An older subscription is no wait: a prompt, most likely its delivery, has come since.
  return scheduled.length > 0 || subscribed.some((subscription) => subscription.sessionID === sessionID && subscription.createdAt >= prompt)
}

/**
 * Tells the parent of a spawned session whose turn ended without reporting to it since its last
 * prompt, unless it waits; finds the session by the reverse index alone. Returns the parents told.
 */
export async function reportSilent(ports: WatchPorts, seen: Set<string>, event: SessionEvent) {
  const { sessionID } = event.data
  const entry = await indexedEntry(ports.storage, sessionID)
  // Claimed after the lookup, so other sessions' turns do not crowd `seen`, and before anything is told.
  if (!entry || !claim(seen, event.id)) return []
  const report = await reportOf(ports.storage, sessionID)
  if (!report?.owes || (await waits(ports, sessionID, report.prompt))) return []
  // The notice goes out without the reply rather than not at all.
  const lastText = await ports.session.context({ sessionID }).then(lastReply, () => undefined)
  // Before the notice, which may end the parent's turn at once: once told, it no longer waits for this one.
  const toldAt = event.created ?? ports.now()
  await told(ports.storage, sessionID, toldAt).catch((error: unknown) =>
    ports.log(`courier watch: could not note that the parent of ${sessionID} was told: ${String(error)}`),
  )
  try {
    await ports.session.synthetic({
      sessionID: entry.parentID,
      text: envelope(sessionID, silentNotice(entry.title, lastText, report.progressed), { ended: "without-report" }),
      description: `Session ${sessionID} ended without a report`,
      metadata: { source: "courier", from: sessionID, ended: "without-report" },
      delivery: "steer",
    })
  } catch (error) {
    // Not told after all: the parent still waits for it.
    await untold(ports.storage, sessionID, toldAt).catch(() => undefined)
    throw error
  }
  return [entry.parentID]
}

/** The session at the top of a lineage: where its permission requests go, since that is where the person is. */
const topOf = (chain: RosterEntry[]) => chain.at(-1)!.parentID

/**
 * Tells the session at the top, the parent of a child or the session a chain of children started
 * from, what a waiting child asks and which answers there are, waking it. Returns the sessions told.
 */
export async function reportAsked(ports: WatchPorts, state: WatchState, event: PermissionAsked) {
  if (!claim(state.seen, event.id)) return []
  const request = event.data
  const chain = await lineage(ports.storage, request.sessionID)
  // Claimed only now, after the lookup: a request answered meanwhile is in `answered`, and one
  // already relayed, from the event or from the pending list, is in `waiting`.
  if (!chain.length || state.answered.has(request.id) || !claim(state.waiting, request.id)) return []
  const startedBy = chain.length > 1 ? chain[0]!.parentID : undefined
  await ports.session.synthetic({
    sessionID: topOf(chain),
    text: envelope(request.sessionID, permissionNotice(chain[0]!.title, request, startedBy), {
      asks: "permission",
      request: request.id,
    }),
    description: `Session ${request.sessionID} asks for permission`,
    metadata: { source: "courier", from: request.sessionID, asks: "permission", requestID: request.id },
    delivery: "steer",
  })
  return [topOf(chain)]
}

/**
 * Tells the session told about a request that it was answered some other way, so it does not pass on
 * a stale question; requests answered through courier_answer no longer wait and are skipped.
 */
export async function reportReplied(ports: WatchPorts, state: WatchState, event: PermissionReplied) {
  if (!claim(state.seen, event.id)) return []
  const { sessionID, requestID, reply } = event.data
  if (!state.waiting.delete(requestID)) {
    claim(state.answered, requestID)
    return []
  }
  const chain = await lineage(ports.storage, sessionID)
  if (!chain.length) return []
  await ports.session.synthetic({
    sessionID: topOf(chain),
    text: envelope(sessionID, permissionSettledNotice(chain[0]!.title, requestID, reply), { answered: reply, request: requestID }),
    description: `Session ${sessionID} no longer asks for permission`,
    metadata: { source: "courier", from: sessionID, answered: reply, requestID },
    delivery: "steer",
  })
  return [topOf(chain)]
}

/**
 * Tells the top session about a form OpenCode shows in a spawned session, such as web search asking
 * for its provider, which only the person can answer; question forms are left to the question relay.
 */
export async function reportForm(ports: WatchPorts, state: WatchState, event: FormCreated) {
  if (!claim(state.seen, event.id)) return []
  const form = event.data.form
  if (kindOf(form) === QUESTION_FORM) return []
  const chain = await lineage(ports.storage, form.sessionID)
  // As with a permission request, claimed after the lookup, so a form settled meanwhile is not told.
  if (!chain.length || state.forms.settled.has(form.id) || state.forms.told.has(form.id)) return []
  const startedBy = chain.length > 1 ? chain[0]!.parentID : undefined
  const kind = kindOf(form)
  const telling = ports.session.synthetic({
    sessionID: topOf(chain),
    text: envelope(form.sessionID, formNotice(chain[0]!.title, form, startedBy), {
      asks: "form",
      form: form.id,
      ...(kind ? { kind } : {}),
    }),
    description: `Session ${form.sessionID} shows a form`,
    metadata: { source: "courier", from: form.sessionID, asks: "form", formID: form.id, ...(kind ? { kind } : {}) },
    delivery: "steer",
  })
  setBounded(state.forms.told, form.id, telling, SEEN_MAX)
  await telling
  return [topOf(chain)]
}

/** Tells the session told about a form that it was answered or withdrawn, so it does not send the person to a form that is gone. */
export async function reportFormSettled(ports: WatchPorts, state: WatchState, event: FormSettled) {
  if (!claim(state.seen, event.id)) return []
  const { id, sessionID } = event.data
  const telling = state.forms.told.get(id)
  if (!telling) {
    claim(state.forms.settled, id)
    return []
  }
  state.forms.told.delete(id)
  const settled = event.type === "form.replied" ? "answered" : "cancelled"
  // After the notice that the form is shown, which another instance may still be sending, so the
  // settling never arrives first; and not at all when that notice did not go out.
  const [chain, told] = await Promise.all([lineage(ports.storage, sessionID), telling.then(() => true, () => false)])
  if (!chain.length || !told) return []
  await ports.session.synthetic({
    sessionID: topOf(chain),
    text: envelope(sessionID, formSettledNotice(chain[0]!.title, id, settled), { settled, form: id }),
    description: `Session ${sessionID} no longer shows a form`,
    metadata: { source: "courier", from: sessionID, settled, formID: id },
    delivery: "steer",
  })
  return [topOf(chain)]
}

/**
 * Relays the requests that spawned sessions already wait on, in every loaded location, which the
 * event stream does not repeat: those asked while it was down, before the watcher (re)subscribed.
 */
export async function relayPending(ports: WatchPorts, state: WatchState) {
  const sessions = new Set((await allEntries(ports.storage)).map((entry) => entry.sessionID))
  const domains = [...ports.permissions()]
  // Each request is claimed before its notice goes out, so relaying them all at once tells each
  // once, however many locations list it; a location that cannot be read lists none.
  const relay = async (sessionID: string) => {
    const listed = (await listEverywhere(domains, sessionID)).flatMap((found) => found.requests)
    await Promise.all(listed.map((request) => reportAsked(ports, state, { id: `pending:${request.id}`, data: request })))
  }
  await Promise.all([...sessions].map(relay))
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done)
  })

/**
 * Handles one event of OpenCode's stream; those that cannot concern a spawned child, or a question
 * relayed for one, are ignored.
 */
async function handle(ports: WatchPorts, state: WatchState, event: { readonly type: string }) {
  if (event.type === "session.execution.failed") return reportFailure(ports, state.seen, event as unknown as ExecutionFailed)
  if (event.type === "session.execution.succeeded") return reportSilent(ports, state.seen, event as unknown as SessionEvent)
  if (event.type === "session.execution.interrupted") return noteInterrupted(ports, event as unknown as SessionEvent)
  if (event.type === "session.inbox.enqueued") return noteEnqueued(ports, state.inbox, event as unknown as InboxEnqueued)
  if (event.type === "session.inbox.delivered") return notePrompt(ports, event as unknown as SessionEvent, state.inbox)
  if (event.type === "session.deleted") return noteDeleted(ports, event as unknown as SessionEvent)
  if (event.type === "permission.asked") return reportAsked(ports, state, event as unknown as PermissionAsked)
  if (event.type === "permission.replied") return reportReplied(ports, state, event as unknown as PermissionReplied)
  if (event.type === "form.created") {
    // Not claimed: the hub's other subscription, or another copy's watcher, may resolve the same
    // waiting call, which is harmless.
    formShown(event as unknown as Parameters<typeof formShown>[0])
    return reportForm(ports, state, event as unknown as FormCreated)
  }
  if (event.type === "form.replied" || event.type === "form.cancelled")
    return reportFormSettled(ports, state, event as unknown as FormSettled)
  // Not claimed either: a location closing withdraws its forms, which must not pass for dismissals.
  // The event's location is optional; without one, the shutdown counts for every location.
  if (event.type === "location.shutdown") {
    const directory = (event as { location?: { directory?: unknown } }).location?.directory
    locationClosing(ports.now(), typeof directory === "string" ? directory : undefined)
  }
  return []
}

const ENDED: IteratorReturnResult<undefined> = { done: true, value: undefined }

/**
 * `events` until it ends or `signal` aborts, the stream left open; each wait hears the abort only while
 * it waits, so a watcher that follows events for the life of the process holds nothing per event.
 */
const until = <T>(events: AsyncIterator<T>, signal: AbortSignal): AsyncIterable<T> => ({
  [Symbol.asyncIterator]: () => ({
    next: () =>
      new Promise<IteratorResult<T>>((resolve, reject) => {
        if (signal.aborted) return resolve(ENDED)
        const stop = () => resolve(ENDED)
        signal.addEventListener("abort", stop, { once: true })
        // Once the signal has aborted, whatever the stream ends this wait with is not wanted.
        events.next().then(
          (next) => {
            signal.removeEventListener("abort", stop)
            resolve(next)
          },
          (error: unknown) => {
            signal.removeEventListener("abort", stop)
            reject(error)
          },
        )
      }),
  }),
})

/** Relays the requests already pending, kept in `relaying` until done, for the watcher's end to wait for. */
function relayAlongside(ports: WatchPorts, state: WatchState, relaying: Set<Promise<void>>) {
  const relayed: Promise<void> = relayPending(ports, state)
    .catch((error: unknown) => ports.log(`courier watch: could not relay pending requests: ${String(error)}`))
    .finally(() => relaying.delete(relayed))
  relaying.add(relayed)
}

/** Handles one event, logging a failure rather than ending the watch. */
function handleLogged(ports: WatchPorts, state: WatchState, event: { readonly type: string; readonly data?: unknown }) {
  return handle(ports, state, event).catch((error: unknown) => {
    const data = event.data as { sessionID?: string; form?: { sessionID?: string } } | undefined
    const sessionID = data?.sessionID ?? data?.form?.sessionID
    ports.log(`courier watch: could not handle ${event.type} of ${sessionID}: ${String(error)}`)
  })
}

/**
 * Follows OpenCode's events until `signal` aborts: tells parents of a spawned child's failed or silent
 * turn, its pending permission or form, notes forms and shutdowns for the relay; ends after its current event.
 */
export async function watchChildren(ports: WatchPorts, state: WatchState, signal: AbortSignal, retryMs = RESUBSCRIBE_MS) {
  const relaying = new Set<Promise<void>>()
  while (!signal.aborted) {
    let following = false
    let events: AsyncIterator<{ readonly type: string; readonly data?: unknown }> | undefined
    try {
      events = ports.event.subscribe({ signal })[Symbol.asyncIterator]()
      // Question forms shown while no instance followed the events were not seen: released now,
      // and again on the first event, by when the stream is surely connected.
      let missed = eventsFollowed()
      following = true
      // Alongside the new subscription; a request both relays see is relayed once.
      relayAlongside(ports, state, relaying)
      for await (const event of until(events, signal)) {
        if (missed) formsMayHaveBeenMissed()
        missed = false
        await handleLogged(ports, state, event)
      }
    } catch (error) {
      if (!signal.aborted) ports.log(`courier watch: event stream broke: ${String(error)}`)
    } finally {
      if (following) eventsLeft()
      // Closed without waiting: closing the adapter's stream waits on OpenCode, which may not answer
      // while a location closes, and the leave waiting for this watcher must not wait for that too.
      void events?.return?.().catch(() => {})
    }
    if (!signal.aborted) await pause(retryMs, signal)
  }
  await Promise.allSettled(relaying)
}

/**
 * Makes the hub start its subscriptions to OpenCode's events with this copy's watcher, the one loaded
 * last; `join` starts them. The second is a standby, connected before the first's member leaves.
 */
export function watchFromHub(hub: Pick<Hub, "subscribe">, state: WatchState, retryMs = RESUBSCRIBE_MS) {
  hub.subscribe = (member: Member) => {
    const stop = new AbortController()
    return { member, stop, done: watchChildren(member.watch, state, stop.signal, retryMs) }
  }
}
