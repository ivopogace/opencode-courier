// The package's `tui` entrypoint, a second composition root: each module's TUI part. Bundled on its own by
// script/build-tui.ts, with every package left to the host, which provides them.
import { Plugin } from "@opencode/plugin/tui"
import { addAsksInbox } from "./person/tui.js"
import { addTreeStatus } from "./tree/tui.js"

export default Plugin.define({
  id: "courier.tui",
  setup: (ctx) => {
    const inbox = addAsksInbox(ctx)
    // The footer's "waiting on you" opens the inbox.
    const releaseStatus = addTreeStatus(ctx, (sessionID) => void inbox.open(sessionID))
    return () => {
      releaseStatus()
      inbox.cleanup()
    }
  },
})
