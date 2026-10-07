// An event probe for the live test, loaded next to the courier: each of its instances, one per
// location like the courier's, follows OpenCode's events through the same `event.subscribe()` the
// courier's watcher uses, and appends a line per event to the file named by its `log` option, with
// the location it runs in and the server's pid, so the test can tell which instances saw an event.
import { appendFileSync, realpathSync } from "node:fs"

// The session an event concerns, where the watcher looks for it: `data.sessionID`, or a form's.
const sessionOf = (data) => data?.sessionID ?? data?.form?.sessionID
// The directory with symlinks resolved, so the test compares one spelling of each location.
const canonical = (directory) => {
  try {
    return realpathSync(directory)
  } catch {
    return directory
  }
}

export default {
  id: "courier-e2e-probe",
  setup: async (ctx) => {
    const file = ctx.options.log
    const location = canonical(ctx.location.directory)
    const write = (line) => {
      try {
        appendFileSync(file, `${JSON.stringify({ pid: process.pid, location, ...line })}\n`)
      } catch {}
    }
    write({ type: "probe.loaded" })
    const following = new AbortController()
    // Subscribes again when the stream ends or breaks, as the courier's watcher does.
    void (async () => {
      while (!following.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: following.signal }))
            write({ type: event.type, id: event.id, sessionID: sessionOf(event.data) })
          if (!following.signal.aborted) write({ type: "probe.ended" })
        } catch (error) {
          if (!following.signal.aborted) write({ type: "probe.broke", error: String(error) })
        }
        if (!following.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
    })()
    return () => {
      following.abort()
      write({ type: "probe.unloaded" })
    }
  },
}
