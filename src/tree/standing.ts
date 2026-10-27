import { existsSync } from "node:fs"
import { isStatus } from "../kernel/protocol.js"
import { isNotFound } from "../platform/json.js"
import { isExpired, standingOf } from "./domain.js"
import type { Entry, ReportNote, RosterStorage, StandingPorts } from "./ports.js"
import { childStore, groupStore } from "./store.js"
import { STANDING_KEY, standingEntry, type ChildState, type StandingRow } from "./text.js"

/** Whether `at` is known and no earlier than the prompt at `prompt`. */
const since = (at: number | undefined, prompt: number) => at !== undefined && at >= prompt

/** A child's state from its report notes, as `reportOf` and the silent-turn rule read them. */
export function stateOf(notes: { readonly [K in "prompt" | "settled" | "progress" | "told" | "stopped"]: ReportNote }): ChildState {
  const prompt = notes.prompt.at
  if (notes.stopped.at !== undefined && (prompt === undefined || notes.stopped.at >= prompt)) return { kind: "stopped" }
  if (prompt === undefined) return { kind: "started" }
  const progressed = since(notes.progress.at, prompt) ? { progressed: true } : {}
  if (!since(notes.settled.at, prompt)) return since(notes.told.at, prompt) ? { kind: "ended", ...progressed } : { kind: "working", ...progressed }
  const { by, status } = notes.settled
  if (by === "failed" || by === "interrupted") return { kind: by }
  return { kind: "reported", status: isStatus(status) ? status : "done", ...progressed }
}

/** The rows of a parent's standing entry: its unexpired children, oldest first, each with its state and group standing. */
export async function standingRows(storage: RosterStorage, parentID: string, now: number): Promise<StandingRow[]> {
  const children = childStore(storage)
  // The groups read best effort, as courier_children reads them: a member's standing is `unknown` when they cannot be.
  const [entries, members] = await Promise.all([children.children(parentID), groupStore(storage).ofParent(parentID).catch(() => undefined)])
  const current = entries.filter((entry) => !isExpired(entry, now, existsSync))
  return Promise.all(
    current.map(async (entry) => {
      const notes = await children.notes(entry.sessionID, ["prompt", "settled", "progress", "told", "stopped"])
      const member = members?.find((one) => one.group === entry.group && one.sessionID === entry.sessionID)
      const standing = members ? standingOf(member) : "unknown"
      return {
        sessionID: entry.sessionID,
        title: entry.title,
        state: stateOf(notes),
        ...(entry.group ? { group: { name: entry.group, standing } } : {}),
      }
    }),
  )
}

/** What `syncStanding` did to the parent's entry. */
export type Synced = "put" | "unchanged" | "removed" | "absent" | "skipped"

/** The syncs under way in this process, by parent, each run after the one before it: a sync that read earlier never writes last. */
const inTurn = new Map<string, Promise<unknown>>()

/**
 * Writes a parent's `standing` entry once something of it changed: put when its text differs from the entry's, removed when
 * the parent has no children left; skipped without the keyed entries. A failure is logged, never thrown.
 */
export function syncStanding(ports: StandingPorts, parentID: string): Promise<Synced> {
  const entries = ports.session?.instructions?.entry
  if (!entries) return Promise.resolve("skipped")
  const before = inTurn.get(parentID) ?? Promise.resolve()
  const run = before.then(() => sync(ports, parentID, entries))
  const done = run.finally(() => {
    if (inTurn.get(parentID) === done) inTurn.delete(parentID)
  })
  inTurn.set(parentID, done)
  return run
}

type Entries = NonNullable<NonNullable<StandingPorts["session"]>["instructions"]>["entry"]

async function sync(ports: StandingPorts, parentID: string, entries: Entries): Promise<Synced> {
  try {
    const rows = await standingRows(ports.storage, parentID, ports.now())
    const stored = (await entries.list({ sessionID: parentID })).find((entry) => entry.key === STANDING_KEY)
    if (!rows.length) {
      if (!stored) return "absent"
      await entries.remove({ sessionID: parentID, key: STANDING_KEY })
      return "removed"
    }
    const value = standingEntry(rows)
    if (stored?.value === value) return "unchanged"
    await entries.put({ sessionID: parentID, key: STANDING_KEY, value })
    return "put"
  } catch (error) {
    // A parent OpenCode no longer knows has no entry to keep: a child deleted after it is a normal path.
    if (!isNotFound(error)) ports.log?.(`courier: the standing entry of ${parentID} could not be written, so it may be behind courier_children: ${String(error)}`)
    return "skipped"
  }
}

/** Writes `given` entries to a session, each put logged on failure and never thrown: the session gets its task all the same. */
export async function putEntries(ports: StandingPorts, sessionID: string, given: ReadonlyArray<Entry>) {
  const entries = ports.session?.instructions?.entry
  if (!entries) return
  await Promise.all(
    given.map(({ key, value }) =>
      entries.put({ sessionID, key, value }).catch((error: unknown) => ports.log?.(`courier_spawn: the ${key} entry of ${sessionID} could not be written: ${String(error)}`)),
    ),
  )
}
