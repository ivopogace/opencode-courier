import { describe, expect, test } from "bun:test"
import { permissionNotice, permissionSettledNotice as settledNotice, REJECTED } from "../src/person/text.js"
import { answer, isDeclined, pendingOf, type AnswerPorts, type Permissions } from "../src/person/permission.js"
import { childStore } from "../src/tree/store.js"

const request = { id: "per_1", sessionID: "ses_child", action: "shell", resources: ["git push"], save: ["git push*"] }

/** What `permission.assert` rejects with through the promise API: a `Tool.Error` carrying OpenCode's error, or the decline itself. */
class ToolError extends Error {
  readonly _tag = "Tool.Error"
  constructor(message: string, readonly error: { _tag: string }) {
    super(message)
  }
}
class DeclinedError extends Error {
  readonly _tag = "Permission.DeclinedError"
}
const denied = () => new ToolError("Permission denied: shell", { _tag: "Permission.BlockedError" })
const corrected = (feedback: string) => new ToolError(feedback, { _tag: "Permission.CorrectedError" })

/** The caller's `permission.assert`: records what it was asked, and answers as told, or holds until `release` is called. */
function caller(outcome: "allow" | Error | "hold" = "allow") {
  const asked: any[] = []
  let release: (error?: Error) => void = () => {}
  const assert = (input: any) => {
    asked.push(input)
    if (outcome === "allow") return Promise.resolve()
    if (outcome === "hold") return new Promise<void>((resolve, reject) => (release = (error) => (error ? reject(error) : resolve())))
    return Promise.reject(outcome)
  }
  return { assert, asked, release: (error?: Error) => release(error) }
}

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
  return setUpWith(caller(), ...locations)
}

