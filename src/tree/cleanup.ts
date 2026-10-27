import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { isAbsolute } from "node:path"
import { forgetDropped } from "./forget.js"
import type { CleanupPorts, CleanupResult, WorktreeState } from "./ports.js"
import { syncStanding } from "./standing.js"
import { childStore } from "./store.js"
import { keepReason } from "./text.js"

export interface CleanupInput {
  readonly sessionID: string
  readonly force?: boolean
}

/** At most this many changes and commits are returned; the reason still counts them all. */
export const MAX_LISTED = 50

/**
 * Forgets a child the parent started, removing its worktree if it is isolated. A worktree with uncommitted changes
 * or commits found nowhere else is kept unless `force` is set; the result says so.
 */
export async function cleanup(ports: CleanupPorts, parentID: string, input: CleanupInput): Promise<CleanupResult> {
  const entry = await childStore(ports.storage).entry(parentID, input.sessionID)
  if (!entry) throw new Error(`${input.sessionID} is not on the courier_children list of ${parentID}.`)
  const { directory } = entry
  // A member still out is dropped from its group, so the group is released without it; the result names that group.
  const forget = async () => {
    const group = await forgetDropped(ports, entry)
    await syncStanding(ports, parentID)
    return group ? { group } : {}
  }
  if (!entry.isolated) return { sessionID: input.sessionID, directory, outcome: "forgotten", ...(await forget()) }
  // With force the state only decides whether there is anything left to remove, so a worktree git
  // can no longer read is still removed.
  const state = await ports
    .inspect(directory, entry.base)
    .catch((error: unknown) => (input.force ? { changes: [], commits: [] } : Promise.reject(error)))
  if (!state) return { sessionID: input.sessionID, directory, outcome: "gone", ...(await forget()) }
  const reason = keepReason(state)
  if (reason && !input.force)
    return {
      sessionID: input.sessionID,
      directory,
      outcome: "kept",
      reason,
      changes: state.changes.slice(0, MAX_LISTED),
      commits: state.commits.slice(0, MAX_LISTED),
    }
  await ports.worktree.remove({
    projectID: entry.project ?? ports.projectID,
    directory,
    force: input.force === true,
  })
  return { sessionID: input.sessionID, directory, outcome: "removed", ...(await forget()) }
}

/** Names the git to run, by absolute path, overriding the places `GIT_LOCATIONS` lists. */
export const GIT_ENV = "OPENCODE_COURIER_GIT"

/**
 * Where git is looked for, in order: its usual install locations, never `PATH`, so a writable
 * directory early in `PATH` cannot put another program in its place.
 */
export const GIT_LOCATIONS: Readonly<Record<"posix" | "win32", readonly string[]>> = {
  posix: [
    "/usr/bin/git",
    "/usr/local/bin/git",
    "/opt/homebrew/bin/git",
    // NixOS, and nix-darwin.
    "/run/current-system/sw/bin/git",
  ],
  win32: [String.raw`C:\Program Files\Git\cmd\git.exe`, String.raw`C:\Program Files (x86)\Git\cmd\git.exe`],
}

/**
 * The git to run: `OPENCODE_COURIER_GIT` when it is an absolute path, otherwise the first of
 * `GIT_LOCATIONS` that exists. Throws when there is none.
 */
export function findGit(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
) {
  const named = env[GIT_ENV]?.trim()
  if (named) {
    if (!isAbsolute(named)) throw new Error(`${GIT_ENV} must be an absolute path, not ${named}.`)
    return named
  }
  const locations = GIT_LOCATIONS[platform === "win32" ? "win32" : "posix"]
  const found = locations.find((path) => exists(path))
  if (!found) throw new Error(`git is in none of ${locations.join(", ")}; set ${GIT_ENV} to its absolute path.`)
  return found
}

function git(directory: string, args: string[]) {
  return new Promise<string>((resolve, reject) =>
    execFile(findGit(), ["-C", directory, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(`git ${args[0]} in ${directory}: ${stderr.trim() || error.message}`)) : resolve(stdout),
    ),
  )
}

/** The commit a worktree is on, or undefined when git cannot tell. */
export function headOf(directory: string) {
  return git(directory, ["rev-parse", "HEAD"]).then(
    (out) => out.trim() || undefined,
    () => undefined,
  )
}

/** Whether a worktree has uncommitted changes, untracked files included; undefined when git cannot tell. */
export function dirtyOf(directory: string) {
  return git(directory, ["status", "--porcelain"]).then(
    (out) => out.trim().length > 0,
    () => undefined,
  )
}

/**
 * Reads a worktree's state with git; undefined when the directory is gone. Commits reachable from
 * `base`, the commit the worktree was made from, are not its own work and are not listed.
 */
export async function inspectWorktree(directory: string, base?: string): Promise<WorktreeState | undefined> {
  if (!existsSync(directory)) return undefined
  // An untracked directory is one entry, not every file in it.
  const status = await git(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"])
  const changes: string[] = []
  const records = status.split("\0").filter(Boolean)
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    changes.push(record.slice(3))
    // A rename or copy is followed by its source path in a record of its own.
    if ("RC".includes(record[0]!) || "RC".includes(record[1]!)) i++
  }
  const log = await git(directory, [
    "log",
    "--format=%h %s",
    "HEAD",
    "--not",
    "--branches",
    "--tags",
    "--remotes",
    ...(base ? [base] : []),
  ])
  return { changes, commits: log.split("\n").filter(Boolean) }
}
