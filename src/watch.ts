import type { Plugin } from "@opencode/plugin"
import { envelope } from "./courier.js"
import { eventsFollowed, eventsLeft, formShown, formsMayHaveBeenMissed } from "./question.js"
import { permissionNotice, settledNotice, type PermissionAsked, type PermissionReplied, type Waiting } from "./relay.js"
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
 * notice whose roster lookup was overtaken by the answer is not sent.
 */
export interface WatchState {
  readonly seen: Set<string>
  readonly waiting: Waiting
  readonly answered: Set<string>
}

/** The part of OpenCode's `session.execution.failed` event the notice is made from. */
export interface ExecutionFailed {
  readonly id: string
  readonly data: {
    readonly sessionID: string
    readonly error: { readonly type: string; readonly message: string; readonly status?: number | undefined }
  }
}

export function failureNotice(title: string, error: ExecutionFailed["data"]["error"]) {
  const status = error.status === undefined ? "" : `, status ${error.status}`
  return [
    `This session, "${title}", which you started with courier_spawn, failed: ${error.message} (${error.type}${status}).`,
    "Its turn ended without finishing, so it will not report back on its own.",
    "Message it with courier_send to have it try again, start a replacement, or carry on without it.",
  ].join("\n")
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
  for (const entry of entries)
    await ports.session.synthetic({
      sessionID: entry.parentID,
      text: envelope(sessionID, failureNotice(entry.title, error), { failed: error.type }),
      description: `Session ${sessionID} failed`,
      metadata: { source: "courier", from: sessionID, failed: true },
      delivery: "steer",
    })
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
    text: envelope(sessionID, settledNotice(chain[0]!.title, requestID, reply), { answered: reply, request: requestID }),
    description: `Session ${sessionID} no longer asks for permission`,
    metadata: { source: "courier", from: sessionID, answered: reply, requestID },
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
  for (const sessionID of sessions)
    for (const request of await ports.permission.list({ sessionID }).catch(() => []))
      await reportAsked(ports, state, { id: `pending:${request.id}`, data: request })
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

/** Handles one event of OpenCode's stream; those that cannot concern a spawned child are ignored. */
async function handle(ports: WatchPorts, state: WatchState, event: { readonly type: string }) {
  if (event.type === "session.execution.failed") return reportFailure(ports, state.seen, event as unknown as ExecutionFailed)
  if (event.type === "permission.asked") return reportAsked(ports, state, event as unknown as PermissionAsked)
  if (event.type === "permission.replied") return reportReplied(ports, state, event as unknown as PermissionReplied)
  // Not claimed: every instance may resolve the same waiting call, which is harmless.
  if (event.type === "form.created") formShown(event as unknown as Parameters<typeof formShown>[0])
  return []
}

/**
 * Follows OpenCode's events until `signal` aborts, telling parents when a spawned child's turn
 * fails, when it waits for a permission and when that request is answered without them, and
 * noting the question forms shown, which the question relay waits for.
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
          const sessionID = (event.data as { sessionID?: string } | undefined)?.sessionID
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
