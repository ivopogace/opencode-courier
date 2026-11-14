import { expect, test } from "bun:test"
import { forgetChild } from "../src/tree/forget.js"
import { cleanup } from "../src/tree/cleanup.js"
import type { RosterStorage } from "../src/tree/ports.js"
import { pruneExpired } from "../src/tree/roster.js"
import { standingRows } from "../src/tree/standing.js"
import { childStore, wakeStore } from "../src/tree/store.js"

function loggingStorage() {
  const store = new Map<string, string>()
  const writes: string[] = []
  const storage: RosterStorage = {
    get: async (key) => (store.has(key) ? JSON.parse(store.get(key)!) : undefined),
    set: async (key, value) => {
      writes.push(`set ${key} ${JSON.stringify(value)}`)
      store.set(key, JSON.stringify(value))
    },
    remove: async (key) => {
      writes.push(`remove ${key}`)
      store.delete(key)
    },
    scan: async ({ prefix }) => ({
      entries: [...store.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => ({ key, value: JSON.parse(store.get(key)!) })),
    }),
  }
  return { storage, store, writes }
}

test("the stores write a child's roster entry, reverse key and report state under the keys older copies read, and no group key", async () => {
  const { storage, store, writes } = loggingStorage()
  const children = childStore(storage)
  await children.record({
    sessionID: "ses_child",
    parentID: "ses_parent",
    title: "Child",
    directory: "/repo",
    isolated: false,
    createdAt: 1,
    reports: "status",
    model: "mock/small#high",
  })
  await children.prompted("ses_child", 10)
  await children.progressed("ses_child", 20)
  await children.settled("ses_child", "report", 30, "done")
  await children.told("ses_child", 40)
  await children.stopped("ses_child", 50)
  await children.nudged("ses_child", 55)
  await children.nudged("ses_child", 55, "msg_n")
  await children.settled("ses_child", "failed", 60, undefined, 600_060)

  expect(writes).toEqual([
    'set roster/ses_parent/ses_child {"sessionID":"ses_child","parentID":"ses_parent","title":"Child","directory":"/repo","isolated":false,"createdAt":1,"reports":"status","model":"mock/small#high"}',
    'set roster-by-child/ses_child {"ancestors":["ses_parent"]}',
    'set report/ses_child/prompt {"at":10}',
    'set report/ses_child/progress {"at":20}',
    'set report/ses_child/settled {"at":30,"by":"report","status":"done"}',
    'set report/ses_child/told {"at":40}',
    'set report/ses_child/stopped {"at":50}',
    'set report/ses_child/nudged {"at":55}',
    'set report/ses_child/nudged {"at":55,"inboxID":"msg_n"}',
    'set report/ses_child/settled {"at":60,"by":"failed","resumesAt":600060}',
  ])
  expect(await children.nudgeOf("ses_child")).toEqual({ at: 55, inboxID: "msg_n" })
  expect(await children.reported()).toEqual(
    new Map([["ses_child", ["report/ses_child/nudged", "report/ses_child/progress", "report/ses_child/prompt", "report/ses_child/settled", "report/ses_child/stopped", "report/ses_child/told"]]]),
  )

  writes.length = 0
  await forgetChild(storage, "ses_parent", "ses_child")
  expect(writes).toEqual([
    "remove roster/ses_parent/ses_child",
    "remove roster-by-child/ses_child",
    "remove report/ses_child/prompt",
    "remove report/ses_child/settled",
    "remove report/ses_child/progress",
    "remove report/ses_child/told",
    "remove report/ses_child/stopped",
    "remove report/ses_child/nudged",
  ])
  expect([...store.keys()]).toEqual([])
})

