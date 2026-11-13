import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { send } from "../src/tree/send.js"
import { spawn } from "../src/tree/spawn.js"
import { admit, liveBelow } from "../src/tree/limits.js"
import { shapeContext } from "../src/tree/context.js"
import { busy, DEFAULT_LIMITS, endedAt, endsIdle, nativeRootOf, readLimits, readNativeChildren, turnEnd, type RosterEntry } from "../src/tree/domain.js"
import { runs, turnOf } from "../src/tree/running.js"
import type { ContextPorts, CourierPorts, LimitPorts, Role, SpawnGate } from "../src/tree/ports.js"
import { ROOT_SPLIT_LINE, SKILL_ID } from "../src/kernel/protocol.js"
import { childBrief, depthRefusal, childrenRefusal, HOST_REPORTS, ROLE_KEY, ROLE_PREFIX, rolePart, STANDING_KEY, standingEntry, totalRefusal } from "../src/tree/text.js"
import { reportOf } from "../src/tree/report.js"
import { childStore, wakeStore } from "../src/tree/store.js"

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

function fakeInstructions(entries: Map<string, Map<string, unknown>>, calls: string[]) {
  return {
    entry: {
      put: async ({ sessionID, key, value }: { sessionID: string; key: string; value: unknown }) => {
        calls.push(`put ${sessionID} ${key}: ${String(value)}`)
        entries.set(sessionID, new Map(entries.get(sessionID)).set(key, value))
      },
      list: async ({ sessionID }: { sessionID: string }) => {
        calls.push(`list ${sessionID}`)
        return [...(entries.get(sessionID) ?? [])].map(([key, value]) => ({ key, value }))
      },
      remove: async ({ sessionID, key }: { sessionID: string; key: string }) => {
        calls.push(`remove ${sessionID} ${key}`)
        entries.get(sessionID)?.delete(key)
      },
    },
  }
}

const standingCalls = (parentID: string, ...children: Array<[string, string]>) => [
  `list ${parentID}`,
  `put ${parentID} ${STANDING_KEY}: ${standingEntry(children.map(([sessionID, title]) => ({ sessionID, title, state: { kind: "working" } })))}`,
]

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

async function chainTo(child: (parentID: string, sessionID: string) => Promise<void>, depth: number) {
  let parent = "ses_root"
  for (let level = 1; level <= depth; level++) {
    await child(parent, `ses_d${level}`)
    parent = `ses_d${level}`
  }
  return parent
}

