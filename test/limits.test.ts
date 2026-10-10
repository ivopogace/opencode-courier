import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { spawn, type CourierPorts } from "../src/courier.js"
import { admit, busy, DEFAULT_LIMITS, readLimits, shapeContext, type ContextPorts, type LimitPorts, type SpawnGate } from "../src/limits.js"
import { childBrief, depthRefusal, childrenRefusal, ROLE_PREFIX, rolePart, totalRefusal } from "../src/notices.js"
import { reportOf, prompted, settled } from "../src/report.js"
import { record } from "../src/roster.js"

/** Whether a spawned session owes its parent a report, as `reportOf` reads it. */
const owesReport = async (storage: Parameters<typeof reportOf>[0], sessionID: string) => (await reportOf(storage, sessionID))?.owes

function fakeStorage() {
  const store = new Map<string, unknown>()
  return {
    store,
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => void store.set(key, value),
    remove: async (key: string) => void store.delete(key),
    scan: async ({ prefix }: { prefix: string }) => ({
      entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    }),
  } as any
}

const RUNNING = { created: 1, updated: 5 }
const FINISHED = { created: 1, updated: 5, idle: 5 }

/** Limit ports over a roster and the sessions' times, all running unless `times` says otherwise. */
function limitPorts(limits = DEFAULT_LIMITS, times: Record<string, object> = {}) {
  const storage = fakeStorage()
  const gate: SpawnGate = { reserved: new Set(), turn: Promise.resolve() }
  const ports: LimitPorts = {
    storage,
    limits,
    gate,
    session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, time: times[sessionID] ?? RUNNING }) } as any,
  }
  const child = (parentID: string, sessionID: string) =>
    record(storage, { sessionID, parentID, title: sessionID, directory: "/repo", isolated: false, createdAt: 1 })
  return { ports, storage, gate, child }
}

/** Records a chain root -> d1 -> d2 -> ... down to `depth`, returning the deepest session. */
async function chainTo(child: (parentID: string, sessionID: string) => Promise<void>, depth: number) {
  let parent = "ses_root"
  for (let level = 1; level <= depth; level++) {
    await child(parent, `ses_d${level}`)
    parent = `ses_d${level}`
  }
  return parent
}

describe("readLimits", () => {
  test("defaults to maxDepth 3, maxChildren 5 and maxTotal 20", () => {
    expect(readLimits(undefined)).toEqual({ limits: { maxDepth: 3, maxChildren: 5, maxTotal: 20 }, problems: [] })
    expect(readLimits({ webhook: true })).toEqual({ limits: DEFAULT_LIMITS, problems: [] })
  })

  test("reads each from the plugin's options", () => {
    expect(readLimits({ maxDepth: 1, maxChildren: 2, maxTotal: 7 }).limits).toEqual({ maxDepth: 1, maxChildren: 2, maxTotal: 7 })
  })

  test("keeps the default for one that is not a positive integer, and names it", () => {
    const { limits, problems } = readLimits({ maxDepth: 0, maxChildren: "4", maxTotal: 2.5 })
    expect(limits).toEqual(DEFAULT_LIMITS)
    expect(problems).toEqual([
      "maxDepth must be a positive integer, not 0; using 3",
      'maxChildren must be a positive integer, not "4"; using 5',
      "maxTotal must be a positive integer, not 2.5; using 20",
    ])
  })
})

describe("busy", () => {
  const time = (value: object) => value as Parameters<typeof busy>[0]

  test("a session that never finished a turn, or was reached after its last one, is running", () => {
    expect(busy(time({ updated: 2 }))).toBe(true)
    expect(busy(time({ updated: 9, idle: 5 }))).toBe(true)
  })

  test("one whose last turn ended after anything reached it is not", () => {
    expect(busy(time({ updated: 5, idle: 5 }))).toBe(false)
    expect(busy(time({ updated: 4, idle: 5 }))).toBe(false)
  })

  test("reads OpenCode's DateTime values", () => {
    const at = (ms: number) => DateTime.makeUnsafe(ms)
    expect(busy(time({ updated: at(9), idle: at(5) }))).toBe(true)
    expect(busy(time({ updated: at(5), idle: at(5) }))).toBe(false)
  })
})

