// The memory's RPC (#262), which the TUI's memory view reads the project's tree records through and forgets one, or
// only its lesson, with; and the forget use case behind it.
import { describe, expect, test } from "bun:test"
import { PART_STATUSES } from "../src/memory/domain.js"
import { forget } from "../src/memory/forget.js"
import { records, registerMemoryRpc } from "../src/memory/rpc-handlers.js"
import { memoryRpc, PART_STATUSES as RPC_STATUSES } from "../src/memory/rpc.js"
import { memoryStore } from "../src/memory/store.js"
import type { TreeRecord } from "../src/memory/domain.js"

const NOW = 1_700_000_000_000

/** Ports over a map, with the writes made and the project `proj_1`. */
function fakePorts(memory = true) {
  const store = new Map<string, unknown>()
  const writes: string[] = []
  const storage = {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => {
      writes.push(`set ${key}`)
      store.set(key, JSON.parse(JSON.stringify(value)))
    },
    remove: async (key: string) => {
      writes.push(`remove ${key}`)
      store.delete(key)
    },
    scan: async ({ prefix }: { prefix: string }) => ({
      entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    }),
  }
  const ports = { storage, projectID: "proj_1", memory }
  return { ports: ports as unknown as Parameters<typeof records>[0], store, writes, records: memoryStore(storage as never) }
}

const record = (title: string, movedAt: number, more: Partial<TreeRecord> = {}): TreeRecord => ({
  startedAt: movedAt - 600_000,
  movedAt,
  title,
  split: "split: 2 parts: core, docs",
  finished: true,
  parts: [
    { sessionID: "ses_core", title: "Core", depth: 1, isolated: true, group: "wave", status: "done", duration: 540_000, cost: 0.42, context: 0.31 },
    { sessionID: "ses_docs", title: "Docs", depth: 1, isolated: false, status: "partial", duration: 60_000, refused: 1 },
  ],
  ...more,
})

const lesson = { text: "The docs part was ten lines; next time do it yourself.", at: NOW - 10_000 }

describe("records", () => {
  test("lists the project's records newest first, each with its top session, and no other project's", async () => {
    const { ports, records: store } = fakePorts()
    await store.put("proj_1", "ses_old", record("Old", NOW - 100_000))
    await store.put("proj_1", "ses_new", record("New", NOW, { lesson, recalled: { at: NOW - 500, calls: 2 } }))
    await store.put("proj_2", "ses_elsewhere", record("Elsewhere", NOW))

    const read = await records(ports)

    expect(read.memory).toBe(true)
    expect(read.projectID).toBe("proj_1")
    expect(read.records.map((one) => [one.sessionID, one.title])).toEqual([
      ["ses_new", "New"],
      ["ses_old", "Old"],
    ])
    expect(read.records[0]).toEqual({ sessionID: "ses_new", ...record("New", NOW, { lesson, recalled: { at: NOW - 500, calls: 2 } }) })
    expect(read.records[0]).not.toHaveProperty("projectID")
    expect((await memoryRpc.methods.records.output["~standard"].validate(read)).issues).toBeUndefined()
  })

  test("says memory is off, and lists nothing, when the option is", async () => {
    const { ports, records: store } = fakePorts(false)
    await store.put("proj_1", "ses_new", record("New", NOW))

    expect(await records(ports)).toEqual({ memory: false, projectID: "proj_1", records: [] })
  })

  test("a project with no record lists none", async () => {
    expect(await records(fakePorts().ports)).toEqual({ memory: true, projectID: "proj_1", records: [] })
  })

  test("the RPC's part statuses are the record's", () => {
    expect([...RPC_STATUSES]).toEqual([...PART_STATUSES])
  })
})

describe("forget", () => {
  test("removes the record's key, and nothing else", async () => {
    const { ports, store, writes, records: store2 } = fakePorts()
    await store2.put("proj_1", "ses_a", record("A", NOW))
    await store2.put("proj_1", "ses_b", record("B", NOW))
    writes.length = 0

    expect(await forget(ports, "ses_a")).toBe("record")

    expect(writes).toEqual(["remove memory/proj_1/ses_a"])
    expect([...store.keys()]).toEqual(["memory/proj_1/ses_b"])
  })

  test("drops only the lesson when asked, writing the record back without it, and keeps its facts", async () => {
    const { ports, writes, records: store } = fakePorts()
    await store.put("proj_1", "ses_a", record("A", NOW, { lesson, recalled: { calls: 1 } }))
    writes.length = 0

    expect(await forget(ports, "ses_a", { lesson: true })).toBe("lesson")

    expect(writes).toEqual(["set memory/proj_1/ses_a"])
    expect(await store.get("proj_1", "ses_a")).toEqual(record("A", NOW, { recalled: { calls: 1 } }))
    expect(await store.get("proj_1", "ses_a")).not.toHaveProperty("lesson")
  })

  test("finds nothing to forget for a record that is not there, or a lesson a record lacks", async () => {
    const { ports, writes, records: store } = fakePorts()
    await store.put("proj_1", "ses_a", record("A", NOW))
    writes.length = 0

    expect(await forget(ports, "ses_none")).toBe("none")
    expect(await forget(ports, "ses_none", { lesson: true })).toBe("none")
    expect(await forget(ports, "ses_a", { lesson: true })).toBe("none")
    expect(writes).toEqual([])
  })

  test("forgets with the memory option off too: it only removes", async () => {
    const { ports, records: store } = fakePorts(false)
    await store.put("proj_1", "ses_a", record("A", NOW))

    expect(await forget(ports, "ses_a")).toBe("record")
    expect(await store.get("proj_1", "ses_a")).toBeUndefined()
  })
})

test("registerMemoryRpc serves both methods under its own id, beside the tree's and the person's", async () => {
  const { ports, records: store } = fakePorts()
  await store.put("proj_1", "ses_a", record("A", NOW, { lesson }))
  const registered: { definition: any; handlers: any }[] = []
  await registerMemoryRpc({ register: async (definition: any, handlers: any) => void registered.push({ definition, handlers }) } as never, ports)

  expect(registered.map(({ definition }) => [definition.id, Object.keys(definition.methods)])).toEqual([["courier-memory", ["records", "forget"]]])
  const { handlers } = registered[0]!
  expect((await handlers.records({})).records.map((one: { sessionID: string }) => one.sessionID)).toEqual(["ses_a"])
  expect(await handlers.forget({ sessionID: "ses_a", lesson: true })).toEqual({ outcome: "lesson" })
  expect(await handlers.forget({ sessionID: "ses_a" })).toEqual({ outcome: "record" })
  expect(await handlers.forget({ sessionID: "ses_a" })).toEqual({ outcome: "none" })
  expect((await memoryRpc.methods.forget.output["~standard"].validate({ outcome: "none" })).issues).toBeUndefined()
  expect((await memoryRpc.methods.forget.input["~standard"].validate({ wrong: 1 })).issues).toBeDefined()
  expect((await memoryRpc.methods.records.input["~standard"].validate({})).issues).toBeUndefined()
})
