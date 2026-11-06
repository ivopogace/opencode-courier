import type { Plugin } from "@opencode/plugin"
import type { Storage } from "../platform/storage.js"
import type { Instructions, Lister, ModelWindow } from "../tree/index.js"
import type { Pinned, ReadKind, Reads, StoredRecord, TreeRecord } from "./domain.js"

export type { Lesson, PartRecord, PartStatus, Pinned, ReadKind, Reads, Recalled, Revision, StoredRecord, TreeRecord } from "./domain.js"

type Context = Plugin.Context

export interface RefreshPorts {
  readonly storage: Storage
  readonly session: Pick<Context["session"], "get" | "context"> & Lister
  readonly now: () => number
  readonly log: (message: string) => void
}

export interface MemoryPorts extends RefreshPorts {
  readonly session: RefreshPorts["session"] & Instructions
  readonly projectID: string
  readonly memory: boolean
  readonly maxDepth: number
}

export interface MemoryState {
  readonly windows: Map<string, ModelWindow>
  readonly off: Set<string>
  readonly tops: Set<string>
  readonly seen: Set<string>
}

export interface MemoryStore {
  get(projectID: string, sessionID: string): Promise<TreeRecord | undefined>
  put(projectID: string, sessionID: string, record: TreeRecord): Promise<void>
  remove(projectID: string, sessionID: string): Promise<void>
  noteRead(projectID: string, sessionID: string, by: string, kind: ReadKind, at: number): Promise<Reads>
  pin(projectID: string, sessionID: string, pinned: Pinned | undefined): Promise<void>
  ofProject(projectID: string): Promise<StoredRecord[]>
  all(): Promise<StoredRecord[]>
  strays(): Promise<Array<{ projectID: string; sessionID: string }>>
}
