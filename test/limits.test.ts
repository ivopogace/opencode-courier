import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { send } from "../src/tree/send.js"
import { spawn } from "../src/tree/spawn.js"
import { admit } from "../src/tree/limits.js"
import { shapeContext } from "../src/tree/context.js"
import { busy, DEFAULT_LIMITS, endedAt, endsIdle, nativeRootOf, readLimits, readNativeChildren, turnEnd, type RosterEntry } from "../src/tree/domain.js"
import { runs, turnOf } from "../src/tree/running.js"
import type { ContextPorts, CourierPorts, LimitPorts, SpawnGate } from "../src/tree/ports.js"
import { ROOT_SPLIT_LINE, SKILL_ID } from "../src/kernel/protocol.js"
import { childBrief, depthRefusal, childrenRefusal, ROLE_PREFIX, rolePart, totalRefusal } from "../src/tree/text.js"
import { reportOf } from "../src/tree/report.js"
import { childStore, wakeStore } from "../src/tree/store.js"

/** Whether a spawned session owes its parent a report, as `reportOf` reads it. */
const owesReport = async (storage: Parameters<typeof childStore>[0], sessionID: string) => (await reportOf(childStore(storage), sessionID))?.owes

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

/** Limit ports over a roster and the sessions' times, all running, by their transcripts too, unless `times` says otherwise; `turns` run on in theirs. */
function limitPorts(limits = DEFAULT_LIMITS, times: Record<string, object> = {}, turns: ReadonlyArray<string> = []) {
  const storage = fakeStorage()
  const gate: SpawnGate = { reserved: new Set(), turn: Promise.resolve() }
  const ports: LimitPorts = {
    storage,
    limits,
    gate,
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, time: times[sessionID] ?? RUNNING }),
      context: async ({ sessionID }: { sessionID: string }) => [{ type: turns.includes(sessionID) || !times[sessionID] ? "assistant" : "idle" }],
    } as any,
  }
  const child = (parentID: string, sessionID: string) =>
    childStore(storage).record({ sessionID, parentID, title: sessionID, directory: "/repo", isolated: false, createdAt: 1 })
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
  test("defaults to maxDepth 5, maxChildren 5 and maxTotal 20", () => {
    expect(readLimits(undefined)).toEqual({ limits: { maxDepth: 5, maxChildren: 5, maxTotal: 20 }, problems: [] })
    expect(readLimits({ webhook: true })).toEqual({ limits: DEFAULT_LIMITS, problems: [] })
  })

  test("reads each from the plugin's options", () => {
    expect(readLimits({ maxDepth: 1, maxChildren: 2, maxTotal: 7 }).limits).toEqual({ maxDepth: 1, maxChildren: 2, maxTotal: 7 })
  })

  test("keeps the default for one that is not a positive integer, and names it", () => {
    const { limits, problems } = readLimits({ maxDepth: 0, maxChildren: "4", maxTotal: 2.5 })
    expect(limits).toEqual(DEFAULT_LIMITS)
    expect(problems).toEqual([
      "maxDepth must be a positive integer, not 0; using 5",
      'maxChildren must be a positive integer, not "4"; using 5',
      "maxTotal must be a positive integer, not 2.5; using 20",
    ])
  })
})

describe("readNativeChildren", () => {
  test("is off unless the option is true", () => {
    expect(readNativeChildren(undefined)).toEqual({ nativeChildren: false, problems: [] })
    expect(readNativeChildren({ maxDepth: 2 })).toEqual({ nativeChildren: false, problems: [] })
    expect(readNativeChildren({ nativeChildren: false })).toEqual({ nativeChildren: false, problems: [] })
    expect(readNativeChildren({ nativeChildren: true })).toEqual({ nativeChildren: true, problems: [] })
  })

  test("keeps it off for a value that is not a boolean, and names it", () => {
    expect(readNativeChildren({ nativeChildren: "yes" })).toEqual({
      nativeChildren: false,
      problems: ['nativeChildren must be true or false, not "yes"; using false'],
    })
  })
})

