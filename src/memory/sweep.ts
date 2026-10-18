import type { Storage } from "../platform/storage.js"
import { keep, type StoredRecord } from "./domain.js"
import { memoryStore } from "./store.js"

/**
 * On loading: drops, per project, the records `keep` does not at `now`, the pinned never among them, and the reads or
 * pin left beside a record removed meanwhile. Returns the records dropped.
 */
export async function sweepRecords(storage: Storage, now: number) {
  const store = memoryStore(storage)
  const byProject = new Map<string, StoredRecord[]>()
  for (const record of await store.all()) byProject.set(record.projectID, [...(byProject.get(record.projectID) ?? []), record])
  const dropped = [...byProject.values()].flatMap((records) => keep(records, now).dropped)
  const strays = await store.strays()
  await Promise.all([...dropped, ...strays].map((record) => store.remove(record.projectID, record.sessionID)))
  return dropped
}