async function setUpWith(top: ReturnType<typeof caller>, ...locations: Permissions[]) {
  const store = new Map<string, unknown>()
  const ports: AnswerPorts = {
    assert: top.assert,
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
  await childStore(ports.storage).record({ sessionID: "ses_child", parentID: "ses_parent", title: "Fix the bug", directory: "/wt", isolated: true, createdAt: 1 })
  return ports
}

describe("permissionNotice", () => {
  test("says what is asked, offers once and reject, and tells the parent to propose one, which OpenCode asks the person about", () => {
    const notice = permissionNotice("Fix the bug", request)

    expect(notice).toContain('This session, "Fix the bug", which you started with courier_spawn, is waiting for permission')
    expect(notice).toContain("It asks for: shell\nOn:\n- git push\n")
    expect(notice).toContain("You cannot decide this: the person you are working with does, in OpenCode's own permission prompt")
    expect(notice).toContain("Do not ask them in your reply or with your question tool first")
    expect(notice).toContain("- once: allow this request only; OpenCode first asks the person in your session")
    expect(notice).not.toContain("- always")
    expect(notice).toContain("- reject: refuse it")
    expect(notice).toContain('Call courier_answer with sessionID "ses_child", requestID "per_1"')
    expect(notice).toContain("Propose once unless the person has told you to refuse it")
  })

  test("names the session that started a child's child", () => {
    expect(permissionNotice("t", request, "ses_mid")).toContain(
      'This session, "t", which ses_mid started with courier_spawn, a session started from yours, is waiting',
    )
  })

  test("never offers always, whatever the request would save: courier_answer grants no standing rule", () => {
    expect(permissionNotice("t", { ...request, save: ["*"] })).not.toContain("always")
    expect(permissionNotice("t", { ...request, save: ["*"] }, undefined, true)).not.toContain("always")
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
  test("replies where the request is pending, in the child's location, once OpenCode has allowed it in the caller's session", async () => {
    const own = location()
    const worktree = location([request])
    const top = caller()
    const ports = await setUpWith(top, own.domain, worktree.domain)
    const waiting = new Set(["per_1"])
    const call = { messageID: "msg_p", callID: "call_1" }

    const result = await answer(ports, waiting, "ses_parent", { sessionID: "ses_child", requestID: "per_1", reply: "once", call })

    expect(result).toEqual({ sessionID: "ses_child", requestID: "per_1", reply: "once", answered: true })
    // The caller's own session is asked, with the child's request as OpenCode received it, nothing to save, and the call as source.
    expect(top.asked).toEqual([
      {
        sessionID: "ses_parent",
        action: "shell",
        resources: ["git push"],
        metadata: { source: "courier", from: "ses_child", asks: "permission", requestID: "per_1" },
        source: { type: "tool", messageID: "msg_p", id: "call_1" },
      },
    ])
    expect(worktree.replies).toEqual([{ sessionID: "ses_child", requestID: "per_1", decision: "once" }])
    expect(own.replies).toEqual([])
    expect(waiting.size).toBe(0)
  })

  test("holds the reply until the caller's prompt is answered, and the request waits meanwhile", async () => {
    const worktree = location([request])
    const top = caller("hold")
    const ports = await setUpWith(top, worktree.domain)
    const waiting = new Set(["per_1"])
    let settled = false

    const answering = answer(ports, waiting, "ses_parent", { sessionID: "ses_child", requestID: "per_1", reply: "once" }).then(() => (settled = true))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(top.asked).toHaveLength(1)
    expect(settled).toBe(false)
    expect(worktree.replies).toEqual([])
    expect(worktree.pending.has("per_1")).toBe(true)
    expect(waiting).toEqual(new Set(["per_1"]))

    top.release()
    await answering
    expect(settled).toBe(true)
    expect(worktree.replies).toEqual([{ sessionID: "ses_child", requestID: "per_1", decision: "once" }])
    expect(waiting.size).toBe(0)
  })

  test("passes nothing on when the request was answered while the person was asked", async () => {
    const worktree = location([request])
    const top = caller("hold")
    const ports = await setUpWith(top, worktree.domain)
    const waiting = new Set(["per_1"])

    const answering = answer(ports, waiting, "ses_parent", { sessionID: "ses_child", requestID: "per_1", reply: "once" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    worktree.pending.clear()
    top.release()

    expect(await answering).toEqual({ sessionID: "ses_child", requestID: "per_1", reply: "once", answered: false })
    expect(worktree.replies).toEqual([])
    expect(waiting.size).toBe(0)
  })

  test("a deny rule in the caller's session fails the call with the reason, and the child's request is refused with it", async () => {
    const worktree = location([request])
    const ports = await setUpWith(caller(denied()), worktree.domain)
    const waiting = new Set(["per_1"])

    await expect(answer(ports, waiting, "ses_parent", { sessionID: "ses_child", requestID: "per_1", reply: "once" })).rejects.toThrow(
      "not allowed in your session (Permission denied: shell). The refusal was passed on with that reason to request per_1 of ses_child, so its call fails and it carries on",
    )
    expect(worktree.replies).toEqual([{ sessionID: "ses_child", requestID: "per_1", decision: "reject", message: "Permission denied: shell" }])
    expect(waiting.size).toBe(0)
  })

  test("a rejection with a reason in the caller's prompt does the same", async () => {
    const worktree = location([request])
    const ports = await setUpWith(caller(corrected("Not on main")), worktree.domain)

    await expect(answer(ports, new Set(), "ses_parent", { sessionID: "ses_child", requestID: "per_1", reply: "once" })).rejects.toThrow(
      "not allowed in your session (Not on main). The refusal was passed on with that reason to request per_1 of ses_child",
    )
    expect(worktree.replies).toEqual([{ sessionID: "ses_child", requestID: "per_1", decision: "reject", message: "Not on main" }])
  })

  test("a plain rejection of the caller's prompt comes back as it is, and the child's request waits on", async () => {
    const worktree = location([request])
    const declined = new DeclinedError()
    const ports = await setUpWith(caller(declined), worktree.domain)
    const waiting = new Set(["per_1"])

    const failure = await answer(ports, waiting, "ses_parent", { sessionID: "ses_child", requestID: "per_1", reply: "once" }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBe(declined)
    expect(isDeclined(failure)).toBe(true)
    expect(isDeclined(denied())).toBe(false)
    expect(isDeclined(new Error("x"))).toBe(false)
    expect(worktree.replies).toEqual([])
    expect(worktree.pending.has("per_1")).toBe(true)
    expect(waiting).toEqual(new Set(["per_1"]))
  })

  test("any other failure of the caller's check is the tool's, and the child's request waits on", async () => {
    const worktree = location([request])
    const ports = await setUpWith(caller(new ToolError("Session not found: ses_parent", { _tag: "Session.NotFoundError" })), worktree.domain)
    const waiting = new Set(["per_1"])

    await expect(answer(ports, waiting, "ses_parent", { sessionID: "ses_child", requestID: "per_1", reply: "once" })).rejects.toThrow(
      "Session not found: ses_parent",
    )
    expect(worktree.replies).toEqual([])
    expect(waiting).toEqual(new Set(["per_1"]))
  })

  test("refuses always: no standing rule is granted through courier_answer, and the caller is not asked", async () => {
    const worktree = location([request])
    const top = caller()
    const ports = await setUpWith(top, worktree.domain)

    await expect(answer(ports, new Set(), "ses_parent", { sessionID: "ses_child", requestID: "per_1", reply: "always" })).rejects.toThrow(
      'reply must be once or reject, not "always": courier_answer grants no standing rule; the person grants one in OpenCode\'s own prompt, in the asking session or the asks inbox.',
    )
    expect(top.asked).toEqual([])
    expect(worktree.replies).toEqual([])
  })

  test("rejects with the reason given, or with one that keeps the child going, without asking the caller's session", async () => {
    const worktree = location([request, { ...request, id: "per_2" }])
    const top = caller(denied())
    const ports = await setUpWith(top, worktree.domain)

    await answer(ports, new Set(), "ses_parent", { sessionID: "ses_child", requestID: "per_1", reply: "reject", message: "Not on main" })
    await answer(ports, new Set(), "ses_parent", { sessionID: "ses_child", requestID: "per_2", reply: "reject" })

    expect(worktree.replies.map((reply) => reply.message)).toEqual(["Not on main", REJECTED])
    expect(top.asked).toEqual([])
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
      'reply must be once or reject, not "yes".',
    )
    expect(worktree.replies).toEqual([])
  })

  test("answers a request of a child's child from the session at the top, and not from the child", async () => {
    const grandchild = { ...request, id: "per_g", sessionID: "ses_grand" }
    const worktree = location([grandchild])
    const ports = await setUp(worktree.domain)
    await childStore(ports.storage).record({ sessionID: "ses_grand", parentID: "ses_child", title: "Push", directory: "/wt", isolated: true, createdAt: 2 })

    await expect(answer(ports, new Set(), "ses_child", { sessionID: "ses_grand", requestID: "per_g", reply: "once" })).rejects.toThrow(
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
