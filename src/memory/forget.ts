import type { MemoryPorts } from "./ports.js"
import { memoryStore } from "./store.js"

export type Forgotten = "record" | "lesson" | "none"

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
