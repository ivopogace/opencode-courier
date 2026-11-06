import type { Plugin } from "@opencode/plugin"
import type { Hub, Member } from "./hub.js"

export interface HostEvent {
  readonly type: string
  readonly data?: unknown
}

export interface EventPorts {
  readonly event: Pick<Plugin.Context["event"], "subscribe">
  readonly log: (message: string) => void
}

// a plugin never receives server.connected (api-notes)
export type EventType = NonNullable<NonNullable<Parameters<EventPorts["event"]["subscribe"]>[0]>["types"]>[number]

export interface EventModule<P extends EventPorts> {
  readonly types?: readonly EventType[]
  readonly handle?: (ports: P, event: HostEvent) => Promise<unknown> | undefined
  readonly after?: (ports: P, event: HostEvent) => Promise<void> | undefined
  readonly followed?: () => (() => void) | undefined
  readonly subscribed?: (ports: P) => Promise<void>
  readonly left?: () => void
}

export const RESUBSCRIBE_MS = 5_000

// a plugin's event stream never says it connected (api-notes)
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

const until = <T>(events: AsyncIterator<T>, signal: AbortSignal): AsyncIterable<T> => ({
  [Symbol.asyncIterator]: () => ({
    next: () =>
      new Promise<IteratorResult<T>>((resolve, reject) => {
        if (signal.aborted) return resolve(ENDED)
        const stop = () => resolve(ENDED)
        signal.addEventListener("abort", stop, { once: true })
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

export function typesOf(modules: readonly EventModule<never>[]): EventType[] | undefined {
  const types = new Set<EventType>()
  for (const module of modules) {
    if (!module.types) return undefined
    for (const type of module.types) types.add(type)
  }
  return [...types].sort((a, b) => Number(a > b) - Number(a < b))
}

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

function handleLogged<P extends EventPorts>(ports: P, modules: readonly EventModule<P>[], event: HostEvent) {
  return handle(ports, modules, event).catch((error: unknown) => {
    const data = event.data as { sessionID?: string; form?: { sessionID?: string } } | undefined
    const sessionID = data?.sessionID ?? data?.form?.sessionID
    ports.log(`courier watch: could not handle ${event.type} of ${sessionID}: ${String(error)}`)
  })
}

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

async function subscription<P extends EventPorts>(ports: P, modules: readonly EventModule<P>[], signal: AbortSignal, alongside: Set<Promise<void>>, connectedMs: number) {
  let following = false
  let events: AsyncIterator<HostEvent> | undefined
  let first: (() => void)[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
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
      // a host may ignore the types filter (api-notes)
      if (wanted && !wanted.has(event.type)) continue
      await handleLogged(ports, modules, event)
    }
  } catch (error) {
    if (!signal.aborted) ports.log(`courier watch: event stream broke: ${String(error)}`)
  } finally {
    clearTimeout(timer)
    first = []
    if (following) for (const module of modules) module.left?.()
    // not awaited: closing waits on OpenCode, stuck while a location closes
    void events?.return?.().catch(() => {})
  }
}

export async function follow<P extends EventPorts>(ports: P, modules: readonly EventModule<P>[], signal: AbortSignal, retryMs = RESUBSCRIBE_MS, connectedMs = CONNECTED_MS) {
  const alongside = new Set<Promise<void>>()
  while (!signal.aborted) {
    await subscription(ports, modules, signal, alongside, connectedMs)
    if (!signal.aborted) await pause(retryMs, signal)
  }
  await Promise.allSettled(alongside)
}

export function watchFromHub<P extends EventPorts>(hub: Pick<Hub, "subscribe">, modules: readonly EventModule<P>[], retryMs = RESUBSCRIBE_MS) {
  const types = typesOf(modules)
  hub.subscribe = (member: Member) => {
    const stop = new AbortController()
    member.log(`courier watch: following ${types ? types.join(", ") : "every event"} through ${member.directory}`)
    return { member, stop, done: follow(member.watch as P, modules, stop.signal, retryMs) }
  }
}
