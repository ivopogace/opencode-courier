import { Plugin } from "@opencode/plugin/tui"
import { addMemoryView, MEMORY_USAGE } from "./memory/tui.js"
import { addAsksInbox } from "./person/tui.js"
import { addTreeAttention, addTreePanel, addTreeStatus, CHANGES } from "./tree/tui.js"

export default Plugin.define({
  id: "courier.tui",
  setup: (ctx) => {
    const inbox = addAsksInbox(ctx, CHANGES)
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
