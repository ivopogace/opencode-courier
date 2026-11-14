import { existsSync } from "node:fs"
import { isStatus } from "../kernel/protocol.js"
import { isNotFound } from "../platform/json.js"
import { isExpired } from "./domain.js"
import type { ReportNote, RosterStorage, StandingPorts } from "./ports.js"
import { childStore } from "./store.js"
import { STANDING_KEY, standingEntry, type ChildState, type StandingRow } from "./text.js"

const since = (at: number | undefined, prompt: number) => at !== undefined && at >= prompt

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

export async function standingRows(storage: RosterStorage, parentID: string, now: number): Promise<StandingRow[]> {
  const children = childStore(storage)
  const current = (await children.children(parentID)).filter((entry) => !isExpired(entry, now, existsSync))
  return Promise.all(
    current.map(async (entry) => {
      const notes = await children.notes(entry.sessionID, ["prompt", "settled", "progress", "told", "stopped"])
      return { sessionID: entry.sessionID, title: entry.title, state: stateOf(notes) }
    }),
  )
}

export type Synced = "put" | "unchanged" | "removed" | "absent" | "skipped"

const inTurn = new Map<string, Promise<unknown>>()

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
    if (!isNotFound(error)) ports.log?.(`courier: the standing entry of ${parentID} could not be written, so it may be behind courier_tree: ${String(error)}`)
    return "skipped"
  }
}
