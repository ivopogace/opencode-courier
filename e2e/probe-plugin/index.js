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
      const role = event.system.map((part) => part.text.match(/^opencode-courier role: (root orchestrator|sub-orchestrator|leaf|root)/m)?.[1]).find(Boolean)
      write({ type: "probe.context", sessionID: event.sessionID, tools: Object.keys(event.tools), role: role ?? null })
      if (JSON.stringify(event.messages).includes("CHILD-FORCES")) {
        if (!event.tools.courier_spawn)
          event.tools.courier_spawn = {
            description: "Start a session.",
            input: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
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
    const itemOf = (event) => {
      if (event.type !== "session.inbox.enqueued" || !event.data?.item) return {}
      const { type, delivery, payload } = event.data.item
      const text = typeof payload?.text === "string" ? payload.text : undefined
      return {
        item: {
          type,
          delivery: delivery ?? null,
          metadata: payload?.metadata ?? null,
          text: text === undefined ? null : text.slice(0, 200),
          chars: text?.length ?? null,
          files: payload?.files?.length ?? 0,
          agents: payload?.agents?.length ?? 0,
          skills: payload?.skills?.length ?? 0,
        },
      }
    }
    void follow({}, (event) => ({ type: event.type, id: event.id, sessionID: sessionOf(event.data), ...itemOf(event) }))
    if (ctx.options.types)
      void follow({ types: ctx.options.types }, (event) => ({ type: "probe.filtered", event: event.type, id: event.id, sessionID: sessionOf(event.data) }))
    return () => {
      following.abort()
      write({ type: "probe.unloaded" })
    }
  },
}
