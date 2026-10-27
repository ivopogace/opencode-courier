import { describe, expect, test } from "bun:test"
import { memoryEvents } from "../src/memory/events.js"
import type { MemoryState } from "../src/memory/ports.js"
import { personEvents } from "../src/person/events.js"
import { follow, typesOf, watchFromHub, type EventModule, type EventPorts, type EventType, type HostEvent } from "../src/platform/events.js"
import type { Hub, Member } from "../src/platform/hub.js"
import { treeEvents, waitsOn } from "../src/tree/events.js"
import { fakePorts, fresh } from "./fixtures/events.js"

/** Ports whose subscriptions yield `streams` one after another; the last one aborts `stop` once it has yielded its events. */
function ports(streams: HostEvent[][], stop: AbortController) {
  const logged: string[] = []
  const options: { types?: readonly string[]; onActivity?: () => void }[] = []
  let subscriptions = 0
  const eventPorts = {
    event: {
      subscribe: async function* (given: (typeof options)[number]) {
        options.push(given)
        yield* streams[subscriptions++] ?? []
        if (subscriptions >= streams.length) stop.abort()
      },
    },
    log: (message: string) => void logged.push(message),
  } as unknown as EventPorts
  return { ports: eventPorts, logged, options, subscriptions: () => subscriptions }
}

const event = (type: string, sessionID = "ses_a"): HostEvent => ({ type, data: { sessionID } })

/** A module recording each of its phases in `seen`, under `name`. */
function recording(name: string, seen: string[], overrides: Partial<EventModule<EventPorts>> = {}): EventModule<EventPorts> {
  return {
    handle: async (_ports, { type }) => void seen.push(`${name} handle ${type}`),
    after: async (_ports, { type }) => void seen.push(`${name} after ${type}`),
    followed: () => {
      seen.push(`${name} followed`)
      return () => void seen.push(`${name} first`)
    },
    subscribed: async () => void seen.push(`${name} subscribed`),
    left: () => void seen.push(`${name} left`),
    ...overrides,
  }
}

describe("follow", () => {
  test("runs each event through every module's handle in list order, then every module's after", async () => {
    const stop = new AbortController()
    const { ports: eventPorts } = ports([[event("one"), event("two")]], stop)
    const seen: string[] = []

    await follow(eventPorts, [recording("a", seen), recording("b", seen)], stop.signal, 1)

    expect(seen).toEqual([
      "a followed",
      "b followed",
      "a subscribed",
      "b subscribed",
      "a first",
      "b first",
      "a handle one",
      "b handle one",
      "a after one",
      "b after one",
      "a handle two",
      "b handle two",
      "a after two",
      "b after two",
      "a left",
      "b left",
    ])
  })

  test("a handle that throws ends the handle phase, not the after phase or the watch, and is logged", async () => {
    const stop = new AbortController()
    const { ports: eventPorts, logged } = ports([[event("one", "ses_x"), event("two")]], stop)
    const seen: string[] = []
    const failing = recording("a", seen, {
      handle: async (_ports, { type }) => {
        if (type === "one") throw new Error("storage gone")
        seen.push(`a handle ${type}`)
      },
    })

    await follow(eventPorts, [failing, recording("b", seen)], stop.signal, 1)

    expect(seen.filter((step) => step.includes(" one"))).toEqual(["a after one", "b after one"])
    expect(seen.filter((step) => step.includes(" two"))).toEqual(["a handle two", "b handle two", "a after two", "b after two"])
    expect(logged).toEqual(["courier watch: could not handle one of ses_x: Error: storage gone"])
  })

  test("a handle with nothing to do lets the next module's handle start at once", async () => {
    const stop = new AbortController()
    const { ports: eventPorts } = ports([[event("one")]], stop)
    const seen: string[] = []
    const idle: EventModule<EventPorts> = { handle: () => undefined }
    const second: EventModule<EventPorts> = {
      handle: () => {
        seen.push("second")
        return undefined
      },
    }

    await follow(eventPorts, [idle, second], stop.signal, 1)

    expect(seen).toEqual(["second"])
  })

  test("subscribes again after the stream ends: followed, subscribed and left each time, first only at a first event", async () => {
    const stop = new AbortController()
    const { ports: eventPorts, subscriptions } = ports([[event("one")], []], stop)
    const seen: string[] = []

    await follow(eventPorts, [recording("a", seen, { after: undefined })], stop.signal, 1)

    expect(subscriptions()).toBe(2)
    expect(seen).toEqual(["a followed", "a subscribed", "a first", "a handle one", "a left", "a followed", "a subscribed", "a left"])
  })

  test("its end waits for what subscribed started, and logs a failure of it", async () => {
    const stop = new AbortController()
    const { ports: eventPorts, logged } = ports([], stop)
    let release = () => {}
    let ended = false
    const slow: EventModule<EventPorts> = {
      subscribed: () =>
        new Promise<void>((_resolve, reject) => {
          release = () => reject(new Error("list gone"))
        }),
    }

    const done = follow(eventPorts, [slow], stop.signal, 1).then(() => (ended = true))
    await Bun.sleep(5)
    expect(ended).toBe(false)
    release()
    await done

    expect(logged).toEqual(["courier watch: Error: list gone"])
  })
})

