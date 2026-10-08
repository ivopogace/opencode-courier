import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { hostname } from "node:os"
import { join as joinPath } from "node:path"
import {
  HUB_KEY,
  HUB_VERSION,
  OWNER_EXPIRY_MS,
  OWNER_KEY,
  OWNER_RENEW_MS,
  OWNER_WAIT_MS,
  SERVER,
  hub,
  join,
  open,
  permissions,
  resetHub,
  type Member,
  type Timers,
} from "../src/hub.js"
import { TICK_MS, type LaterEntry, type LaterPorts } from "../src/later.js"

const LEGACY = ["claimed", "watched", "forms", "questions", "receiver", "locations"]
const at = (registry: Record<symbol, unknown>, key: string) => registry[Symbol.for(key)]

/** Scheduler ports over `store`, recording the deliveries made through them under `directory`. */
function laterPorts(
  directory: string,
  store = new Map<string, unknown>(),
  delivered: string[] = [],
  now: () => number = () => 1_000,
): LaterPorts {
  return {
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
    } as unknown as LaterPorts["storage"],
    session: {
      synthetic: async (input: { metadata: { scheduled: string } }) => {
        delivered.push(`${directory} ${input.metadata.scheduled}`)
        return { id: "msg_1" }
      },
    } as unknown as LaterPorts["session"],
    now,
    newID: () => "later_new",
    log: () => {},
  }
}

const member = (directory: string, log: (message: string) => void = () => {}, later = laterPorts(directory)): Member =>
  ({
    directory,
    permission: { list: async () => [], reply: async () => {} },
    later,
    watch: {},
    questions: {},
    log,
  }) as unknown as Member

// These members carry no ports to follow OpenCode's events through, so the process's hub starts no
// subscription while they are joined, whichever test file set its watcher before.
let subscribe: typeof hub.subscribe
beforeEach(() => {
  subscribe = hub.subscribe
  hub.subscribe = undefined
})
afterEach(() => {
  resetHub()
  hub.subscribe = subscribe
})

