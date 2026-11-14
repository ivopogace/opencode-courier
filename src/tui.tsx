import { Plugin } from "@opencode/plugin/tui"
import { addAsksInbox } from "./person/tui.js"
import { addTreeAttention, addTreePanel, addTreeStatus, CHANGES } from "./tree/tui.js"

export default Plugin.define({
  id: "courier.tui",
  setup: (ctx) => {
    const inbox = addAsksInbox(ctx, CHANGES)
    const cleanups = [
      inbox.cleanup,
      addTreeStatus(ctx, (sessionID) => void inbox.open(sessionID)),
      addTreePanel(ctx),
      addTreeAttention(ctx),
    ]
    return () => {
      for (const cleanup of cleanups.toReversed()) cleanup()
    }
  },
})