describe("admit", () => {
  test("maxDepth: a session one level above it may spawn, its child at maxDepth", async () => {
    const { ports, child } = limitPorts()
    const parent = await chainTo(child, 2)

    const admitted = await admit(ports, parent)

    expect(admitted.depth).toBe(3)
  })

  test("maxDepth: a session at it is refused, saying so", async () => {
    const { ports, child } = limitPorts()
    const parent = await chainTo(child, 3)

    await expect(admit(ports, parent)).rejects.toThrow(depthRefusal(3, 3))
  })

  test("a session nobody spawned starts children at depth 1", async () => {
    const { ports } = limitPorts()
    expect((await admit(ports, "ses_root")).depth).toBe(1)
  })

  test("maxChildren: one below it is allowed, and at it the spawn is refused", async () => {
    const { ports, child } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 3 })
    await child("ses_root", "ses_a")
    await child("ses_root", "ses_b")

    const admitted = await admit(ports, "ses_root")
    admitted.release()
    await child("ses_root", "ses_c")

    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(3, 3))
  })

  test("maxChildren counts only running children", async () => {
    const { ports, child } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 2 }, { ses_a: FINISHED, ses_b: FINISHED })
    await child("ses_root", "ses_a")
    await child("ses_root", "ses_b")
    await child("ses_root", "ses_c")

    expect((await admit(ports, "ses_root")).depth).toBe(1)
  })

  test("spawns made together count each other, so no more than maxChildren get through", async () => {
    const { ports, gate } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 2 })

    const results = await Promise.allSettled([1, 2, 3].map(() => admit(ports, "ses_root")))

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected"])
    expect(gate.reserved.size).toBe(2)
  })

  test("a spawn whose child is on the roster is counted once, not as well by its reservation", async () => {
    const { ports, child } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 2 })
    const first = await admit(ports, "ses_root")
    first.reservation.sessionID = "ses_a"
    await child("ses_root", "ses_a")

    const second = await admit(ports, "ses_root")

    expect(second.depth).toBe(1)
  })

  test("release frees the place", async () => {
    const { ports, gate } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1 })
    const first = await admit(ports, "ses_root")
    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(1, 1))

    first.release()

    expect(gate.reserved.size).toBe(0)
    expect((await admit(ports, "ses_root")).depth).toBe(1)
  })

  test("maxTotal: counts the running sessions of the whole tree, and refuses at it", async () => {
    const { ports, child } = limitPorts({ ...DEFAULT_LIMITS, maxTotal: 4 })
    await child("ses_root", "ses_a")
    await child("ses_root", "ses_b")
    await child("ses_a", "ses_a1")

    const admitted = await admit(ports, "ses_b")
    admitted.release()
    await child("ses_b", "ses_b1")

    await expect(admit(ports, "ses_b")).rejects.toThrow(totalRefusal(4, 4))
    await expect(admit(ports, "ses_root")).rejects.toThrow(totalRefusal(4, 4))
  })

  test("maxTotal does not count another tree's sessions, or finished ones", async () => {
    const { ports, child } = limitPorts({ ...DEFAULT_LIMITS, maxTotal: 2 }, { ses_a: FINISHED })
    await child("ses_other", "ses_x")
    await child("ses_other", "ses_y")
    await child("ses_root", "ses_a")
    await child("ses_root", "ses_b")

    expect((await admit(ports, "ses_root")).depth).toBe(1)
  })

  test("a refused check does not hold up the next", async () => {
    const { ports, child } = limitPorts({ ...DEFAULT_LIMITS, maxDepth: 1 })
    await child("ses_root", "ses_a")

    await expect(admit(ports, "ses_a")).rejects.toThrow(depthRefusal(1, 1))
    expect((await admit(ports, "ses_root")).depth).toBe(1)
  })
})