describe("the hub", () => {
  test("is kept under its key on globalThis, with the claim sets under the keys of the copies before the hub", () => {
    expect(hub.version).toBe(HUB_VERSION)
    expect(at(globalThis, HUB_KEY)).toBe(hub)
    expect(at(globalThis, "opencode-courier.claimed")).toBe(hub.claimed)
    expect(at(globalThis, "opencode-courier.watched")).toBe(hub.watched)
    expect(at(globalThis, "opencode-courier.forms")).toBe(hub.forms)
    expect(at(globalThis, "opencode-courier.questions")).toBe(hub.questions)
    expect(at(globalThis, "opencode-courier.receiver")).toBe(hub.receivers)
    expect(at(globalThis, "opencode-courier.locations")).toBe(hub.locations)
  })

  test("join adds an instance and its permission domain, and its leave takes both out", () => {
    const a = member("/a")
    const b = member("/b")
    const leaveA = join(a)
    const leaveB = join(b)

    expect([...hub.members]).toEqual([a, b])
    expect([...permissions()]).toEqual([a.permission, b.permission])

    leaveA()
    expect([...hub.members]).toEqual([b])
    expect([...permissions()]).toEqual([b.permission])
    leaveB()
    expect(hub.members.size).toBe(0)
    expect(hub.locations.size).toBe(0)
  })

  test("of the same version is found by the next copy, which joins the same one", () => {
    const registry: Record<symbol, unknown> = {}
    const first = open(registry)
    const second = open(registry)
    expect(second.hub).toBe(first.hub)
    expect(at(registry, HUB_KEY)).toBe(first.hub)
    const leave = second.join(member("/a"))
    expect(first.hub.members.size).toBe(1)
    leave()
    expect(first.hub.members.size).toBe(0)
  })

  test("takes the objects of a copy before the hub, loaded first, fills in the fields it lacks, and makes the missing ones", () => {
    const claimed = new Set(["later_1"])
    const watched = { seen: new Set(["evt_1"]), waiting: new Set<string>(), answered: new Set<string>() }
    const questions = { questions: new Map(), noticed: new Set(["question_1"]) }
    const locations = new Map()
    const registry: Record<symbol, unknown> = {
      [Symbol.for("opencode-courier.claimed")]: claimed,
      [Symbol.for("opencode-courier.watched")]: watched,
      [Symbol.for("opencode-courier.questions")]: questions,
      [Symbol.for("opencode-courier.locations")]: locations,
    }

    const { hub: fresh, join: joinFresh } = open(registry)

    expect(at(registry, HUB_KEY)).toBe(fresh)
    expect(fresh.claimed).toBe(claimed)
    expect(fresh.watched).toBe(watched)
    expect(fresh.questions).toBe(questions as never)
    expect(fresh.questions.noticed.has("question_1")).toBe(true)
    expect(fresh.questions.loaded).toBeInstanceOf(Set)
    expect(fresh.questions.following).toBe(0)
    expect(fresh.questions.followed).toBe(false)
    // The ones the earlier copy did not make are made, under their keys, for the copies after.
    expect(at(registry, "opencode-courier.forms")).toBe(fresh.forms)
    expect(at(registry, "opencode-courier.receiver")).toBe(fresh.receivers)
    for (const name of LEGACY) expect(at(registry, `opencode-courier.${name}`)).toBeDefined()

    const leave = joinFresh(member("/a"))
    expect(locations.size).toBe(1)
    leave()
    expect(locations.size).toBe(0)
  })

  test("of another version found under its key is logged once, and the copy keeps its own, sharing the claim sets", () => {
    const other = { version: HUB_VERSION + 1 }
    // The other copy's claim set, under the key every copy shares.
    const claimed = new Set(["later_1"])
    const registry: Record<symbol, unknown> = { [Symbol.for(HUB_KEY)]: other, [Symbol.for("opencode-courier.claimed")]: claimed }

    const skewed = open(registry)
    expect(at(registry, HUB_KEY)).toBe(other)
    expect(at(registry, `${HUB_KEY}@${HUB_VERSION}`)).toBe(skewed.hub)
    expect(skewed.hub.version).toBe(HUB_VERSION)
    // The claim set is the one every copy claims in, so an older copy and this one never both act.
    expect(skewed.hub.claimed).toBe(claimed)

    const logs: string[] = []
    const leaveA = skewed.join(member("/a", (message) => logs.push(message)))
    const leaveB = skewed.join(member("/b", (message) => logs.push(message)))
    // A second copy of the same version finds the same versioned hub, which has logged already.
    const again = open(registry)
    expect(again.hub).toBe(skewed.hub)
    const leaveC = again.join(member("/c", (message) => logs.push(message)))
    expect(logs).toEqual([
      `courier: another copy of the plugin with hub version ${HUB_VERSION + 1} has been loaded in this process; ` +
        `this copy (hub version ${HUB_VERSION}) keeps its own under ${HUB_KEY}@${HUB_VERSION} and shares the claim sets with it`,
    ])
    expect(skewed.hub.members.size).toBe(3)
    for (const leave of [leaveA, leaveB, leaveC]) leave()
    expect(skewed.hub.members.size).toBe(0)
  })

  test("found as null under its key counts as none", () => {
    const registry: Record<symbol, unknown> = { [Symbol.for(HUB_KEY)]: null }
    const opened = open(registry)
    expect(at(registry, HUB_KEY)).toBe(opened.hub)
    const logs: string[] = []
    const leave = opened.join(member("/a", (message) => logs.push(message)))
    expect(logs).toEqual([])
    leave()
  })

  test("is shared by two copies of the module in one process", () => {
    // In a process of its own, since a second copy would replace this one's coverage (see the script).
    const run = Bun.spawnSync([process.execPath, joinPath(import.meta.dir, "fixtures", "two-copies.ts")])
    expect(run.stderr.toString()).toBe("")
    expect(JSON.parse(run.stdout.toString())).toEqual({
      sameHub: true,
      separateModules: true,
      joined: { members: ["/a", "/b"], permissions: 2 },
      oneLoop: true,
      afterLeave: ["/b"],
      loopKept: true,
      emptyAtEnd: true,
      skewedOwnLoop: true,
      // One tick as the shared loop started, through the first copy's instance, and one as the skewed hub's did.
      ownerReads: ["/a", "/c"],
      skewedOwnHub: true,
      skewedSharesClaims: true,
      logs: 1,
    })
  })

  test("resetHub forgets the remembered ids and the question relay's state, not the joined instances", () => {
    const leave = join(member("/a"))
    hub.claimed.add("later_1")
    hub.watched.seen.add("evt_1")
    hub.watched.waiting.add("per_1")
    hub.watched.answered.add("per_2")
    hub.forms.told.set("form_1", Promise.resolve())
    hub.forms.settled.add("form_2")
    hub.questions.noticed.add("question_1")
    hub.questions.answered.add("question_2")
    hub.questions.shutdowns.set("/a", 1)
    hub.questions.following = 2
    hub.questions.followed = true

    resetHub()

    expect(hub.claimed.size + hub.watched.seen.size + hub.watched.waiting.size + hub.watched.answered.size).toBe(0)
    expect(hub.forms.told.size + hub.forms.settled.size).toBe(0)
    expect(hub.questions.noticed.size + hub.questions.answered.size + hub.questions.shutdowns.size).toBe(0)
    expect(hub.questions.following).toBe(0)
    expect(hub.questions.followed).toBe(false)
    expect(hub.members.size).toBe(1)
    leave()
  })
})

