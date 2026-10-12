import { describe, expect, test } from "bun:test"
import { follow, type EventModule, type EventPorts, type HostEvent } from "../src/platform/events.js"

/** Ports whose subscriptions yield `streams` one after another; the last one aborts `stop` once it has yielded its events. */
function ports(streams: HostEvent[][], stop: AbortController) {
  const logged: string[] = []
  let subscriptions = 0
  const eventPorts = {
    event: {
      subscribe: async function* () {
        yield* streams[subscriptions++] ?? []
        if (subscriptions >= streams.length) stop.abort()
      },
    },
    log: (message: string) => void logged.push(message),
  } as unknown as EventPorts
  return { ports: eventPorts, logged, subscriptions: () => subscriptions }
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