describe("admit, with children that owe a report", () => {
  /** Three finished children of ses_root: ses_a reported, ses_b ended without reporting, ses_c is `c`. */
  async function owing(c: "failed" | "interrupted" | "silent") {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 2, maxTotal: 2 }, {
      ses_a: FINISHED,
      ses_b: FINISHED,
      ses_c: FINISHED,
    })
    for (const id of ["ses_a", "ses_b", "ses_c"]) {
      await child("ses_root", id)
      await prompted(storage, id, 100)
    }
    await settled(storage, "ses_a", "report", 150)
    if (c !== "silent") await settled(storage, "ses_c", c, 150)
    return ports
  }

  test("counts a child whose turn ended without a report, against maxChildren and maxTotal", async () => {
    const ports = await owing("silent")
    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(2, 2))
    await expect(admit(ports, "ses_b")).rejects.toThrow(totalRefusal(2, 2))
  })

  test("but not one that reported, failed or was interrupted since its last prompt", async () => {
    expect((await admit(await owing("failed"), "ses_root")).depth).toBe(1)
    expect((await admit(await owing("interrupted"), "ses_root")).depth).toBe(1)
  })

  test("counts one that reported once a new prompt reached it", async () => {
    const ports = await owing("failed")
    await prompted(ports.storage, "ses_a", 200)
    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(2, 2))
  })

  test("counts a child that reported early while its turn still runs", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1 })
    await child("ses_root", "ses_a")
    await prompted(storage, "ses_a", 100)
    await settled(storage, "ses_a", "report", 150)
    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(1, 1))
  })

  test("a child OpenCode no longer knows does not count, though it owes a report; one it cannot look up now does", async () => {
    const ports = await owing("silent")
    const get = ports.session.get
    let error: unknown = Object.assign(new Error(""), { _tag: "Session.NotFoundError" })
    ;(ports.session as any).get = async (input: { sessionID: string }) => {
      if (input.sessionID === "ses_b") throw error
      return get(input as never)
    }
    expect((await admit(ports, "ses_root")).depth).toBe(1)
    ports.gate.reserved.clear()
    error = new Error("database is locked")
    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(2, 2))
  })

  test("a child whose state cannot be read counts only if it runs", async () => {
    const ports = await owing("silent")
    ;(ports.storage as any).get = async () => {
      throw new Error("disk gone")
    }
    expect(await owesReport(ports.storage, "ses_b").catch(() => "threw")).toBe("threw")
    expect((await admit(ports, "ses_root")).depth).toBe(1)
  })
})

describe("admit, with sessions waiting on their own children", () => {
  /** A tree under ses_r: ses_a and ses_b, each with one child; `running` names the sessions whose turn runs. */
  async function waitingTree(limits: Partial<typeof DEFAULT_LIMITS>, running: string[]) {
    const storage = fakeStorage()
    const ports: LimitPorts = {
      storage,
      limits: { ...DEFAULT_LIMITS, ...limits },
      gate: { reserved: new Set(), turn: Promise.resolve() },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, time: running.includes(sessionID) ? RUNNING : FINISHED }),
      } as any,
    }
    const add = (parentID: string, sessionID: string) =>
      record(storage, { sessionID, parentID, title: sessionID, directory: "/repo", isolated: false, createdAt: 1 })
    for (const [parentID, sessionID] of [["ses_r", "ses_a"], ["ses_r", "ses_b"], ["ses_a", "ses_a1"], ["ses_b", "ses_b1"]]) await add(parentID!, sessionID!)
    return ports
  }

  test("maxChildren counts a child whose turn ended while a child of its own runs", async () => {
    const ports = await waitingTree({ maxChildren: 2 }, ["ses_a1", "ses_b1"])
    await expect(admit(ports, "ses_r")).rejects.toThrow(childrenRefusal(2, 2))
  })

  test("maxTotal counts those waiting sessions with the ones running below them", async () => {
    const ports = await waitingTree({ maxTotal: 3 }, ["ses_a1", "ses_b1"])
    await expect(admit(ports, "ses_r")).rejects.toThrow(totalRefusal(4, 3))
  })

  test("as it counts children whose own turn runs", async () => {
    const ports = await waitingTree({ maxChildren: 2 }, ["ses_a", "ses_b"])
    await expect(admit(ports, "ses_r")).rejects.toThrow(childrenRefusal(2, 2))
  })

  test("and counts none of them once nothing below them runs", async () => {
    const ports = await waitingTree({ maxChildren: 2, maxTotal: 3 }, [])
    expect((await admit(ports, "ses_r")).depth).toBe(1)
  })
})

