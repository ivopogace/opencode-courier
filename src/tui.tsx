// The package's `tui` entrypoint, a second composition root: each module's TUI part. Bundled on its own by
// script/build-tui.ts, with every package left to the host, which provides them.
import { Plugin } from "@opencode/plugin/tui"
import { addMemoryView, MEMORY_USAGE } from "./memory/tui.js"
import { addAsksInbox } from "./person/tui.js"
import { addTreeAttention, addTreePanel, addTreeStatus, CHANGES } from "./tree/tui.js"

export default Plugin.define({
  id: "courier.tui",
  setup: (ctx) => {
    // The inbox's open list follows the tree on the footer's events.
    const inbox = addAsksInbox(ctx, CHANGES)
    // The footer's "waiting on you" opens the inbox.
    // The memory view, the project's tree records, which the tree's /courier command opens as its verb `memory`.
    const memory = addMemoryView(ctx)
    const cleanups = [
      inbox.cleanup,
      addTreeStatus(ctx, (sessionID) => void inbox.open(sessionID)),
      addTreePanel(ctx, { memory: { run: () => void memory.open(), usage: MEMORY_USAGE } }),
      addTreeAttention(ctx),
    ]
    return () => {
      for (const cleanup of cleanups.toReversed()) cleanup()
    }
  },
})
