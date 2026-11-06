import type { MemoryPorts } from "./ports.js"
import { memoryStore } from "./store.js"

export type PinOutcome = "pinned" | "unpinned" | "none"

export async function pin(ports: Pick<MemoryPorts, "storage" | "projectID" | "now">, sessionID: string, pinned: boolean): Promise<PinOutcome> {
  const store = memoryStore(ports.storage)
  const record = await store.get(ports.projectID, sessionID)
  if (!record) return "none"
  await store.pin(ports.projectID, sessionID, pinned ? (record.pinned ?? { at: ports.now() }) : undefined)
  return pinned ? "pinned" : "unpinned"
}