describe("spawn", () => {
  function spawnPorts(limits = DEFAULT_LIMITS) {
    const { ports, storage, gate, child } = limitPorts(limits)
    const calls: string[] = []
    const roles = new Map<string, number | null>([["ses_root", null]])
    let next = 0
    const courier = {
      ...ports,
      roles,
      directory: "/repo",
      projectID: "proj_1",
      now: () => 1,
      head: async () => undefined,
      pending: async () => [],
      agent: { get: async () => ({ data: {} }) },
      worktree: {},
      session: {
        ...ports.session,
        create: async () => {
          calls.push("session.create")
          return { id: `ses_new${++next}`, location: { directory: "/repo" } }
        },
        prompt: async (input: { text: string }) => void calls.push(input.text),
      },
    } as unknown as CourierPorts
    return { courier, storage, gate, roles, calls, child }
  }

  test("a refused spawn creates nothing", async () => {
    const { courier, calls, child, gate } = spawnPorts({ ...DEFAULT_LIMITS, maxDepth: 1 })
    await child("ses_root", "ses_a")

    await expect(spawn(courier, "ses_a", { task: "t" })).rejects.toThrow(depthRefusal(1, 1))

    expect(calls).toEqual([])
    expect(gate.reserved.size).toBe(0)
  })

  test("briefs the child with its depth and the limits, frees its place, and forgets the parent's role", async () => {
    const { courier, calls, gate, roles, child } = spawnPorts()
    await child("ses_root", "ses_a")

    await spawn(courier, "ses_a", { task: "t" })

    expect(calls).toEqual(["session.create", childBrief("ses_a", "t", 2, DEFAULT_LIMITS)])
    expect(gate.reserved.size).toBe(0)
    await spawn(courier, "ses_root", { task: "t" })
    expect(roles.has("ses_root")).toBe(false)
  })

  test("notes the child as owing a report before it is prompted", async () => {
    const { courier, storage, calls } = spawnPorts()
    ;(courier.session as any).prompt = async () => void calls.push(`prompted, owing: ${await owesReport(storage, "ses_new1")}`)

    await spawn(courier, "ses_root", { task: "t" })

    expect(calls).toEqual(["session.create", "prompted, owing: true"])
  })

  test("a child that cannot be prompted owes no report and does not count, since it never got its task", async () => {
    const { courier, storage } = spawnPorts({ ...DEFAULT_LIMITS, maxChildren: 1 })
    ;(courier.session as any).prompt = async () => Promise.reject(new Error("session gone"))

    await expect(spawn(courier, "ses_root", { task: "t" })).rejects.toThrow("session gone")

    expect(await owesReport(storage, "ses_new1")).toBe(false)
    // OpenCode still knows it, and it never finished a turn: by its times alone it would run.
    expect((await admit(courier, "ses_root")).depth).toBe(1)
  })

  test("frees its place when the child cannot be created", async () => {
    const { courier, gate } = spawnPorts()
    ;(courier.session as any).create = async () => Promise.reject(new Error("boom"))

    await expect(spawn(courier, "ses_root", { task: "t" })).rejects.toThrow("boom")

    expect(gate.reserved.size).toBe(0)
  })
})

