import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanup, inspectWorktree, keepReason, type CleanupPorts, type WorktreeState } from "../src/cleanup.js"
import { record, rosterKey, type RosterEntry } from "../src/roster.js"

const clean: WorktreeState = { changes: [], commits: [] }

function fakePorts(state: WorktreeState | "gone" = clean) {
  const store = new Map<string, unknown>()
  const removed: unknown[] = []
  const ports: CleanupPorts = {
    directory: "/plugin",
    storage: {
      get: async (key) => store.get(key) as any,
      set: async (key, value) => void store.set(key, value),
      remove: async (key) => void store.delete(key),
      scan: async () => ({ entries: [] }),
    },
    worktree: {
      remove: async (input) => {
        removed.push(input)
      },
    },
    inspect: async () => (state === "gone" ? undefined : state),
  }
  return { ports, store, removed }
}

const child = (overrides: Partial<RosterEntry> = {}): RosterEntry => ({
  sessionID: "ses_child",
  parentID: "ses_parent",
  title: "t",
  directory: "/data/worktree/p/child",
  isolated: true,
  createdAt: 1,
  source: "/repo",
  ...overrides,
})

describe("keepReason", () => {
  test("nothing to keep in a clean worktree whose commits are all on a ref", () => {
    expect(keepReason(clean)).toBeUndefined()
  })

  test("names uncommitted changes and commits on no ref", () => {
    expect(keepReason({ changes: ["a.ts"], commits: [] })).toBe("1 uncommitted change (a.ts)")
    expect(keepReason({ changes: [], commits: ["abc1234 Fix", "def5678 Test"] })).toBe(
      "2 commits on no branch, tag or remote (abc1234 Fix, def5678 Test)",
    )
    expect(keepReason({ changes: ["a", "b", "c", "d", "e", "f"], commits: ["abc1234 Fix"] })).toBe(
      "6 uncommitted changes (a, b, c, d, e, ...) and 1 commit on no branch, tag or remote (abc1234 Fix)",
    )
  })
})

describe("cleanup", () => {
  test("removes a clean worktree through the directory it was made from, and forgets the child", async () => {
    const { ports, store, removed } = fakePorts()
    await record(ports.storage, child())

    const result = await cleanup(ports, "ses_parent", { sessionID: "ses_child" })

    expect(result).toEqual({ sessionID: "ses_child", directory: "/data/worktree/p/child", outcome: "removed" })
    expect(removed).toEqual([{ location: { directory: "/repo" }, directory: "/data/worktree/p/child", force: false }])
    expect(store.has(rosterKey("ses_parent", "ses_child"))).toBe(false)
  })

  test("falls back to the plugin's directory for an entry recorded without its source", async () => {
    const { ports, removed } = fakePorts()
    await record(ports.storage, child({ source: undefined }))

    await cleanup(ports, "ses_parent", { sessionID: "ses_child" })

    expect(removed).toEqual([{ location: { directory: "/plugin" }, directory: "/data/worktree/p/child", force: false }])
  })

  test("keeps a worktree with uncommitted changes, says why, and keeps the child listed", async () => {
    const { ports, store, removed } = fakePorts({ changes: ["notes.txt"], commits: [] })
    await record(ports.storage, child())

    const result = await cleanup(ports, "ses_parent", { sessionID: "ses_child" })

    expect(result).toEqual({
      sessionID: "ses_child",
      directory: "/data/worktree/p/child",
      outcome: "kept",
      reason: "1 uncommitted change (notes.txt)",
      changes: ["notes.txt"],
      commits: [],
    })
    expect(removed).toEqual([])
    expect(store.has(rosterKey("ses_parent", "ses_child"))).toBe(true)
  })

  test("keeps a worktree whose commits are on no branch, tag or remote", async () => {
    const { ports, removed } = fakePorts({ changes: [], commits: ["abc1234 Fix"] })
    await record(ports.storage, child())

    const result = await cleanup(ports, "ses_parent", { sessionID: "ses_child" })

    expect(result).toMatchObject({ outcome: "kept", commits: ["abc1234 Fix"] })
    expect(removed).toEqual([])
  })

  test("with force, removes it anyway and has git discard the changes", async () => {
    const { ports, store, removed } = fakePorts({ changes: ["notes.txt"], commits: ["abc1234 Fix"] })
    await record(ports.storage, child())

    const result = await cleanup(ports, "ses_parent", { sessionID: "ses_child", force: true })

    expect(result.outcome).toBe("removed")
    expect(removed).toEqual([{ location: { directory: "/repo" }, directory: "/data/worktree/p/child", force: true }])
    expect(store.size).toBe(0)
  })

  test("forgets a child whose worktree is already gone", async () => {
    const { ports, store, removed } = fakePorts("gone")
    await record(ports.storage, child())

    const result = await cleanup(ports, "ses_parent", { sessionID: "ses_child" })

    expect(result.outcome).toBe("gone")
    expect(removed).toEqual([])
    expect(store.size).toBe(0)
  })

  test("keeps the child listed when the removal fails", async () => {
    const { ports, store } = fakePorts()
    ;(ports.worktree as any).remove = async () => {
      throw new Error("locked")
    }
    await record(ports.storage, child())

    await expect(cleanup(ports, "ses_parent", { sessionID: "ses_child" })).rejects.toThrow("locked")
    expect(store.has(rosterKey("ses_parent", "ses_child"))).toBe(true)
  })

  test("refuses a session that is not the caller's child", async () => {
    const { ports } = fakePorts()
    await record(ports.storage, child())

    await expect(cleanup(ports, "ses_other", { sessionID: "ses_child" })).rejects.toThrow(
      "ses_child is not on the courier_children list of ses_other.",
    )
  })

  test("refuses a child that shared the parent's directory", async () => {
    const { ports, removed } = fakePorts()
    await record(ports.storage, child({ isolated: false, directory: "/repo", source: undefined }))

    await expect(cleanup(ports, "ses_parent", { sessionID: "ses_child" })).rejects.toThrow(
      "ses_child ran in /repo, not in a worktree of its own",
    )
    expect(removed).toEqual([])
  })
})

