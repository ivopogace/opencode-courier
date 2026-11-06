import { millis } from "../platform/json.js"
import { busy, endsIdle } from "./domain.js"
import type { GroupPorts, Wake, WatchPorts } from "./ports.js"
import { wakeStore } from "./store.js"

type Messages = Awaited<ReturnType<WatchPorts["session"]["context"]>>

export const WAKE_MS = 30_000

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

export interface InboxSettled {
  readonly data: { readonly sessionID: string; readonly inboxID: string }
}

export interface Execution {
  readonly created?: number
  readonly data: { readonly sessionID: string }
}

export async function watchWake(ports: WatchPorts, event: Enqueued) {
  const { sessionID, inboxID, item } = event.data
  const payload = item.payload
  if (item.type !== "synthetic" || payload?.metadata?.source !== "courier" || typeof payload.text !== "string") return false
  // resume: false starts no turn: the item waits for the next (api-notes)
  if (payload.metadata.resume === false) return false
  const at = event.created ?? ports.now()
  if ((await wakeStore(ports.storage).of(sessionID)).some((wake) => wake.inboxID === inboxID)) return true
  await watch(ports, { sessionID, inboxID, at, text: payload.text, ...(typeof payload.description === "string" ? { description: payload.description } : {}) })
  return true
}

export async function noteSent(ports: Pick<WatchPorts, "storage" | "session" | "now">, sent: { readonly sessionID: string; readonly inboxID: string; readonly text: string; readonly description?: string }) {
  const store = wakeStore(ports.storage)
  if ((await store.of(sent.sessionID)).some((wake) => wake.inboxID === sent.inboxID)) return
  await watch(ports, { ...sent, at: ports.now() })
  const stored = await ports.session.context({ sessionID: sent.sessionID }).then((messages) => messages.some((message) => message.id === sent.inboxID), () => false)
  if (stored) await store.remove(sent.sessionID, sent.inboxID)
}

async function watch(ports: Pick<WatchPorts, "storage" | "session">, wake: { readonly sessionID: string; readonly inboxID: string; readonly at: number; readonly text: string; readonly description?: string }) {
  const idle = await ports.session.context({ sessionID: wake.sessionID }).then(endsIdle, () => false)
  await wakeStore(ports.storage).put({ ...wake, running: !idle, ...(idle ? { idleAt: wake.at } : {}) })
}

export async function settleWake(ports: Pick<WatchPorts, "storage">, event: InboxSettled) {
  await wakeStore(ports.storage).remove(event.data.sessionID, event.data.inboxID)
}

export async function wakeStarted(ports: Pick<WatchPorts, "storage">, event: Execution) {
  const store = wakeStore(ports.storage)
  const waiting = await store.of(event.data.sessionID)
  await Promise.all(waiting.filter((wake) => !wake.running).map(({ idleAt: _, ...wake }) => store.put({ ...wake, running: true })))
}

export async function wakeEnded(ports: WatchPorts, event: Execution & { readonly data: { readonly reason?: string } }) {
  const { sessionID } = event.data
  const store = wakeStore(ports.storage)
  const waiting = await store.of(sessionID)
  if (!waiting.length) return
  const at = event.created ?? ports.now()
  const messages = await ports.session.context({ sessionID }).catch((): Messages => [])
  // a plain decline reports a shutdown after its aborted step (api-notes)
  if (event.data.reason === "shutdown" && !endsIdle(messages)) return
  const stored = new Set(messages.map((message) => message.id))
  await Promise.all(
    waiting.map((wake) => (stored.has(wake.inboxID) ? store.remove(sessionID, wake.inboxID) : store.put({ ...wake, running: false, idleAt: at }))),
  )
}

export async function forgetWakes(ports: Pick<WatchPorts, "storage">, sessionID: string) {
  const store = wakeStore(ports.storage)
  await Promise.all((await store.of(sessionID)).map((wake) => store.remove(sessionID, wake.inboxID)))
}

export type WakePorts = GroupPorts & { readonly session: Pick<WatchPorts["session"], "get" | "context">; readonly now: () => number }

export async function wakeMissed(ports: WakePorts, claimed: Set<string>) {
  const store = wakeStore(ports.storage)
  const now = ports.now()
  const due = (await store.all()).filter((wake) => missed(wake, now) && !claimed.has(claimOf(wake)))
  for (const wake of due) claimed.add(claimOf(wake))
  await Promise.all(due.map((wake) => wakeAgain(ports, store, wake, now).finally(() => claimed.delete(claimOf(wake)))))
}

const claimOf = (wake: Wake) => `wake ${wake.sessionID} ${wake.inboxID}`

const waitingSince = (wake: Wake) => Math.max(wake.idleAt ?? wake.at, wake.rewoken ?? 0)

export function missed(wake: Wake, now: number) {
  if (wake.running || wake.stalled !== undefined) return false
  return now - waitingSince(wake) >= WAKE_MS
}

async function wakeAgain(ports: WakePorts, store: ReturnType<typeof wakeStore>, wake: Wake, now: number) {
  try {
    const current = (await store.of(wake.sessionID)).find((one) => one.inboxID === wake.inboxID)
    if (!current || !missed(current, now)) return
    if (await runsNow(ports, current)) {
      const { idleAt: _, ...running } = current
      return await store.put({ ...running, running: true })
    }
    if (current.rewoken !== undefined) {
      ports.log(`courier wake: ${wake.sessionID} has not taken message ${wake.inboxID} since it was woken again; flagged stalled`)
      return await store.put({ ...current, stalled: now })
    }
    // the woken turn may take the message before synthetic returns
    await store.put({ ...current, rewoken: now })
    // synthetic with a waiting item's id wakes again, adds no message (api-notes)
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

async function runsNow(ports: WakePorts, wake: Wake) {
  const { sessionID } = wake
  const info = await ports.session.get({ sessionID }).catch(() => undefined)
  if (!info) return false
  // time.busy, since 2.2.2, records a start whose event was missed (api-notes)
  if (info.time.busy !== undefined) return busy(info.time) && millis(info.time.busy) >= waitingSince(wake)
  if (!busy(info.time)) return false
  const messages = await ports.session.context({ sessionID }).catch((): Messages => [])
  return messages.length > 0 && !endsIdle(messages)
}

export async function waitsInInbox(ports: Pick<WatchPorts, "storage">, sessionID: string, { stalled = true } = {}) {
  return (await wakeStore(ports.storage).of(sessionID)).some((wake) => !wake.running && (stalled || wake.stalled === undefined))
}

export async function stalledAmong(ports: Pick<WatchPorts, "storage">, sessionIDs: ReadonlyArray<string>) {
  const wanted = new Set(sessionIDs)
  const stalled = new Map<string, number>()
  for (const wake of await wakeStore(ports.storage).all()) {
    if (wake.stalled === undefined || !wanted.has(wake.sessionID)) continue
    stalled.set(wake.sessionID, Math.min(stalled.get(wake.sessionID) ?? wake.at, wake.at))
  }
  return stalled
}
