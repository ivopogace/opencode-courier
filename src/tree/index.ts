// What the rest of the plugin uses of the session tree: its tools, RPC, event module, context hook and tick jobs
// for `src/index.ts`, the lineage and subtree queries and types `person/` reads, and what `memory/` reads of each session.
export { dirtyOf, headOf, inspectWorktree } from "./cleanup.js"
export { shapeContext } from "./context.js"
export { busy, lineageIn, nativeRootOf, readLimits, readNativeChildren } from "./domain.js"
export { together, treeEvents, waitsOn } from "./events.js"
export { deliverReleased } from "./group.js"
export { contextOf } from "./panel.js"
export type {
  CleanupPorts,
  CourierPorts,
  ModelWindow,
  Pending,
  PendingPrompt,
  RosterEntry,
  RosterStorage,
  ShownForm,
  SpawnGate,
  Waits,
  WatchPorts,
  WatchState,
} from "./ports.js"
export { allEntries, answeringTop, childrenOf, indexedLineage, lineage, pruneExpired, reportState, RETENTION_MS, type ReportState } from "./roster.js"
export { subtree, type Below } from "./subtree.js"
export { registerTreeRpc } from "./rpc-handlers.js"
export { addTreeTools } from "./tools.js"
export { stalledAmong, wakeMissed } from "./wake.js"
