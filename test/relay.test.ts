import { describe, expect, test } from "bun:test"
import { answer, pendingOf, permissionNotice, REJECTED, settledNotice, type AnswerPorts, type Permissions } from "../src/relay.js"
import { record } from "../src/roster.js"

const request = { id: "per_1", sessionID: "ses_child", action: "shell", resources: ["git push"], save: ["git push*"] }

/** One location's permission domain holding the given requests; replies remove them, as OpenCode does. */
function location(requests: (typeof request)[] = []) {
  const pending = new Map(requests.map((item) => [item.id, item]))
  const replies: any[] = []
  const domain = {
    list: async ({ sessionID }: { sessionID: string }) => [...pending.values()].filter((item) => item.sessionID === sessionID),
    get: async ({ sessionID, requestID }: { sessionID: string; requestID: string }) => {
      const found = pending.get(requestID)
      if (!found || found.sessionID !== sessionID) throw new Error(`Permission request not found: ${requestID}`)
      return found
    },
    reply: async (input: any) => {
      replies.push(input)
      pending.delete(input.requestID)
    },
  }
  return { domain: domain as unknown as Permissions, replies, pending }
}

async function setUp(...locations: Permissions[]) {
  const store = new Map<string, unknown>()
  const ports: AnswerPorts = {
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
    } as unknown as AnswerPorts["storage"],
    permissions: () => locations,
  }
  await record(ports.storage, { sessionID: "ses_child", parentID: "ses_parent", title: "Fix the bug", directory: "/wt", isolated: true, createdAt: 1 })
  return ports
}

describe("permissionNotice", () => {
  test("says what is asked, offers OpenCode's choices and tells the parent to ask the person", () => {
    const notice = permissionNotice("Fix the bug", request)

    expect(notice).toContain('This session, "Fix the bug", which you started with courier_spawn, is waiting for permission')
    expect(notice).toContain("It asks for: shell\nOn:\n- git push\n")
    expect(notice).toContain("Do not decide this yourself. Ask the person you are working with")
    expect(notice).toContain("- once: allow this request only")
    expect(notice).toContain("- always: allow it, and from now on requests matching git push* in this project")
    expect(notice).toContain("- reject: refuse it")
    expect(notice).toContain('call courier_answer with sessionID "ses_child", requestID "per_1"')
  })

  test("names the session that started a child's child", () => {
    expect(permissionNotice("t", request, "ses_mid")).toContain(
      'This session, "t", which ses_mid started with courier_spawn, a session started from yours, is waiting',
    )
  })

  test("offers always only when the request has something to save, as OpenCode's prompt does", () => {
    expect(permissionNotice("t", { ...request, save: [] })).not.toContain("- always")
    expect(permissionNotice("t", { ...request, save: ["*"] })).toContain("from now on every shell request in this project")
  })

  test("shortens long resources, caps how many are listed, and passes on OpenCode's note", () => {
    const resources = ["x".repeat(400), ...Array.from({ length: 24 }, (_, i) => `r${i}`)]
    const notice = permissionNotice("t", { ...request, resources, message: "Outside the project" })

    expect(notice).toContain(`- ${"x".repeat(297)}...\n`)
    expect(notice).toContain("- r18\n- and 5 more")
    expect(notice).not.toContain("- r19")
    expect(notice).toContain("Note: Outside the project")
  })
})

describe("settledNotice", () => {
  test("says the request needs nothing more, and after a refusal that the child may have stopped", () => {
    expect(settledNotice("t", "per_1", "once")).toContain("has been answered (once) without courier_answer, so it no longer waits on you")
    expect(settledNotice("t", "per_1", "once")).not.toContain("refusal")
    expect(settledNotice("t", "per_1", "reject")).toContain("message it with courier_send to have it carry on")
  })
})

