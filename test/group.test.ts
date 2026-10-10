import { describe, expect, test } from "bun:test"
import {
  deliverReleased,
  dropGroups,
  dropMember,
  groupsOf,
  holdReport,
  isGroupName,
  joinGroup,
  leaveGroup,
  memberKey,
  memberOf,
  standingOf,
  type GroupPorts,
  type Membership,
} from "../src/group.js"
import { envelope, groupNotice } from "../src/notices.js"

function fakePorts(options: { pageSize?: number; store?: Map<string, unknown> } = {}) {
  const store = options.store ?? new Map<string, unknown>()
  const delivered: any[] = []
  const logs: string[] = []
  const ports: GroupPorts = {
    storage: {
      get: async (key) => store.get(key) as any,
      set: async (key, value) => void store.set(key, value),
      remove: async (key) => void store.delete(key),
      scan: async ({ prefix, after, limit }) => {
        const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort()
        const start = after === undefined ? 0 : keys.indexOf(after) + 1
        const size = limit ?? options.pageSize ?? keys.length
        const page = keys.slice(start, start + size)
        const entries = page.map((key) => ({ key, value: store.get(key) as any }))
        return start + size < keys.length ? { entries, next: page.at(-1) } : { entries }
      },
    },
    session: {
      synthetic: (async (input: any) => {
        // Yield first, like a real call, so concurrent deliveries interleave.
        await Promise.resolve()
        delivered.push(input)
        return { id: `msg_${delivered.length}` }
      }) as any,
    },
    log: (message) => logs.push(message),
  }
  return { ports, store, delivered, logs }
}

const membership = (sessionID: string, title = sessionID, group = "pair", parentID = "ses_parent"): Membership => ({
  parentID,
  group,
  sessionID,
  title,
  joinedAt: 1,
})
const report = (status: "done" | "partial" | "failed", message = `${status} by me`, at = 100) => ({ at, status, message })

describe("isGroupName", () => {
  test("takes a short name of letters, digits, dots, dashes and underscores, and nothing else", () => {
    expect(["reviews", "phase-1", "wave_2.b", "x".repeat(60)].every(isGroupName)).toBe(true)
    expect(["", " reviews", "a/b", 'a"b', "x".repeat(61), 7, null].some(isGroupName)).toBe(false)
  })
})

