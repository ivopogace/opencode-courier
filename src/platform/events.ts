import type { Plugin } from "@opencode/plugin"
import type { Hub, Member } from "./hub.js"

/** One of OpenCode's events, as a subscription yields it. */
export interface HostEvent {
  readonly type: string
  readonly data?: unknown
}

/** What following OpenCode's events needs of a member's ports: the stream, and a log. */
export interface EventPorts {
  readonly event: Pick<Plugin.Context["event"], "subscribe">
  readonly log: (message: string) => void
}

/** An event type `event.subscribe` can filter on: any of OpenCode's but `server.connected`, which a plugin never receives. */
export type EventType = NonNullable<NonNullable<Parameters<EventPorts["event"]["subscribe"]>[0]>["types"]>[number]

/** What a module does with OpenCode's events, by phase; each phase runs the modules in list order. */
export interface EventModule<P extends EventPorts> {
  /** The event types it handles; without them, every event, so the subscription is not filtered. */
  readonly types?: readonly EventType[]
  /** For each event; the first to throw ends the phase. */
  readonly handle?: (ports: P, event: HostEvent) => Promise<unknown> | undefined
  /** For each event, once the `handle` phase has ended, however it did; the first to throw ends this one too. */
  readonly after?: (ports: P, event: HostEvent) => Promise<void> | undefined
  /** As a subscription starts; returns what to run once the stream is surely connected, if anything. */
  readonly followed?: () => (() => void) | undefined
  /** Alongside each (re)subscription; the watcher's end waits for it. */
  readonly subscribed?: (ports: P) => Promise<void>
  /** Once a subscription has ended or broken. */
  readonly left?: () => void
}

/** How long to wait before subscribing again after the event stream ended or broke. */
export const RESUBSCRIBE_MS = 5_000

/** How long after subscribing the stream is taken as connected, should no event come first: a plugin's reports no connection. */
export const CONNECTED_MS = 1_000

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

/** The types `modules` declare, sorted; undefined, every type, once one of them declares none. */
export function typesOf(modules: readonly EventModule<never>[]): EventType[] | undefined {
  const types = new Set<EventType>()
  for (const module of modules) {
    if (!module.types) return undefined
    for (const type of module.types) types.add(type)
  }
  return [...types].sort((a, b) => Number(a > b) - Number(a < b))
}

/** One event through the `handle` phase, then, however that ended, the `after` phase. */
async function handle<P extends EventPorts>(ports: P, modules: readonly EventModule<P>[], event: HostEvent) {
  try {
    for (const module of modules) {
      const handling = module.handle?.(ports, event)
      if (handling) await handling
    }
  } finally {
    for (const module of modules) {
      const after = module.after?.(ports, event)
      if (after) await after
    }
  }
}

/** Handles one event, logging a failure rather than ending the watch. */
function handleLogged<P extends EventPorts>(ports: P, modules: readonly EventModule<P>[], event: HostEvent) {
  return handle(ports, modules, event).catch((error: unknown) => {
    const data = event.data as { sessionID?: string; form?: { sessionID?: string } } | undefined
    const sessionID = data?.sessionID ?? data?.form?.sessionID
    ports.log(`courier watch: could not handle ${event.type} of ${sessionID}: ${String(error)}`)
  })
}

/** Runs each module's `subscribed` alongside the new subscription, kept in `alongside` until done. */
function subscribed<P extends EventPorts>(ports: P, modules: readonly EventModule<P>[], alongside: Set<Promise<void>>) {
  for (const module of modules) {
    if (!module.subscribed) continue
    const running: Promise<void> = module
      .subscribed(ports)
      .catch((error: unknown) => ports.log(`courier watch: ${String(error)}`))
      .finally(() => alongside.delete(running))
    alongside.add(running)
  }
}

/** One subscription, its events through `modules`' phases, until its stream ends or breaks or `signal` aborts. */
async function subscription<P extends EventPorts>(ports: P, modules: readonly EventModule<P>[], signal: AbortSignal, alongside: Set<Promise<void>>, connectedMs: number) {
  let following = false
  let events: AsyncIterator<HostEvent> | undefined
  let first: (() => void)[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  // The stream is surely connected at its first event, filtered or not, or `connectedMs` after subscribing.
  const connected = () => {
    clearTimeout(timer)
    for (const run of first.splice(0)) run()
  }
  const types = typesOf(modules)
  const wanted = types && new Set<string>(types)
  try {
    events = ports.event.subscribe({ signal, ...(types && { types }) })[Symbol.asyncIterator]()
    first = modules.flatMap((module) => module.followed?.() ?? [])
    if (first.length > 0) timer = setTimeout(connected, connectedMs)
    following = true
    subscribed(ports, modules, alongside)
    for await (const event of until(events, signal)) {
      connected()
      // A host that ignores `types` sends every event; none outside them reaches a module.
      if (wanted && !wanted.has(event.type)) continue
      await handleLogged(ports, modules, event)
    }
  } catch (error) {
    if (!signal.aborted) ports.log(`courier watch: event stream broke: ${String(error)}`)
  } finally {
    clearTimeout(timer)
    first = []
    if (following) for (const module of modules) module.left?.()
    // Closed without waiting: closing the adapter's stream waits on OpenCode, which may not answer
    // while a location closes, and the leave waiting for this watcher must not wait for that too.
    void events?.return?.().catch(() => {})
  }
}

/** Follows OpenCode's events through `ports`, subscribing again after `retryMs` when a subscription ends, until `signal` aborts. */
export async function follow<P extends EventPorts>(ports: P, modules: readonly EventModule<P>[], signal: AbortSignal, retryMs = RESUBSCRIBE_MS, connectedMs = CONNECTED_MS) {
  const alongside = new Set<Promise<void>>()
  while (!signal.aborted) {
    await subscription(ports, modules, signal, alongside, connectedMs)
    if (!signal.aborted) await pause(retryMs, signal)
  }
  await Promise.allSettled(alongside)
}

/**
 * Makes the hub start its subscriptions to OpenCode's events with this copy's modules, the copy loaded
 * last; `join` starts them. The second is a standby, connected before the first's member leaves.
 */
export function watchFromHub<P extends EventPorts>(hub: Pick<Hub, "subscribe">, modules: readonly EventModule<P>[], retryMs = RESUBSCRIBE_MS) {
  const types = typesOf(modules)
  hub.subscribe = (member: Member) => {
    const stop = new AbortController()
    member.log(`courier watch: following ${types ? types.join(", ") : "every event"} through ${member.directory}`)
    // A member of any copy runs them: every hub-v2 member's `watch` ports are the same shape.
    return { member, stop, done: follow(member.watch as P, modules, stop.signal, retryMs) }
  }
}
