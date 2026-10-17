import type { Storage } from "../platform/storage.js"
import { keep, type StoredRecord } from "./domain.js"
import { memoryStore } from "./store.js"

/** On loading: drops, per project, the records past `MAX_RECORDS` or `RETENTION_MS` at `now`. Returns those dropped. */
export async function sweepRecords(storage: Storage, now: number) {
  const store = memoryStore(storage)
  const byProject = new Map<string, StoredRecord[]>()
  for (const record of await store.all()) byProject.set(record.projectID, [...(byProject.get(record.projectID) ?? []), record])
  const dropped = [...byProject.values()].flatMap((records) => keep(records, now).dropped)
  await Promise.all(dropped.map((record) => store.remove(record.projectID, record.sessionID)))
  return dropped
}