describe("joining and leaving", () => {
  test("a member joins under its parent and group, with its title, and is listed by group in the order joined", async () => {
    const { ports } = fakePorts()
    await joinGroup(ports.storage, "ses_parent", "pair", "ses_b", "Second", 2)
    await joinGroup(ports.storage, "ses_parent", "pair", "ses_a", "First", 1)
    await joinGroup(ports.storage, "ses_parent", "other", "ses_c", "Third", 3)
    await joinGroup(ports.storage, "ses_other", "pair", "ses_d", "Elsewhere", 4)

    expect(await memberOf(ports.storage, "ses_parent", "pair", "ses_a")).toEqual({ title: "First", joinedAt: 1 })
    expect(await memberOf(ports.storage, "ses_parent", "pair", "ses_d")).toBeUndefined()
    const groups = await groupsOf(ports.storage, "ses_parent")
    expect([...groups.keys()]).toEqual(["pair", "other"])
    expect(groups.get("pair")!.map((member) => member.sessionID)).toEqual(["ses_a", "ses_b"])
    expect(groups.get("pair")![0]).toEqual({ parentID: "ses_parent", group: "pair", sessionID: "ses_a", title: "First", joinedAt: 1 })
  })

  test("holding a report counts the members that have reported, and says when the last one has", async () => {
    const { ports, store } = fakePorts()
    await joinGroup(ports.storage, "ses_parent", "pair", "ses_a", "A", 1)
    await joinGroup(ports.storage, "ses_parent", "pair", "ses_b", "B", 2)

    expect(await holdReport(ports.storage, membership("ses_a", "A"), report("done"))).toEqual({ reported: 1, members: 2, complete: false })
    expect(store.get(memberKey("ses_parent", "pair", "ses_a"))).toEqual({ title: "A", joinedAt: 1, report: report("done") })
    // A second report of the same member replaces the first.
    expect(await holdReport(ports.storage, membership("ses_a", "A"), report("partial"))).toEqual({ reported: 1, members: 2, complete: false })
    expect(await holdReport(ports.storage, membership("ses_b", "B"), { ...report("failed"), artifacts: { files: ["a.ts"] } })).toEqual({
      reported: 2,
      members: 2,
      complete: true,
    })
    expect(standingOf(await memberOf(ports.storage, "ses_parent", "pair", "ses_b"))).toBe("held")
  })

  test("a member whose turn failed or that was deleted leaves without a report, and the group completes without it", async () => {
    const { ports } = fakePorts()
    await joinGroup(ports.storage, "ses_parent", "pair", "ses_a", "A", 1)
    await joinGroup(ports.storage, "ses_parent", "pair", "ses_b", "B", 2)

    expect(await leaveGroup(ports.storage, "ses_parent", "pair", "ses_a", "failed", 50)).toEqual({ complete: false })
    expect(await memberOf(ports.storage, "ses_parent", "pair", "ses_a")).toEqual({ title: "A", joinedAt: 1, left: { at: 50, by: "failed" } })
    expect(standingOf(await memberOf(ports.storage, "ses_parent", "pair", "ses_a"))).toBe("failed")
    // Not a member: nothing to leave.
    expect(await leaveGroup(ports.storage, "ses_parent", "pair", "ses_c", "deleted", 50)).toBeUndefined()
    // The last member's report completes the group: the one that left counts no more among its members.
    expect(await holdReport(ports.storage, membership("ses_b", "B"), report("done"))).toEqual({ reported: 1, members: 1, complete: true })
  })

  test("a member that reports after it left rejoins with its report, and one whose report is held keeps it when its turn fails later", async () => {
    const { ports } = fakePorts()
    await joinGroup(ports.storage, "ses_parent", "pair", "ses_a", "A", 1)
    await joinGroup(ports.storage, "ses_parent", "pair", "ses_b", "B", 2)
    await leaveGroup(ports.storage, "ses_parent", "pair", "ses_a", "failed", 50)

    expect(await holdReport(ports.storage, membership("ses_a", "A"), report("done"))).toEqual({ reported: 1, members: 2, complete: false })
    expect(await leaveGroup(ports.storage, "ses_parent", "pair", "ses_a", "failed", 60)).toEqual({ complete: false })
    expect(standingOf(await memberOf(ports.storage, "ses_parent", "pair", "ses_a"))).toBe("held")
  })

  test("a member dropped with its roster entry, or a parent's groups dropped with it, are gone", async () => {
    const { ports, store } = fakePorts()
    await joinGroup(ports.storage, "ses_parent", "pair", "ses_a", "A", 1)
    await joinGroup(ports.storage, "ses_parent", "pair", "ses_b", "B", 2)
    await joinGroup(ports.storage, "ses_other", "pair", "ses_c", "C", 3)

    await dropMember(ports.storage, "ses_parent", "pair", "ses_a")
    expect(standingOf(await memberOf(ports.storage, "ses_parent", "pair", "ses_a"))).toBe("released")
    await dropGroups(ports.storage, "ses_parent")
    expect([...store.keys()]).toEqual([memberKey("ses_other", "pair", "ses_c")])
  })
})