describe("the event types a subscription asks for", () => {
  const declaring = (name: string, seen: string[], types: readonly EventType[]) => recording(name, seen, { types })

  test("is the union of the modules' declared types, sorted, each once, on every subscription", async () => {
    const stop = new AbortController()
    const { ports: eventPorts, options } = ports([[], []], stop)
    const modules = [declaring("a", [], ["session.inbox.enqueued", "form.created"]), declaring("b", [], ["form.created", "session.deleted"])]

    await follow(eventPorts, modules, stop.signal, 1)

    expect(options.map((given) => given.types)).toEqual([
      ["form.created", "session.deleted", "session.inbox.enqueued"],
      ["form.created", "session.deleted", "session.inbox.enqueued"],
    ])
    expect(typesOf([...modules].reverse())).toEqual(typesOf(modules))
  })

  test("is every event once one module declares none, as one of another copy may not", async () => {
    const stop = new AbortController()
    const { ports: eventPorts, options } = ports([[]], stop)

    await follow(eventPorts, [declaring("a", [], ["form.created"]), recording("b", [])], stop.signal, 1)

    expect(options).toHaveLength(1)
    expect(options[0]).not.toHaveProperty("types")
  })

  test("an event outside the union reaches no module, from a host that sends it anyway", async () => {
    const stop = new AbortController()
    const { ports: eventPorts } = ports([[event("session.text.delta"), event("form.created"), event("session.tool.called")]], stop)
    const seen: string[] = []

    await follow(eventPorts, [declaring("a", seen, ["form.created"]), declaring("b", seen, ["session.deleted"])], stop.signal, 1)

    expect(seen.filter((line) => line.includes("handle") || line.includes("after"))).toEqual([
      "a handle form.created",
      "b handle form.created",
      "a after form.created",
      "b after form.created",
    ])
  })

  test("a module's first-event hook runs at the stream's first activity, before the first event let through", async () => {
    const stop = new AbortController()
    const seen: string[] = []
    const eventPorts = {
      event: {
        subscribe: async function* (given: { onActivity: () => void }) {
          await Bun.sleep(1)
          seen.push("keepalive")
          given.onActivity()
          yield event("form.created")
          stop.abort()
        },
      },
      log: () => {},
    } as unknown as EventPorts

    await follow(eventPorts, [declaring("a", seen, ["form.created"])], stop.signal, 1)

    expect(seen).toEqual(["a followed", "a subscribed", "keepalive", "a first", "a handle form.created", "a after form.created", "a left"])
  })

  test("the plugin's modules ask for what they dispatch on, the turn's start and its inbox for the missed wake included", async () => {
    const stopping = new AbortController()
    const { ports: watchPorts, options } = fakePorts([[]])
    ;(watchPorts as any).log = () => stopping.abort()
    const state = fresh()
    const modules = [treeEvents(state, waitsOn()), personEvents(state as never), memoryEvents({} as MemoryState)]

    await follow(watchPorts, modules as EventModule<typeof watchPorts>[], stopping.signal, 1)

    expect(options[0]?.types).toEqual([
      "form.cancelled",
      "form.created",
      "form.replied",
      "location.shutdown",
      "permission.asked",
      "permission.replied",
      "session.deleted",
      "session.execution.failed",
      "session.execution.interrupted",
      "session.execution.started",
      "session.execution.succeeded",
      "session.inbox.cancelled",
      "session.inbox.delivered",
      "session.inbox.enqueued",
    ])
    // The live suite's probe follows the same types, and checks the courier asks for them.
    const live = (await Bun.file(new URL("../e2e/run.sh", import.meta.url)).text()).match(/^COURIER_TYPES='(.*)'$/m)?.[1]
    expect(JSON.parse(live ?? "null")).toEqual(options[0]?.types)
  })

  test("the hub's subscription and its standby ask for the same types, and log them with their location", async () => {
    const hub = {} as Pick<Hub, "subscribe">
    const logged: string[] = []
    const subscribedWith: unknown[] = []
    const member = (directory: string) =>
      ({
        directory,
        log: (line: string) => void logged.push(line),
        watch: {
          event: {
            subscribe: async function* (given: { types?: readonly string[] }) {
              subscribedWith.push(given.types)
            },
          },
          log: () => {},
        },
      }) as unknown as Member

    watchFromHub(hub, [declaring("a", [], ["session.deleted", "form.created"])], 1)
    const watchers = [hub.subscribe!(member("/a")), hub.subscribe!(member("/b"))]
    for (const watcher of watchers) watcher.stop.abort()
    await Promise.all(watchers.map((watcher) => watcher.done))

    expect(subscribedWith).toEqual([
      ["form.created", "session.deleted"],
      ["form.created", "session.deleted"],
    ])
    expect(logged).toEqual(["courier watch: following form.created, session.deleted through /a", "courier watch: following form.created, session.deleted through /b"])
  })

  test("a type OpenCode does not publish, or server.connected, does not compile", () => {
    // @ts-expect-error: not one of OpenCode's event types
    const typo: readonly EventType[] = ["session.text.deltas"]
    // @ts-expect-error: a plugin never receives it, so it cannot be asked for
    const connected: readonly EventType[] = ["server.connected"]
    expect([typo, connected]).toHaveLength(2)
  })
})