describe("answer", () => {
  test("replies where the request is pending, in the child's location", async () => {
    const own = location()
    const worktree = location([request])
    const ports = await setUp(own.domain, worktree.domain)
    const waiting = new Set(["per_1"])

    const result = await answer(ports, waiting, "ses_parent", { sessionID: "ses_child", requestID: "per_1", reply: "always" })

    expect(result).toEqual({ sessionID: "ses_child", requestID: "per_1", reply: "always", answered: true })
    expect(worktree.replies).toEqual([{ sessionID: "ses_child", requestID: "per_1", decision: "always" }])
    expect(own.replies).toEqual([])
    expect(waiting.size).toBe(0)
  })

  test("rejects with the person's reason, or with one that keeps the child going", async () => {
    const worktree = location([request, { ...request, id: "per_2" }])
    const ports = await setUp(worktree.domain)

    await answer(ports, new Set(), "ses_parent", { sessionID: "ses_child", requestID: "per_1", reply: "reject", message: "Not on main" })
    await answer(ports, new Set(), "ses_parent", { sessionID: "ses_child", requestID: "per_2", reply: "reject" })

    expect(worktree.replies.map((reply) => reply.message)).toEqual(["Not on main", REJECTED])
  })

  test("passes nothing on when the request was answered already", async () => {
    const ports = await setUp(location().domain)
    const waiting = new Set(["per_1"])

    const result = await answer(ports, waiting, "ses_parent", { sessionID: "ses_child", requestID: "per_1", reply: "once" })

    expect(result).toEqual({ sessionID: "ses_child", requestID: "per_1", reply: "once", answered: false })
    expect(waiting.size).toBe(0)
  })

  test("says so when the reply fails but the request no longer waits", async () => {
    const worktree = location([request])
    ;(worktree.domain as any).reply = async () => {
      worktree.pending.clear()
      throw new Error("Permission request not found: per_1")
    }
    const ports = await setUp(worktree.domain)

    await expect(answer(ports, new Set(), "ses_parent", { sessionID: "ses_child", requestID: "per_1", reply: "once" })).rejects.toThrow(
      "permission.reply failed: Permission request not found: per_1, but per_1 no longer waits, so it was answered, possibly by this call.",
    )
  })

  test("fails rather than calling a request gone when a location cannot be read", async () => {
    const broken = { list: async () => Promise.reject(new Error("database is locked")) } as unknown as Permissions
    const ports = await setUp(location().domain, broken)

    await expect(answer(ports, new Set(), "ses_parent", { sessionID: "ses_child", requestID: "per_1", reply: "once" })).rejects.toThrow(
      "database is locked",
    )
  })

  test("refuses always for a request with nothing to save, which OpenCode does not offer it for", async () => {
    const worktree = location([{ ...request, save: [] }])
    const ports = await setUp(worktree.domain)

    await expect(answer(ports, new Set(), "ses_parent", { sessionID: "ses_child", requestID: "per_1", reply: "always" })).rejects.toThrow(
      "always is not offered for per_1: it has nothing to save.",
    )
    expect(worktree.replies).toEqual([])
  })

  test("keeps the request waiting when the reply fails for another reason", async () => {
    const worktree = location([request])
    ;(worktree.domain as any).reply = async () => {
      throw new Error("database is locked")
    }
    const ports = await setUp(worktree.domain)
    const waiting = new Set(["per_1"])

    await expect(answer(ports, waiting, "ses_parent", { sessionID: "ses_child", requestID: "per_1", reply: "once" })).rejects.toThrow(
      "database is locked",
    )
    expect(waiting).toEqual(new Set(["per_1"]))
  })

  test("answers only for sessions started from the caller, and only with OpenCode's replies", async () => {
    const worktree = location([request, { ...request, id: "per_9", sessionID: "ses_stranger" }])
    const ports = await setUp(worktree.domain)

    await expect(answer(ports, new Set(), "ses_other", { sessionID: "ses_child", requestID: "per_1", reply: "once" })).rejects.toThrow(
      "ses_child's permission requests go to ses_parent, the session at the top of the sessions started from it with courier_spawn; ses_other cannot answer them.",
    )
    await expect(answer(ports, new Set(), "ses_parent", { sessionID: "ses_stranger", requestID: "per_9", reply: "once" })).rejects.toThrow(
      "ses_stranger was not started with courier_spawn",
    )
    await expect(answer(ports, new Set(), "ses_parent", { sessionID: "ses_child", requestID: "per_1", reply: "yes" })).rejects.toThrow(
      'reply must be once, always or reject, not "yes".',
    )
    expect(worktree.replies).toEqual([])
  })

  test("answers a request of a child's child from the session at the top, and not from the child", async () => {
    const grandchild = { ...request, id: "per_g", sessionID: "ses_grand" }
    const worktree = location([grandchild])
    const ports = await setUp(worktree.domain)
    await record(ports.storage, { sessionID: "ses_grand", parentID: "ses_child", title: "Push", directory: "/wt", isolated: true, createdAt: 2 })

    await expect(answer(ports, new Set(), "ses_child", { sessionID: "ses_grand", requestID: "per_g", reply: "always" })).rejects.toThrow(
      "ses_grand's permission requests go to ses_parent",
    )
    expect(worktree.replies).toEqual([])
    const result = await answer(ports, new Set(), "ses_parent", { sessionID: "ses_grand", requestID: "per_g", reply: "once" })
    expect(result.answered).toBe(true)
  })

  test("does not answer a request of another session under the child's id", async () => {
    const worktree = location([{ ...request, id: "per_9", sessionID: "ses_stranger" }])
    ;(worktree.domain as any).list = async () => [{ ...request, id: "per_9", sessionID: "ses_stranger" }]
    const ports = await setUp(worktree.domain)

    const result = await answer(ports, new Set(), "ses_parent", { sessionID: "ses_child", requestID: "per_9", reply: "once" })

    expect(result.answered).toBe(false)
    expect(worktree.replies).toEqual([])
  })
})

describe("pendingOf", () => {
  test("lists a session's requests from every location, once each", async () => {
    const shared = location([request])
    const worktree = location([request, { ...request, id: "per_2", save: [] }, { ...request, id: "per_3", sessionID: "ses_other" }])
    const broken = { list: async () => Promise.reject(new Error("gone")) } as unknown as Permissions

    expect(await pendingOf([shared.domain, worktree.domain, broken], "ses_child")).toEqual([
      { type: "permission", requestID: "per_1", action: "shell", resources: ["git push"], save: ["git push*"] },
      { type: "permission", requestID: "per_2", action: "shell", resources: ["git push"] },
    ])
  })
})
