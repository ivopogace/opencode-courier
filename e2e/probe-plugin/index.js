import { appendFileSync, realpathSync } from "node:fs"

const sessionOf = (data) => data?.sessionID ?? data?.form?.sessionID
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
        appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, location, ...line })}\n`)
      } catch {}
    }
    write({ type: "probe.loaded" })
    await ctx.session.hook("context", (event) => {
      // the role follows <context key="role"> in OpenCode's instruction baseline
      const role = event.system.map((part) => part.text.match(/^opencode-courier role: (root orchestrator|sub-orchestrator|leaf|root)/m)?.[1]).find(Boolean)
      write({ type: "probe.context", sessionID: event.sessionID, tools: Object.keys(event.tools), role: role ?? null })
      if (JSON.stringify(event.messages).includes("CHILD-FORCES")) {
        if (!event.tools.courier_spawn)
          event.tools.courier_spawn = {
            description: "Start a session.",
            input: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
          }
        if (!event.tools.courier_note)
          event.tools.courier_note = {
            description: "Note a lesson.",
            input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          }
      }
    })
    const following = new AbortController()
    const follow = (options, line) => (async () => {
      while (!following.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ ...options, signal: following.signal })) write(line(event))
          if (!following.signal.aborted) write({ type: "probe.ended" })
        } catch (error) {
          if (!following.signal.aborted) write({ type: "probe.broke", error: String(error) })
        }
        if (!following.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
    })()
    void follow({}, (event) => ({ type: event.type, id: event.id, sessionID: sessionOf(event.data) }))
    if (ctx.options.types)
      void follow({ types: ctx.options.types }, (event) => ({ type: "probe.filtered", event: event.type, id: event.id, sessionID: sessionOf(event.data) }))
    return () => {
      following.abort()
      write({ type: "probe.unloaded" })
    }
  },
}
