// What the rest of the plugin uses of the session tree: its tools, RPC, event module, context hook and tick job
// for `src/index.ts`, and the lineage and subtree queries and types `person/` reads.
export { dirtyOf, headOf, inspectWorktree } from "./cleanup.js"
export { shapeContext } from "./context.js"
export { lineageIn, nativeRootOf, readLimits, readNativeChildren } from "./domain.js"
export { together, treeEvents, waitsOn } from "./events.js"
export { deliverReleased } from "./group.js"
export type {
  CleanupPorts,
  CourierPorts,
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
export { allEntries, answeringTop, lineage, pruneExpired, RETENTION_MS } from "./roster.js"
export { subtree } from "./subtree.js"
export { registerTreeRpc } from "./rpc-handlers.js"
export { addTreeTools } from "./tools.js"