/**
 * Timers the test fires by hand, recording what was started and stopped and how long each wait
 * before re-reading the owner key was; a wait ends at once, or, with `held`, when `go` is called.
 */
function fakeTimers(held = false) {
  const started: Array<{ run: () => void; ms: number }> = []
  const stopped: unknown[] = []
  const waits: number[] = []
  const pending: Array<() => void> = []
  const timers: Timers = {
    every: (run, ms) => (started.push({ run, ms }), started.length),
    stop: (timer) => void stopped.push(timer),
    wait: (ms) => (waits.push(ms), held ? new Promise((resolve) => pending.push(resolve)) : Promise.resolve()),
  }
  const go = () => {
    for (const resolve of pending.splice(0)) resolve()
  }
  return { timers, started, stopped, waits, go, fire: () => started.at(-1)!.run() }
}

const due = (id: string): LaterEntry => ({ id, sessionID: "ses_parent", from: "ses_parent", message: "wake", fireAt: 1, createdAt: 0 })
const settle = () => Bun.sleep(1)

describe("the scheduler", () => {
  test("runs one loop for several instances, through the first one loaded, with a tick as it starts", async () => {
    const { timers, started, fire } = fakeTimers()
    const { join: joinHub } = open({}, timers)
    const store = new Map<string, unknown>([["later/later_1", due("later_1")]])
    const delivered: string[] = []
    const leaves = ["/a", "/b", "/c"].map((directory) => joinHub(member(directory, () => {}, laterPorts(directory, store, delivered))))

    expect(started.map((timer) => timer.ms)).toEqual([TICK_MS])
    await settle()
    expect(delivered).toEqual(["/a later_1"])

    store.set("later/later_2", due("later_2"))
    fire()
    await settle()
    expect(delivered).toEqual(["/a later_1", "/a later_2"])
    expect([...store.keys()]).toEqual([OWNER_KEY])
    for (const leave of leaves) leave()
  })

  test("hands the loop over to the next instance when the one it runs through leaves", async () => {
    const { timers, started, stopped, fire } = fakeTimers()
    const { join: joinHub } = open({}, timers)
    const store = new Map<string, unknown>()
    const delivered: string[] = []
    const leaveA = joinHub(member("/a", () => {}, laterPorts("/a", store, delivered)))
    const leaveB = joinHub(member("/b", () => {}, laterPorts("/b", store, delivered)))
    await settle()

    leaveA()
    store.set("later/later_1", due("later_1"))
    fire()
    await settle()

    expect(delivered).toEqual(["/b later_1"])
    expect(started).toHaveLength(1)
    expect(stopped).toEqual([])
    leaveB()
  })

  test("stops after the last instance leaves, and starts again, with a tick, when one joins", async () => {
    const { timers, started, stopped } = fakeTimers()
    const { hub: fresh, join: joinHub } = open({}, timers)
    const store = new Map<string, unknown>()
    const delivered: string[] = []
    const leaveA = joinHub(member("/a", () => {}, laterPorts("/a", store, delivered)))
    const leaveB = joinHub(member("/b", () => {}, laterPorts("/b", store, delivered)))
    await settle()

    leaveA()
    expect(stopped).toEqual([])
    leaveB()
    expect(stopped).toEqual([1])
    expect(fresh.scheduler.timer).toBeUndefined()
    // A leave called again does not stop it twice.
    leaveB()
    expect(stopped).toEqual([1])

    store.set("later/later_1", due("later_1"))
    const leaveC = joinHub(member("/c", () => {}, laterPorts("/c", store, delivered)))
    await settle()
    expect(started).toHaveLength(2)
    expect(delivered).toEqual(["/c later_1"])
    leaveC()
    expect(stopped).toEqual([1, 2])
  })

  test("skips a tick while the last one is still under way", async () => {
    const { timers, fire } = fakeTimers()
    const { join: joinHub } = open({}, timers)
    let scans = 0
    let release = () => {}
    const later = laterPorts("/a")
    const slow: LaterPorts = {
      ...later,
      storage: { ...later.storage, scan: () => (scans++, new Promise((resolve) => (release = () => resolve({ entries: [] } as never)))) },
    }
    const leave = joinHub(member("/a", () => {}, slow))

    fire()
    fire()
    await settle()
    expect(scans).toBe(1)
    release()
    await settle()
    fire()
    await settle()
    expect(scans).toBe(2)
    release()
    leave()
  })

  test("does not wait on a tick through an instance that has left, so a new loop ticks at once", async () => {
    const { timers, fire } = fakeTimers()
    const { join: joinHub } = open({}, timers)
    const later = laterPorts("/a")
    // A tick through /a that never ends, as through an instance whose location has shut down.
    const hung: LaterPorts = { ...later, storage: { ...later.storage, scan: () => new Promise(() => {}) } }
    const store = new Map<string, unknown>([["later/later_1", due("later_1")]])
    const delivered: string[] = []
    const leaveA = joinHub(member("/a", () => {}, hung))
    const leaveB = joinHub(member("/b", () => {}, laterPorts("/b", store, delivered)))
    fire()
    await settle()
    expect(delivered).toEqual([])

    leaveA()
    fire()
    await settle()
    expect(delivered).toEqual(["/b later_1"])

    // And once every instance has left, the next to join ticks at once, the hung tick notwithstanding.
    const leaveC = joinHub(member("/c", () => {}, hung))
    leaveB()
    leaveC()
    store.set("later/later_2", due("later_2"))
    const leaveD = joinHub(member("/d", () => {}, laterPorts("/d", store, delivered)))
    await settle()
    expect(delivered).toEqual(["/b later_1", "/d later_2"])
    leaveD()
  })

  test("ticks with the code of the copy that joined last", () => {
    const registry: Record<symbol, unknown> = {}
    const { timers } = fakeTimers()
    const first = open(registry, timers)
    const leaveA = first.join(member("/a"))
    const firstTick = first.hub.scheduler.tick
    const second = open(registry, timers)
    const leaveB = second.join(member("/b"))
    expect(second.hub).toBe(first.hub)
    expect(first.hub.scheduler.tick).toBeFunction()
    expect(first.hub.scheduler.tick).not.toBe(firstTick)
    leaveA()
    leaveB()
  })

  test("logs a failed tick through the instance it ran through, and carries on", async () => {
    const { timers, fire } = fakeTimers()
    const { join: joinHub } = open({}, timers)
    const logs: string[] = []
    const later = laterPorts("/a")
    let fail = true
    const failing: LaterPorts = {
      ...later,
      storage: {
        ...later.storage,
        scan: async (input: never) => {
          if (fail) throw new Error("storage gone")
          return later.storage.scan(input)
        },
      } as LaterPorts["storage"],
    }
    const leave = joinHub(member("/a", (message) => logs.push(message), failing))
    await settle()
    expect(logs).toEqual(["courier_later scheduler: Error: storage gone"])

    fail = false
    fire()
    await settle()
    expect(logs).toHaveLength(1)
    leave()
  })
})

