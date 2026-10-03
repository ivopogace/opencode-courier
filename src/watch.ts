import type { Plugin } from "@opencode-ai/plugin"
import { envelope } from "./courier.js"
import { permissionNotice, settledNotice, type PermissionAsked, type PermissionReplied, type Waiting } from "./relay.js"
import { entriesOf, type RosterStorage } from "./roster.js"

type Context = Plugin.Context

/** How long to wait before subscribing again after the event stream ended or broke. */
export const RESUBSCRIBE_MS = 5_000

/** How many handled event ids, and waiting requests, are remembered. */
const SEEN_MAX = 1_000

export interface WatchPorts {
  readonly storage: RosterStorage
  readonly session: Pick<Context["session"], "synthetic">
  readonly event: Pick<Context["event"], "subscribe">
  readonly log: (message: string) => void
}

/**
 * What every plugin instance in the process shares: OpenCode sets the plugin up once per project
 * location, all in one process, and each instance may see the same event, so an event id is
 * claimed synchronously and handled once. `waiting` holds the permission requests a parent was told
 * about and has not answered.
 */
export interface WatchState {
  readonly seen: Set<string>
  readonly waiting: Waiting
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

/**
 * Tells the parent of a child that waits for a permission what it asks and which answers there
 * are, waking it. Returns the parents told.
 */
export async function reportAsked(ports: WatchPorts, state: WatchState, event: PermissionAsked) {
  if (!claim(state.seen, event.id)) return []
  const request = event.data
  const entries = await entriesOf(ports.storage, request.sessionID)
  if (!entries.length) return []
  claim(state.waiting, request.id)
  for (const entry of entries) {
    const startedBySession = (await entriesOf(ports.storage, entry.parentID)).length > 0
    await ports.session.synthetic({
      sessionID: entry.parentID,
      text: envelope(request.sessionID, permissionNotice(entry.title, request, startedBySession), {
        asks: "permission",
        request: request.id,
      }),
      description: `Session ${request.sessionID} asks for permission`,
      metadata: { source: "courier", from: request.sessionID, asks: "permission", requestID: request.id },
      delivery: "steer",
    })
  }
  return entries.map((entry) => entry.parentID)
}

/**
 * Tells the parent that a request it was told about has been answered some other way, in the
 * child's own session or along with another answer, so it does not pass on a stale question.
 * Requests answered through courier_answer are no longer waiting and are skipped.
 */
export async function reportReplied(ports: WatchPorts, state: WatchState, event: PermissionReplied) {
  if (!claim(state.seen, event.id)) return []
  const { sessionID, requestID, reply } = event.data
  if (!state.waiting.delete(requestID)) return []
  const entries = await entriesOf(ports.storage, sessionID)
  for (const entry of entries)
    await ports.session.synthetic({
      sessionID: entry.parentID,
      text: envelope(sessionID, settledNotice(entry.title, requestID, reply), { answered: reply, request: requestID }),
      description: `Session ${sessionID} no longer asks for permission`,
      metadata: { source: "courier", from: sessionID, answered: reply, requestID },
      delivery: "steer",
    })
  return entries.map((entry) => entry.parentID)
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
  return []
}

/**
 * Follows OpenCode's events until `signal` aborts, telling parents when a spawned child's turn
 * fails, when it waits for a permission and when that request is answered without them.
 */
export async function watchChildren(ports: WatchPorts, state: WatchState, signal: AbortSignal, retryMs = RESUBSCRIBE_MS) {
  while (!signal.aborted) {
    try {
      for await (const event of ports.event.subscribe({ signal })) {
        await handle(ports, state, event).catch((error: unknown) => {
          const sessionID = (event.data as { sessionID?: string } | undefined)?.sessionID
          ports.log(`courier watch: could not handle ${event.type} of ${sessionID}: ${String(error)}`)
        })
      }
    } catch (error) {
      if (!signal.aborted) ports.log(`courier watch: event stream broke: ${String(error)}`)
    }
    if (!signal.aborted) await pause(retryMs, signal)
  }
}
