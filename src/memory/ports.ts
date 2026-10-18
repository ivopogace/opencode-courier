/** The memory's ports: what refreshing a record and courier_recall need of the plugin context, and what the process shares. */
import type { Plugin } from "@opencode/plugin"
import type { Storage } from "../platform/storage.js"
import type { ModelWindow } from "../tree/index.js"
import type { StoredRecord, TreeRecord } from "./domain.js"

export type { Lesson, PartRecord, PartStatus, Recalled, Revision, StoredRecord, TreeRecord } from "./domain.js"

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

/** The records, by project and top session. */
export interface MemoryStore {
  get(projectID: string, sessionID: string): Promise<TreeRecord | undefined>
  put(projectID: string, sessionID: string, record: TreeRecord): Promise<void>
  remove(projectID: string, sessionID: string): Promise<void>
  /** A project's records, in key order. */
  ofProject(projectID: string): Promise<StoredRecord[]>
  /** Every project's records. */
  all(): Promise<StoredRecord[]>
}