describe("the owner key", () => {
  test("is taken with a wait on the first tick, then renewed every tick without one", async () => {
    const { timers, waits, fire } = fakeTimers()
    const { join: joinHub } = open({}, timers, "server_a")
    let now = 1_000
    const store = new Map<string, unknown>()
    const delivered: string[] = []
    const leave = joinHub(member("/a", () => {}, laterPorts("/a", store, delivered, () => now)))
    await settle()
    expect(store.get(OWNER_KEY)).toEqual({ server: "server_a", at: 1_000 })
    expect(waits).toHaveLength(1)
    expect(waits[0]).toBeGreaterThanOrEqual(OWNER_WAIT_MS)
    expect(waits[0]).toBeLessThan(2 * OWNER_WAIT_MS)

    now += TICK_MS
    store.set("later/later_1", due("later_1"))
    fire()
    await settle()
    expect(store.get(OWNER_KEY)).toEqual({ server: "server_a", at: 1_000 + TICK_MS })
    expect(waits).toHaveLength(1)
    expect(delivered).toEqual(["/a later_1"])
    leave()
  })

  test("held fresh by another server keeps this one from delivering, until it expires", async () => {
    const { timers, waits, fire } = fakeTimers()
    const { join: joinHub } = open({}, timers, "server_a")
    let now = 1_000
    const store = new Map<string, unknown>([
      [OWNER_KEY, { server: "server_b", at: 1_000 }],
      ["later/later_1", due("later_1")],
    ])
    const delivered: string[] = []
    const leave = joinHub(member("/a", () => {}, laterPorts("/a", store, delivered, () => now)))
    await settle()
    now = 1_000 + OWNER_EXPIRY_MS - 1
    fire()
    await settle()
    expect(delivered).toEqual([])
    expect(waits).toEqual([])
    expect(store.get(OWNER_KEY)).toEqual({ server: "server_b", at: 1_000 })

    now = 1_000 + OWNER_EXPIRY_MS
    fire()
    await settle()
    expect(store.get(OWNER_KEY)).toEqual({ server: "server_a", at: now })
    expect(waits).toHaveLength(1)
    expect(delivered).toEqual(["/a later_1"])
    leave()
  })

  test("written by two servers ticking in step is held by the one that wrote last, and only it delivers", async () => {
    const store = new Map<string, unknown>([["later/later_1", due("later_1")]])
    const delivered: string[] = []
    const a = fakeTimers(true)
    const b = fakeTimers(true)
    const leaveA = open({}, a.timers, "server_a").join(member("/a", () => {}, laterPorts("/a", store, delivered)))
    const leaveB = open({}, b.timers, "server_b").join(member("/b", () => {}, laterPorts("/b", store, delivered)))
    await settle()
    // Both read the key free and wrote it before either read it back.
    expect(a.waits).toHaveLength(1)
    expect(b.waits).toHaveLength(1)
    a.go()
    b.go()
    await settle()
    expect(delivered).toEqual(["/b later_1"])

    store.set("later/later_2", due("later_2"))
    a.fire()
    b.fire()
    await settle()
    expect(delivered).toEqual(["/b later_1", "/b later_2"])
    expect(store.get(OWNER_KEY)).toEqual({ server: "server_b", at: 1_000 })
    leaveA()
    leaveB()
  })

  test("of this server, older than the renewal limit, is taken again with a wait, and lost to a server that wrote meanwhile", async () => {
    const { timers, waits, go, fire } = fakeTimers(true)
    const { join: joinHub } = open({}, timers, "server_a")
    const store = new Map<string, unknown>([["later/later_1", due("later_1")]])
    const delivered: string[] = []
    const now = 1_000 + OWNER_RENEW_MS
    store.set(OWNER_KEY, { server: "server_a", at: 1_000 })
    const leave = joinHub(member("/a", () => {}, laterPorts("/a", store, delivered, () => now)))
    await settle()
    expect(waits).toHaveLength(1)
    store.set(OWNER_KEY, { server: "server_b", at: now })
    go()
    await settle()
    expect(delivered).toEqual([])

    // A key just renewed is renewed again without a wait.
    store.set(OWNER_KEY, { server: "server_a", at: now - OWNER_RENEW_MS + 1 })
    fire()
    await settle()
    expect(waits).toHaveLength(1)
    expect(delivered).toEqual(["/a later_1"])
    leave()
  })

  test("written in the future, after the clock went back, holds no longer than the expiry", async () => {
    const { timers } = fakeTimers()
    const { join: joinHub } = open({}, timers, "server_a")
    const store = new Map<string, unknown>([
      [OWNER_KEY, { server: "server_b", at: 1_000 + OWNER_EXPIRY_MS }],
      ["later/later_1", due("later_1")],
    ])
    const delivered: string[] = []
    const leave = joinHub(member("/a", () => {}, laterPorts("/a", store, delivered)))
    await settle()
    expect(delivered).toEqual(["/a later_1"])
    leave()
  })

  test("that is not an owner record counts as free", async () => {
    const { timers } = fakeTimers()
    const { join: joinHub } = open({}, timers, "server_a")
    const store = new Map<string, unknown>([
      [OWNER_KEY, { server: 7, at: 1_000 }],
      ["later/later_1", due("later_1")],
    ])
    const delivered: string[] = []
    const leave = joinHub(member("/a", () => {}, laterPorts("/a", store, delivered)))
    await settle()
    expect(delivered).toEqual(["/a later_1"])
    leave()
  })

  test("is released when the last instance leaves, so another server takes over at its next tick", async () => {
    const { timers } = fakeTimers()
    const { join: joinHub } = open({}, timers, "server_a")
    const store = new Map<string, unknown>()
    const leaveA = joinHub(member("/a", () => {}, laterPorts("/a", store)))
    const leaveB = joinHub(member("/b", () => {}, laterPorts("/b", store)))
    await settle()
    leaveA()
    await settle()
    expect(store.get(OWNER_KEY)).toEqual({ server: "server_a", at: 1_000 })
    leaveB()
    await settle()
    expect(store.has(OWNER_KEY)).toBe(false)
  })

  test("is renewed by the ticks that fall due while a tick is still delivering, for a minute from its start", async () => {
    const { timers, fire } = fakeTimers()
    const { join: joinHub } = open({}, timers, "server_a")
    let now = 1_000
    const store = new Map<string, unknown>()
    const later = laterPorts("/a", store, [], () => now)
    // A delivery that does not end, as one held up by a slow session.
    const slow: LaterPorts = { ...later, storage: { ...later.storage, scan: () => new Promise(() => {}) } }
    const leave = joinHub(member("/a", () => {}, slow))
    await settle()
    expect(store.get(OWNER_KEY)).toEqual({ server: "server_a", at: 1_000 })

    for (const step of [1, 2, 3]) {
      now = 1_000 + step * TICK_MS
      fire()
      await settle()
      expect(store.get(OWNER_KEY)).toEqual({ server: "server_a", at: now })
    }
    // A minute after the tick started it is taken to hang, and the key is left to expire.
    now = 1_000 + OWNER_EXPIRY_MS
    fire()
    await settle()
    expect(store.get(OWNER_KEY)).toEqual({ server: "server_a", at: 1_000 + 3 * TICK_MS })
    void leave()
  })

  test("held by another server is not renewed by a tick still delivering", async () => {
    const { timers, fire } = fakeTimers()
    const { join: joinHub } = open({}, timers, "server_a")
    let now = 1_000
    const store = new Map<string, unknown>()
    const later = laterPorts("/a", store, [], () => now)
    const slow: LaterPorts = { ...later, storage: { ...later.storage, scan: () => new Promise(() => {}) } }
    const leave = joinHub(member("/a", () => {}, slow))
    await settle()
    store.set(OWNER_KEY, { server: "server_b", at: 1_000 })
    now += TICK_MS
    fire()
    await settle()
    expect(store.get(OWNER_KEY)).toEqual({ server: "server_b", at: 1_000 })
    void leave()
  })

  test("is left by a last leave during a delivery to the tick, which releases it when it ends", async () => {
    const { timers, go } = fakeTimers(true)
    const { join: joinHub } = open({}, timers, "server_a")
    const store = new Map<string, unknown>([["later/later_1", due("later_1")]])
    const later = laterPorts("/a", store)
    let finish = () => {}
    const slow: LaterPorts = {
      ...later,
      session: { synthetic: () => new Promise((resolve) => (finish = () => resolve({ id: "msg_1" } as never))) } as never,
    }
    const leave = joinHub(member("/a", () => {}, slow))
    await settle()
    // The first tick's wait before reading the key back; the leave's own wait is never let go.
    go()
    await settle()
    let left = false
    void leave().then(() => (left = true))
    await settle()
    // Still delivering: the key stays, so no other server takes the message meanwhile.
    expect(store.get(OWNER_KEY)).toEqual({ server: "server_a", at: 1_000 })
    expect(left).toBe(false)
    finish()
    await settle()
    expect(store.has(OWNER_KEY)).toBe(false)
    expect(store.has("later/later_1")).toBe(false)
    expect(left).toBe(true)
  })

  test("is not released while a hub of another version in the process has instances", async () => {
    const { timers } = fakeTimers()
    const registry: Record<symbol, unknown> = { [Symbol.for(HUB_KEY)]: { version: HUB_VERSION + 1, members: new Set([{}]) } }
    const { join: joinHub } = open(registry, timers, "server_a")
    const store = new Map<string, unknown>()
    const leave = joinHub(member("/a", () => {}, laterPorts("/a", store)))
    await settle()
    await leave()
    expect(store.get(OWNER_KEY)).toEqual({ server: "server_a", at: 1_000 })
  })

  test("is kept when an instance joins again while it is being released", async () => {
    const { timers } = fakeTimers()
    const { join: joinHub } = open({}, timers, "server_a")
    const store = new Map<string, unknown>()
    const leaveA = joinHub(member("/a", () => {}, laterPorts("/a", store)))
    await settle()
    void leaveA()
    const leaveB = joinHub(member("/b", () => {}, laterPorts("/b", store)))
    await settle()
    expect(store.get(OWNER_KEY)).toEqual({ server: "server_a", at: 1_000 })
    void leaveB()
  })

  test("the last leave settles once it is released", async () => {
    const { timers, go } = fakeTimers(true)
    const { join: joinHub } = open({}, timers, "server_a")
    const store = new Map<string, unknown>([[OWNER_KEY, { server: "server_a", at: 1_000 }]])
    const leave = joinHub(member("/a", () => {}, laterPorts("/a", store)))
    await settle()
    // The first tick renews its own fresh key without a wait; the leave's wait is never let go.
    await leave()
    expect(store.has(OWNER_KEY)).toBe(false)
    go()
  })

  test("held by another server is left alone when the last instance leaves", async () => {
    const { timers } = fakeTimers()
    const { join: joinHub } = open({}, timers, "server_a")
    const store = new Map<string, unknown>([[OWNER_KEY, { server: "server_b", at: 1_000 }]])
    const leave = joinHub(member("/a", () => {}, laterPorts("/a", store)))
    await settle()
    leave()
    await settle()
    expect(store.get(OWNER_KEY)).toEqual({ server: "server_b", at: 1_000 })
  })

  test("written by a tick whose loop stopped during its wait is released, and nothing is delivered", async () => {
    const { timers, go } = fakeTimers(true)
    const { join: joinHub } = open({}, timers, "server_a")
    const store = new Map<string, unknown>([["later/later_1", due("later_1")]])
    const delivered: string[] = []
    const leave = joinHub(member("/a", () => {}, laterPorts("/a", store, delivered)))
    await settle()
    leave()
    await settle()
    go()
    await settle()
    expect(delivered).toEqual([])
    expect(store.has(OWNER_KEY)).toBe(false)
  })

  test("a failure to release it is logged", async () => {
    const { timers } = fakeTimers()
    const { join: joinHub } = open({}, timers, "server_a")
    const logs: string[] = []
    const later = laterPorts("/a")
    const failing: LaterPorts = {
      ...later,
      storage: { ...later.storage, remove: async () => Promise.reject(new Error("storage gone")) } as LaterPorts["storage"],
    }
    const leave = joinHub(member("/a", (message) => logs.push(message), failing))
    await settle()
    leave()
    await settle()
    expect(logs).toEqual(["courier_later scheduler: owner key not released: Error: storage gone"])
  })

  test("names this server by host, process and the process's start, the same for every copy", () => {
    expect(SERVER).toBe(`${hostname()}:${process.pid}:${performance.timeOrigin}`)
  })
})

test("hub.ts is the only module of src/ that keeps anything process-wide", () => {
  const src = joinPath(import.meta.dir, "..", "src")
  const users = readdirSync(src, { recursive: true, encoding: "utf8" }).filter(
    (file) => file.endsWith(".ts") && file !== "storage.ts" && /\bprocessWide\s*[(<]|Symbol\.for\s*\(|globalThis/.test(readFileSync(joinPath(src, file), "utf8")),
  )
  expect(users).toEqual(["hub.ts"])
})
