import type { Plugin } from "@opencode/plugin"
import { pinnedFirst, type StoredRecord } from "./domain.js"
import { forget } from "./forget.js"
import { pin } from "./pin.js"
import type { MemoryPorts } from "./ports.js"
import { memoryRpc, type MemoryRecord, type Records } from "./rpc.js"
import { memoryStore } from "./store.js"

const toRecord = ({ projectID: _project, revisions: _revisions, ...record }: StoredRecord): MemoryRecord => record

export type MemoryRpcPorts = Pick<MemoryPorts, "storage" | "projectID" | "memory" | "now">

export async function records(ports: Pick<MemoryRpcPorts, "storage" | "projectID" | "memory">): Promise<Records> {
  const { projectID } = ports
  if (!ports.memory) return { memory: false, projectID, records: [] }
  return { memory: true, projectID, records: pinnedFirst(await memoryStore(ports.storage).ofProject(projectID)).map(toRecord) }
}

export function registerMemoryRpc(rpc: Pick<Plugin.Context["rpc"], "register">, ports: MemoryRpcPorts) {
  return rpc.register(memoryRpc, {
    records: () => records(ports),
    forget: async ({ sessionID, lesson }) => ({ outcome: await forget(ports, sessionID, { lesson: lesson === true }) }),
    pin: async ({ sessionID, pinned }) => ({ outcome: await pin(ports, sessionID, pinned) }),
  })
}
