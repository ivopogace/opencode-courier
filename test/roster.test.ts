import { describe, expect, test } from "bun:test"
import {
  backfill,
  children,
  current,
  entriesOf,
  forget,
  lineage,
  pruneExpired,
  record,
  remove,
  RETENTION_MS,
  reverseKey,
  rosterKey,
  type RosterEntry,
  type RosterStorage,
} from "../src/roster.js"

function fakeStorage(pageSize?: number) {
  const store = new Map<string, unknown>()
  const scans: string[] = []
  const storage: RosterStorage = {
    get: async (key) => store.get(key) as any,
    set: async (key, value) => void store.set(key, value),
    remove: async (key) => void store.delete(key),
    scan: async ({ prefix, after }) => {
      scans.push(prefix)
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort()
      const start = after === undefined ? 0 : keys.indexOf(after) + 1
      const size = pageSize ?? keys.length
      const page = keys.slice(start, start + size)
      const entries = page.map((key) => ({ key, value: store.get(key) as any }))
      return start + size < keys.length ? { entries, next: page.at(-1) } : { entries }
    },
  }
  return { storage, store, scans }
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

  test("prunes expired children of every parent", async () => {
    const { storage, store } = fakeStorage()
    const now = 10 * RETENTION_MS
    await record(storage, entry("ses_a", "ses_one", now - RETENTION_MS - 1))
    await record(storage, entry("ses_b", "ses_two", now - RETENTION_MS - 1))
    await record(storage, entry("ses_c", "ses_two", now))
    store.set("later/x", { id: "x" })

    await pruneExpired(storage, now)

    expect([...store.keys()].sort()).toEqual(["later/x", reverseKey("ses_c"), rosterKey("ses_two", "ses_c")])
  })

  test("keeps an expired isolated child while its worktree exists, so it can still be cleaned up", async () => {
    const { storage, store } = fakeStorage()
    const now = 10 * RETENTION_MS
    const old = now - RETENTION_MS - 1
    await record(storage, { ...entry("ses_kept", "ses_parent", old), isolated: true, directory: "/wt/kept" })
    await record(storage, { ...entry("ses_gone", "ses_parent", old), isolated: true, directory: "/wt/gone" })
    const exists = (directory: string) => directory === "/wt/kept"

    expect((await current(storage, "ses_parent", now, exists)).map((child) => child.sessionID)).toEqual(["ses_kept"])
    await pruneExpired(storage, now, exists)
    expect([...store.keys()].sort()).toEqual([reverseKey("ses_kept"), rosterKey("ses_parent", "ses_kept")])
  })

  describe("reverse index", () => {
    const ids = (entries: RosterEntry[]) => entries.map((each) => each.sessionID)

    test("records each child's ancestors under its own session, up to the session at the top", async () => {
      const { storage, store } = fakeStorage()
      await record(storage, entry("ses_child", "ses_top", 1))
      await record(storage, entry("ses_grandchild", "ses_child", 2))

      expect(store.get(reverseKey("ses_child"))).toEqual({ ancestors: ["ses_top"] })
      expect(store.get(reverseKey("ses_grandchild"))).toEqual({ ancestors: ["ses_child", "ses_top"] })
    })

    test("finds a child's entry and lineage without scanning the roster", async () => {
      const { storage, scans } = fakeStorage()
      await record(storage, entry("ses_child", "ses_top", 1))
      await record(storage, entry("ses_grandchild", "ses_child", 2))
      await record(storage, entry("ses_other", "ses_elsewhere", 3))
      scans.length = 0

      expect(await entriesOf(storage, "ses_grandchild")).toEqual([entry("ses_grandchild", "ses_child", 2)])
      expect(ids(await lineage(storage, "ses_grandchild"))).toEqual(["ses_grandchild", "ses_child"])
      expect((await lineage(storage, "ses_grandchild")).at(-1)!.parentID).toBe("ses_top")
      expect(scans).toEqual([])
    })

    test("indexes a child of a top session by scanning once, and a child of an indexed one without", async () => {
      const { storage, scans } = fakeStorage()
      await record(storage, entry("ses_child", "ses_top", 1))
      expect(scans).toEqual(["roster/"])
      scans.length = 0

      await record(storage, entry("ses_grandchild", "ses_child", 2))
      expect(scans).toEqual([])
    })

    test("follows the top's own reverse key, for a parent recorded after its child", async () => {
      const { storage, scans } = fakeStorage()
      await record(storage, entry("ses_grandchild", "ses_child", 2))
      await record(storage, entry("ses_child", "ses_top", 1))
      scans.length = 0

      expect(ids(await lineage(storage, "ses_grandchild"))).toEqual(["ses_grandchild", "ses_child"])
      expect(scans).toEqual([])
    })

    test("ends the lineage where an entry is gone, and finds nothing for a child whose entry is gone", async () => {
      const { storage, store } = fakeStorage()
      await record(storage, entry("ses_child", "ses_top", 1))
      await record(storage, entry("ses_grandchild", "ses_child", 2))
      // As an older copy of the plugin removes them: the entry only, the reverse key stays.
      store.delete(rosterKey("ses_top", "ses_child"))

      expect(ids(await lineage(storage, "ses_grandchild"))).toEqual(["ses_grandchild"])
      expect(await lineage(storage, "ses_child")).toEqual([])
      expect(await entriesOf(storage, "ses_child")).toEqual([])
    })

    test("falls back to scanning for an entry without a reverse key, as an older copy writes it", async () => {
      const { storage, store, scans } = fakeStorage()
      store.set(rosterKey("ses_top", "ses_child"), entry("ses_child", "ses_top", 1))
      await record(storage, entry("ses_grandchild", "ses_child", 2))
      store.set(rosterKey("ses_grandchild", "ses_old"), entry("ses_old", "ses_grandchild", 3))
      scans.length = 0

      expect(await entriesOf(storage, "ses_child")).toEqual([entry("ses_child", "ses_top", 1)])
      expect(ids(await lineage(storage, "ses_old"))).toEqual(["ses_old", "ses_grandchild", "ses_child"])
      expect(scans).toEqual(["roster/", "roster/"])
      // The grandchild, recorded by this copy, was indexed through that scan, its parent included.
      expect(store.get(reverseKey("ses_grandchild"))).toEqual({ ancestors: ["ses_child", "ses_top"] })
      expect(await entriesOf(storage, "ses_nobody")).toEqual([])
      expect(await lineage(storage, "ses_nobody")).toEqual([])
    })

    test("keeps a child on the roster when its reverse key cannot be written", async () => {
      const { storage, store } = fakeStorage()
      const failing: RosterStorage = {
        ...storage,
        set: async (key, value) => (key.startsWith("roster-by-child/") ? Promise.reject(new Error("disk full")) : storage.set(key, value)),
      }

      await record(failing, entry("ses_child", "ses_top", 1))

      expect(store.has(reverseKey("ses_child"))).toBe(false)
      expect(ids(await lineage(storage, "ses_child"))).toEqual(["ses_child"])
    })

    test("removes the reverse key with the entry, and drops it from its group as dropped", async () => {
      const { storage, store } = fakeStorage()
      await record(storage, entry("ses_a", "ses_parent", 1))
      await record(storage, { ...entry("ses_b", "ses_parent", 2), group: "pair" })
      store.set("group/ses_parent/pair/ses_b", { title: "b", joinedAt: 2 })
      store.set("group/ses_parent/pair/ses_c", { title: "c", joinedAt: 3 })

      await remove(storage, "ses_parent", "ses_a")
      expect(await forget(storage, "ses_parent", "ses_b")).toBe(true)

      // The group no longer waits for it: marked as dropped, which releases the group without it.
      expect(store.get("group/ses_parent/pair/ses_b")).toEqual({ title: "b", joinedAt: 2, left: { at: 0, by: "dropped" } })
      store.set("roster/ses_parent/ses_c", { ...entry("ses_c", "ses_parent", 3), group: "pair" })
      await remove(storage, "ses_parent", "ses_c", "pair", 6)
      expect(store.get("group/ses_parent/pair/ses_c")).toEqual({ title: "c", joinedAt: 3, left: { at: 6, by: "dropped" } })
      // A held report outlives the entry: the group still delivers it.
      store.set("group/ses_parent/pair/ses_d", { title: "d", joinedAt: 4, report: { at: 5, status: "done", message: "m" } })
      store.set("roster/ses_parent/ses_d", { ...entry("ses_d", "ses_parent", 4), group: "pair" })
      expect(await forget(storage, "ses_parent", "ses_d")).toBe(true)
      // The dropped memberships are marked, not gone: the group releases with them named, and drops them then.
      expect([...store.keys()]).toEqual(["group/ses_parent/pair/ses_b", "group/ses_parent/pair/ses_c", "group/ses_parent/pair/ses_d"])
    })

    test("back-fills missing reverse keys and drops those whose entry is gone, once however often it runs", async () => {
      const { storage, store } = fakeStorage(1)
      store.set(rosterKey("ses_top", "ses_child"), entry("ses_child", "ses_top", 1))
      store.set(rosterKey("ses_child", "ses_grandchild"), entry("ses_grandchild", "ses_child", 2))
      await record(storage, entry("ses_indexed", "ses_top", 3))
      store.set(reverseKey("ses_gone"), { ancestors: ["ses_top"] })
      store.set(reverseKey("ses_junk"), "not an index")
      store.set(rosterKey("ses_top", "ses_moved"), entry("ses_moved", "ses_top", 4))
      store.set(reverseKey("ses_moved"), { ancestors: ["ses_elsewhere"] })
      const entries = [
        entry("ses_child", "ses_top", 1),
        entry("ses_grandchild", "ses_child", 2),
        entry("ses_indexed", "ses_top", 3),
        entry("ses_moved", "ses_top", 4),
      ]

      await backfill(storage, entries)
      const once = new Map(store)
      await backfill(storage, entries)

      expect(store).toEqual(once)
      expect(store.get(reverseKey("ses_child"))).toEqual({ ancestors: ["ses_top"] })
      expect(store.get(reverseKey("ses_grandchild"))).toEqual({ ancestors: ["ses_child", "ses_top"] })
      expect(store.get(reverseKey("ses_indexed"))).toEqual({ ancestors: ["ses_top"] })
      expect(store.has(reverseKey("ses_gone"))).toBe(false)
      expect(store.has(reverseKey("ses_junk"))).toBe(false)
      expect(store.get(reverseKey("ses_moved"))).toEqual({ ancestors: ["ses_top"] })
    })

    test("removing an entry succeeds when its reverse key cannot be removed", async () => {
      const { storage, store } = fakeStorage()
      await record(storage, entry("ses_child", "ses_top", 1))
      const failing: RosterStorage = {
        ...storage,
        remove: async (key) => (key.startsWith("roster-by-child/") ? Promise.reject(new Error("locked")) : storage.remove(key)),
      }

      await remove(failing, "ses_top", "ses_child")

      expect([...store.keys()]).toEqual([reverseKey("ses_child")])
      expect(await lineage(storage, "ses_child")).toEqual([])
    })

    test("back-filling keeps a reverse key whose entry was recorded after the roster was read", async () => {
      const { storage, store } = fakeStorage()
      await record(storage, entry("ses_new", "ses_top", 1))

      await backfill(storage, [])

      expect(store.get(reverseKey("ses_new"))).toEqual({ ancestors: ["ses_top"] })
    })

    test("pruning on load back-fills the entries it keeps", async () => {
      const { storage, store, scans } = fakeStorage()
      const now = 10 * RETENTION_MS
      store.set(rosterKey("ses_top", "ses_child"), entry("ses_child", "ses_top", now))
      store.set(rosterKey("ses_top", "ses_old"), entry("ses_old", "ses_top", now - RETENTION_MS - 1))

      await pruneExpired(storage, now)
      scans.length = 0

      expect([...store.keys()].sort()).toEqual([reverseKey("ses_child"), rosterKey("ses_top", "ses_child")])
      expect(ids(await lineage(storage, "ses_child"))).toEqual(["ses_child"])
      expect(scans).toEqual([])
    })
  })
})
