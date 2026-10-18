// The memory's RPC (#262), through which the TUI's memory view reads the project's tree records, forgets one or only its
// lesson, and pins one (#285); and the forget and pin use cases behind it.
import { describe, expect, test } from "bun:test"
import { PART_STATUSES } from "../src/memory/domain.js"
import { forget } from "../src/memory/forget.js"
import { pin } from "../src/memory/pin.js"
import { records, registerMemoryRpc } from "../src/memory/rpc-handlers.js"
import { memoryRpc, PART_STATUSES as RPC_STATUSES } from "../src/memory/rpc.js"
import { memoryStore, pinKey, readsKey } from "../src/memory/store.js"
import type { TreeRecord } from "../src/memory/domain.js"

const NOW = 1_700_000_000_000

/** Ports over a map, with the writes made, the project `proj_1` and the clock at `NOW`. */
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
  const ports = { storage, projectID: "proj_1", memory, now: () => NOW }
  return { ports: ports as unknown as Parameters<typeof registerMemoryRpc>[1], store, writes, records: memoryStore(storage as never) }
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

  test("leaves the split line's revisions out, which its schema does not hold yet (#292)", async () => {
    const { ports, records: store } = fakePorts()
    await store.put("proj_1", "ses_staged", record("Staged", NOW, { revisions: [{ text: "split: 2 parts: tests, docs", at: NOW - 1000, parts: 1 }] }))

    const read = await records(ports)

    expect(read.records[0]).toEqual({ sessionID: "ses_staged", ...record("Staged", NOW) })
    expect((await memoryRpc.methods.records.output["~standard"].validate(read)).issues).toBeUndefined()
  })

  test("lists a pinned record first, whatever its age, each record with its reads and pin as they lie beside it (#285)", async () => {
    const { ports, store, records: memory } = fakePorts()
    await memory.put("proj_1", "ses_new", record("New", NOW))
    await memory.put("proj_1", "ses_old", record("Old", NOW - 100_000))
    await store.set(pinKey("proj_1", "ses_old"), { at: NOW - 50_000 })
    await store.set(readsKey("proj_1", "ses_old", "ses_reader"), { shown: 3, read: 1, at: NOW - 60_000 })
    await store.set(readsKey("proj_1", "ses_old", "ses_other"), { shown: 4, read: 0, at: NOW - 70_000 })

    const read = await records(ports)

    expect(read.records.map((one) => one.sessionID)).toEqual(["ses_old", "ses_new"])
    expect(read.records[0]).toEqual({ sessionID: "ses_old", ...record("Old", NOW - 100_000), reads: { shown: 7, read: 1, at: NOW - 60_000 }, pinned: { at: NOW - 50_000 } })
    expect(read.records[1]).not.toHaveProperty("reads")
    expect(read.records[1]).not.toHaveProperty("pinned")
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

describe("pin", () => {
  test("pins a record under its own key, dated now, and unpins it by removing the key; the record's facts are not written", async () => {
    const { ports, store, writes, records: memory } = fakePorts()
    await memory.put("proj_1", "ses_a", record("A", NOW))
    writes.length = 0

    expect(await pin(ports, "ses_a", true)).toBe("pinned")
    expect(writes).toEqual(["set memory/proj_1/ses_a/pin"])
    expect(store.get("memory/proj_1/ses_a/pin")).toEqual({ at: NOW })
    expect((await memory.get("proj_1", "ses_a"))?.pinned).toEqual({ at: NOW })

    // Pinned again later, it keeps when it was first pinned.
    ;(ports as any).now = () => NOW + 5000
    expect(await pin(ports, "ses_a", true)).toBe("pinned")
    expect(store.get("memory/proj_1/ses_a/pin")).toEqual({ at: NOW })

    writes.length = 0
    expect(await pin(ports, "ses_a", false)).toBe("unpinned")
    expect(writes).toEqual(["remove memory/proj_1/ses_a/pin"])
    expect(await memory.get("proj_1", "ses_a")).not.toHaveProperty("pinned")
  })

  test("finds no record to pin, or unpin, under a top with none, and writes nothing", async () => {
    const { ports, writes } = fakePorts()
    expect(await pin(ports, "ses_none", true)).toBe("none")
    expect(await pin(ports, "ses_none", false)).toBe("none")
    expect(writes).toEqual([])
  })

  test("a forget removes the pin and the reads with the record", async () => {
    const { ports, store, records: memory } = fakePorts()
    await memory.put("proj_1", "ses_a", record("A", NOW))
    await pin(ports, "ses_a", true)
    await store.set(readsKey("proj_1", "ses_a", "ses_reader"), { shown: 1, read: 0, at: NOW })

    expect(await forget(ports, "ses_a")).toBe("record")
    expect([...store.keys()]).toEqual([])
  })

  test("pins with the memory option off too: a pin is the person's", async () => {
    const { ports, records: memory } = fakePorts(false)
    await memory.put("proj_1", "ses_a", record("A", NOW))
    expect(await pin(ports, "ses_a", true)).toBe("pinned")
  })
})

test("registerMemoryRpc serves its three methods under its own id, beside the tree's and the person's", async () => {
  const { ports, records: store } = fakePorts()
  await store.put("proj_1", "ses_a", record("A", NOW, { lesson }))
  const registered: { definition: any; handlers: any }[] = []
  await registerMemoryRpc({ register: async (definition: any, handlers: any) => void registered.push({ definition, handlers }) } as never, ports)

  expect(registered.map(({ definition }) => [definition.id, Object.keys(definition.methods)])).toEqual([["courier-memory", ["records", "forget", "pin"]]])
  const { handlers } = registered[0]!
  expect((await handlers.records({})).records.map((one: { sessionID: string }) => one.sessionID)).toEqual(["ses_a"])
  expect(await handlers.pin({ sessionID: "ses_a", pinned: true })).toEqual({ outcome: "pinned" })
  expect((await handlers.records({})).records[0].pinned).toEqual({ at: NOW })
  expect(await handlers.pin({ sessionID: "ses_a", pinned: false })).toEqual({ outcome: "unpinned" })
  expect(await handlers.forget({ sessionID: "ses_a", lesson: true })).toEqual({ outcome: "lesson" })
  expect(await handlers.forget({ sessionID: "ses_a" })).toEqual({ outcome: "record" })
  expect(await handlers.forget({ sessionID: "ses_a" })).toEqual({ outcome: "none" })
  expect(await handlers.pin({ sessionID: "ses_a", pinned: true })).toEqual({ outcome: "none" })
  expect((await memoryRpc.methods.forget.output["~standard"].validate({ outcome: "none" })).issues).toBeUndefined()
  expect((await memoryRpc.methods.forget.input["~standard"].validate({ wrong: 1 })).issues).toBeDefined()
  expect((await memoryRpc.methods.pin.output["~standard"].validate({ outcome: "unpinned" })).issues).toBeUndefined()
  expect((await memoryRpc.methods.pin.input["~standard"].validate({ sessionID: "ses_a" })).issues).toBeDefined()
  expect((await memoryRpc.methods.pin.input["~standard"].validate({ sessionID: "ses_a", pinned: true })).issues).toBeUndefined()
  expect((await memoryRpc.methods.records.input["~standard"].validate({})).issues).toBeUndefined()
})
