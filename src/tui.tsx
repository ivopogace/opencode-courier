// The package's `tui` entrypoint, a second composition root: each module's TUI part. Bundled on its own by
// script/build-tui.ts, with every package left to the host, which provides them.
import { Plugin } from "@opencode/plugin/tui"
import { addTreeAttention, addTreePanel, addTreeStatus } from "./tree/tui.js"

export default Plugin.define({
  id: "courier.tui",
  setup: (ctx) => {
    const cleanups = [addTreeStatus(ctx), addTreePanel(ctx), addTreeAttention(ctx)]
    return () => {
      for (const cleanup of cleanups.reverse()) cleanup()
    }
  },
})
