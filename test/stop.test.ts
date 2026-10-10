import { describe, expect, test } from "bun:test"
import { DEFAULT_LIMITS } from "../src/limits.js"
import { joinGroup, memberKey } from "../src/group.js"
import { schedule } from "../src/later.js"
import { stoppedNotice, stopText, treeText } from "../src/notices.js"
import { progressKey, promptKey, settledKey, stoppedKey, stoppedSincePrompt } from "../src/report.js"
import { record, type RosterEntry } from "../src/roster.js"
import { stop, type StopPorts } from "../src/stop.js"
import { subtree, tree } from "../src/tree.js"

type Call = { method: string; input: any }

const entry = (sessionID: string, parentID: string, createdAt: number, more: Partial<RosterEntry> = {}): RosterEntry => ({
  sessionID,
  parentID,
  title: `title ${sessionID}`,
  directory: "/repo",
  isolated: false,
  createdAt,
  ...more,
})

/** A root with a middle session, two leaves under it and a sibling of the middle one. */
async function fixture(options: { idle?: string[]; missing?: string[]; failing?: string[]; inspect?: (directory: string) => any } = {}) {
  const store = new Map<string, unknown>()
  const calls: Call[] = []
  const logs: string[] = []
  const storage = {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => void store.set(key, value),
    remove: async (key: string) => void store.delete(key),
    scan: async ({ prefix }: { prefix: string }) => ({
      entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    }),
  }
  const session = {
    interrupt: async (input: any) => {
      calls.push({ method: "interrupt", input })
      if (options.missing?.includes(input.sessionID)) throw { _tag: "Session.NotFoundError", sessionID: input.sessionID }
      if (options.failing?.includes(input.sessionID)) throw new Error("boom")
      return { interrupted: !options.idle?.includes(input.sessionID) }
    },
    synthetic: async (input: any) => {
      calls.push({ method: "synthetic", input })
      return { id: "msg" }
    },
    get: async ({ sessionID }: any) => ({ id: sessionID, title: `title ${sessionID}`, time: { created: 1, updated: 2, idle: 2 } }),
    context: async () => [],
  }
  const nudges: number[] = []
  const courier = {
    storage,
    session,
    limits: { ...DEFAULT_LIMITS, maxTotal: 20 },
    now: () => 5_000,
    log: (message: string) => void logs.push(message),
    nudge: () => void nudges.push(1),
    pending: async () => [],
  }
  const later = { storage, session, now: () => 5_000, newID: (() => { let n = 0; return () => `later_${++n}` })(), log: courier.log }
  const removed: any[] = []
  const cleanupPorts = {
    storage,
    projectID: "proj",
    nudge: courier.nudge,
    worktree: { remove: async (input: any) => void removed.push(input) },
    inspect: async (directory: string) => (options.inspect ? options.inspect(directory) : { changes: [], commits: [] }),
  }
  const ports = { courier, later, cleanup: cleanupPorts } as unknown as StopPorts
  const entries = [
    entry("mid", "root", 1, { isolated: true, directory: "/wt/mid", group: "g" }),
    entry("side", "root", 2),
    entry("leaf1", "mid", 3, { isolated: true, directory: "/wt/leaf1" }),
    entry("leaf2", "mid", 4),
  ]
  for (const one of entries) await record(storage as any, one)
  return { ports, store, calls, logs, removed, nudges }
}

describe("subtree", () => {
  test("lists each session before what it started, siblings oldest first, with depths", async () => {
    const { ports } = await fixture()

    const { nodes, truncated } = await subtree(ports.courier.storage, "root")

    expect(nodes.map((node) => [node.entry.sessionID, node.depth])).toEqual([["mid", 1], ["leaf1", 2], ["leaf2", 2], ["side", 1]])
    expect(truncated).toBe(false)
  })

  test("is cut at max, and says so", async () => {
    const { ports } = await fixture()

    const { nodes, truncated } = await subtree(ports.courier.storage, "root", 3)

    expect(nodes.map((node) => node.entry.sessionID).sort()).toEqual(["leaf1", "mid", "side"])
    expect(truncated).toBe(true)
  })

  test("reads one prefix per parent, never the whole roster", async () => {
    const { ports } = await fixture()
    const prefixes: string[] = []
    const scan = ports.courier.storage.scan
    ;(ports.courier.storage as any).scan = async (input: any) => (prefixes.push(input.prefix), scan(input))

    await subtree(ports.courier.storage, "root")

    expect(prefixes.sort()).toEqual(["roster/leaf1/", "roster/leaf2/", "roster/mid/", "roster/root/", "roster/side/"])
  })

  test("does not loop on a roster that names a session twice", async () => {
    const { ports } = await fixture()
    await record(ports.courier.storage as any, entry("root", "leaf2", 9))

    const { nodes } = await subtree(ports.courier.storage, "root")

    expect(nodes.map((node) => node.entry.sessionID)).toEqual(["mid", "leaf1", "leaf2", "side"])
  })
})

