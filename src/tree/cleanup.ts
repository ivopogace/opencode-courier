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

export const MAX_LISTED = 50

export async function cleanup(ports: CleanupPorts, parentID: string, input: CleanupInput): Promise<CleanupResult> {
  const entry = await childStore(ports.storage).entry(parentID, input.sessionID)
  if (!entry) throw new Error(`${input.sessionID} is not a child of ${parentID}: courier_cleanup takes a session you started yourself.`)
  const { directory } = entry
  const forget = async () => {
    const group = await forgetDropped(ports, entry)
    await syncStanding(ports, parentID)
    return group ? { group } : {}
  }
  if (!entry.isolated) return { sessionID: input.sessionID, directory, outcome: "forgotten", ...(await forget()) }
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

export const GIT_ENV = "OPENCODE_COURIER_GIT"

export const GIT_LOCATIONS: Readonly<Record<"posix" | "win32", readonly string[]>> = {
  posix: [
    "/usr/bin/git",
    "/usr/local/bin/git",
    "/opt/homebrew/bin/git",
    "/run/current-system/sw/bin/git",
  ],
  win32: [String.raw`C:\Program Files\Git\cmd\git.exe`, String.raw`C:\Program Files (x86)\Git\cmd\git.exe`],
}

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

export function headOf(directory: string) {
  return git(directory, ["rev-parse", "HEAD"]).then(
    (out) => out.trim() || undefined,
    () => undefined,
  )
}

export function dirtyOf(directory: string) {
  return git(directory, ["status", "--porcelain"]).then(
    (out) => out.trim().length > 0,
    () => undefined,
  )
}

export async function inspectWorktree(directory: string, base?: string): Promise<WorktreeState | undefined> {
  if (!existsSync(directory)) return undefined
  const status = await git(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"])
  const changes: string[] = []
  const records = status.split("\0").filter(Boolean)
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    changes.push(record.slice(3))
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
