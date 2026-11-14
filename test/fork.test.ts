import { describe, expect, test } from "bun:test"
import { envelope } from "../src/kernel/protocol.js"
import { onFork } from "../src/tree/fork.js"
import type { ForkPorts } from "../src/tree/ports.js"
import { forkNotice, ROLE_KEY, STANDING_KEY } from "../src/tree/text.js"

interface Fake {
  readonly metadata?: Record<string, unknown>
  readonly original?: string
  readonly entries?: Record<string, string>
  readonly stored?: Record<string, unknown>
  readonly instructions?: false
}

function forkPorts({ metadata, original = "ses_orig", entries = {}, stored = {}, instructions }: Fake = {}) {
  const store = new Map(Object.entries(stored))
  const held = new Map(Object.entries(entries))
  const calls: string[] = []
  const sent: any[] = []
  const logged: string[] = []
  const entry = {
    list: async ({ sessionID }: { sessionID: string }) => {
      calls.push(`list ${sessionID}`)
      return [...held].map(([key, value]) => ({ key, value }))
    },
    remove: async ({ sessionID, key }: { sessionID: string; key: string }) => {
      calls.push(`remove ${sessionID} ${key}`)
      held.delete(key)
    },
    put: async () => void calls.push("put"),
  }
  const ports = {
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async ({ prefix }: { prefix: string }) => ({ entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }),
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, ...(original ? { fork: { sessionID: original } } : {}), ...(metadata ? { metadata } : {}) }),
      synthetic: async (input: unknown) => {
        sent.push(input)
        return { id: "msg_fork" }
      },
      ...(instructions === false ? {} : { instructions: { entry } }),
    },
    log: (message: string) => void logged.push(message),
  } as unknown as ForkPorts
  return { ports, calls, sent, logged, held, entry, store }
}

const child = { sessionID: "ses_kid", parentID: "ses_orig", title: "t", directory: "/repo", isolated: false, createdAt: Date.now(), reports: "status" }

