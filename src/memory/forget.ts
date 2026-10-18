import type { MemoryPorts } from "./ports.js"
import { memoryStore } from "./store.js"

/** What forgetting did: the record is gone, only its lesson is, or there was nothing to forget. */
export type Forgotten = "record" | "lesson" | "none"

/**
 * Forgets the record of the tree under `sessionID` in the ports' project, as the memory view's `x` does, or with
 * `lesson` only its lesson, writing the record back without it. Whatever the memory option says: it only removes.
 */
export async function forget(ports: Pick<MemoryPorts, "storage" | "projectID">, sessionID: string, { lesson = false } = {}): Promise<Forgotten> {
  const store = memoryStore(ports.storage)
  const record = await store.get(ports.projectID, sessionID)
  if (!record) return "none"
  if (!lesson) {
    await store.remove(ports.projectID, sessionID)
    return "record"
  }
  if (!record.lesson) return "none"
  const { lesson: _dropped, ...kept } = record
  await store.put(ports.projectID, sessionID, kept)
  return "lesson"
}