describe("deliverReleased", () => {
  const artifacts = { branch: "b/work", checks: [{ command: "bun test", result: "ok" }] }

  async function pair(ports: GroupPorts) {
    await joinGroup(ports.storage, "ses_parent", "pair", "ses_a", "First", 1)
    await joinGroup(ports.storage, "ses_parent", "pair", "ses_b", "Second", 2)
  }

  test("delivers a group whose every member has reported, in one message listing each report in the order joined, then drops it", async () => {
    const { ports, store, delivered } = fakePorts()
    await pair(ports)
    await joinGroup(ports.storage, "ses_parent", "open", "ses_c", "Third", 3)
    await holdReport(ports.storage, membership("ses_b", "Second"), { ...report("failed", "Could not."), artifacts })
    await holdReport(ports.storage, membership("ses_a", "First"), report("done", "Did it."))

    await deliverReleased(ports, new Set())

    const reports = [
      { sessionID: "ses_a", title: "First", ...report("done", "Did it.") },
      { sessionID: "ses_b", title: "Second", ...report("failed", "Could not."), artifacts },
    ]
    expect(delivered).toEqual([
      {
        sessionID: "ses_parent",
        text: envelope("ses_a,ses_b", groupNotice("pair", reports), { group: "pair", reports: "2" }),
        description: "Reports of group pair",
        metadata: { source: "courier", from: ["ses_a", "ses_b"], group: "pair", reports: 2 },
        delivery: "steer",
      },
    ])
    expect(delivered[0].text).toContain('[1/2] ses_a "First": done\nDid it.\n\n[2/2] ses_b "Second": failed\nCould not.\n\nArtifacts:\n- branch: b/work\n- checks:\n  - bun test: ok')
    expect([...store.keys()]).toEqual([memberKey("ses_parent", "open", "ses_c")])
  })

  test("delivers nothing while a member is out, and names a member that left without a report", async () => {
    const { ports, delivered, store } = fakePorts()
    await pair(ports)
    await holdReport(ports.storage, membership("ses_a", "First"), report("done"))
    await deliverReleased(ports, new Set())
    expect(delivered).toEqual([])

    await leaveGroup(ports.storage, "ses_parent", "pair", "ses_b", "failed", 50)
    await deliverReleased(ports, new Set())

    expect(delivered).toHaveLength(1)
    expect(delivered[0].text).toContain('1 report of 2 members (1 done)')
    expect(delivered[0].text).toContain('Without a report, as you were told: ses_b "Second" (its turn failed).')
    expect(delivered[0].metadata.from).toEqual(["ses_a"])
    expect(store.size).toBe(0)
  })

  test("drops a group whose every member left, unsent: the parent was told of each", async () => {
    const { ports, delivered, store } = fakePorts()
    await pair(ports)
    await leaveGroup(ports.storage, "ses_parent", "pair", "ses_a", "failed", 50)
    await leaveGroup(ports.storage, "ses_parent", "pair", "ses_b", "deleted", 60)

    await deliverReleased(ports, new Set())

    expect(delivered).toEqual([])
    expect(store.size).toBe(0)
  })

  test("two plugin instances sharing storage and claims deliver a group once", async () => {
    const { ports, delivered } = fakePorts()
    await pair(ports)
    await holdReport(ports.storage, membership("ses_a"), report("done"))
    await holdReport(ports.storage, membership("ses_b"), report("done"))
    const claimed = new Set<string>()

    await Promise.all([deliverReleased(ports, claimed), deliverReleased(ports, claimed), deliverReleased(ports, claimed)])

    expect(delivered).toHaveLength(1)
    expect(claimed.size).toBe(0)
  })

  test("an instance that scanned before another delivered does not deliver again", async () => {
    const { ports, delivered } = fakePorts()
    await pair(ports)
    await holdReport(ports.storage, membership("ses_a"), report("done"))
    await holdReport(ports.storage, membership("ses_b"), report("done"))
    const stale = { ...ports, storage: { ...ports.storage } }
    const firstScan = ports.storage.scan({ prefix: "group/" })
    let scans = 0
    stale.storage.scan = (input) => (scans++ ? ports.storage.scan(input) : firstScan)

    await deliverReleased(ports, new Set())
    await deliverReleased(stale, new Set())

    expect(delivered).toHaveLength(1)
  })

  test("keeps a group whose delivery failed, logs it, and delivers it at a later tick", async () => {
    const { ports, delivered, logs, store } = fakePorts()
    await pair(ports)
    await holdReport(ports.storage, membership("ses_a"), report("done"))
    await holdReport(ports.storage, membership("ses_b"), report("done"))
    const synthetic = ports.session.synthetic
    ;(ports.session as any).synthetic = async () => Promise.reject(new Error("parent is gone"))

    await deliverReleased(ports, new Set())
    expect(delivered).toEqual([])
    expect(store.size).toBe(2)
    expect(logs).toEqual(["courier group pair of ses_parent not delivered, held for another try: Error: parent is gone"])

    ;(ports.session as any).synthetic = synthetic
    await deliverReleased(ports, new Set())
    expect(delivered).toHaveLength(1)
    expect(store.size).toBe(0)
  })

  test("what it keeps survives a restart: a new instance over the same storage delivers it", async () => {
    const before = fakePorts()
    await pair(before.ports)
    await holdReport(before.ports.storage, membership("ses_a"), report("done"))
    await holdReport(before.ports.storage, membership("ses_b"), report("done"))

    const after = fakePorts({ store: before.store })
    await deliverReleased(after.ports, new Set())

    expect(after.delivered).toHaveLength(1)
    expect(before.delivered).toEqual([])
  })

  test("reads every page of members, and leaves out what is not a member", async () => {
    const { ports, delivered, store } = fakePorts({ pageSize: 2 })
    for (const id of ["a", "b", "c", "d", "e"]) {
      await joinGroup(ports.storage, "ses_parent", "five", `ses_${id}`, id, 1)
      await holdReport(ports.storage, membership(`ses_${id}`, id, "five"), report("done"))
    }
    store.set("group/ses_parent/five", { stray: true })
    store.set("group/ses_parent/odd/ses_x", "not a member")

    await deliverReleased(ports, new Set())

    expect(delivered).toHaveLength(1)
    expect(delivered[0].metadata.reports).toBe(5)
    expect([...store.keys()].sort()).toEqual(["group/ses_parent/five", "group/ses_parent/odd/ses_x"])
  })
})
