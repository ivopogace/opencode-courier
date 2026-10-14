// What a read of a tree lists (#188): every session is looked up, the listing keeps the live ones first, then the
// newest, with what is above them, and counts the older ones it leaves out; expired entries are left out of every read.
import { describe, expect, test } from "bun:test"
import { cut, DEFAULT_LIMITS, isLive, type RosterEntry } from "../src/tree/domain.js"
import type { Pending } from "../src/tree/ports.js"
import { RETENTION_MS } from "../src/tree/roster.js"
import { childStore } from "../src/tree/store.js"
import { readTree, type ReadPorts } from "../src/tree/subtree.js"

const node = (sessionID: string, parentID: string, createdAt: number, live = false) => ({ sessionID, parentID, createdAt, live })

describe("cut", () => {
  test("keeps every node, in the order given, when they fit", () => {
    const nodes = [node("a", "root", 1), node("a1", "a", 3), node("b", "root", 2)]
    expect(cut(nodes, 3)).toEqual({ kept: nodes, leftOut: 0 })
  })

  test("keeps the live ones first, then the newest, and counts the rest", () => {
    const nodes = [node("a", "root", 1, true), node("b", "root", 2), node("c", "root", 3), node("d", "root", 4)]
    expect(cut(nodes, 2)).toEqual({ kept: [nodes[0]!, nodes[3]!], leftOut: 2 })
    expect(cut(nodes, 1)).toEqual({ kept: [nodes[0]!], leftOut: 3 })
    expect(cut(nodes, 0)).toEqual({ kept: [], leftOut: 4 })
  })

  test("keeps what is above a kept node, so the tree still draws, and skips a node that would not fit with it", () => {
    const nodes = [node("a", "root", 1), node("a1", "a", 2), node("a1x", "a1", 5, true), node("b", "root", 3), node("c", "root", 4)]
    // The live grandchild needs its parent and grandparent: three of three; the newest, c, does not fit.
    expect(cut(nodes, 3).kept.map((one) => one.sessionID)).toEqual(["a", "a1", "a1x"])
    // With four, c fits as the newest; b is left out.
    expect(cut(nodes, 4)).toMatchObject({ kept: [nodes[0]!, nodes[1]!, nodes[2]!, nodes[4]!], leftOut: 1 })
    // Two: the grandchild's chain of three does not fit, so the newest that do are kept.
    expect(cut(nodes, 2).kept.map((one) => one.sessionID)).toEqual(["b", "c"])
  })
})

describe("isLive", () => {
  const running = { updated: 9, idle: 5 }
  const idle = { updated: 5, idle: 5 }
  test("a session that runs, waits on a request or owes a report is live; one OpenCode no longer knows is not", () => {
    expect(isLive(running, 0, false)).toBe(true)
    expect(isLive(idle, 1, false)).toBe(true)
    expect(isLive(idle, 0, true)).toBe(true)
    expect(isLive(idle, 0, false)).toBe(false)
    expect(isLive(undefined, 1, true)).toBe(false)
  })
})

type Times = { updated: number; idle?: number }

/** Ports over an in-memory store, with each session's times and pending requests as given; one without times is gone. */
function fakePorts(times: Record<string, Times>, pending: Record<string, Pending[]> = {}, maxTotal = DEFAULT_LIMITS.maxTotal) {
  const store = new Map<string, unknown>()
  const ports: ReadPorts = {
    now: () => 1_000,
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
    } as never,
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const time = times[sessionID]
        if (!time) throw new Error(`session ${sessionID} not found`)
        return { id: sessionID, title: sessionID, time: { created: 1, ...time } }
      },
    } as never,
    pending: async (sessionID: string) => pending[sessionID] ?? [],
    limits: { ...DEFAULT_LIMITS, maxTotal },
  }
  return { ports, store }
}

const entry = (sessionID: string, parentID: string, createdAt: number, more: Partial<RosterEntry> = {}): RosterEntry => ({
  sessionID,
  parentID,
  title: sessionID,
  directory: "/repo",
  isolated: false,
  createdAt,
  ...more,
})

const asks: Pending = { type: "permission", requestID: "per_1", action: "shell", resources: ["echo hi"] }

describe("readTree", () => {
  test("looks up every session under the root and lists the live ones first, then the newest, counting the rest", async () => {
    const { ports } = fakePorts(
      { ses_a: { updated: 5, idle: 5 }, ses_b: { updated: 5, idle: 5 }, ses_c: { updated: 5, idle: 5 }, ses_d: { updated: 9, idle: 5 } },
      { ses_d: [asks] },
      2,
    )
    const children = childStore(ports.storage)
    for (const [index, child] of ["ses_a", "ses_b", "ses_c", "ses_d"].entries()) await children.record(entry(child, "ses_root", 900 + index))
    await children.prompted("ses_a", 950)

    const { all, kept, leftOut } = await readTree(ports, "ses_root")

    expect(all.map((node) => [node.entry.sessionID, node.live, node.pending.length, node.report?.owes])).toEqual([
      ["ses_a", true, 0, true],
      ["ses_b", false, 0, undefined],
      ["ses_c", false, 0, undefined],
      ["ses_d", true, 1, undefined],
    ])
    expect(kept.map((node) => node.entry.sessionID)).toEqual(["ses_a", "ses_d"])
    expect(leftOut).toBe(2)
    expect((await readTree(ports, "ses_root", 3)).kept.map((node) => node.entry.sessionID)).toEqual(["ses_a", "ses_c", "ses_d"])
  })

  test("a session OpenCode no longer knows, or whose requests cannot be read, is looked up as far as it can be", async () => {
    const { ports } = fakePorts({ ses_a: { updated: 5 } })
    ;(ports as any).pending = async () => {
      throw new Error("no permission domain")
    }
    const children = childStore(ports.storage)
    await children.record(entry("ses_a", "ses_root", 900))
    await children.record(entry("ses_gone", "ses_root", 901))

    const { all, leftOut } = await readTree(ports, "ses_root")

    expect(all.map((node) => [node.entry.sessionID, node.info?.id, node.live, node.pending])).toEqual([
      ["ses_a", "ses_a", true, []],
      ["ses_gone", undefined, false, []],
    ])
    expect(leftOut).toBe(0)
  })

  test("leaves out an entry past retention and what is under it, keeping an isolated one whose worktree exists, and deletes nothing", async () => {
    const { ports, store } = fakePorts({ ses_old: { updated: 5 }, ses_under: { updated: 5 }, ses_kept: { updated: 5 }, ses_new: { updated: 5 } })
    ;(ports as any).now = () => RETENTION_MS + 1_000
    const children = childStore(ports.storage)
    await children.record(entry("ses_old", "ses_root", 999))
    await children.record(entry("ses_under", "ses_old", 1_000))
    await children.record(entry("ses_kept", "ses_root", 999, { isolated: true, directory: import.meta.dir }))
    await children.record(entry("ses_new", "ses_root", 1_000))

    const { all } = await readTree(ports, "ses_root")

    expect(all.map((node) => node.entry.sessionID)).toEqual(["ses_kept", "ses_new"])
    expect([...store.keys()].filter((key) => key.startsWith("roster/"))).toHaveLength(4)
  })
})
