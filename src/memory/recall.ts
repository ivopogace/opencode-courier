import { addBounded, SEEN_MAX } from "../platform/bounded.js"
import { finite, millis } from "../platform/json.js"
import { lineage } from "../tree/index.js"
import { NOT_STATED, noteRead, noteRecall, pinnedFirst, type ReadKind, type StoredRecord } from "./domain.js"
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
 * Counts, on each record of another tree, that this call listed it or gave it in full, best effort: a count lost is
 * logged, never the call's failure. Gives the reads of the reader's tree on each, in order, or undefined where it failed.
 */
function count(ports: MemoryPorts, top: string, kind: ReadKind, sessionIDs: ReadonlyArray<string>) {
  const store = memoryStore(ports.storage)
  const now = ports.now()
  return Promise.all(
    sessionIDs.map((sessionID) =>
      store.noteRead(ports.projectID, sessionID, top, kind, now).catch((error: unknown) => {
        ports.log(`courier memory: could not count the ${kind === "shown" ? "listing" : "read"} of the record under ${sessionID}: ${String(error)}`)
        return undefined
      }),
    ),
  )
}

/**
 * courier_recall: notes the call on the caller's tree, then lists the project's records, pinned first and then newest first,
 * or gives the one under `sessionID` in full, each counted on the other trees' records; with the memory option off, nothing is written or read.
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
    if (!record) return { kind: "missing", projectID, sessionID: wanted }
    // Another tree's record is given with this read added to the reads just read; the caller's own is not counted.
    const [counted] = wanted === top ? [undefined] : await count(ports, top, "read", [wanted])
    const reads = counted ? noteRead(record.reads, "read", counted.at) : record.reads
    return { kind: "record", projectID, record: { ...record, ...(reads ? { reads } : {}), projectID, sessionID: wanted } }
  }
  const records = pinnedFirst(await store.ofProject(projectID))
  await count(ports, top, "shown", records.flatMap((record) => (record.sessionID === top ? [] : [record.sessionID])))
  return { kind: "list", projectID, top, records }
}
