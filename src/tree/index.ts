// What the rest of the plugin uses of the session tree: its tools, RPC, event module, context hook and tick jobs
// for `src/index.ts`, the lineage and subtree queries and types `person/` reads, and what `memory/` reads of each session.
export { dirtyOf, headOf, inspectWorktree } from "./cleanup.js"
export { shapeContext } from "./context.js"
export { endsIdle, lineageIn, nativeRootOf, readLimits, readNativeChildren } from "./domain.js"
export { together, treeEvents, waitsOn } from "./events.js"
export { deliverReleased } from "./group.js"
export { contextOf } from "./panel.js"
export type {
  CleanupPorts,
  CourierPorts,
  ModelWindow,
  Pending,
  PendingPrompt,
  Role,
  RosterEntry,
  RosterStorage,
  ShownForm,
  SpawnGate,
  Waits,
  WatchPorts,
  WatchState,
} from "./ports.js"
export { allEntries, answeringTop, childrenOf, indexedLineage, lineage, pruneExpired, reportState, RETENTION_MS, type ReportState } from "./roster.js"
export { runs, turnIn, turnOf, type Turn } from "./running.js"
export { subtree, type Below } from "./subtree.js"
export { registerTreeRpc } from "./rpc-handlers.js"
export { addTreeTools } from "./tools.js"
export { stalledAmong, waitsInInbox, wakeMissed } from "./wake.js"