describe("nativeRootOf", () => {
  const entry = (sessionID: string, parentID: string, native?: true) =>
    ({ sessionID, parentID, title: "t", directory: "/repo", isolated: !native, createdAt: 1, ...(native ? { native } : {}) }) as RosterEntry

  test("is the session itself when it is not a native child", () => {
    expect(nativeRootOf([entry("ses_c", "ses_p")])).toBe("ses_c")
  })

  test("climbs native parents to the first session that is not a native child", () => {
    expect(nativeRootOf([entry("ses_c", "ses_p", true), entry("ses_p", "ses_top", true)])).toBe("ses_top")
    expect(nativeRootOf([entry("ses_c", "ses_p", true), entry("ses_p", "ses_top")])).toBe("ses_p")
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

describe("endsIdle", () => {
  test("is a transcript whose last message is a turn's end", () => {
    expect(endsIdle([{ type: "user" }, { type: "assistant" }, { type: "idle" }])).toBe(true)
    expect(endsIdle([{ type: "idle" }, { type: "synthetic" }, { type: "assistant" }])).toBe(false)
    expect(endsIdle([])).toBe(false)
  })

  test("past a switch of agent or model, or a move, made since: at rest after the turn's end, running within a turn", () => {
    expect(endsIdle([{ type: "idle" }, { type: "model-switched" }, { type: "agent-switched" }, { type: "location-switched" }])).toBe(true)
    expect(endsIdle([{ type: "idle" }, { type: "user" }, { type: "model-switched" }])).toBe(false)
    expect(endsIdle([{ type: "model-switched" }])).toBe(false)
  })

  test("past a shell command the person ran since, which is no turn of its own", () => {
    expect(endsIdle([{ type: "idle" }, { type: "shell" }, { type: "agent-switched" }])).toBe(true)
    expect(endsIdle([{ type: "idle" }, { type: "skill" }])).toBe(false)
    expect(endsIdle([{ type: "idle" }, { type: "compaction" }])).toBe(false)
  })

  // #326: a declined permission or dismissed question interrupts the step and ends the turn with no `idle` message.
  test("on a step interrupted with nothing after it, as a decline ends a turn, but not a step that failed otherwise", () => {
    const declined = { type: "assistant", error: { type: "aborted" } }
    expect(endsIdle([{ type: "idle" }, { type: "user" }, declined])).toBe(true)
    expect(endsIdle([{ type: "user" }, declined, { type: "model-switched" }])).toBe(true)
    expect(endsIdle([{ type: "idle" }, declined, { type: "synthetic" }])).toBe(false)
    expect(endsIdle([{ type: "idle" }, { type: "user" }, { type: "assistant", error: { type: "provider" } }])).toBe(false)
  })
})

describe("runs", () => {
  const session = (messages: { type: string }[] | Error) => ({
    context: async () => {
      if (messages instanceof Error) throw messages
      return messages
    },
  }) as any
  const stamped = { updated: 9, idle: 5 } as Parameters<typeof runs>[2]

  test("reads no transcript when its last turn ended after its last stamp", async () => {
    const unread = session(new Error("not read"))
    expect(await runs(unread, "ses_a", { updated: 5, idle: 5 } as any)).toBe(false)
    expect(await runs(unread, "ses_a", { updated: 4, idle: 5 } as any)).toBe(false)
  })

  // #326: what stamps `updated` after a turn's end, and what each leaves in the transcript (projector.ts, message-updater.ts, v2.1.0).
  const ended = [{ type: "user" }, { type: "assistant" }, { type: "idle" }]
  const atRest: Array<[string, Array<{ type: string; error?: { type: string } }>]> = [
    ["a rename, a metadata or permissions change", ended],
    ["an archive, or an unarchive", ended],
    ["a staged or cleared revert", ended],
    ["an item waiting in the inbox, sent without a wake or its wake lost", ended],
    ["a switch of agent or model", [...ended, { type: "agent-switched" }, { type: "model-switched" }]],
    ["a move", [...ended, { type: "location-switched" }]],
    ["a shell command the person ran", [...ended, { type: "shell" }]],
    ["a declined permission or dismissed question, which records no idle", [...ended, { type: "user" }, { type: "assistant", error: { type: "aborted" } }]],
  ]
  const running: Array<[string, Array<{ type: string }>]> = [
    ["a step started or ended", [...ended, { type: "user" }, { type: "assistant" }]],
    ["a prompt or message delivered, its step not yet started", [...ended, { type: "synthetic" }]],
    ["a skill, or a compaction", [...ended, { type: "skill" }]],
    ["a switch made during a turn", [...ended, { type: "user" }, { type: "assistant" }, { type: "model-switched" }]],
  ]

  for (const [stamp, messages] of atRest)
    test(`else goes by the transcript: idle after ${stamp}`, async () => {
      expect(await runs(session(messages), "ses_a", stamped)).toBe(false)
      expect(await runs(session(messages), "ses_a", { updated: 9, idle: 5, archived: 9 } as any)).toBe(false)
    })

  for (const [stamp, messages] of running)
    test(`and running after ${stamp}`, async () => {
      expect(await runs(session(messages), "ses_a", stamped)).toBe(true)
    })

  test("in a first turn too, which no idle time marks: running until it ends, as a decline ends it", async () => {
    expect(await runs(session([{ type: "user" }, { type: "assistant" }]), "ses_a", { updated: 9 } as any)).toBe(true)
    expect(await runs(session([{ type: "user" }, { type: "assistant", error: { type: "aborted" } }] as any), "ses_a", { updated: 9 } as any)).toBe(false)
  })

  test("as its times say, running, when the transcript cannot be read or holds nothing", async () => {
    expect(await runs(session(new Error("db locked")), "ses_a", stamped)).toBe(true)
    expect(await runs(session([]), "ses_a", stamped)).toBe(true)
    expect(await runs(session([]), "ses_a", { updated: 9 } as any)).toBe(true)
  })

  test("remembers a transcript read per stamp, calls made together sharing the read, and reads again after a new stamp, a failure or nothing", async () => {
    let reads = 0
    let fail = true
    let messages: { type: string }[] = []
    const counted = {
      context: async () => {
        reads++
        if (fail) throw new Error("db locked")
        return messages
      },
    } as any
    expect(await runs(counted, "ses_a", stamped)).toBe(true)
    fail = false
    expect(await runs(counted, "ses_a", stamped)).toBe(true)
    expect(reads).toBe(2)
    reads = 0
    messages = [{ type: "idle" }]
    expect(await Promise.all([runs(counted, "ses_a", stamped), runs(counted, "ses_a", stamped)])).toEqual([false, false])
    expect(await runs(counted, "ses_a", stamped)).toBe(false)
    expect(reads).toBe(1)
    expect(await runs(counted, "ses_a", { updated: 14, idle: 10 } as any)).toBe(false)
    expect(await runs(counted, "ses_b", stamped)).toBe(false)
    expect(reads).toBe(3)
  })

  test("a read that fails after it was evicted leaves the newer answer for its stamp", async () => {
    let fail = () => {}
    const reads: string[] = []
    const held = {
      context: ({ sessionID }: { sessionID: string }) => {
        reads.push(sessionID)
        if (reads.length === 1) return new Promise((_, reject) => (fail = () => reject(new Error("db locked"))))
        return Promise.resolve([{ type: "idle" }])
      },
    } as any
    const first = runs(held, "ses_a", stamped)
    for (let i = 0; i < 500; i++) await runs(held, `ses_${i}`, stamped)
    expect(await runs(held, "ses_a", stamped)).toBe(false)
    fail()
    expect(await first).toBe(true)
    expect(await runs(held, "ses_a", stamped)).toBe(false)
    expect(reads.filter((sessionID) => sessionID === "ses_a")).toHaveLength(2)
  })

  test("remembers one answer per session, so a running session's new stamps evict no other session's", async () => {
    const reads: string[] = []
    const counted = {
      context: async ({ sessionID }: { sessionID: string }) => {
        reads.push(sessionID)
        return [{ type: sessionID === "ses_idle" ? "idle" : "assistant" }]
      },
    } as any
    expect(await runs(counted, "ses_idle", stamped)).toBe(false)
    for (let step = 0; step < 600; step++) expect(await runs(counted, "ses_run", { updated: 10 + step, idle: 5 } as any)).toBe(true)
    expect(await runs(counted, "ses_idle", stamped)).toBe(false)
    expect(reads.filter((sessionID) => sessionID === "ses_idle")).toHaveLength(1)
  })

  // An item enqueued at a stamp is not in the transcript until delivered, which stamps nothing until its first step starts.
  test("reads a rest answer again while its stamp is fresh, so a delivery after it is seen; a running one, or an older rest, is kept", async () => {
    let messages: { type: string }[] = [{ type: "idle" }]
    let reads = 0
    const counted = {
      context: async () => {
        reads++
        return messages
      },
    } as any
    const enqueued = { updated: 100_000, idle: 5 } as any
    expect(await runs(counted, "ses_a", enqueued, 100_500)).toBe(false)
    messages = [{ type: "idle" }, { type: "synthetic" }]
    expect(await runs(counted, "ses_a", enqueued, 101_000)).toBe(true)
    expect(await runs(counted, "ses_a", enqueued, 102_000)).toBe(true)
    expect(reads).toBe(2)
    messages = [{ type: "idle" }]
    expect(await runs(counted, "ses_b", enqueued, 110_000)).toBe(false)
    expect(await runs(counted, "ses_b", enqueued, 120_000)).toBe(false)
    expect(reads).toBe(3)
  })

  // A wake sent again under a waiting item's id delivers it with no new stamp, so a rest is read again within 30 s.
  test("keeps a rest answer 30 s from its read, then reads again; a running one until the next stamp", async () => {
    let messages: { type: string }[] = [{ type: "idle" }]
    let reads = 0
    const counted = {
      context: async () => {
        reads++
        return messages
      },
    } as any
    expect(await runs(counted, "ses_a", stamped, 100_000)).toBe(false)
    expect(await runs(counted, "ses_a", stamped, 129_999)).toBe(false)
    expect(reads).toBe(1)
    messages = [{ type: "idle" }, { type: "synthetic" }]
    expect(await runs(counted, "ses_a", stamped, 130_000)).toBe(true)
    expect(await runs(counted, "ses_a", stamped, 900_000)).toBe(true)
    expect(reads).toBe(2)
  })
})

describe("turnOf", () => {
  const session = (messages: unknown[]) => ({ context: async () => messages }) as any

  test("says when the last turn ended: its idle time, by the times or after an idle message", async () => {
    expect(await turnOf(session([]), "ses_a", { updated: 5, idle: 7 } as any)).toEqual({ running: false, endedAt: 7 })
    expect(await turnOf(session([{ type: "idle" }, { type: "model-switched" }]), "ses_a", { updated: 9, idle: 7 } as any)).toEqual({ running: false, endedAt: 7 })
  })

  test("or when the step a decline interrupted ended, past the last turn's idle time, or in a first turn with none", async () => {
    const declined = { type: "assistant", time: { created: 8, completed: 9 }, error: { type: "aborted" } }
    expect(await turnOf(session([{ type: "idle" }, { type: "user" }, declined]), "ses_a", { updated: 10, idle: 7 } as any)).toEqual({ running: false, endedAt: 9 })
    expect(await turnOf(session([{ type: "user" }, { ...declined, time: { created: 8 } }]), "ses_b", { updated: 10 } as any)).toEqual({ running: false, endedAt: 8 })
    expect(await turnOf(session([{ type: "user" }, { type: "assistant", error: { type: "aborted" } }]), "ses_c", { updated: 10 } as any)).toEqual({ running: false })
  })

  test("and nothing while a turn runs", async () => {
    expect(await turnOf(session([{ type: "idle" }, { type: "user" }]), "ses_a", { updated: 10, idle: 7 } as any)).toEqual({ running: true })
  })
})

describe("turnEnd and endedAt", () => {
  test("turnEnd is the message a transcript's last turn ended on, past asides; none while one runs", () => {
    const idle = { type: "idle" }
    const declined = { type: "assistant", error: { type: "aborted" } }
    expect(turnEnd([{ type: "user" }, idle, { type: "shell" }])).toBe(idle)
    expect(turnEnd([{ type: "user" }, declined])).toBe(declined)
    expect(turnEnd([idle, { type: "user" }])).toBeUndefined()
  })

  test("endedAt is the idle time for an idle message, else when the interrupted step ended, if its times are known", () => {
    expect(endedAt({ type: "idle", time: { created: 3 } }, { updated: 9, idle: 4 } as any)).toBe(4)
    expect(endedAt({ type: "assistant", time: { created: 6, completed: 8 } }, { updated: 9, idle: 4 } as any)).toBe(8)
    expect(endedAt({ type: "assistant", time: { created: DateTime.makeUnsafe(6) } }, { updated: 9 } as any)).toBe(6)
    expect(endedAt({ type: "assistant" }, { updated: 9 } as any)).toBeUndefined()
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
    const { ports, child } = limitPorts({ ...DEFAULT_LIMITS, maxDepth: 3 })
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
      await childStore(storage).prompted(id, 100)
    }
    await childStore(storage).settled("ses_a", "report", 150)
    if (c !== "silent") await childStore(storage).settled("ses_c", c, 150)
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
    await childStore(ports.storage).prompted("ses_a", 200)
    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(2, 2))
  })

  test("counts a child that reported early while its turn still runs", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1 })
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)
    await childStore(storage).settled("ses_a", "report", 150)
    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(1, 1))
  })

  test("not one that reported and that the person archived since, whose archive bumped its updated time (#324)", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1, maxTotal: 1 }, { ses_a: { ...FINISHED, updated: 9, archived: 9 } })
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)
    await childStore(storage).settled("ses_a", "report", 150)

    expect((await admit(ports, "ses_root")).depth).toBe(1)
  })

  test("nor one renamed, unarchived, switched or sent an item that waits in its inbox since, which bump its updated time too (#326)", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1, maxTotal: 1 }, { ses_a: { ...FINISHED, updated: 9 } })
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)
    await childStore(storage).settled("ses_a", "report", 150)

    expect((await admit(ports, "ses_root")).depth).toBe(1)
  })

  // OpenCode's inbox item is in no transcript until delivered, so the wake store says that a follow-up owes it a turn.
  test("but one that reported counts while a courier message sent with a wake waits in its inbox, and not once it is delivered", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1, maxTotal: 1 }, { ses_a: { ...FINISHED, updated: 9 } })
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)
    await childStore(storage).settled("ses_a", "report", 150)
    await wakeStore(storage).put({ sessionID: "ses_a", inboxID: "msg_more", at: 200, text: "more", running: false, idleAt: 200 })

    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(1, 1))
    await wakeStore(storage).remove("ses_a", "msg_more")
    expect((await admit(ports, "ses_root")).depth).toBe(1)
  })

  // #330: the enqueued event is handled after the send returns, so the spawn in the same step must not wait for it.
  test("and counts it as soon as courier_send returns, before OpenCode's enqueued event is handled (#330)", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1, maxTotal: 1 }, { ses_a: { ...FINISHED, updated: 9 } })
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)
    await childStore(storage).settled("ses_a", "report", 150)
    const sending = { ...ports, now: () => 200, nudge: () => undefined, log: () => undefined, session: { ...ports.session, synthetic: async () => ({ id: "msg_more" }) } }

    await send(sending as unknown as CourierPorts, "ses_root", { sessionID: "ses_a", message: "more" })

    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(1, 1))
    expect(await wakeStore(storage).of("ses_a")).toEqual([{ sessionID: "ses_a", inboxID: "msg_more", at: 200, text: expect.any(String), description: "Message from ses_root", running: false, idleAt: 200 }])
  })

  test("and a message delivered before courier_send could note it leaves no row behind (#330)", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1, maxTotal: 1 }, { ses_a: FINISHED })
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)
    await childStore(storage).settled("ses_a", "report", 150)
    const context = async () => [{ id: "msg_more", type: "user" }, { id: "msg_idle", type: "idle" }]
    const sending = { ...ports, now: () => 200, nudge: () => undefined, log: () => undefined, session: { ...ports.session, context, synthetic: async () => ({ id: "msg_more" }) } }

    await send(sending as unknown as CourierPorts, "ses_root", { sessionID: "ses_a", message: "more" })

    expect(await wakeStore(storage).of("ses_a")).toEqual([])
  })

  test("nor once the message is flagged stalled, which nothing wakes it for any more, as when its turn failed before", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1, maxTotal: 1 }, { ses_a: FINISHED })
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)
    await childStore(storage).settled("ses_a", "failed", 150)
    await wakeStore(storage).put({ sessionID: "ses_a", inboxID: "msg_more", at: 200, text: "more", running: false, idleAt: 200, rewoken: 300, stalled: 400 })

    expect((await admit(ports, "ses_root")).depth).toBe(1)
  })

  test("and counts when the messages waiting in its inbox cannot be read", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1, maxTotal: 1 }, { ses_a: FINISHED })
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)
    await childStore(storage).settled("ses_a", "report", 150)
    const scan = storage.scan
    storage.scan = async (input: { prefix: string }) => (input.prefix.startsWith("wake/") ? Promise.reject(new Error("db locked")) : scan(input))

    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(1, 1))
  })

  test("but one archived after reporting early, while its turn runs on between two steps, still counts", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1 }, { ses_a: { ...FINISHED, updated: 9, archived: 9 } }, ["ses_a"])
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)
    await childStore(storage).settled("ses_a", "report", 150)

    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(1, 1))
  })

  test("and an archived one that still owes a report counts, as it would unarchived", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1 }, { ses_a: { ...FINISHED, updated: 9, archived: 9 } })
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)

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
        context: async ({ sessionID }: { sessionID: string }) => [{ type: running.includes(sessionID) ? "assistant" : "idle" }],
      } as any,
    }
    const add = (parentID: string, sessionID: string) =>
      childStore(storage).record({ sessionID, parentID, title: sessionID, directory: "/repo", isolated: false, createdAt: 1 })
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
      forms: async () => [],
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

  test("points a session nobody spawned that has started none to the skill, with its tools as they are", async () => {
    const { shape } = contextPorts()
    const event = await shape("ses_alone")
    expect(event).toEqual({ sessionID: "ses_alone", tools: tools(), system: [{ type: "text", text: "base" }, { type: "text", text: rolePart(null, DEFAULT_LIMITS) }] })
    expect(event.system[1]!.text).toStartWith(ROLE_PREFIX)
    expect(event.system[1]!.text).toContain(SKILL_ID)
    expect(event.system[1]!.text).toContain(ROOT_SPLIT_LINE)
  })

  test("points no session that cannot spawn, such as one whose agent lacks the courier tools", async () => {
    const { ports } = contextPorts()
    const event = { sessionID: "ses_alone", tools: { courier_send: {}, read: {} }, system: [{ type: "text" as const, text: "base" }] }

    await shapeContext(ports, event)

    expect(event).toEqual({ sessionID: "ses_alone", tools: { courier_send: {}, read: {} }, system: [{ type: "text", text: "base" }] })
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
    const pointer = { type: "text" as const, text: rolePart(null, DEFAULT_LIMITS) }
    const root = { type: "text" as const, text: rolePart(0, DEFAULT_LIMITS) }
    expect((await shape("ses_root")).system.at(-1)).toEqual(pointer)
    await child("ses_root", "ses_a")
    expect((await shape("ses_root")).system.at(-1)).toEqual(pointer)

    ports.roles.delete("ses_root")
    expect((await shape("ses_root")).system).toEqual([{ type: "text", text: "base" }, root])

    storage.scan = async () => Promise.reject(new Error("not read again"))
    storage.get = async () => Promise.reject(new Error("not read again"))
    expect((await shape("ses_root")).system).toEqual([{ type: "text", text: "base" }, root])
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

    expect((await shape("ses_alone")).system.at(-1)).toEqual({ type: "text", text: rolePart(null, DEFAULT_LIMITS) })
    expect(scanned).toEqual(["roster/ses_alone/"])
    expect((await shape("ses_alone")).system).toHaveLength(2)
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

  test("adds no second role part or pointer, as a second copy of the plugin would", async () => {
    const { ports, child } = contextPorts()
    await child("ses_root", "ses_a")
    for (const sessionID of ["ses_a", "ses_alone"]) {
      const event = { sessionID, tools: tools(), system: [{ type: "text" as const, text: `${ROLE_PREFIX} other copy` }] }

      await shapeContext(ports, event)

      expect(event.system).toHaveLength(1)
    }
  })

  test("logs a failed lookup and leaves the request as it is", async () => {
    const { storage, shape, logged } = contextPorts()
    storage.get = async () => Promise.reject(new Error("db locked"))
    storage.scan = async () => Promise.reject(new Error("db locked"))

    expect((await shape("ses_a")).system).toHaveLength(1)
    expect(logged).toEqual(["courier: cannot tell the role of session ses_a: Error: db locked"])
  })
})
