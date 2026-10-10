// Live-test probe: logs each event per instance (location, pid) to its `log` option's file, and, after the
// courier's context hook, each request's tools and role; puts courier_spawn back for a CHILD-FORCES task.
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
    await ctx.session.hook("context", (event) => {
      const role = event.system.map((part) => part.text.match(/^opencode-courier role: (root orchestrator|sub-orchestrator|leaf|root)/)?.[1]).find(Boolean)
      write({ type: "probe.context", sessionID: event.sessionID, tools: Object.keys(event.tools), role: role ?? null })
      if (!event.tools.courier_spawn && JSON.stringify(event.messages).includes("CHILD-FORCES"))
        event.tools.courier_spawn = {
          description: "Start a session.",
          input: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
        }
    })
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
