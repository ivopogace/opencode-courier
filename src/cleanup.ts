import type { Plugin } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { forget, rosterKey, type RosterEntry, type RosterStorage } from "./roster.js"

type Context = Plugin.Context

/** What would be lost by removing a worktree. */
export interface WorktreeState {
  /** Paths with uncommitted changes, untracked files included, as `git status --porcelain` lists them. */
  readonly changes: readonly string[]
  /** Commits reachable from the worktree's HEAD but from no branch, tag or remote-tracking ref, newest first. */
  readonly commits: readonly string[]
}

export interface CleanupPorts {
  readonly storage: RosterStorage
  readonly worktree: Pick<Context["worktree"], "remove">
  /** The plugin's own location, for roster entries recorded before they carried their source. */
  readonly directory: string
  /** The worktree's state, or undefined when its directory no longer exists. */
  readonly inspect: (directory: string) => Promise<WorktreeState | undefined>
}

export interface CleanupInput {
  readonly sessionID: string
  readonly force?: boolean
}

export type CleanupResult =
  | { readonly sessionID: string; readonly directory: string; readonly outcome: "removed" }
  | { readonly sessionID: string; readonly directory: string; readonly outcome: "gone" }
  | {
      readonly sessionID: string
      readonly directory: string
      readonly outcome: "kept"
      readonly reason: string
      readonly changes: readonly string[]
      readonly commits: readonly string[]
    }

/** Why a worktree in this state must be kept, or undefined when removing it loses nothing. */
export function keepReason(state: WorktreeState) {
  const reasons = [
    state.changes.length ? `${count(state.changes.length, "uncommitted change")} (${preview(state.changes)})` : "",
    state.commits.length
      ? `${count(state.commits.length, "commit")} on no branch, tag or remote (${preview(state.commits)})`
      : "",
  ].filter(Boolean)
  return reasons.length ? reasons.join(" and ") : undefined
}

function count(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

function preview(items: readonly string[]) {
  return items.length > 5 ? `${items.slice(0, 5).join(", ")}, ...` : items.join(", ")
}

/**
 * Removes the worktree of an isolated child the parent started, and forgets the child. A worktree
 * with uncommitted changes or commits that exist nowhere else is kept unless `force` is set, and the
 * result says what is in it.
 */
export async function cleanup(ports: CleanupPorts, parentID: string, input: CleanupInput): Promise<CleanupResult> {
  const entry = (await ports.storage.get(rosterKey(parentID, input.sessionID))) as unknown as RosterEntry | undefined
  if (!entry) throw new Error(`${input.sessionID} is not on the courier_children list of ${parentID}.`)
  if (!entry.isolated)
    throw new Error(`${input.sessionID} ran in ${entry.directory}, not in a worktree of its own; there is nothing to remove.`)
  const { directory } = entry
  const state = await ports.inspect(directory)
  if (!state) {
    await forget(ports.storage, parentID, input.sessionID)
    return { sessionID: input.sessionID, directory, outcome: "gone" }
  }
  const reason = keepReason(state)
  if (reason && !input.force)
    return { sessionID: input.sessionID, directory, outcome: "kept", reason, changes: state.changes, commits: state.commits }
  await ports.worktree.remove({
    location: { directory: entry.source ?? ports.directory },
    directory,
    force: input.force === true,
  })
  await forget(ports.storage, parentID, input.sessionID)
  return { sessionID: input.sessionID, directory, outcome: "removed" }
}

function git(directory: string, args: string[]) {
  return new Promise<string>((resolve, reject) =>
    execFile("git", ["-C", directory, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(`git ${args[0]} in ${directory}: ${stderr.trim() || error.message}`)) : resolve(stdout),
    ),
  )
}

/** Reads a worktree's state with git; undefined when the directory is gone. */
export async function inspectWorktree(directory: string): Promise<WorktreeState | undefined> {
  if (!existsSync(directory)) return undefined
  const status = await git(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  const changes: string[] = []
  const records = status.split("\0").filter(Boolean)
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    changes.push(record.slice(3))
    // A rename or copy is followed by its source path in a record of its own.
    if (record[0] === "R" || record[0] === "C") i++
  }
  const log = await git(directory, ["log", "--format=%h %s", "HEAD", "--not", "--branches", "--tags", "--remotes"])
  return { changes, commits: log.split("\n").filter(Boolean) }
}
