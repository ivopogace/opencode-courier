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

/**
 * What a module does with OpenCode's events, by phase. For each event, every module's `handle` runs
 * in list order, the first to throw ending the phase; then, however it ended, every module's `after`.
 * Around each subscription: `followed` as it starts, returning what to run at its first event, if
 * anything; `subscribed` alongside it, which the watcher's end waits for; `left` once it has ended.
 */
export interface EventModule<P extends EventPorts> {
  readonly handle?: (ports: P, event: HostEvent) => Promise<unknown> | undefined
  readonly after?: (ports: P, event: HostEvent) => Promise<void> | undefined
  readonly followed?: () => (() => void) | undefined
  readonly subscribed?: (ports: P) => Promise<void>
  readonly left?: () => void
}

/** How long to wait before subscribing again after the event stream ended or broke. */
export const RESUBSCRIBE_MS = 5_000

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

/** One event through every module's `handle`, then, however that ended, every module's `after`. */
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

/**
 * Follows OpenCode's events through `ports` until `signal` aborts, subscribing again when the stream
 * ends or breaks, and runs each through `modules`' phases; ends after its current event.
 */
export async function follow<P extends EventPorts>(ports: P, modules: readonly EventModule<P>[], signal: AbortSignal, retryMs = RESUBSCRIBE_MS) {
  const alongside = new Set<Promise<void>>()
  while (!signal.aborted) {
    let following = false
    let events: AsyncIterator<HostEvent> | undefined
    try {
      events = ports.event.subscribe({ signal })[Symbol.asyncIterator]()
      let first = modules.flatMap((module) => module.followed?.() ?? [])
      following = true
      subscribed(ports, modules, alongside)
      for await (const event of until(events, signal)) {
        for (const run of first) run()
        first = []
        await handleLogged(ports, modules, event)
      }
    } catch (error) {
      if (!signal.aborted) ports.log(`courier watch: event stream broke: ${String(error)}`)
    } finally {
      if (following) for (const module of modules) module.left?.()
      // Closed without waiting: closing the adapter's stream waits on OpenCode, which may not answer
      // while a location closes, and the leave waiting for this watcher must not wait for that too.
      void events?.return?.().catch(() => {})
    }
    if (!signal.aborted) await pause(retryMs, signal)
  }
  await Promise.allSettled(alongside)
}

/**
 * Makes the hub start its subscriptions to OpenCode's events with this copy's modules, the copy loaded
 * last; `join` starts them. The second is a standby, connected before the first's member leaves.
 */
export function watchFromHub<P extends EventPorts>(hub: Pick<Hub, "subscribe">, modules: readonly EventModule<P>[], retryMs = RESUBSCRIBE_MS) {
  hub.subscribe = (member: Member) => {
    const stop = new AbortController()
    // A member of any copy runs them: every hub-v2 member's `watch` ports are the same shape.
    return { member, stop, done: follow(member.watch as P, modules, stop.signal, retryMs) }
  }
}
