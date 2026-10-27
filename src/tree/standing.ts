import { existsSync } from "node:fs"
import { isStatus } from "../kernel/protocol.js"
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
  const [entries, members] = await Promise.all([children.children(parentID), groupStore(storage).ofParent(parentID)])
  const current = entries.filter((entry) => !isExpired(entry, now, existsSync))
  return Promise.all(
    current.map(async (entry) => {
      const notes = await children.notes(entry.sessionID, ["prompt", "settled", "progress", "told", "stopped"])
      const member = entry.group ? members.find((one) => one.group === entry.group && one.sessionID === entry.sessionID) : undefined
      return {
        sessionID: entry.sessionID,
        title: entry.title,
        state: stateOf(notes),
        ...(entry.group ? { group: { name: entry.group, standing: standingOf(member) } } : {}),
      }
    }),
  )
}

/** What `syncStanding` did to the parent's entry. */
export type Synced = "put" | "unchanged" | "removed" | "absent" | "skipped"

/**
 * Writes a parent's `standing` entry from what the tree keeps of its children, once something of it changed: put when its
 * text differs from the entry's, removed when the parent has no children left. Skipped without the keyed entries, or when
 * the parent is gone. A failure is logged, never thrown: the tool result or the notice it follows is the one to report.
 */
export async function syncStanding(ports: StandingPorts, parentID: string): Promise<Synced> {
  const entries = ports.session?.instructions?.entry
  if (!entries) return "skipped"
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
    ports.log?.(`courier: the standing entry of ${parentID} could not be written, so it may be behind courier_children: ${String(error)}`)
    return "skipped"
  }
}

/** Writes `given` entries to a session, each put logged on failure and never thrown: the session gets its task all the same. */
export async function putEntries(ports: StandingPorts, sessionID: string, given: ReadonlyArray<Entry>) {
  const entries = ports.session?.instructions?.entry
  if (!entries) return
  for (const { key, value } of given) {
    try {
      await entries.put({ sessionID, key, value })
    } catch (error) {
      ports.log?.(`courier_spawn: the ${key} entry of ${sessionID} could not be written: ${String(error)}`)
    }
  }
}