describe("readLimits", () => {
  test("defaults to maxDepth 5, maxChildren 5 and maxTotal 30", () => {
    expect(readLimits(undefined)).toEqual({ limits: { maxDepth: 5, maxChildren: 5, maxTotal: 30 }, problems: [] })
    expect(readLimits({ memory: false })).toEqual({ limits: DEFAULT_LIMITS, problems: [] })
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
      "maxTotal must be a positive integer, not 2.5; using 30",
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

  describe("with the latest execution's start stamped (time.busy, OpenCode 2.2.2)", () => {
    const unread = session(new Error("not read"))
    const running = [...ended, { type: "user" }, { type: "assistant" }]
    const declined = [...ended, { type: "user" }, { type: "assistant", error: { type: "aborted" } }]

    test("at rest from the times alone, no transcript read, when it is not later than the last turn's end, whatever stamped updated since", async () => {
      expect(await runs(unread, "ses_a", { updated: 9, idle: 5, busy: 3 } as any)).toBe(false)
      expect(await runs(unread, "ses_a", { updated: 9, idle: 5, busy: 5 } as any)).toBe(false)
      expect(await runs(unread, "ses_a", { updated: 9, idle: 5, busy: 3, archived: 9 } as any)).toBe(false)
      expect(await turnOf(unread, "ses_a", { updated: 9, idle: 5, busy: 3 } as any)).toEqual({ running: false, endedAt: 5 })
    })

    test("and none of the caching: a read of rest is not kept, so a start stamped next is seen at once", async () => {
      let reads = 0
      const counted = { context: async () => (reads++, running) } as any
      expect(await runs(counted, "ses_a", { updated: 9, idle: 5, busy: 3 } as any, 100_000)).toBe(false)
      expect(await runs(counted, "ses_a", { updated: 9, idle: 5, busy: 9 } as any, 100_001)).toBe(true)
      expect(reads).toBe(1)
    })

    test("by the transcript when it is later: a plain decline leaves it so at rest, as it stamps no idle, and a turn runs on it", async () => {
      expect(await runs(session(declined), "ses_a", { updated: 9, idle: 5, busy: 7 } as any)).toBe(false)
      expect(await runs(session(running), "ses_a", { updated: 9, idle: 5, busy: 7 } as any)).toBe(true)
      expect(await runs(session([...ended, { type: "synthetic" }]), "ses_a", { updated: 5, idle: 5, busy: 7 } as any)).toBe(true)
      expect(await runs(session(ended), "ses_a", { updated: 5, idle: 5, busy: 7 } as any)).toBe(false)
    })

    test("in a first turn too, which no idle time marks, as a decline ends it", async () => {
      expect(await runs(session([{ type: "user" }, { type: "assistant" }]), "ses_a", { updated: 9, busy: 7 } as any)).toBe(true)
      expect(await runs(session([{ type: "user" }, { type: "assistant", error: { type: "aborted" } }] as any), "ses_a", { updated: 9, busy: 7 } as any)).toBe(false)
    })

    test("a new start is a new stamp: the transcript is read again for it, the other times unchanged", async () => {
      let reads = 0
      let messages = declined
      const counted = { context: async () => (reads++, messages) } as any
      expect(await runs(counted, "ses_a", { updated: 9, idle: 5, busy: 7 } as any, 100_000)).toBe(false)
      expect(await runs(counted, "ses_a", { updated: 9, idle: 5, busy: 7 } as any, 100_001)).toBe(false)
      expect(reads).toBe(1)
      messages = [...declined, { type: "synthetic" }]
      expect(await runs(counted, "ses_a", { updated: 9, idle: 5, busy: 12 } as any, 100_002)).toBe(true)
      expect(reads).toBe(2)
    })

    test("without it, a host before 2.2.2 or a session with no execution since the upgrade, the times and the transcript tell as before", async () => {
      expect(await runs(unread, "ses_a", { updated: 5, idle: 5 } as any)).toBe(false)
      expect(await runs(session(ended), "ses_a", stamped)).toBe(false)
      expect(await runs(session(running), "ses_a", stamped)).toBe(true)
    })
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
    const { ports, child } = limitPorts({ ...DEFAULT_LIMITS, maxDepth: 3 })
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

    await expect(admit(ports, "ses_b")).rejects.toThrow(totalRefusal(4, 4, 1))
    await expect(admit(ports, "ses_root")).rejects.toThrow(totalRefusal(4, 4, 2))
  })

  test("maxTotal: tells a session with none of its own running that only reports held for a group can wake it (#479, #526)", async () => {
    const { ports, child } = limitPorts({ ...DEFAULT_LIMITS, maxTotal: 3 })
    await child("ses_root", "ses_a")
    await child("ses_root", "ses_b")
    await child("ses_a", "ses_a1")

    const refused = admit(ports, "ses_b")
    await expect(refused).rejects.toThrow(totalRefusal(3, 3, 0))
    await expect(refused).rejects.toThrow("only reports already held for a group can still wake you")
    await expect(admit(ports, "ses_a")).rejects.toThrow(totalRefusal(3, 3, 1))
    await expect(admit(ports, "ses_a")).rejects.toThrow("answer any session you started that is blocked, end your turn and try again once one of them has reported, not in a loop.")
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

describe("a failed session with live sessions under it (#462)", () => {
  async function failedOver(times: Record<string, object>) {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1 }, { ses_a: FINISHED, ...times })
    await child("ses_root", "ses_a")
    await child("ses_a", "ses_g")
    await child("ses_g", "ses_gg")
    await child("ses_root", "ses_other")
    await child("ses_other", "ses_cousin")
    for (const id of ["ses_a", "ses_g", "ses_gg", "ses_other", "ses_cousin"]) await childStore(storage).prompted(id, 100)
    await childStore(storage).settled("ses_a", "failed", 150)
    await childStore(storage).settled("ses_other", "report", 150)
    return { ports, storage }
  }

  test("names every live session under it, at any depth, and none beside it", async () => {
    const { ports } = await failedOver({ ses_other: FINISHED })
    expect((await liveBelow(ports, "ses_a")).map((entry) => entry.title)).toEqual(["ses_g", "ses_gg"])
  })

  test("still counts toward its parent's limits, so a replacement is refused", async () => {
    const { ports } = await failedOver({ ses_other: FINISHED, ses_cousin: FINISHED })
    await childStore(ports.storage).settled("ses_cousin", "report", 150)
    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(1, 1))
  })

  test("names none and is not counted for one under it idle after a blocked report, which counts itself (#524)", async () => {
    const { ports, storage } = await failedOver({ ses_other: FINISHED, ses_cousin: FINISHED, ses_g: FINISHED, ses_gg: FINISHED })
    for (const id of ["ses_gg", "ses_cousin"]) await childStore(storage).settled(id, "report", 150)
    await childStore(storage).settled("ses_g", "report", 150, "blocked")
    expect(await liveBelow(ports, "ses_a")).toEqual([])
    expect((await admit(ports, "ses_root")).depth).toBe(1)
    await expect(admit(ports, "ses_a")).rejects.toThrow(childrenRefusal(1, 1))
  })

  test("names none and counts no more once nothing under it is live", async () => {
    const { ports, storage } = await failedOver({ ses_other: FINISHED, ses_cousin: FINISHED, ses_g: FINISHED, ses_gg: FINISHED })
    for (const id of ["ses_g", "ses_gg", "ses_cousin"]) await childStore(storage).settled(id, "report", 150)
    expect(await liveBelow(ports, "ses_a")).toEqual([])
    expect((await admit(ports, "ses_root")).depth).toBe(1)
  })
})

describe("admit, with children that owe a report", () => {
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
    await expect(admit(ports, "ses_b")).rejects.toThrow(totalRefusal(2, 2, 0))
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

  test("not one that reported while its turn still runs, so its parent can start the next in the turn the report starts (#511)", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1, maxTotal: 1 }, {}, ["ses_a"])
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)
    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(1, 1))
    await childStore(storage).settled("ses_a", "report", 150)
    expect((await admit(ports, "ses_root")).depth).toBe(1)
  })

  test("its courier_send notes the report before the parent can see it, so a spawn the report wakes is admitted (#511)", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1, maxTotal: 1 }, {}, ["ses_a"])
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)
    const admitted: number[] = []
    const synthetic = async () => {
      admitted.push((await admit(ports, "ses_root")).depth)
      return { id: "msg_report" }
    }
    const sending = { ...ports, now: () => 200, nudge: () => undefined, log: () => undefined, session: { ...ports.session, synthetic } }

    await send(sending as unknown as CourierPorts, "ses_a", { sessionID: "ses_root", message: "done", status: "done" })

    expect(admitted).toEqual([1])
  })

  test("but one whose turn ended after its report and that runs a new turn, such as one the person prompted (#511)", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1 }, { ses_a: { created: 1, updated: 300, idle: 200, busy: 300 } }, ["ses_a"])
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)
    await childStore(storage).settled("ses_a", "report", 150)
    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(1, 1))
  })

  test("but one whose report is blocked while its turn still runs (#511)", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1 }, {}, ["ses_a"])
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)
    await childStore(storage).settled("ses_a", "report", 150, "blocked")
    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(1, 1))
  })

  test("and one that reported while a session it started is live, until that one is not (#511)", async () => {
    const times: Record<string, object> = {}
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1, maxTotal: 3 }, times, ["ses_a"])
    await child("ses_root", "ses_a")
    await child("ses_a", "ses_g")
    for (const id of ["ses_a", "ses_g"]) await childStore(storage).prompted(id, 100)
    await childStore(storage).settled("ses_a", "report", 150)
    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(1, 1))
    times.ses_g = FINISHED
    await childStore(storage).settled("ses_g", "report", 160)
    expect((await admit(ports, "ses_root")).depth).toBe(1)
  })

  test("counts one that reported again once a message waits in its inbox (#511)", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1 }, {}, ["ses_a"])
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)
    await childStore(storage).settled("ses_a", "report", 150)
    await childStore(storage).prompted("ses_a", 200)
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

  test("and one idle after a blocked report, until it reports again (#524)", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1 }, { ses_a: FINISHED })
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)
    await childStore(storage).settled("ses_a", "report", 150, "blocked")
    await expect(admit(ports, "ses_root")).rejects.toThrow(childrenRefusal(1, 1))
    await childStore(storage).settled("ses_a", "report", 160)
    expect((await admit(ports, "ses_root")).depth).toBe(1)
  })

  test("and the refusal for one idle after a blocked report names courier_cleanup for it (#537)", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1 }, { ses_a: FINISHED })
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)
    await childStore(storage).settled("ses_a", "report", 150, "blocked")
    await expect(admit(ports, "ses_root")).rejects.toThrow(/one that is blocked, .* counts until it reports or you drop it with courier_cleanup\.$/)
  })

  test("but one archived after a blocked report, while its turn runs on between two steps, still counts", async () => {
    const { ports, child, storage } = limitPorts({ ...DEFAULT_LIMITS, maxChildren: 1 }, { ses_a: { ...FINISHED, updated: 9, archived: 9 } }, ["ses_a"])
    await child("ses_root", "ses_a")
    await childStore(storage).prompted("ses_a", 100)
    await childStore(storage).settled("ses_a", "report", 150, "blocked")

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
    await expect(admit(ports, "ses_r")).rejects.toThrow(totalRefusal(4, 3, 2))
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
  function spawnPorts(limits = DEFAULT_LIMITS, entries?: Map<string, Map<string, unknown>>) {
    const { ports, storage, gate, child } = limitPorts(limits)
    const calls: string[] = []
    const logged: string[] = []
    const roles = new Map<string, Role>([["ses_root", { depth: null, entry: false }]])
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
      defaultModel: async () => undefined,
      worktree: {},
      log: (message: string) => void logged.push(message),
      session: {
        ...ports.session,
        create: async () => {
          calls.push("session.create")
          return { id: `ses_new${++next}`, location: { directory: "/repo" } }
        },
        prompt: async (input: { text: string }) => void calls.push(input.text),
        ...(entries ? { instructions: fakeInstructions(entries, calls) } : {}),
      },
    } as unknown as CourierPorts
    return { courier, storage, gate, roles, calls, logged, child }
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

  test("writes the child's role entry before its prompt, and the root's own at its first spawn, once", async () => {
    const entries = new Map<string, Map<string, unknown>>()
    const { courier, calls, roles } = spawnPorts(DEFAULT_LIMITS, entries)

    await spawn(courier, "ses_root", { task: "t" })

    expect(calls).toEqual([
      "session.create",
      `put ses_new1 ${ROLE_KEY}: ${rolePart(1, DEFAULT_LIMITS)}`,
      `put ses_root ${ROLE_KEY}: ${rolePart(0, DEFAULT_LIMITS)}`,
      childBrief("ses_root", "t", 1, DEFAULT_LIMITS),
      ...standingCalls("ses_root", ["ses_new1", "t"]),
    ])
    expect(entries.get("ses_new1")?.get(ROLE_KEY)).toStartWith(ROLE_PREFIX)
    expect(roles.get("ses_root")).toEqual({ depth: 0, entry: true })
    calls.length = 0
    await spawn(courier, "ses_root", { task: "u" })
    expect(calls).toEqual([
      "session.create",
      `put ses_new2 ${ROLE_KEY}: ${rolePart(1, DEFAULT_LIMITS)}`,
      childBrief("ses_root", "u", 1, DEFAULT_LIMITS),
      ...standingCalls("ses_root", ["ses_new1", "t"], ["ses_new2", "u"]),
    ])
    expect(roles.get("ses_root")).toEqual({ depth: 0, entry: true })
  })

  test("a sub-orchestrator's spawn writes only the child's entry, and forgets the parent's role", async () => {
    const entries = new Map<string, Map<string, unknown>>()
    const { courier, calls, roles, child } = spawnPorts(DEFAULT_LIMITS, entries)
    await child("ses_root", "ses_a")
    roles.set("ses_a", { depth: 1, entry: true })

    await spawn(courier, "ses_a", { task: "t" })

    expect(calls).toEqual(["session.create", `put ses_new1 ${ROLE_KEY}: ${rolePart(2, DEFAULT_LIMITS)}`, childBrief("ses_a", "t", 2, DEFAULT_LIMITS), ...standingCalls("ses_a", ["ses_new1", "t"])])
    expect(roles.has("ses_a")).toBe(false)
  })

  describe("what OpenCode's own message at a native child's turn end is (#604)", () => {
    const rolePuts = (calls: string[], sessionID: string) => calls.filter((call) => call.startsWith(`put ${sessionID} ${ROLE_KEY}: `))

    test("with nativeChildren on, a child that can start sessions and the root get the text in their role entry, a leaf does not", async () => {
      const limits = { ...DEFAULT_LIMITS, maxDepth: 2 }
      const entries = new Map<string, Map<string, unknown>>()
      const { courier, calls } = spawnPorts(limits, entries)
      ;(courier as any).nativeChildren = true

      await spawn(courier, "ses_root", { task: "t" })
      await spawn(courier, "ses_new1", { task: "u" })

      expect(entries.get("ses_root")?.get(ROLE_KEY)).toBe(rolePart(0, limits, true))
      expect(entries.get("ses_new1")?.get(ROLE_KEY)).toBe(rolePart(1, limits, true))
      expect(entries.get("ses_new2")?.get(ROLE_KEY)).toBe(rolePart(2, limits))
      expect(String(entries.get("ses_new2")?.get(ROLE_KEY))).not.toContain(HOST_REPORTS)
      expect(rolePuts(calls, "ses_root")).toHaveLength(1)
      expect(new Set(rolePuts(calls, "ses_new1"))).toEqual(new Set([`put ses_new1 ${ROLE_KEY}: ${rolePart(1, limits, true)}`]))
    })

    test("with it on, a child spawned with native: false or isolate still tells its parent, which can start a native one", async () => {
      const entries = new Map<string, Map<string, unknown>>()
      const { courier } = spawnPorts(DEFAULT_LIMITS, entries)
      ;(courier as any).nativeChildren = true

      await spawn(courier, "ses_root", { task: "t", native: false })

      expect(entries.get("ses_root")?.get(ROLE_KEY)).toBe(rolePart(0, DEFAULT_LIMITS, true))
    })

    test("with it off and no native child, nobody gets the text", async () => {
      const entries = new Map<string, Map<string, unknown>>()
      const { courier } = spawnPorts(DEFAULT_LIMITS, entries)

      await spawn(courier, "ses_root", { task: "t" })
      await spawn(courier, "ses_new1", { task: "u" })

      for (const sessionID of ["ses_root", "ses_new1", "ses_new2"]) expect(String(entries.get(sessionID)?.get(ROLE_KEY))).not.toContain(HOST_REPORTS)
    })

    test("with it off, native: true at the root's first spawn puts the text in the root's entry, and the child's has none", async () => {
      const entries = new Map<string, Map<string, unknown>>()
      const { courier, calls } = spawnPorts(DEFAULT_LIMITS, entries)

      await spawn(courier, "ses_root", { task: "t", native: true })

      expect(rolePuts(calls, "ses_root")).toEqual([`put ses_root ${ROLE_KEY}: ${rolePart(0, DEFAULT_LIMITS, true)}`])
      expect(entries.get("ses_new1")?.get(ROLE_KEY)).toBe(rolePart(1, DEFAULT_LIMITS))
    })

    test("with it off, a session's first native child renews its role entry with the text, and every later spawn carries the same bytes", async () => {
      const entries = new Map<string, Map<string, unknown>>()
      const { courier, calls, roles } = spawnPorts(DEFAULT_LIMITS, entries)
      const told = `put ses_root ${ROLE_KEY}: ${rolePart(0, DEFAULT_LIMITS, true)}`

      await spawn(courier, "ses_root", { task: "t" })
      expect(rolePuts(calls, "ses_root")).toEqual([`put ses_root ${ROLE_KEY}: ${rolePart(0, DEFAULT_LIMITS)}`])
      await spawn(courier, "ses_root", { task: "u", native: true })
      expect(rolePuts(calls, "ses_root").slice(1)).toEqual([told])
      await spawn(courier, "ses_root", { task: "v" })
      await spawn(courier, "ses_root", { task: "w", native: true })
      expect(rolePuts(calls, "ses_root").slice(1)).toEqual([told, told])

      roles.delete("ses_root")
      await spawn(courier, "ses_root", { task: "x" })
      expect(rolePuts(calls, "ses_root").slice(1)).toEqual([told, told, told])
      expect(entries.get("ses_root")?.get(ROLE_KEY)).toBe(rolePart(0, DEFAULT_LIMITS, true))
    })

    test("with it off, a sub-orchestrator's native child renews the sub-orchestrator's entry at its own depth", async () => {
      const entries = new Map<string, Map<string, unknown>>()
      const { courier, calls, roles, child } = spawnPorts(DEFAULT_LIMITS, entries)
      await child("ses_root", "ses_a")

      await spawn(courier, "ses_a", { task: "t", native: true })

      expect(rolePuts(calls, "ses_a")).toEqual([`put ses_a ${ROLE_KEY}: ${rolePart(1, DEFAULT_LIMITS, true)}`])
      expect(roles.get("ses_a")).toEqual({ depth: 1, entry: true })
      expect(entries.get("ses_new1")?.get(ROLE_KEY)).toBe(rolePart(2, DEFAULT_LIMITS))
    })

    test("the text names the courier's child only: not a subagent started with OpenCode's tool, nor a session cleaned up", () => {
      expect(HOST_REPORTS).toContain("a session you started with courier_spawn as your OpenCode subagent")
      expect(HOST_REPORTS).toEndWith(
        "This holds only for sessions you started with courier_spawn and have not removed with courier_cleanup: the <subagent> message of a subagent you started with OpenCode's subagent tool is that subagent's result.",
      )
      expect(HOST_REPORTS).not.toContain("\n")
      for (const depth of [DEFAULT_LIMITS.maxDepth, null]) expect(rolePart(depth, DEFAULT_LIMITS, true)).toBe(rolePart(depth, DEFAULT_LIMITS))
      for (const depth of [0, 1, 2]) expect(rolePart(depth, DEFAULT_LIMITS, true)).toBe(`${rolePart(depth, DEFAULT_LIMITS)}\n${HOST_REPORTS}`)
    })
  })

  test("on a host without keyed instructions writes no entry: the context hook adds the part", async () => {
    const { courier, calls, roles } = spawnPorts()

    await spawn(courier, "ses_root", { task: "t" })

    expect(calls).toEqual(["session.create", childBrief("ses_root", "t", 1, DEFAULT_LIMITS)])
    expect(roles.has("ses_root")).toBe(false)
  })

  test("a failed put is logged, the child still gets its task, and the root's role is forgotten rather than marked", async () => {
    const entries = new Map<string, Map<string, unknown>>()
    const { courier, calls, roles, logged } = spawnPorts(DEFAULT_LIMITS, entries)
    ;(courier.session as any).instructions.entry.put = async () => Promise.reject(new Error("no such route"))

    await spawn(courier, "ses_root", { task: "t" })

    expect(calls).toEqual(["session.create", childBrief("ses_root", "t", 1, DEFAULT_LIMITS), "list ses_root"])
    expect(logged).toEqual([
      "courier_spawn: the role entry of ses_new1 could not be written, so its role goes in a system part: Error: no such route",
      "courier_spawn: the role entry of ses_root could not be written, so its role goes in a system part: Error: no such route",
      "courier: the standing entry of ses_root could not be written, so it may be behind courier_children: Error: no such route",
    ])
    expect(roles.has("ses_root")).toBe(false)
  })

  test("writes the entries the other modules supply after the role, to a child below maxDepth and to the root at its first spawn", async () => {
    const limits = { ...DEFAULT_LIMITS, maxDepth: 2 }
    const entries = new Map<string, Map<string, unknown>>()
    const { courier, calls, child } = spawnPorts(limits, entries)
    let lessons = "opencode-courier lessons: one"
    ;(courier as any).entries = async () => [{ key: "lessons", value: lessons }]

    await spawn(courier, "ses_root", { task: "t" })

    expect(calls).toEqual([
      "session.create",
      `put ses_new1 ${ROLE_KEY}: ${rolePart(1, limits)}`,
      "put ses_new1 lessons: opencode-courier lessons: one",
      `put ses_root ${ROLE_KEY}: ${rolePart(0, limits)}`,
      "put ses_root lessons: opencode-courier lessons: one",
      childBrief("ses_root", "t", 1, limits),
      ...standingCalls("ses_root", ["ses_new1", "t"]),
    ])
    calls.length = 0
    lessons = "opencode-courier lessons: two"
    await spawn(courier, "ses_root", { task: "u" })
    expect(calls.filter((call) => call.includes("lessons"))).toEqual(["put ses_new2 lessons: opencode-courier lessons: two"])
    calls.length = 0
    await child("ses_root", "ses_a")
    await spawn(courier, "ses_a", { task: "v" })
    expect(calls.filter((call) => call.includes("lessons"))).toEqual([])
    expect(calls[1]).toBe(`put ses_new3 ${ROLE_KEY}: ${rolePart(2, limits)}`)
  })

  test("a supplier that fails leaves the session with its role alone, logged; without keyed instructions it is not asked", async () => {
    const entries = new Map<string, Map<string, unknown>>()
    const { courier, calls, logged } = spawnPorts(DEFAULT_LIMITS, entries)
    ;(courier as any).entries = async () => Promise.reject(new Error("db locked"))

    await spawn(courier, "ses_root", { task: "t" })

    expect(calls.filter((call) => call.startsWith("put"))).toEqual([
      `put ses_new1 ${ROLE_KEY}: ${rolePart(1, DEFAULT_LIMITS)}`,
      `put ses_root ${ROLE_KEY}: ${rolePart(0, DEFAULT_LIMITS)}`,
      standingCalls("ses_root", ["ses_new1", "t"])[1]!,
    ])
    expect(logged).toEqual(["courier_spawn: the entries of the other modules could not be read, so the session starts without them: Error: db locked"])
    const asked: number[] = []
    const { courier: older, calls: olderCalls } = spawnPorts()
    ;(older as any).entries = async () => (asked.push(1), [{ key: "lessons", value: "x" }])
    await spawn(older, "ses_root", { task: "t" })
    expect(asked).toEqual([])
    expect(olderCalls).toEqual(["session.create", childBrief("ses_root", "t", 1, DEFAULT_LIMITS)])
  })

  test("the standing is not put again when the entry already holds it", async () => {
    const entries = new Map<string, Map<string, unknown>>()
    const { courier, calls, logged } = spawnPorts(DEFAULT_LIMITS, entries)
    await spawn(courier, "ses_root", { task: "t" })
    expect(entries.get("ses_root")?.get(STANDING_KEY)).toStartWith("opencode-courier standing:")
    calls.length = 0
    entries.get("ses_root")!.set(STANDING_KEY, standingEntry([{ sessionID: "ses_new1", title: "t", state: { kind: "working" } }, { sessionID: "ses_new2", title: "u", state: { kind: "working" } }]))

    await spawn(courier, "ses_root", { task: "u" })

    expect(calls.filter((call) => call.includes(STANDING_KEY))).toEqual([])
    expect(logged).toEqual([])
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

  function contextPorts(limits = DEFAULT_LIMITS, entries?: Map<string, Map<string, unknown>>) {
    const { storage, child } = limitPorts(limits)
    const logged: string[] = []
    const calls: string[] = []
    const parents = new Map<string, string>()
    const ports: ContextPorts = {
      storage,
      limits,
      roles: new Map(),
      session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, ...(parents.has(sessionID) ? { parentID: parents.get(sessionID) } : {}) }) } as any,
      ...(entries ? { instructions: fakeInstructions(entries, calls) as unknown as ContextPorts["instructions"] } : {}),
      log: (message) => void logged.push(message),
    }
    const shape = async (sessionID: string, base = "base") => {
      const event = { sessionID, tools: tools() as Record<string, unknown>, system: [{ type: "text" as const, text: base }] }
      await shapeContext(ports, event)
      return event
    }
    return { ports, storage, child, shape, logged, calls, parents }
  }

  const baseline = (depth: number) => `AGENTS.md says so.\n\n<context key="${ROLE_KEY}">\n${rolePart(depth, DEFAULT_LIMITS)}\n</context>`

  test("adds no part for a session whose role entry is listed, reading the entries once per session", async () => {
    const entries = new Map([["ses_d1", new Map([[ROLE_KEY, rolePart(1, DEFAULT_LIMITS)]])]])
    const { shape, child, calls, ports } = contextPorts(DEFAULT_LIMITS, entries)
    await chainTo(child, 1)

    expect((await shape("ses_d1")).system).toEqual([{ type: "text", text: "base" }])
    expect((await shape("ses_d1", baseline(1))).system).toEqual([{ type: "text", text: baseline(1) }])
    expect(calls).toEqual(["list ses_d1"])
    expect(ports.roles.get("ses_d1")).toEqual({ depth: 1, entry: true })
  })

  describe("the role part of a session whose entry could not be written, and OpenCode's own message at a turn end (#604)", () => {
    const native = (storage: Parameters<typeof childStore>[0], parentID: string, sessionID: string) =>
      childStore(storage).record({ sessionID, parentID, title: sessionID, directory: "/repo", isolated: false, createdAt: 1, native: true })

    test("carries the text, the same bytes on two requests, for a session with a native child", async () => {
      const { shape, child, storage } = contextPorts()
      await chainTo(child, 1)
      await native(storage, "ses_d1", "ses_kid")

      const [first, second] = [await shape("ses_d1"), await shape("ses_d1")]

      expect(first.system.at(-1)).toEqual({ type: "text", text: rolePart(1, DEFAULT_LIMITS, true) })
      expect(second.system.at(-1)?.text).toBe(first.system.at(-1)!.text)
      expect((await shape("ses_root")).system.at(-1)?.text).toBe(rolePart(0, DEFAULT_LIMITS))
    })

    test("carries it with nativeChildren on for a session that can start one, not for a leaf, the native child itself or a session outside a tree", async () => {
      const limits = { ...DEFAULT_LIMITS, maxDepth: 2 }
      const { ports, child } = contextPorts(limits)
      await chainTo(child, 2)
      const shape = async (sessionID: string) => {
        const event = { sessionID, tools: tools() as Record<string, unknown>, system: [{ type: "text" as const, text: "base" }] }
        await shapeContext({ ...ports, nativeChildren: true }, event)
        return event.system.at(-1)!.text
      }

      for (const _ of [1, 2]) expect(await shape("ses_root")).toBe(rolePart(0, limits, true))
      expect(await shape("ses_d1")).toBe(rolePart(1, limits, true))
      expect(await shape("ses_d2")).toBe(rolePart(2, limits))
      expect(await shape("ses_d2")).not.toContain(HOST_REPORTS)
      expect(await shape("ses_alone")).toBe(rolePart(null, limits))
    })

    test("leaves it out with nativeChildren off and no native child", async () => {
      const { shape, child } = contextPorts()
      await chainTo(child, 2)

      for (const [sessionID, depth] of [["ses_root", 0], ["ses_d1", 1], ["ses_d2", 2]] as const)
        expect((await shape(sessionID)).system.at(-1)).toEqual({ type: "text", text: rolePart(depth, DEFAULT_LIMITS) })
    })
  })

  test("adds the part, the same on every request, when the entries hold no role, and reads them once", async () => {
    const entries = new Map([["ses_d1", new Map([["other", "x"]])]])
    const { shape, child, calls } = contextPorts(DEFAULT_LIMITS, entries)
    await chainTo(child, 1)

    for (const _ of [1, 2]) expect((await shape("ses_d1")).system).toEqual([{ type: "text", text: "base" }, { type: "text", text: rolePart(1, DEFAULT_LIMITS) }])
    expect(calls).toEqual(["list ses_d1"])
  })

  test("reads no entries for a session nobody spawned that has started none, and points it to the skill", async () => {
    const { shape, calls } = contextPorts(DEFAULT_LIMITS, new Map())

    expect((await shape("ses_alone")).system.at(-1)).toEqual({ type: "text", text: rolePart(null, DEFAULT_LIMITS) })
    expect(calls).toEqual([])
  })

  test("adds no second part when the baseline already carries the entry's block, with or without the entries to read", async () => {
    const { shape, child } = contextPorts()
    await chainTo(child, 1)
    const listed = contextPorts(DEFAULT_LIMITS, new Map())
    await chainTo(listed.child, 1)

    expect((await shape("ses_d1", baseline(1))).system).toEqual([{ type: "text", text: baseline(1) }])
    expect((await listed.shape("ses_d1", baseline(1))).system).toEqual([{ type: "text", text: baseline(1) }])
  })

  test("hides the tools from a leaf whose entry names it, as from one without", async () => {
    const entries = new Map([["ses_d2", new Map([[ROLE_KEY, rolePart(2, DEFAULT_LIMITS)]])]])
    const { ports, child } = contextPorts({ ...DEFAULT_LIMITS, maxDepth: 2 }, entries)
    ports.roles.set("ses_d2", { depth: 2, entry: true })
    await chainTo(child, 2)
    const event = { sessionID: "ses_d2", tools: { ...tools(), courier_recall: {}, courier_note: {} }, system: [{ type: "text" as const, text: baseline(2) }] }

    await shapeContext({ ...ports, hiddenFromLeaf: ["courier_recall", "courier_note"] }, event)

    expect(Object.keys(event.tools)).toEqual(["courier_send", "read"])
    expect(event.system).toEqual([{ type: "text", text: baseline(2) }])
  })

  test("a failed entry read is logged, and the part added as on a host without entries", async () => {
    const { ports, shape, child, logged } = contextPorts(DEFAULT_LIMITS, new Map())
    await chainTo(child, 1)
    ;(ports.instructions as any).entry.list = async () => Promise.reject(new Error("db locked"))

    expect((await shape("ses_d1")).system).toEqual([{ type: "text", text: "base" }, { type: "text", text: rolePart(1, DEFAULT_LIMITS) }])
    expect(logged).toEqual(["courier: cannot read the instruction entries of session ses_d1, so its role goes in a system part: Error: db locked"])
  })

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

  test("tells the root orchestrator to load the skill if it is not in its context, as the other orchestrators are told", () => {
    expect(rolePart(0, DEFAULT_LIMITS)).toEndWith(`Load the ${SKILL_ID} skill if it is not in your context.`)
    expect(rolePart(1, DEFAULT_LIMITS)).toContain(`load the ${SKILL_ID} skill`)
    expect(rolePart(null, DEFAULT_LIMITS)).toContain(`${SKILL_ID} skill`)
  })

  test("sets each split-line form in backticks, in the root's role line and the brief", () => {
    const forms = ["`split: no, because …; considered: <the parts you weighed>`", "`split: <n> parts: …`", "`split: 1 part: <the task>, to keep my context`"]
    expect(rolePart(null, DEFAULT_LIMITS)).toEndWith(`${forms[0]} or ${forms[1]} (one phrase per part) or ${forms[2]}.`)
    const brief = childBrief("ses_root", "t", 1, DEFAULT_LIMITS)
    expect(brief).toContain(`${forms[0]} or ${forms[1]} (one phrase per part).`)
    expect(brief).not.toContain(forms[2])
  })

  test("the maxChildren and maxTotal refusals say not to retry in a loop, and what still counts (#511, #525)", () => {
    const counts = "A session also counts while one it started is live, and one that is blocked, or whose turn ended without a report unless it failed or was interrupted, counts until it reports or"
    expect(childrenRefusal(2, 2)).toContain("2 sessions you started are running, blocked or still owe a report")
    expect(childrenRefusal(2, 2)).toEndWith(
      `start it once one of them has reported, not in a loop. ${counts} you drop it with courier_cleanup.`,
    )
    expect(totalRefusal(4, 4, 1)).toEndWith(
      `try again once one of them has reported, not in a loop. ${counts} its parent drops it with courier_cleanup.`,
    )
    expect(childrenRefusal(1, 1)).not.toContain("turn has ended")
    expect(totalRefusal(4, 4, 1)).not.toContain("turn has ended")
  })

  test("the maxChildren and maxTotal refusals say to answer a blocked child before waiting for a report (#534)", () => {
    expect(childrenRefusal(2, 2)).toContain("or answer any of them that is blocked, end your turn and start it once one of them has reported")
    expect(totalRefusal(4, 4, 1)).toContain("or answer any session you started that is blocked, end your turn and try again")
    expect(totalRefusal(4, 4, 0)).not.toContain("blocked, end your turn")
  })

  test("the maxTotal refusal to a session with none of its own running says to do the part itself", () => {
    const refusal = totalRefusal(4, 4, 0)
    expect(refusal).toEndWith("Do this part yourself: none of the sessions you started counts, so only reports already held for a group can still wake you.")
    expect(refusal).not.toContain("end your turn")
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

  const leafTools = () => ({ ...tools(), courier_recall: {}, courier_note: {} })

  test("gives an OpenCode subagent of a tree's session no role part and, as a leaf, no courier_spawn, courier_recall or courier_note", async () => {
    const { ports, child, parents } = contextPorts()
    await chainTo(child, 1)
    parents.set("ses_sub", "ses_d1")
    const event = { sessionID: "ses_sub", tools: leafTools() as Record<string, unknown>, system: [{ type: "text" as const, text: "base" }] }

    await shapeContext({ ...ports, hiddenFromLeaf: ["courier_recall", "courier_note"] }, event)

    expect(Object.keys(event.tools)).toEqual(["courier_send", "read"])
    expect(event.system).toEqual([{ type: "text", text: "base" }])
    expect(ports.roles.get("ses_sub")).toEqual({ depth: null, entry: false, subagent: true })
  })

  test("treats as subagents those of the tree's top and of a subagent in the tree, and leaves a native courier child its role", async () => {
    const { shape, child, parents } = contextPorts()
    await chainTo(child, 1)
    parents.set("ses_d1", "ses_root")
    parents.set("ses_top_sub", "ses_root")
    parents.set("ses_sub", "ses_d1")
    parents.set("ses_sub_sub", "ses_sub")

    for (const sessionID of ["ses_top_sub", "ses_sub_sub"]) {
      const event = await shape(sessionID)
      expect(Object.keys(event.tools)).toEqual(["courier_send", "read"])
      expect(event.system).toEqual([{ type: "text", text: "base" }])
    }
    expect((await shape("ses_d1")).system).toEqual([{ type: "text", text: "base" }, { type: "text", text: rolePart(1, DEFAULT_LIMITS) }])
  })

  test("leaves an OpenCode subagent of a session outside any tree a root, and finds it a subagent once its parent spawns", async () => {
    const { ports, shape, child, parents } = contextPorts()
    parents.set("ses_sub", "ses_alone")

    const before = await shape("ses_sub")
    expect(Object.keys(before.tools)).toEqual(["courier_spawn", "courier_send", "read"])
    expect(before.system.at(-1)).toEqual({ type: "text", text: rolePart(null, DEFAULT_LIMITS) })
    expect(ports.roles.has("ses_sub")).toBe(false)

    await child("ses_alone", "ses_a")
    ports.roles.delete("ses_alone")
    const after = await shape("ses_sub")
    expect(Object.keys(after.tools)).toEqual(["courier_send", "read"])
    expect(after.system).toEqual([{ type: "text", text: "base" }])
  })

  test("ends a loop of OpenCode parents as a root", async () => {
    const { shape, parents } = contextPorts()
    parents.set("ses_x", "ses_y")
    parents.set("ses_y", "ses_x")

    expect((await shape("ses_x")).system.at(-1)).toEqual({ type: "text", text: rolePart(null, DEFAULT_LIMITS) })
  })

  test("logs a failed session read and leaves the request as it is", async () => {
    const { ports, shape, logged } = contextPorts()
    ;(ports.session as any).get = async () => Promise.reject(new Error("gone"))

    expect(await shape("ses_a")).toEqual({ sessionID: "ses_a", tools: tools(), system: [{ type: "text", text: "base" }] })
    expect(logged).toEqual(["courier: cannot tell the role of session ses_a: Error: gone"])
  })

  test("logs a failed lookup and leaves the request as it is", async () => {
    const { storage, shape, logged } = contextPorts()
    storage.get = async () => Promise.reject(new Error("db locked"))
    storage.scan = async () => Promise.reject(new Error("db locked"))

    expect((await shape("ses_a")).system).toHaveLength(1)
    expect(logged).toEqual(["courier: cannot tell the role of session ses_a: Error: db locked"])
  })
})
