import { expect, test } from "bun:test"
import { forgetChild } from "../src/tree/forget.js"
import { holdReport, joinGroup, membershipOf } from "../src/tree/group.js"
import type { RosterStorage } from "../src/tree/ports.js"
import { childStore, groupStore } from "../src/tree/store.js"

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
    "remove report/ses_child/wake",
  ])
  // The held report outlives the child's entry: it still goes to the parent with its group.
  expect([...store.keys()]).toEqual(["group/ses_parent/pair/ses_child"])
})
