import { describe, expect, test } from "bun:test"
import { DEFAULT_LIMITS, type RosterEntry } from "../src/tree/domain.js"
import { holdReport, joinGroup, leaveGroup } from "../src/tree/group.js"
import type { CourierPorts, Pending } from "../src/tree/ports.js"
import { registerTreeRpc } from "../src/tree/rpc-handlers.js"
import { treeRpc } from "../src/tree/rpc.js"
import { childStore, groupStore } from "../src/tree/store.js"
import { summary } from "../src/tree/summary.js"

type Times = { updated: number; idle?: number }

/** Ports over an in-memory store, with each session's times and pending requests as given; one without times is gone. */
function fakePorts(times: Record<string, Times>, pending: Record<string, Pending[]> = {}, maxTotal = DEFAULT_LIMITS.maxTotal) {
  const store = new Map<string, unknown>()
  const ports = {
    now: () => 1_000,
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const time = times[sessionID]
        if (!time) throw new Error(`session ${sessionID} not found`)
        return { id: sessionID, title: sessionID, time: { created: 1, ...time } }
      },
    },
    pending: async (sessionID: string) => pending[sessionID] ?? [],
    limits: { ...DEFAULT_LIMITS, maxTotal },
  } as unknown as CourierPorts
  return { ports, store }
}

const entry = (sessionID: string, parentID: string, group?: string): RosterEntry => ({
  sessionID,
  parentID,
  title: sessionID,
  directory: "/repo",
  isolated: false,
  createdAt: 900,
  reports: "status",
  ...(group ? { group } : {}),
})

const asks: Pending = { type: "permission", requestID: "per_1", action: "shell", resources: ["echo hi"] }

describe("summary", () => {
  test("counts every session under the root by what it does: waiting on a request, running or idle", async () => {
    const { ports } = fakePorts(
      { ses_run: { updated: 5 }, ses_ask: { updated: 9, idle: 5 }, ses_done: { updated: 5, idle: 5 }, ses_leaf: { updated: 9, idle: 5 } },
      { ses_ask: [asks] },
    )
    const children = childStore(ports.storage)
    for (const child of [entry("ses_run", "ses_root"), entry("ses_ask", "ses_root"), entry("ses_done", "ses_root"), entry("ses_leaf", "ses_run")])
      await children.record(child)

    expect(await summary(ports, "ses_root")).toEqual({ running: 2, waiting: 1, idle: 1, groups: [] })
  })

  test("is empty for a session that started none, and leaves out one OpenCode no longer knows", async () => {
    const { ports } = fakePorts({ ses_a: { updated: 5, idle: 5 } })
    await childStore(ports.storage).record(entry("ses_gone", "ses_root"))

    expect(await summary(ports, "ses_none")).toEqual({ running: 0, waiting: 0, idle: 0, groups: [] })
    expect(await summary(ports, "ses_root")).toEqual({ running: 0, waiting: 0, idle: 0, groups: [] })
  })

  test("counts a session whose requests cannot be read by its times alone", async () => {
    const { ports } = fakePorts({ ses_a: { updated: 5 } })
    ;(ports as any).pending = async () => {
      throw new Error("no permission domain")
    }
    await childStore(ports.storage).record(entry("ses_a", "ses_root"))

    expect(await summary(ports, "ses_root")).toEqual({ running: 1, waiting: 0, idle: 0, groups: [] })
  })

  test("lists the groups of the session's own children, with how many reported of those that have not left", async () => {
    const { ports } = fakePorts({
      ses_a: { updated: 5, idle: 5 },
      ses_b: { updated: 5 },
      ses_c: { updated: 5, idle: 5 },
      ses_x: { updated: 5 },
      ses_y: { updated: 5 },
    })
    const children = childStore(ports.storage)
    const groups = groupStore(ports.storage)
    for (const [child, group] of [["ses_a", "pair"], ["ses_b", "pair"], ["ses_c", "pair"]] as const) {
      await children.record(entry(child, "ses_root", group))
      await joinGroup(groups, "ses_root", group, child, child, 900)
    }
    await holdReport(groups, { parentID: "ses_root", group: "pair", sessionID: "ses_a", title: "ses_a", joinedAt: 900 }, {
      at: 950,
      status: "done",
      message: "Done",
    })
    await leaveGroup(groups, "ses_root", "pair", "ses_c", "failed", 960)
    // A grandchild's group is its own parent's to wait on, not the root's.
    await children.record(entry("ses_x", "ses_b"))
    await children.record(entry("ses_y", "ses_x", "inner"))
    await joinGroup(groups, "ses_x", "inner", "ses_y", "ses_y", 900)

    expect((await summary(ports, "ses_root")).groups).toEqual([{ name: "pair", reported: 1, members: 2 }])
  })

  test("leaves out a group released since its children were read", async () => {
    const { ports } = fakePorts({ ses_a: { updated: 5, idle: 5 } })
    await childStore(ports.storage).record(entry("ses_a", "ses_root", "pair"))

    expect(await summary(ports, "ses_root")).toEqual({ running: 0, waiting: 0, idle: 1, groups: [] })
  })

  test("counts at most maxTotal sessions, as courier_tree reads them, and says so", async () => {
    const { ports } = fakePorts({ ses_a: { updated: 5 }, ses_b: { updated: 5 }, ses_c: { updated: 5 } }, {}, 2)
    for (const child of ["ses_a", "ses_b", "ses_c"]) await childStore(ports.storage).record(entry(child, "ses_root"))

    expect(await summary(ports, "ses_root")).toEqual({ running: 2, waiting: 0, idle: 0, groups: [], truncated: 2 })
  })
})

test("registerTreeRpc serves the summary as the courier RPC's summary method", async () => {
  const { ports } = fakePorts({ ses_a: { updated: 5 } })
  await childStore(ports.storage).record(entry("ses_a", "ses_root"))
  const registered: { definition: any; handlers: any }[] = []
  const rpc = {
    register: async (definition: any, handlers: any) => {
      registered.push({ definition, handlers })
      return { dispose: async () => {}, events: { emit: async () => {} } }
    },
  }

  await registerTreeRpc(rpc as any, ports)

  expect(registered.map(({ definition }) => [definition.id, Object.keys(definition.methods)])).toEqual([["courier", ["summary"]]])
  expect(await registered[0]!.handlers.summary({ sessionID: "ses_root" })).toEqual({ running: 1, waiting: 0, idle: 0, groups: [] })
})

test("the summary method's schemas refuse an input without a session and an output with a negative count", async () => {
  const { input, output } = treeRpc.methods.summary
  expect((await input["~standard"].validate({ sessionID: "ses_root" })).issues).toBeUndefined()
  expect((await input["~standard"].validate({ wrong: 1 })).issues).toBeDefined()
  expect((await output["~standard"].validate({ running: 1, waiting: 0, idle: 0, groups: [] })).issues).toBeUndefined()
  expect((await output["~standard"].validate({ running: -1, waiting: 0, idle: 0, groups: [] })).issues).toBeDefined()
})
