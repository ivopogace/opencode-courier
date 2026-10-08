import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join as joinPath } from "node:path"
import { HUB_KEY, HUB_VERSION, hub, join, permissions, resetHub, type Member } from "../src/hub.js"

type HubModule = typeof import("../src/hub.js")

/** Another copy of the hub module, with its own module state, as a second copy of the plugin in the process. */
const copy = (name: string) => import(`../src/hub.js?copy=${name}`) as Promise<HubModule>

const registry = globalThis as Record<symbol, unknown>
const LEGACY = ["claimed", "watched", "forms", "questions", "receiver", "locations"].map((name) => `opencode-courier.${name}`)

/** Runs `body` with the process-wide keys as `set` leaves them, and puts the current ones back afterwards. */
async function withKeys(set: () => void, body: () => Promise<void>) {
  const keys = [HUB_KEY, `${HUB_KEY}@${HUB_VERSION}`, ...LEGACY]
  const saved = keys.map((key) => [key, Object.hasOwn(registry, Symbol.for(key)), registry[Symbol.for(key)]] as const)
  try {
    set()
    await body()
  } finally {
    for (const [key, had, value] of saved) {
      if (had) registry[Symbol.for(key)] = value
      else delete registry[Symbol.for(key)]
    }
  }
}

const member = (directory: string, log: (message: string) => void = () => {}): Member =>
  ({
    directory,
    permission: { list: async () => [], reply: async () => {} },
    later: {},
    watch: {},
    questions: {},
    log,
  }) as unknown as Member

afterEach(() => resetHub())

describe("the hub", () => {
  test("is one object for every copy of the plugin of its version in the process", async () => {
    const second = await copy("2")
    expect(second.hub).toBe(hub)
    expect(hub.version).toBe(HUB_VERSION)
    expect(registry[Symbol.for(HUB_KEY)]).toBe(hub)
  })

  test("join adds an instance and its permission domain, and its leave takes both out, from any copy", async () => {
    const second = await copy("2")
    const a = member("/a")
    const b = member("/b")
    const leaveA = join(a)
    const leaveB = second.join(b)

    expect([...hub.members]).toEqual([a, b])
    expect([...permissions()]).toEqual([a.permission, b.permission])
    expect([...second.permissions()]).toEqual([a.permission, b.permission])

    leaveA()
    expect([...second.hub.members]).toEqual([b])
    expect([...permissions()]).toEqual([b.permission])
    leaveB()
    expect(hub.members.size).toBe(0)
    expect(hub.locations.size).toBe(0)
  })

  test("keeps its claim sets and shared objects under the keys of the copies before the hub", () => {
    expect(registry[Symbol.for("opencode-courier.claimed")]).toBe(hub.claimed)
    expect(registry[Symbol.for("opencode-courier.watched")]).toBe(hub.watched)
    expect(registry[Symbol.for("opencode-courier.forms")]).toBe(hub.forms)
    expect(registry[Symbol.for("opencode-courier.questions")]).toBe(hub.questions)
    expect(registry[Symbol.for("opencode-courier.receiver")]).toBe(hub.receivers)
    expect(registry[Symbol.for("opencode-courier.locations")]).toBe(hub.locations)
    expect(hub.watch).toEqual({ ...hub.watched, forms: hub.forms })
  })

  test("takes the objects of a copy before the hub, loaded first, and fills in the fields it lacks", async () => {
    const claimed = new Set(["later_1"])
    const watched = { seen: new Set(["evt_1"]), waiting: new Set<string>(), answered: new Set<string>() }
    const questions = { questions: new Map(), noticed: new Set(["question_1"]) }
    const locations = new Map()
    await withKeys(
      () => {
        delete registry[Symbol.for(HUB_KEY)]
        for (const key of LEGACY) delete registry[Symbol.for(key)]
        registry[Symbol.for("opencode-courier.claimed")] = claimed
        registry[Symbol.for("opencode-courier.watched")] = watched
        registry[Symbol.for("opencode-courier.questions")] = questions
        registry[Symbol.for("opencode-courier.locations")] = locations
      },
      async () => {
        const fresh = await copy("after-a-copy-before-the-hub")
        expect(fresh.hub).not.toBe(hub)
        expect(registry[Symbol.for(HUB_KEY)]).toBe(fresh.hub)
        expect(fresh.hub.claimed).toBe(claimed)
        expect(fresh.hub.watched).toBe(watched)
        expect(fresh.hub.watch.seen).toBe(watched.seen)
        expect(fresh.hub.questions).toBe(questions as never)
        expect(fresh.hub.questions.noticed.has("question_1")).toBe(true)
        expect(fresh.hub.questions.loaded).toBeInstanceOf(Set)
        expect(fresh.hub.questions.following).toBe(0)
        // The one the earlier copy did not make is made, under its key, for the copies after.
        expect(registry[Symbol.for("opencode-courier.forms")]).toBe(fresh.hub.forms)

        const leave = fresh.join(member("/a"))
        expect(locations.size).toBe(1)
        leave()
        expect(locations.size).toBe(0)
      },
    )
  })

  test("of another version found under its key is logged once, and the copy keeps its own, sharing the claim sets", async () => {
    const other = { version: HUB_VERSION + 1 }
    await withKeys(
      () => {
        registry[Symbol.for(HUB_KEY)] = other
        delete registry[Symbol.for(`${HUB_KEY}@${HUB_VERSION}`)]
      },
      async () => {
        const skewed = await copy("skewed")
        expect(registry[Symbol.for(HUB_KEY)]).toBe(other)
        expect(registry[Symbol.for(`${HUB_KEY}@${HUB_VERSION}`)]).toBe(skewed.hub)
        expect(skewed.hub).not.toBe(hub)
        expect(skewed.hub.version).toBe(HUB_VERSION)
        expect(skewed.hub.members.size).toBe(0)
        // The claim sets are the ones every copy claims in, so an older copy and this one never both act.
        expect(skewed.hub.claimed).toBe(hub.claimed)
        expect(skewed.hub.watched).toBe(hub.watched)
        expect(skewed.hub.forms).toBe(hub.forms)
        expect(skewed.hub.questions).toBe(hub.questions)
        expect(skewed.hub.receivers).toBe(hub.receivers)
        expect(skewed.hub.locations).toBe(hub.locations)

        const logs: string[] = []
        const leaveA = skewed.join(member("/a", (message) => logs.push(message)))
        const leaveB = skewed.join(member("/b", (message) => logs.push(message)))
        // A second copy of the same version finds the same versioned hub, which has logged already.
        const third = await copy("skewed-too")
        expect(third.hub).toBe(skewed.hub)
        const leaveC = third.join(member("/c", (message) => logs.push(message)))
        expect(logs).toEqual([
          `courier: another copy of the plugin with hub version ${HUB_VERSION + 1} is loaded in this process; ` +
            `this copy (hub version ${HUB_VERSION}) keeps its own under ${HUB_KEY}@${HUB_VERSION} and shares the claim sets with it`,
        ])
        expect(skewed.hub.members.size).toBe(3)
        for (const leave of [leaveA, leaveB, leaveC]) leave()
        expect(skewed.hub.members.size).toBe(0)
      },
    )
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

test("hub.ts is the only module of src/ that keeps anything process-wide", () => {
  const src = joinPath(import.meta.dir, "..", "src")
  const users = readdirSync(src).filter(
    (file) => file !== "storage.ts" && /\bprocessWide\s*[(<]/.test(readFileSync(joinPath(src, file), "utf8")),
  )
  expect(users).toEqual(["hub.ts"])
})