describe("the fork hook", () => {
  test("a fork of a child loses its role entry and is told once whose the brief is, without being woken", async () => {
    const { ports, calls, sent, held, logged, store } = forkPorts({ metadata: { courier: { parentID: "ses_parent" } }, entries: { [ROLE_KEY]: "opencode-courier role: leaf", lessons: "opencode-courier lessons: x" } })
    const before = [...store]
    const seen = new Set<string>()

    expect(await onFork(ports, seen, { sessionID: "ses_fork" })).toBe(true)
    expect(await onFork(ports, seen, { sessionID: "ses_fork" })).toBe(false)

    expect(calls.filter((call) => call.startsWith("remove"))).toEqual([`remove ses_fork ${ROLE_KEY}`])
    expect([...held.keys()]).toEqual(["lessons"])
    expect(sent).toEqual([
      {
        sessionID: "ses_fork",
        text: envelope("courier", forkNotice("ses_orig", "ses_parent", false), { notice: "fork", of: "ses_orig" }),
        description: "Courier fork notice",
        metadata: { source: "courier", notice: "fork", of: "ses_orig", resume: false },
        resume: false,
      },
    ])
    expect(sent[0].text).toStartWith('<courier from="courier" notice="fork" of="ses_orig">\nCourier did not start this fork.')
    expect(sent[0].text).toContain("send session ses_parent nothing with courier_send unless the person asks")
    expect(sent[0].text).not.toContain("courier_tree lists none")
    expect([...store]).toEqual(before)
    expect(logged).toEqual([])
  })

  test("a fork of a parent loses its role and standing entries and is told the children report to the original", async () => {
    const { ports, calls, sent } = forkPorts({
      entries: { [ROLE_KEY]: "opencode-courier role: root orchestrator", [STANDING_KEY]: "opencode-courier standing: …" },
      stored: { "roster/ses_orig/ses_kid": child, "roster-by-child/ses_kid": { ancestors: ["ses_orig"] } },
    })

    expect(await onFork(ports, new Set(), { sessionID: "ses_fork" })).toBe(true)

    expect(calls.filter((call) => call.startsWith("remove")).sort()).toEqual([`remove ses_fork ${ROLE_KEY}`, `remove ses_fork ${STANDING_KEY}`])
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toBe(envelope("courier", forkNotice("ses_orig", undefined, true), { notice: "fork", of: "ses_orig" }))
    expect(sent[0].text).toContain("are the children of session ses_orig")
    expect(sent[0].text).not.toContain("The brief above")
  })

  test("a fork of a sub-orchestrator is told both, and a parent is known by its roster alone", async () => {
    const both = forkPorts({ metadata: { courier: { parentID: "ses_parent" } }, entries: { [ROLE_KEY]: "r", [STANDING_KEY]: "s" } })
    const roster = forkPorts({ instructions: false, stored: { "roster/ses_orig/ses_kid": child } })

    expect(await onFork(both.ports, new Set(), { sessionID: "ses_fork" })).toBe(true)
    expect(await onFork(roster.ports, new Set(), { sessionID: "ses_fork" })).toBe(true)

    expect(both.sent[0].text).toBe(envelope("courier", forkNotice("ses_orig", "ses_parent", true), { notice: "fork", of: "ses_orig" }))
    expect(roster.sent[0].text).toBe(envelope("courier", forkNotice("ses_orig", undefined, true), { notice: "fork", of: "ses_orig" }))
    expect(roster.calls).toEqual([])
  })

  test("a fork of a session outside any tree has nothing removed and nothing sent", async () => {
    const { ports, calls, sent, logged } = forkPorts({ metadata: { other: true }, entries: { lessons: "opencode-courier lessons: x", mine: "y" } })
    const seen = new Set<string>()

    expect(await onFork(ports, seen, { sessionID: "ses_fork" })).toBe(false)

    expect(calls).toEqual(["list ses_fork"])
    expect(sent).toEqual([])
    expect(seen.size).toBe(0)
    expect(logged).toEqual([])
  })

  test("a failing entry.remove is logged, does not throw, and the notice still goes", async () => {
    const { ports, sent, logged, entry } = forkPorts({ metadata: { courier: { parentID: "ses_parent" } }, entries: { [ROLE_KEY]: "r" } })
    entry.remove = async () => Promise.reject(new Error("db locked"))

    expect(await onFork(ports, new Set(), { sessionID: "ses_fork" })).toBe(true)

    expect(logged).toEqual([`courier fork: the ${ROLE_KEY} entry of ses_fork could not be removed, so the fork still reads it: Error: db locked`])
    expect(sent).toHaveLength(1)
  })

  test("entries that cannot be listed, a roster that cannot be read, a session that cannot be read and a refused notice are logged, never thrown", async () => {
    const unlisted = forkPorts({ metadata: { courier: { parentID: "ses_parent" } } })
    unlisted.entry.list = async () => Promise.reject(new Error("no route"))
    ;(unlisted.ports.storage as any).scan = async () => Promise.reject(new Error("kv down"))
    const gone = forkPorts()
    ;(gone.ports.session as any).get = async () => Promise.reject(new Error("Session not found"))
    const refused = forkPorts({ metadata: { courier: { parentID: "ses_parent" } } })
    ;(refused.ports.session as any).synthetic = async () => Promise.reject(new Error("inbox closed"))

    expect(await onFork(unlisted.ports, new Set(), { sessionID: "ses_fork" })).toBe(true)
    expect(await onFork(gone.ports, new Set(), { sessionID: "ses_fork" })).toBe(false)
    expect(await onFork(refused.ports, new Set(), { sessionID: "ses_fork" })).toBe(false)

    expect(unlisted.logged).toEqual(["courier fork: cannot read the instruction entries of ses_fork: Error: no route", "courier fork: cannot read the roster of ses_orig: Error: kv down"])
    expect(unlisted.sent[0].text).toBe(envelope("courier", forkNotice("ses_orig", "ses_parent", false), { notice: "fork", of: "ses_orig" }))
    expect(gone.logged).toEqual(["courier fork: could not tell ses_fork that courier did not start it: Error: Session not found"])
    expect(refused.logged).toEqual(["courier fork: could not tell ses_fork that courier did not start it: Error: inbox closed"])
  })

  test("a host that does not say what the fork was copied from still gets the notice, naming no session", async () => {
    const { ports, sent } = forkPorts({ original: "", metadata: { courier: { parentID: "ses_parent" } } })

    expect(await onFork(ports, new Set(), { sessionID: "ses_fork" })).toBe(true)

    expect(sent[0].text).toBe(envelope("courier", forkNotice(undefined, "ses_parent", false), { notice: "fork" }))
    expect(sent[0].metadata).toEqual({ source: "courier", notice: "fork", resume: false })
  })
})
