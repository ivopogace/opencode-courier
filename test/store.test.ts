import { expect, test } from "bun:test"
import { forgetChild } from "../src/tree/forget.js"
import { holdReport, joinGroup, membershipOf } from "../src/tree/group.js"
import type { RosterStorage } from "../src/tree/ports.js"
import { childStore, groupStore, wakeStore } from "../src/tree/store.js"
import { memoryStore } from "../src/memory/store.js"

/** A storage that logs every write and removal with the value as JSON, the form another copy or server reads it in. */
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

// Older copies and a second server on the same data directory read and write these keys: none may move or change shape.
test("the stores write a child's roster entry, reverse key, report state and group membership under the keys older copies read", async () => {
  const { storage, store, writes } = loggingStorage()
  const children = childStore(storage)
  const groups = groupStore(storage)
  await children.record({
    sessionID: "ses_child",
    parentID: "ses_parent",
    title: "Child",
    directory: "/repo",
    isolated: false,
    createdAt: 1,
    reports: "status",
    group: "pair",
  })
  await joinGroup(groups, "ses_parent", "pair", "ses_child", "Child", 5)
  await children.prompted("ses_child", 10)
  await children.progressed("ses_child", 20)
  await children.settled("ses_child", "report", 30, "done")
  await children.told("ses_child", 40)
  await children.stopped("ses_child", 50)
  await holdReport(groups, (await membershipOf(groups, "ses_parent", "pair", "ses_child"))!, { at: 30, status: "done", message: "all done" })

  expect(writes).toEqual([
    'set roster/ses_parent/ses_child {"sessionID":"ses_child","parentID":"ses_parent","title":"Child","directory":"/repo","isolated":false,"createdAt":1,"reports":"status","group":"pair"}',
    'set roster-by-child/ses_child {"ancestors":["ses_parent"]}',
    'set group/ses_parent/pair/ses_child {"title":"Child","joinedAt":5}',
    'set report/ses_child/prompt {"at":10}',
    'set report/ses_child/progress {"at":20}',
    'set report/ses_child/settled {"at":30,"by":"report","status":"done"}',
    'set report/ses_child/told {"at":40}',
    'set report/ses_child/stopped {"at":50}',
    'set group/ses_parent/pair/ses_child {"title":"Child","joinedAt":5,"report":{"at":30,"status":"done","message":"all done"}}',
  ])
  expect(await children.reported()).toEqual(
    new Map([["ses_child", ["report/ses_child/progress", "report/ses_child/prompt", "report/ses_child/settled", "report/ses_child/stopped", "report/ses_child/told"]]]),
  )

  writes.length = 0
  expect(await forgetChild(storage, "ses_parent", "ses_child", "pair")).toEqual({ droppedFromGroup: false })
  expect(writes).toEqual([
    "remove roster/ses_parent/ses_child",
    "remove roster-by-child/ses_child",
    "remove report/ses_child/prompt",
    "remove report/ses_child/settled",
    "remove report/ses_child/progress",
    "remove report/ses_child/told",
    "remove report/ses_child/stopped",
  ])
  // The held report outlives the child's entry: it still goes to the parent with its group.
  expect([...store.keys()]).toEqual(["group/ses_parent/pair/ses_child"])
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

// A record is read by the next release, by `e2e/kv.ts` and by a person seeding one by hand (docs/reference.md, § Memory).
test("the memory store keeps a tree's record under memory/<projectID>/<topSessionID>, as the reference describes it, and reads back what it wrote", async () => {
  const { storage, writes } = loggingStorage()
  const records = memoryStore(storage)
  const record = {
    startedAt: 1760000000000,
    movedAt: 1760000900000,
    title: "Add memory to courier",
    split: "split: 3 parts: core, e2e, docs",
    revisions: [{ text: "split: 2 parts: e2e, docs", at: 1760000600000, parts: 1 }],
    finished: true,
    recalled: { at: 1760000001000, calls: 1 },
    lesson: { text: "The docs part was ten lines; next time do it yourself.", at: 1760000890000 },
    parts: [
      { sessionID: "ses_core", title: "Core", depth: 1, isolated: true, group: "wave", status: "done" as const, duration: 540000, cost: 0.42, context: 0.31, refused: 1 },
      { sessionID: "ses_docs", title: "Docs", depth: 1, isolated: false, status: "out" as const, duration: 60000 },
    ],
  }
  await records.put("proj_1", "ses_top", record)
  expect(writes).toEqual([
    'set memory/proj_1/ses_top {"startedAt":1760000000000,"movedAt":1760000900000,"title":"Add memory to courier","split":"split: 3 parts: core, e2e, docs","revisions":[{"text":"split: 2 parts: e2e, docs","at":1760000600000,"parts":1}],"finished":true,"recalled":{"at":1760000001000,"calls":1},"lesson":{"text":"The docs part was ten lines; next time do it yourself.","at":1760000890000},"parts":[{"sessionID":"ses_core","title":"Core","depth":1,"isolated":true,"group":"wave","status":"done","duration":540000,"cost":0.42,"context":0.31,"refused":1},{"sessionID":"ses_docs","title":"Docs","depth":1,"isolated":false,"status":"out","duration":60000}]}',
  ])
  expect(await records.get("proj_1", "ses_top")).toEqual(record)
  expect(await records.ofProject("proj_1")).toEqual([{ ...record, projectID: "proj_1", sessionID: "ses_top" }])
  // Beside the record, under its key (#285): the person's pin, and the reads of each tree that listed or read it, each
  // key with one writer; the record is read with them, written without them, and removed with them.
  writes.length = 0
  await records.pin("proj_1", "ses_top", { at: 1760001000000 })
  await records.noteRead("proj_1", "ses_top", "ses_reader", "shown", 1760002000000)
  await records.noteRead("proj_1", "ses_top", "ses_reader", "read", 1760003000000)
  expect(writes).toEqual([
    'set memory/proj_1/ses_top/pin {"at":1760001000000}',
    'set memory/proj_1/ses_top/reads/ses_reader {"shown":1,"read":0,"at":1760002000000}',
    'set memory/proj_1/ses_top/reads/ses_reader {"shown":1,"read":1,"at":1760003000000}',
  ])
  const beside = { reads: { shown: 1, read: 1, at: 1760003000000 }, pinned: { at: 1760001000000 } }
  expect(await records.get("proj_1", "ses_top")).toEqual({ ...record, ...beside })
  writes.length = 0
  await records.put("proj_1", "ses_top", { ...record, ...beside })
  expect(writes[0]).not.toContain("reads")
  expect(writes[0]).not.toContain("pinned")
  writes.length = 0
  await records.remove("proj_1", "ses_top")
  expect(writes).toEqual(["remove memory/proj_1/ses_top", "remove memory/proj_1/ses_top/pin", "remove memory/proj_1/ses_top/reads/ses_reader"])
})
