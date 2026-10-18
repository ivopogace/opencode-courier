import type { MemoryPorts } from "./ports.js"
import { memoryStore } from "./store.js"

/** What pinning did: the record is pinned, unpinned, or there is no record to pin. */
export type PinOutcome = "pinned" | "unpinned" | "none"

/**
 * Pins the record of the tree under `sessionID` in the ports' project, as the memory view's `p` does, or with `pinned`
 * false unpins it; a record pinned already keeps when it was. Whatever the memory option says: a pin is the person's.
 */
export async function pin(ports: Pick<MemoryPorts, "storage" | "projectID" | "now">, sessionID: string, pinned: boolean): Promise<PinOutcome> {
  const store = memoryStore(ports.storage)
  const record = await store.get(ports.projectID, sessionID)
  if (!record) return "none"
  await store.pin(ports.projectID, sessionID, pinned ? (record.pinned ?? { at: ports.now() }) : undefined)
  return pinned ? "pinned" : "unpinned"
}
