// An event probe for the live test, loaded next to the courier: each of its instances, one per
// location like the courier's, follows OpenCode's events through the same `event.subscribe()` the
// courier's watcher uses, and appends a line per event to the file named by its `log` option, with
// the location it runs in and the server's pid, so the test can tell which instances saw an event.
import { appendFileSync } from "node:fs"

// The session an event concerns, where the watcher looks for it: `data.sessionID`, or a form's.
const sessionOf = (data) => data?.sessionID ?? data?.form?.sessionID

export default {
  id: "courier-e2e-probe",
  setup: async (ctx) => {
    const file = ctx.options.log
    const location = ctx.location.directory
    const write = (line) => appendFileSync(file, `${JSON.stringify({ pid: process.pid, location, ...line })}\n`)
    write({ type: "probe.loaded" })
    const following = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: following.signal }))
          write({ type: event.type, id: event.id, sessionID: sessionOf(event.data) })
      } catch (error) {
        if (!following.signal.aborted) write({ type: "probe.broke", error: String(error) })
      }
    })()
    return () => {
      following.abort()
      write({ type: "probe.unloaded" })
    }
  },
}
