/** The memory's ports: what refreshing a record and courier_recall need of the plugin context, and what the process shares. */
import type { Plugin } from "@opencode/plugin"
import type { Storage } from "../platform/storage.js"
import type { ModelWindow } from "../tree/index.js"
import type { Pinned, ReadKind, Reads, StoredRecord, TreeRecord } from "./domain.js"

export type { Lesson, PartRecord, PartStatus, Pinned, ReadKind, Reads, Recalled, Revision, StoredRecord, TreeRecord } from "./domain.js"

type Context = Plugin.Context

/** What refreshing a record runs on: every hub-v2 member's watch ports have these, so the event module runs through any. */
export interface RefreshPorts {
  readonly storage: Storage
  readonly session: Pick<Context["session"], "get" | "context">
  readonly now: () => number
  readonly log: (message: string) => void
}

/** What courier_recall and courier_note run on: one instance's ports. */
export interface MemoryPorts extends RefreshPorts {
  /** The project of the plugin's location, whose records the tools read and write. */
  readonly projectID: string
  /** The `memory` option: off, and the tools write and list nothing. */
  readonly memory: boolean
  /** The tree's `maxDepth` limit: a session at it is a leaf, which courier_note refuses. */
  readonly maxDepth: number
}

/** What every plugin instance in the process shares of the memory, under a fixed key outside the hub. */
export interface MemoryState {
  /** The context windows of the models known, by `<providerID>/<modelID>`, filled as each instance loads. */
  readonly windows: Map<string, ModelWindow>
  /** The directories of the locations whose instance has memory off: no record is written for a tree whose top runs there. */
  readonly off: Set<string>
  /** The top sessions that called courier_recall, whose turn ends refresh their record before they have started a session. */
  readonly tops: Set<string>
  /** The turn ends recorded, so the hub's two subscriptions refresh once. */
  readonly seen: Set<string>
}

/** The records, by project and top session, each read with its reads and pin, which lie beside it and are written apart. */
export interface MemoryStore {
  get(projectID: string, sessionID: string): Promise<TreeRecord | undefined>
  /** Writes the record's facts; its `reads` and `pinned` are left out, as nothing but `noteRead` and `pin` write them. */
  put(projectID: string, sessionID: string, record: TreeRecord): Promise<void>
  /** Removes the record with its reads and pin. */
  remove(projectID: string, sessionID: string): Promise<void>
  /** Counts a listing or a full read of the record by the tree under `by` at `at`; gives that tree's reads of it. */
  noteRead(projectID: string, sessionID: string, by: string, kind: ReadKind, at: number): Promise<Reads>
  /** Pins the record, or with `undefined` unpins it. */
  pin(projectID: string, sessionID: string, pinned: Pinned | undefined): Promise<void>
  /** A project's records, in key order. */
  ofProject(projectID: string): Promise<StoredRecord[]>
  /** Every project's records. */
  all(): Promise<StoredRecord[]>
  /** The trees with reads or a pin but no record, left by a record removed while it was read or pinned. */
  strays(): Promise<Array<{ projectID: string; sessionID: string }>>
}