describe("inspectWorktree", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" })

  function repoWithWorktree() {
    const root = mkdtempSync(join(tmpdir(), "courier-cleanup-"))
    dirs.push(root)
    const repo = join(root, "repo")
    const worktree = join(root, "worktree")
    execFileSync("git", ["init", "-q", repo])
    writeFileSync(join(repo, "a.txt"), "a\n")
    run(repo, "add", "a.txt")
    run(repo, "commit", "-q", "-m", "first")
    run(repo, "worktree", "add", "-q", "--detach", worktree)
    return { repo, worktree }
  }

  test("a fresh detached worktree loses nothing", async () => {
    const { worktree } = repoWithWorktree()

    expect(await inspectWorktree(worktree)).toEqual(clean)
  })

  test("lists modified, untracked and renamed files", async () => {
    const { worktree } = repoWithWorktree()
    writeFileSync(join(worktree, "new file.txt"), "n\n")
    run(worktree, "mv", "a.txt", "b.txt")

    const state = await inspectWorktree(worktree)

    expect([...state!.changes].sort()).toEqual(["b.txt", "new file.txt"])
    expect(state!.commits).toEqual([])
  })

  test("lists commits on the detached HEAD, until a branch holds them", async () => {
    const { repo, worktree } = repoWithWorktree()
    writeFileSync(join(worktree, "a.txt"), "changed\n")
    run(worktree, "commit", "-q", "-am", "child work")

    const state = await inspectWorktree(worktree)
    expect(state!.changes).toEqual([])
    expect(state!.commits).toHaveLength(1)
    expect(state!.commits[0]).toMatch(/^[0-9a-f]+ child work$/)

    run(worktree, "branch", "keep-it")
    expect(await inspectWorktree(worktree)).toEqual(clean)
    expect(run(repo, "branch", "--list", "keep-it")).toContain("keep-it")
  })

  test("is undefined for a directory that no longer exists", async () => {
    expect(await inspectWorktree(join(tmpdir(), "courier-no-such-worktree"))).toBeUndefined()
  })
})