describe("tree", () => {
  test("gives each session its status, depth, parent, group standing, report state and isolation", async () => {
    const { ports, store } = await fixture()
    await joinGroup(ports.courier.storage, "root", "g", "mid", "title mid", 1)
    store.set(promptKey("mid"), { at: 10 })
    store.set(settledKey("mid"), { at: 20, by: "report", status: "partial" })
    store.set(progressKey("mid"), { at: 15 })
    store.set(promptKey("leaf2"), { at: 10 })

    const result = await tree(ports.courier, "root")

    expect(result.sessionID).toBe("root")
    expect(result.sessions.map((one) => [one.sessionID, one.depth, one.parentID])).toEqual([
      ["mid", 1, "root"],
      ["leaf1", 2, "mid"],
      ["leaf2", 2, "mid"],
      ["side", 1, "root"],
    ])
    const [mid, leaf1, leaf2] = result.sessions
    expect(mid).toMatchObject({ isolated: true, group: { name: "g", report: "out" }, report: { owes: false, progressed: true, ended: false, status: "partial" } })
    expect(leaf1).not.toHaveProperty("report")
    expect(leaf2).toMatchObject({ isolated: false, report: { owes: true, progressed: false, ended: false } })
    expect(Object.values(mid!).includes(undefined)).toBe(false)
  })

  test("is cut at maxTotal", async () => {
    const { ports } = await fixture()
    ;(ports.courier.limits as any).maxTotal = 2

    const result = await tree(ports.courier, "root")

    expect(result.sessions).toHaveLength(2)
    expect(result.truncated).toBe(2)
    expect(treeText(result)).toContain("Only the first 2 sessions are listed")
  })

  test("is empty for a session that started none", async () => {
    const { ports } = await fixture()

    const result = await tree(ports.courier, "side")

    expect(treeText(result)).toBe("No sessions started with courier_spawn.")
  })
})

