import type { Plugin } from "@opencode/plugin"
import { newestFirst, type StoredRecord } from "./domain.js"
import { forget } from "./forget.js"
import type { MemoryPorts } from "./ports.js"
import { memoryRpc, type MemoryRecord, type Records } from "./rpc.js"
import { memoryStore } from "./store.js"

/** A stored record as the RPC gives it: without its project, which the listing names once, nor the split line's revisions, which its schema lacks. */
const toRecord = ({ projectID: _project, revisions: _revisions, ...record }: StoredRecord): MemoryRecord => record

/**
 * The records of the ports' project, newest first, as the memory view lists them; nothing, and `memory` false, with the
 * option off. Read from the store alone: unlike courier_recall, a look from the terminal is noted on no record.
 */
export async function records(ports: Pick<MemoryPorts, "storage" | "projectID" | "memory">): Promise<Records> {
  const { projectID } = ports
  if (!ports.memory) return { memory: false, projectID, records: [] }
  return { memory: true, projectID, records: newestFirst(await memoryStore(ports.storage).ofProject(projectID)).map(toRecord) }
}

/** Serves the memory's RPC at the plugin's location, after the tree's and the person's; disposed with the plugin. */
export function registerMemoryRpc(rpc: Pick<Plugin.Context["rpc"], "register">, ports: Pick<MemoryPorts, "storage" | "projectID" | "memory">) {
  return rpc.register(memoryRpc, {
    records: () => records(ports),
    forget: async ({ sessionID, lesson }) => ({ outcome: await forget(ports, sessionID, { lesson: lesson === true }) }),
  })
}
