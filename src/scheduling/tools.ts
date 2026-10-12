import { Schema } from "effect"
import { rethrow, type ToolEditor } from "../kernel/tool.js"
import { cancel, schedule, type LaterPorts } from "./later.js"
import { cancelText, laterText } from "./text.js"

export const LaterInput = Schema.Struct({
  message: Schema.String.annotate({ description: "The message to deliver." }),
  delayMinutes: Schema.optional(
    // Some models send the number as a string ("3", "3.0") whatever the schema says, and resend it
    // unchanged after the error, so a string is accepted and schedule reads it as a number.
    Schema.Union([Schema.Number, Schema.String]).annotate({
      description: "Deliver this many minutes from now. Give this or at.",
    }),
  ),
  at: Schema.optional(Schema.String.annotate({ description: "Deliver at this ISO 8601 time. Give this or delayMinutes." })),
  sessionID: Schema.optional(Schema.String.annotate({ description: "The session to deliver to; defaults to this one." })),
})

export const CancelInput = Schema.Struct({
  id: Schema.String.annotate({ description: "The id courier_later returned." }),
})

/** Adds `courier_later` and `courier_cancel`. */
export function addSchedulingTools(tools: ToolEditor, later: LaterPorts) {
  tools.add({
    name: "courier_later",
    options: { codemode: false },
    description:
      "Schedule a message for a session (this one by default), delivered when due and waking it if idle. " +
      "Use it as a safety net when you start sessions: schedule one check-in, end your turn by replying without " +
      "calling more tools, and cancel it with courier_cancel if the child reports first. Survives server restarts; " +
      "may arrive up to ~15 seconds late.",
    input: LaterInput,
    execute: async (input, context) => {
      const entry = await schedule(later, context.sessionID, input).catch(rethrow("courier_later"))
      const fireAt = new Date(entry.fireAt).toISOString()
      return {
        content: laterText(entry, fireAt, entry.sessionID === context.sessionID),
        metadata: { id: entry.id, fireAt, sessionID: entry.sessionID },
      }
    },
  })

  tools.add({
    name: "courier_cancel",
    options: { codemode: false },
    description: "Cancel a message scheduled with courier_later, e.g. because the child it was waiting for reported.",
    input: CancelInput,
    execute: async (input) => {
      const cancelled = await cancel(later, input.id).catch(rethrow("courier_cancel"))
      return { content: cancelText(input.id, cancelled), metadata: { id: input.id, cancelled } }
    },
  })
}