describe("stop", () => {
  test("interrupts the session and everything under it, deepest first", async () => {
    const { ports, calls } = await fixture()

    const result = await stop(ports, "root", { sessionID: "mid" })

    const order = calls.filter((call) => call.method === "interrupt").map((call) => call.input.sessionID)
    expect(order.indexOf("mid")).toBe(2)
    expect(order.slice(0, 2).sort()).toEqual(["leaf1", "leaf2"])
    expect(order).not.toContain("side")
    expect(result.stopped.map((one) => [one.sessionID, one.depth, one.outcome])).toEqual([
      ["leaf1", 1, "interrupted"],
      ["leaf2", 1, "interrupted"],
      ["mid", 0, "interrupted"],
    ])
  })

  test("settles each stopped session as interrupted and notes the stop", async () => {
    const { ports, store } = await fixture()

    await stop(ports, "root", { sessionID: "mid" })

    for (const id of ["mid", "leaf1", "leaf2"]) {
      expect(store.get(settledKey(id))).toMatchObject({ by: "interrupted" })
      expect(store.get(stoppedKey(id))).toEqual({ at: 5_000 })
    }
    expect(store.has(stoppedKey("side"))).toBe(false)
  })

  test("a stop counts only until the session is prompted again", async () => {
    const { ports, store } = await fixture()
    await stop(ports, "root", { sessionID: "mid" })
    expect(await stoppedSincePrompt(ports.courier.storage as any, "leaf1")).toBe(true)

    store.set(promptKey("leaf1"), { at: 6_000 })

    expect(await stoppedSincePrompt(ports.courier.storage as any, "leaf1")).toBe(false)
  })

  test("does not tell the caller of what it stopped", async () => {
    const { ports, calls } = await fixture()

    const result = await stop(ports, "root", { sessionID: "mid" })

    expect(calls.filter((call) => call.method === "synthetic")).toEqual([])
    expect(result.told).toBeUndefined()
  })

  test("tells the parent of the target once when it is below the caller, and not the sessions that are stopped too", async () => {
    const { ports, calls } = await fixture()

    const result = await stop(ports, "root", { sessionID: "leaf1" })

    const told = calls.filter((call) => call.method === "synthetic")
    expect(told).toHaveLength(1)
    expect(told[0]!.input).toMatchObject({
      sessionID: "mid",
      delivery: "steer",
      metadata: { source: "courier", from: "leaf1", ended: "stopped" },
    })
    expect(told[0]!.input.text).toContain('<courier from="leaf1" ended="stopped">')
    expect(told[0]!.input.text).toContain(stoppedNotice("title leaf1", "root"))
    expect(result.told).toBe("mid")
  })

  test("tells no one when the target's parent is the caller and the target's own children are stopped", async () => {
    const { ports, calls } = await fixture()

    await stop(ports, "root", { sessionID: "mid" })

    expect(calls.some((call) => call.method === "synthetic")).toBe(false)
  })

  test("does not tell a parent of a target that was not running", async () => {
    const { ports, calls } = await fixture({ idle: ["leaf1"] })

    const result = await stop(ports, "root", { sessionID: "leaf1" })

    expect(result.stopped).toMatchObject([{ sessionID: "leaf1", outcome: "idle" }])
    expect(calls.some((call) => call.method === "synthetic")).toBe(false)
  })

  test("a session that is not running is no error, nor is one OpenCode no longer knows; a failed interrupt is listed and the rest go on", async () => {
    const { ports } = await fixture({ idle: ["leaf1"], missing: ["leaf2"], failing: ["mid"] })

    const result = await stop(ports, "root", { sessionID: "mid" })

    expect(result.stopped.map((one) => [one.sessionID, one.outcome])).toEqual([
      ["leaf1", "idle"],
      ["leaf2", "gone"],
      ["mid", "failed"],
    ])
    expect(result.stopped[2]!.error).toBe("session.interrupt failed: boom")
    expect(stopText(result)).toContain("Those that failed may still run")
  })

  test("a session that was not running is not settled as interrupted", async () => {
    const { ports, store } = await fixture({ idle: ["leaf1"] })

    await stop(ports, "root", { sessionID: "mid" })

    expect(store.has(settledKey("leaf1"))).toBe(false)
  })

  test("cancels the messages scheduled for the stopped sessions, before interrupting any, and no others", async () => {
    const { ports, store, calls } = await fixture()
    const order: string[] = []
    const interrupt = ports.courier.session.interrupt
    ;(ports.courier.session as any).interrupt = async (input: any) => {
      order.push(`interrupt ${input.sessionID} with ${[...store.keys()].filter((key) => key.startsWith("later/")).length} left`)
      return interrupt(input)
    }
    const a = await schedule(ports.later, "mid", { message: "check", delayMinutes: 5 })
    await schedule(ports.later, "root", { message: "mine", delayMinutes: 5, sessionID: "leaf1" })
    const c = await schedule(ports.later, "root", { message: "other", delayMinutes: 5, sessionID: "side" })

    const result = await stop(ports, "root", { sessionID: "mid" })

    expect(result.cancelled).toHaveLength(2)
    expect(result.cancelled).not.toContain(c.id)
    expect(result.cancelled).toContain(a.id)
    expect([...store.keys()].filter((key) => key.startsWith("later/"))).toEqual([`later/${c.id}`])
    expect(order.every((line) => line.endsWith("with 1 left"))).toBe(true)
    void calls
  })

  test("a group member that is stopped leaves its group through the interrupt event, as before", async () => {
    const { ports, store } = await fixture()
    await joinGroup(ports.courier.storage, "root", "g", "mid", "title mid", 1)

    await stop(ports, "root", { sessionID: "mid" })

    expect(store.get(memberKey("root", "g", "mid"))).toEqual({ title: "title mid", joinedAt: 1 })
  })

  test("looks again for a session started meanwhile and stops it too", async () => {
    const { ports, calls } = await fixture()
    const interrupt = ports.courier.session.interrupt
    ;(ports.courier.session as any).interrupt = async (input: any) => {
      if (input.sessionID === "mid") await record(ports.courier.storage as any, entry("late", "mid", 8))
      return interrupt(input)
    }

    const result = await stop(ports, "root", { sessionID: "mid" })

    expect(result.stopped.map((one) => one.sessionID)).toEqual(["leaf1", "leaf2", "mid", "late"])
    expect(calls.filter((call) => call.method === "interrupt").map((call) => call.input.sessionID)).toContain("late")
  })

  describe("the caller", () => {
    test("may be any session above the target, not only its parent", async () => {
      const { ports } = await fixture()

      const result = await stop(ports, "root", { sessionID: "leaf2" })

      expect(result.stopped).toHaveLength(1)
    })

    test("may not be the target, a session below it, a sibling or a stranger", async () => {
      const { ports, calls } = await fixture()

      for (const caller of ["mid", "leaf1", "side", "ses_other"])
        await expect(stop(ports, caller, { sessionID: "mid" })).rejects.toThrow(`${caller} is not above mid`)

      expect(calls).toEqual([])
    })

    test("cannot stop a session courier_spawn did not start, and the top session is that", async () => {
      const { ports } = await fixture()

      await expect(stop(ports, "root", { sessionID: "root" })).rejects.toThrow("root was not started with courier_spawn")
    })
  })

  describe("with cleanup", () => {
    test("removes the worktrees of the isolated sessions, deepest first, and forgets them", async () => {
      const { ports, removed, store } = await fixture()

      const result = await stop(ports, "root", { sessionID: "mid", cleanup: true })

      expect(removed.map((input) => input.directory)).toEqual(["/wt/leaf1", "/wt/mid"])
      expect(result.cleanup).toMatchObject([
        { sessionID: "leaf1", outcome: "removed" },
        { sessionID: "mid", outcome: "removed" },
      ])
      expect(store.has("roster/root/mid")).toBe(false)
      expect(stopText(result)).toContain("Removed the worktree /wt/leaf1 of leaf1.")
    })

    test("keeps a worktree with work on no branch and lists it, as courier_cleanup does", async () => {
      const { ports, removed } = await fixture({ inspect: (directory) => (directory === "/wt/leaf1" ? { changes: ["a.ts"], commits: [] } : { changes: [], commits: [] }) })

      const result = await stop(ports, "root", { sessionID: "mid", cleanup: true })

      expect(removed.map((input) => input.directory)).toEqual(["/wt/mid"])
      expect(result.cleanup![0]).toMatchObject({ sessionID: "leaf1", outcome: "kept", changes: ["a.ts"] })
      expect(stopText(result)).toContain("Kept the worktree /wt/leaf1 of leaf1: it has 1 uncommitted change (a.ts).")
    })

    test("reports a worktree that could not be inspected, and goes on", async () => {
      const { ports, removed } = await fixture({
        inspect: (directory) => {
          if (directory === "/wt/leaf1") throw new Error("git broke")
          return { changes: [], commits: [] }
        },
      })

      const result = await stop(ports, "root", { sessionID: "mid", cleanup: true })

      expect(result.cleanup![0]).toEqual({ sessionID: "leaf1", outcome: "failed", error: "courier_cleanup failed: git broke" })
      expect(removed.map((input) => input.directory)).toEqual(["/wt/mid"])
    })

    test("leaves worktrees alone without it", async () => {
      const { ports, removed } = await fixture()

      const result = await stop(ports, "root", { sessionID: "mid" })

      expect(removed).toEqual([])
      expect(result.cleanup).toBeUndefined()
    })

    test("says so when none of them ran in a worktree of its own", async () => {
      const { ports } = await fixture()

      const result = await stop(ports, "root", { sessionID: "leaf2", cleanup: true })

      expect(stopText(result)).toContain("None of them ran in a worktree of its own.")
    })
  })
})
