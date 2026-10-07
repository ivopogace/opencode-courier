import type { Plugin } from "@opencode/plugin"
import {
  envelope,
  failureNotice,
  formNotice,
  formSettledNotice,
  kindOf,
  permissionNotice,
  permissionSettledNotice,
  type ExecutionError,
} from "./notices.js"
import { eventsFollowed, eventsLeft, formShown, formsMayHaveBeenMissed, locationClosing } from "./question.js"
import {
  QUESTION_FORM,
  type FormCreated,
  type FormSettled,
  type PermissionAsked,
  type PermissionReplied,
  type Waiting,
} from "./relay.js"
import { allEntries, entriesOf, lineage, type RosterEntry, type RosterStorage } from "./roster.js"

type Context = Plugin.Context

/** How long to wait before subscribing again after the event stream ended or broke. */
export const RESUBSCRIBE_MS = 5_000

/** How many handled event ids, and waiting or answered requests, are remembered. */
const SEEN_MAX = 1_000

export interface WatchPorts {
  readonly storage: RosterStorage
  readonly session: Pick<Context["session"], "synthetic">
  readonly event: Pick<Context["event"], "subscribe">
  /** This location's pending permission requests, relayed when the watcher (re)subscribes. */
  readonly permission: Pick<Context["permission"], "list">
  readonly log: (message: string) => void
}

/**
 * What every plugin instance in the process shares: OpenCode sets the plugin up once per project
 * location, all in one process, and each instance may see the same event, so an event id is
 * claimed synchronously and handled once. `waiting` holds the permission requests a session was
 * told about and has not answered; `answered`, requests answered before anyone was told, so a
 * notice whose roster lookup was overtaken by the answer is not sent. `forms` does the same for
 * the forms of spawned sessions.
 */
export interface WatchState {
  readonly seen: Set<string>
  readonly waiting: Waiting
  readonly answered: Set<string>
  readonly forms: FormsTold
}

/** The forms sessions were told about, kept apart from the permission requests. */
export interface FormsTold {
  /** Forms still shown whose notice went out, or is going out: the notice's delivery. */
  readonly told: Map<string, Promise<unknown>>
  /** Forms settled before anyone was told, so a notice whose roster lookup was overtaken is not sent. */
  readonly settled: Set<string>
}

/** The part of OpenCode's `session.execution.failed` event the notice is made from. */
export interface ExecutionFailed {
  readonly id: string
  readonly data: {
    readonly sessionID: string
    readonly error: ExecutionError
  }
}

/** Adds to a bounded set, dropping the oldest entry; false when the value was there already. */
export function claim(set: Set<string>, value: string) {
  if (set.has(value)) return false
  set.add(value)
  if (set.size > SEEN_MAX) set.delete(set.values().next().value!)
  return true
}

/**
 * Tells the parent of a child whose turn failed, since a child that cannot reach its model cannot
 * call courier_send. Returns the parents told.
 */
export async function reportFailure(ports: WatchPorts, seen: Set<string>, event: ExecutionFailed) {
  if (!claim(seen, event.id)) return []
  const { sessionID, error } = event.data
  const entries = await entriesOf(ports.storage, sessionID)
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
 * Tells the session that was told about a request that it has been answered some other way, in the
 * child's own session or along with another answer, so it does not pass on a stale question.
 * Requests answered through courier_answer are no longer waiting and are skipped.
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

/** Like `claim`, for a bounded map: adds the entry, dropping the oldest. */
function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.set(key, value)
  if (map.size > SEEN_MAX) map.delete(map.keys().next().value!)
}

/**
 * Tells the session at the top about a form OpenCode shows in a spawned session, such as web
 * search asking for its provider, which only the person can answer there. Question forms are
 * left to the question relay, which passes every question of a spawned session on.
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
  remember(state.forms.told, form.id, telling)
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
 * Relays the requests that spawned sessions in this location already wait on, which the event
 * stream does not repeat: those asked while it was down, before the watcher (re)subscribed.
 */
export async function relayPending(ports: WatchPorts, state: WatchState) {
  const sessions = new Set((await allEntries(ports.storage)).map((entry) => entry.sessionID))
  // Each request is claimed before its notice goes out, so relaying them all at once tells each once.
  const relay = async (sessionID: string) => {
    const requests = await ports.permission.list({ sessionID }).catch(() => [])
    await Promise.all(requests.map((request) => reportAsked(ports, state, { id: `pending:${request.id}`, data: request })))
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
  if (event.type === "permission.asked") return reportAsked(ports, state, event as unknown as PermissionAsked)
  if (event.type === "permission.replied") return reportReplied(ports, state, event as unknown as PermissionReplied)
  if (event.type === "form.created") {
    // Not claimed: every instance may resolve the same waiting call, which is harmless.
    formShown(event as unknown as Parameters<typeof formShown>[0])
    return reportForm(ports, state, event as unknown as FormCreated)
  }
  if (event.type === "form.replied" || event.type === "form.cancelled")
    return reportFormSettled(ports, state, event as unknown as FormSettled)
  // Not claimed either: a location closing withdraws its forms, which must not pass for dismissals.
  // The event's location is optional; without one, the shutdown counts for every location.
  if (event.type === "location.shutdown") {
    const directory = (event as { location?: { directory?: unknown } }).location?.directory
    locationClosing(typeof directory === "string" ? directory : undefined)
  }
  return []
}

/**
 * Follows OpenCode's events until `signal` aborts, telling parents when a spawned child's turn
 * fails, when it waits for a permission or on a form and when that is answered without them, and
 * noting for the question relay the question forms shown, which it waits for, and the locations
 * shutting down, whose withdrawn forms must not pass for dismissals.
 */
export async function watchChildren(ports: WatchPorts, state: WatchState, signal: AbortSignal, retryMs = RESUBSCRIBE_MS) {
  while (!signal.aborted) {
    let following = false
    try {
      const events = ports.event.subscribe({ signal })
      // Question forms shown while no instance followed the events were not seen: released now,
      // and again on the first event, by when the stream is surely connected.
      let missed = eventsFollowed()
      following = true
      // Alongside the new subscription; a request both relays see is relayed once.
      void relayPending(ports, state).catch((error: unknown) => ports.log(`courier watch: could not relay pending requests: ${String(error)}`))
      for await (const event of events) {
        if (missed) formsMayHaveBeenMissed()
        missed = false
        await handle(ports, state, event).catch((error: unknown) => {
          const data = event.data as { sessionID?: string; form?: { sessionID?: string } } | undefined
          const sessionID = data?.sessionID ?? data?.form?.sessionID
          ports.log(`courier watch: could not handle ${event.type} of ${sessionID}: ${String(error)}`)
        })
      }
    } catch (error) {
      if (!signal.aborted) ports.log(`courier watch: event stream broke: ${String(error)}`)
    } finally {
      if (following) eventsLeft()
    }
    if (!signal.aborted) await pause(retryMs, signal)
  }
}
