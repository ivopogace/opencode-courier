import { describe, expect, test } from "bun:test"
import { children, current, forget, record, RETENTION_MS, rosterKey, type RosterEntry, type RosterStorage } from "../src/roster.js"

function fakeStorage(pageSize?: number) {
  const store = new Map<string, unknown>()
  const storage: RosterStorage = {
    get: async (key) => store.get(key) as any,
    set: async (key, value) => void store.set(key, value),
    remove: async (key) => void store.delete(key),
    scan: async ({ prefix, after }) => {
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort()
      const start = after === undefined ? 0 : keys.indexOf(after) + 1
      const size = pageSize ?? keys.length
      const page = keys.slice(start, start + size)
      const entries = page.map((key) => ({ key, value: store.get(key) as any }))
      return start + size < keys.length ? { entries, next: page.at(-1) } : { entries }
    },
  }
  return { storage, store }
}

const entry = (sessionID: string, parentID: string, createdAt: number): RosterEntry => ({
  sessionID,
  parentID,
  title: `title of ${sessionID}`,
  directory: "/repo",
  isolated: false,
  createdAt,
})

describe("roster", () => {
  test("records a child under its parent", async () => {
    const { storage, store } = fakeStorage()

    await record(storage, entry("ses_a", "ses_parent", 1))

    expect(store.get(rosterKey("ses_parent", "ses_a"))).toEqual(entry("ses_a", "ses_parent", 1))
  })

  test("lists only the parent's children, oldest first, across pages", async () => {
    const { storage } = fakeStorage(1)
    await record(storage, entry("ses_b", "ses_parent", 2))
    await record(storage, entry("ses_a", "ses_parent", 1))
    await record(storage, entry("ses_c", "ses_parent", 3))
    await record(storage, entry("ses_x", "ses_other", 1))
    await record(storage, entry("ses_y", "ses_parent2", 1))

    expect((await children(storage, "ses_parent")).map((child) => child.sessionID)).toEqual(["ses_a", "ses_b", "ses_c"])
    expect(await children(storage, "ses_nobody")).toEqual([])
  })

  test("forgets a child", async () => {
    const { storage } = fakeStorage()
    await record(storage, entry("ses_a", "ses_parent", 1))
    await record(storage, entry("ses_b", "ses_parent", 2))

    expect(await forget(storage, "ses_parent", "ses_a")).toBe(true)
    expect(await forget(storage, "ses_parent", "ses_a")).toBe(false)
    expect((await children(storage, "ses_parent")).map((child) => child.sessionID)).toEqual(["ses_b"])
  })

  test("drops children past the retention period when the roster is read", async () => {
    const { storage, store } = fakeStorage()
    const now = 10 * RETENTION_MS
    await record(storage, entry("ses_old", "ses_parent", now - RETENTION_MS - 1))
    await record(storage, entry("ses_new", "ses_parent", now - RETENTION_MS))

    expect((await current(storage, "ses_parent", now)).map((child) => child.sessionID)).toEqual(["ses_new"])
    expect(store.has(rosterKey("ses_parent", "ses_old"))).toBe(false)
  })
})