test("a group/ entry in storage is not read and not removed", async () => {
  const { storage, store, writes } = loggingStorage()
  const reads: string[] = []
  const watched: RosterStorage = {
    ...storage,
    get: async (key) => (reads.push(key), storage.get(key)),
    scan: async (input) => (reads.push(input.prefix), storage.scan(input)),
  }
  const held = JSON.stringify({ title: "Child", joinedAt: 5, report: { at: 30, status: "done", message: "all done" } })
  const out = JSON.stringify({ title: "Other", joinedAt: 6 })
  store.set("group/ses_parent/pair/ses_child", held)
  store.set("group/ses_parent/pair/ses_other", out)
  const children = childStore(watched)
  const entry = { parentID: "ses_parent", directory: "/repo", isolated: false, createdAt: Date.now(), reports: "status" as const, group: "pair" }
  await children.record({ ...entry, sessionID: "ses_child", title: "Child" })
  await children.record({ ...entry, sessionID: "ses_other", title: "Other" })
  await children.record({ ...entry, sessionID: "ses_old", title: "Old", createdAt: 1 })
  await children.prompted("ses_child", 10)
  await children.settled("ses_child", "report", 30, "done")

  expect(await standingRows(watched, "ses_parent", Date.now())).toHaveLength(2)
  await pruneExpired(watched, Date.now(), () => false)
  const ports = { storage: watched, worktree: { remove: async () => {} }, projectID: "prj", inspect: async () => undefined, now: Date.now }
  expect(await cleanup(ports, "ses_parent", { sessionID: "ses_other" })).toEqual({ sessionID: "ses_other", directory: "/repo", outcome: "forgotten" })
  await forgetChild(watched, "ses_parent", "ses_child")

  expect(reads.filter((key) => key.startsWith("group"))).toEqual([])
  expect(writes.filter((write) => write.includes(" group/"))).toEqual([])
  expect([...store]).toEqual([
    ["group/ses_parent/pair/ses_child", held],
    ["group/ses_parent/pair/ses_other", out],
  ])
})

test("a typed row is kept under typed/<sessionID>/<inboxID> and goes with the child's other rows", async () => {
  const { storage, store, writes } = loggingStorage()
  const children = childStore(storage)
  await children.record({ sessionID: "ses_child", parentID: "ses_parent", title: "Child", directory: "/repo", isolated: false, createdAt: 1, reports: "status" })
  writes.length = 0
  await children.typed("ses_child", "msg_1", 10, "typed words")
  await children.typed("ses_child", "msg_2", 11, "more")
  expect(writes).toEqual(['set typed/ses_child/msg_1 {"at":10,"text":"typed words"}', 'set typed/ses_child/msg_2 {"at":11,"text":"more"}'])
  expect(await children.typedOf("ses_child", "msg_1")).toEqual({ at: 10, text: "typed words" })
  expect(await children.typedOf("ses_child", "msg_9")).toBeUndefined()
  expect(await children.typedSessions()).toEqual(new Set(["ses_child"]))

  await children.forgetTyped("ses_child", "msg_1")
  expect(store.has("typed/ses_child/msg_1")).toBe(false)
  expect(store.has("typed/ses_child/msg_2")).toBe(true)

  await forgetChild(storage, "ses_parent", "ses_child")
  expect(await children.typedSessions()).toEqual(new Set())
})

test("the load sweep drops the typed rows of sessions with no roster entry", async () => {
  const { storage, store } = loggingStorage()
  const children = childStore(storage)
  await children.record({ sessionID: "ses_child", parentID: "ses_parent", title: "Child", directory: "/repo", isolated: false, createdAt: Date.now(), reports: "status" })
  await children.typed("ses_child", "msg_1", 10, "kept")
  await children.typed("ses_gone", "msg_2", 10, "dropped")

  await pruneExpired(storage, Date.now(), () => true)

  expect(store.has("typed/ses_child/msg_1")).toBe(true)
  expect(store.has("typed/ses_gone/msg_2")).toBe(false)
})

test("the wake store keeps a watched message under wake/<sessionID>/<inboxID>, without its key's ids, and reads back what it wrote", async () => {
  const { storage, writes } = loggingStorage()
  const wakes = wakeStore(storage)
  await wakes.put({ sessionID: "ses_parent", inboxID: "msg_1", at: 10, text: "report", description: "Message from ses_child", running: false, idleAt: 10 })
  await wakes.put({ sessionID: "ses_parent", inboxID: "msg_1", at: 10, text: "report", running: false, idleAt: 10, rewoken: 40, stalled: 70 })
  await wakes.put({ sessionID: "ses_other", inboxID: "msg_2", at: 20, text: "notice", running: true })
  expect(writes).toEqual([
    'set wake/ses_parent/msg_1 {"at":10,"text":"report","description":"Message from ses_child","running":false,"idleAt":10}',
    'set wake/ses_parent/msg_1 {"at":10,"text":"report","running":false,"idleAt":10,"rewoken":40,"stalled":70}',
    'set wake/ses_other/msg_2 {"at":20,"text":"notice","running":true}',
  ])
  expect(await wakes.of("ses_parent")).toEqual([
    { sessionID: "ses_parent", inboxID: "msg_1", at: 10, text: "report", running: false, idleAt: 10, rewoken: 40, stalled: 70 },
  ])
  expect((await wakes.all()).map((wake) => wake.inboxID)).toEqual(["msg_2", "msg_1"])
  writes.length = 0
  await wakes.remove("ses_parent", "msg_1")
  expect(writes).toEqual(["remove wake/ses_parent/msg_1"])
})
