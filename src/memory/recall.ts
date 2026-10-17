import { addBounded, SEEN_MAX } from "../platform/bounded.js"
import { finite, millis } from "../platform/json.js"
import { lineage } from "../tree/index.js"
import { newestFirst, NOT_STATED, noteRecall, type StoredRecord } from "./domain.js"
import type { MemoryPorts, MemoryState } from "./ports.js"
import { memoryStore } from "./store.js"

export interface RecallInput {
  readonly sessionID?: string
}

/** What courier_recall gives: the option is off, the project's records with the caller's tree named, one record in full, or none under that session. */
export type Recall =
  | { readonly kind: "off" }
  | { readonly kind: "list"; readonly projectID: string; readonly top: string; readonly records: ReadonlyArray<StoredRecord> }
  | { readonly kind: "record"; readonly projectID: string; readonly record: StoredRecord }
  | { readonly kind: "missing"; readonly projectID: string; readonly sessionID: string }

/** The top of the caller's tree: the top of its lineage, or itself. */
async function topOfCaller(ports: MemoryPorts, callerID: string) {
  return (await lineage(ports.storage, callerID)).at(-1)?.parentID ?? callerID
}

/** Notes the call on the caller's tree's record, which is written now if the tree has none yet, so the call is remembered before any session is started. */
async function note(ports: MemoryPorts, top: string, byTop: boolean) {
  const store = memoryStore(ports.storage)
  const now = ports.now()
  const previous = await store.get(ports.projectID, top)
  const recalled = noteRecall(previous?.recalled, byTop, now)
  if (previous) return store.put(ports.projectID, top, { ...previous, recalled })
  const info = await ports.session.get({ sessionID: top }).catch(() => undefined)
  await store.put(ports.projectID, top, {
    startedAt: finite(millis(info?.time.created)) ?? now,
    movedAt: now,
    title: info?.title ?? "",
    split: NOT_STATED,
    finished: false,
    recalled,
    parts: [],
  })
}

/**
 * courier_recall: notes the call on the caller's tree, then lists the project's records newest first, or gives the one
 * under `sessionID` in full. With the memory option off, nothing is written or read.
 */
export async function recall(ports: MemoryPorts, state: Pick<MemoryState, "tops">, callerID: string, input: RecallInput): Promise<Recall> {
  if (!ports.memory) return { kind: "off" }
  const top = await topOfCaller(ports, callerID)
  await note(ports, top, top === callerID)
  addBounded(state.tops, top, SEEN_MAX)
  const store = memoryStore(ports.storage)
  const { projectID } = ports
  // Some models send null, or an empty string, for an optional field they leave out.
  const wanted = typeof input.sessionID === "string" ? input.sessionID.trim() : ""
  if (wanted) {
    const record = await store.get(projectID, wanted)
    return record ? { kind: "record", projectID, record: { ...record, projectID, sessionID: wanted } } : { kind: "missing", projectID, sessionID: wanted }
  }
  return { kind: "list", projectID, top, records: newestFirst(await store.ofProject(projectID)) }
}
