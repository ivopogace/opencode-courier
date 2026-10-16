import type { GroupPorts, Wake, WatchPorts } from "./ports.js"
import { wakeStore } from "./store.js"

/** How long a courier message may wait in an idle session's inbox before its wake counts as missed. */
export const WAKE_MS = 30_000

/** OpenCode's `session.inbox.enqueued`, with the item's payload, which carries the courier's metadata. */
export interface Enqueued {
  readonly created?: number
  readonly data: {
    readonly sessionID: string
    readonly inboxID: string
    readonly item: {
      readonly type: string
      readonly payload?: { readonly text?: unknown; readonly description?: unknown; readonly metadata?: { readonly source?: unknown; readonly resume?: unknown } }
    }
  }
}

/** OpenCode's `session.inbox.delivered` and `session.inbox.cancelled`. */
export interface InboxSettled {
  readonly data: { readonly sessionID: string; readonly inboxID: string }
}

/** OpenCode's `session.execution.*` events, which frame a session's busy period. */
export interface Execution {
  readonly created?: number
  readonly data: { readonly sessionID: string }
}

type Messages = Awaited<ReturnType<WatchPorts["session"]["context"]>>

/** Whether a session's stored messages end with the marker of an ended turn; one with none yet is taken to run. */
const endsIdle = (messages: Messages) => messages.at(-1)?.type === "idle"

/**
 * Watches a courier message enqueued for a session until it is delivered, noting whether the session runs.
 * Returns whether it is watched, which one sent with `resume: false` is not.
 */
export async function watchWake(ports: WatchPorts, event: Enqueued) {
  const { sessionID, inboxID, item } = event.data
  const payload = item.payload
  if (item.type !== "synthetic" || payload?.metadata?.source !== "courier" || typeof payload.text !== "string") return false
  // Sent without a wake: it waits for the next turn, which nothing owes it.
  if (payload.metadata.resume === false) return false
  const at = event.created ?? ports.now()
  // Read after the enqueue: a turn it started has stored messages since, and an unknown session is taken to run.
  const idle = await ports.session.context({ sessionID }).then(endsIdle, () => false)
  await wakeStore(ports.storage).put({
    sessionID,
    inboxID,
    at,
    text: payload.text,
    ...(typeof payload.description === "string" ? { description: payload.description } : {}),
    running: !idle,
    ...(idle ? { idleAt: at } : {}),
  })
  return true
}

/** Stops watching a message once it is delivered or cancelled. */
export async function settleWake(ports: Pick<WatchPorts, "storage">, event: InboxSettled) {
  await wakeStore(ports.storage).remove(event.data.sessionID, event.data.inboxID)
}

/** A turn started in a session: the messages waiting there are its to take. */
export async function wakeStarted(ports: Pick<WatchPorts, "storage">, event: Execution) {
  const store = wakeStore(ports.storage)
  const waiting = await store.of(event.data.sessionID)
  await Promise.all(waiting.filter((wake) => !wake.running).map(({ idleAt: _, ...wake }) => store.put({ ...wake, running: true })))
}

/**
 * A session's turn ended: a message it took is no longer watched, as its delivery may have been missed by this
 * subscription; one still waiting is watched as waiting in an idle session from now.
 */
export async function wakeEnded(ports: WatchPorts, event: Execution & { readonly data: { readonly reason?: string } }) {
  if (event.data.reason === "shutdown") return
  const { sessionID } = event.data
  const store = wakeStore(ports.storage)
  const waiting = await store.of(sessionID)
  if (!waiting.length) return
  const at = event.created ?? ports.now()
  const stored = new Set((await ports.session.context({ sessionID }).catch((): Messages => [])).map((message) => message.id))
  await Promise.all(
    waiting.map((wake) => (stored.has(wake.inboxID) ? store.remove(sessionID, wake.inboxID) : store.put({ ...wake, running: false, idleAt: at }))),
  )
}

/** Forgets the messages watched in a session's inbox: it was deleted, or stopped, which nothing is to wake again. */
export async function forgetWakes(ports: Pick<WatchPorts, "storage">, sessionID: string) {
  const store = wakeStore(ports.storage)
  await Promise.all((await store.of(sessionID)).map((wake) => store.remove(sessionID, wake.inboxID)))
}

/** The ports the scheduler's tick wakes sessions through: what every hub member's `later` ports have. */
export type WakePorts = GroupPorts & { readonly now: () => number }

/**
 * Sends once more, under its inbox id, each courier message an idle session has left waiting for `WAKE_MS`, and flags
 * stalled one still waiting `WAKE_MS` later; run by the scheduler's owner, `claimed` keeping a tick alongside off it.
 */
export async function wakeMissed(ports: WakePorts, claimed: Set<string>) {
  const store = wakeStore(ports.storage)
  const now = ports.now()
  const due = (await store.all()).filter((wake) => missed(wake, now) && !claimed.has(claimOf(wake)))
  for (const wake of due) claimed.add(claimOf(wake))
  await Promise.all(due.map((wake) => wakeAgain(ports, store, wake, now).finally(() => claimed.delete(claimOf(wake)))))
}

const claimOf = (wake: Wake) => `wake ${wake.sessionID} ${wake.inboxID}`

/** Whether a message has waited in an idle session past `WAKE_MS`, and since a wake again, if one was sent; a stalled one is done. */
export function missed(wake: Wake, now: number) {
  if (wake.running || wake.stalled !== undefined) return false
  const since = Math.max(wake.idleAt ?? wake.at, wake.rewoken ?? 0)
  return now - since >= WAKE_MS
}

async function wakeAgain(ports: WakePorts, store: ReturnType<typeof wakeStore>, wake: Wake, now: number) {
  try {
    // Re-read: the message may have been delivered, or the session woken, since the scan.
    const current = (await store.of(wake.sessionID)).find((one) => one.inboxID === wake.inboxID)
    if (!current || !missed(current, now)) return
    if (current.rewoken !== undefined) {
      ports.log(`courier wake: ${wake.sessionID} has not taken message ${wake.inboxID} since it was woken again; flagged stalled`)
      return await store.put({ ...current, stalled: now })
    }
    // Noted before the send: the turn it starts may take the message, and drop the watch, before the send returns.
    await store.put({ ...current, rewoken: now })
    await ports.session.synthetic({
      sessionID: wake.sessionID,
      id: wake.inboxID,
      text: wake.text,
      ...(wake.description !== undefined ? { description: wake.description } : {}),
      metadata: { source: "courier", wake: "again" },
      delivery: "steer",
    }).catch(async (error: unknown) => {
      await store.put(current)
      throw error
    })
    ports.log(`courier wake: ${wake.sessionID} left message ${wake.inboxID} waiting while idle; woken again`)
  } catch (error) {
    ports.log(`courier wake: could not wake ${wake.sessionID} again for ${wake.inboxID}: ${String(error)}`)
  }
}

/** The sessions among `sessionIDs` flagged stalled, each with when its oldest stalled message was enqueued. */
export async function stalledAmong(ports: Pick<WatchPorts, "storage">, sessionIDs: ReadonlyArray<string>) {
  const wanted = new Set(sessionIDs)
  const stalled = new Map<string, number>()
  for (const wake of await wakeStore(ports.storage).all()) {
    if (wake.stalled === undefined || !wanted.has(wake.sessionID)) continue
    stalled.set(wake.sessionID, Math.min(stalled.get(wake.sessionID) ?? wake.at, wake.at))
  }
  return stalled
}
