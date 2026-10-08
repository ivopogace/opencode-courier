import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join as joinPath } from "node:path"
import { HUB_KEY, HUB_VERSION, hub, join, open, permissions, resetHub, type Member, type Timers } from "../src/hub.js"
import { TICK_MS, type LaterEntry, type LaterPorts } from "../src/later.js"

const LEGACY = ["claimed", "watched", "forms", "questions", "receiver", "locations"]
const at = (registry: Record<symbol, unknown>, key: string) => registry[Symbol.for(key)]

/** Scheduler ports over `store`, recording the deliveries made through them under `directory`. */
function laterPorts(directory: string, store = new Map<string, unknown>(), delivered: string[] = []): LaterPorts {
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
    now: () => 1_000,
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

afterEach(() => resetHub())

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
      ticks: ["/a", "/c"],
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

/** Timers the test fires by hand, recording what was started and stopped. */
function fakeTimers() {
  const started: Array<{ run: () => void; ms: number }> = []
  const stopped: unknown[] = []
  const timers: Timers = {
    every: (run, ms) => (started.push({ run, ms }), started.length),
    stop: (timer) => void stopped.push(timer),
  }
  return { timers, started, stopped, fire: () => started.at(-1)!.run() }
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
    expect(store.size).toBe(0)
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
    expect(scans).toBe(1)
    release()
    await settle()
    fire()
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

test("hub.ts is the only module of src/ that keeps anything process-wide", () => {
  const src = joinPath(import.meta.dir, "..", "src")
  const users = readdirSync(src).filter(
    (file) => file !== "storage.ts" && /\bprocessWide\s*[(<]|Symbol\.for\s*\(|globalThis/.test(readFileSync(joinPath(src, file), "utf8")),
  )
  expect(users).toEqual(["hub.ts"])
})