describe("the context hook", () => {
  const tools = () => ({ courier_spawn: {}, courier_send: {}, read: {} })

  function contextPorts(limits = DEFAULT_LIMITS) {
    const { storage, child } = limitPorts(limits)
    const logged: string[] = []
    const ports: ContextPorts = { storage, limits, roles: new Map(), log: (message) => void logged.push(message) }
    const shape = async (sessionID: string) => {
      const event = { sessionID, tools: tools() as Record<string, unknown>, system: [{ type: "text" as const, text: "base" }] }
      await shapeContext(ports, event)
      return event
    }
    return { ports, storage, child, shape, logged }
  }

  test("leaves a session nobody spawned that has started none as it is", async () => {
    const { shape } = contextPorts()
    expect(await shape("ses_alone")).toEqual({ sessionID: "ses_alone", tools: tools(), system: [{ type: "text", text: "base" }] })
  })

  test("names the role per depth: root orchestrator, sub-orchestrator, leaf", async () => {
    const { shape, child } = contextPorts()
    await chainTo(child, 3)

    for (const [sessionID, depth] of [["ses_root", 0], ["ses_d1", 1], ["ses_d2", 2], ["ses_d3", 3]] as const) {
      const event = await shape(sessionID)
      expect(event.system).toEqual([{ type: "text", text: "base" }, { type: "text", text: rolePart(depth, DEFAULT_LIMITS) }])
    }
  })

  test("hides courier_spawn at maxDepth and keeps it above", async () => {
    const { shape, child } = contextPorts({ ...DEFAULT_LIMITS, maxDepth: 2 })
    await chainTo(child, 2)

    expect(Object.keys((await shape("ses_d1")).tools)).toEqual(["courier_spawn", "courier_send", "read"])
    expect(Object.keys((await shape("ses_d2")).tools)).toEqual(["courier_send", "read"])
    expect(Object.keys((await shape("ses_root")).tools)).toEqual(["courier_spawn", "courier_send", "read"])
  })

  test("remembers a depth, and finds a root's role once a spawn forgot it", async () => {
    const { ports, storage, shape, child } = contextPorts()
    expect((await shape("ses_root")).system).toHaveLength(1)
    await child("ses_root", "ses_a")
    expect((await shape("ses_root")).system).toHaveLength(1)

    ports.roles.delete("ses_root")
    expect((await shape("ses_root")).system).toHaveLength(2)

    storage.scan = async () => Promise.reject(new Error("not read again"))
    storage.get = async () => Promise.reject(new Error("not read again"))
    expect((await shape("ses_root")).system).toHaveLength(2)
  })

  test("a session nobody spawned costs one read and one scan of its own children, never the whole roster", async () => {
    const { storage, shape, child } = contextPorts()
    await chainTo(child, 2)
    const scanned: string[] = []
    const scan = storage.scan
    storage.scan = async (input: { prefix: string }) => {
      scanned.push(input.prefix)
      return scan(input)
    }

    expect((await shape("ses_alone")).system).toHaveLength(1)
    expect(scanned).toEqual(["roster/ses_alone/"])
  })

  test("indexed sessions keep their depths without scanning the roster", async () => {
    const { storage, shape, child } = contextPorts()
    await chainTo(child, 3)
    const scan = storage.scan
    storage.scan = async (input: { prefix: string }) =>
      input.prefix === "roster/" ? Promise.reject(new Error("whole roster scanned")) : scan(input)

    for (const [sessionID, depth] of [["ses_root", 0], ["ses_d1", 1], ["ses_d2", 2], ["ses_d3", 3]] as const)
      expect((await shape(sessionID)).system.at(-1)).toEqual({ type: "text", text: rolePart(depth, DEFAULT_LIMITS) })
  })

  test("adds no second role part, as a second copy of the plugin would", async () => {
    const { ports, child } = contextPorts()
    await child("ses_root", "ses_a")
    const event = { sessionID: "ses_a", tools: tools(), system: [{ type: "text" as const, text: `${ROLE_PREFIX} other copy` }] }

    await shapeContext(ports, event)

    expect(event.system).toHaveLength(1)
  })

  test("logs a failed lookup and leaves the request as it is", async () => {
    const { storage, shape, logged } = contextPorts()
    storage.get = async () => Promise.reject(new Error("db locked"))
    storage.scan = async () => Promise.reject(new Error("db locked"))

    expect((await shape("ses_a")).system).toHaveLength(1)
    expect(logged).toEqual(["courier: cannot tell the role of session ses_a: Error: db locked"])
  })
})
