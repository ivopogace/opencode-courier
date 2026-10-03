import { Plugin } from "@opencode-ai/plugin"
import { Schema } from "effect"
import { send, spawn, status, type CourierPorts } from "./courier.js"

const SpawnInput = Schema.Struct({
  task: Schema.String.annotate({ description: "What the new session should do. It is told who started it and how to report back." }),
  title: Schema.optional(Schema.String.annotate({ description: "Session title; defaults to the task's first line." })),
  agent: Schema.optional(Schema.String.annotate({ description: "Agent to run the session with; defaults to the default agent." })),
  isolate: Schema.optional(
    Schema.Boolean.annotate({ description: "Run the session in its own git worktree so parallel sessions don't share files." }),
  ),
})

const SendInput = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The session to deliver to." }),
  message: Schema.String.annotate({ description: "The message text." }),
  queue: Schema.optional(
    Schema.Boolean.annotate({ description: "Wait until the target's current turn ends instead of steering it now." }),
  ),
})

const StatusInput = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The session to look at." }),
})

export default Plugin.define({
  id: "courier",
  setup: async (ctx) => {
    const ports: CourierPorts = { session: ctx.session, worktree: ctx.worktree, directory: ctx.location.directory }

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "courier_spawn",
        description:
          "Start a new OpenCode session on a task and return immediately. The session reports back with courier_send, " +
          "which wakes this session. DO NOT poll it or call courier_status in a loop; end your turn and wait.",
        input: SpawnInput,
        execute: async (input, context) => {
          const child = await spawn(ports, context.sessionID, input)
          return {
            content: `Started session ${child.sessionID} in ${child.directory}. It will report back with courier_send.`,
            metadata: child,
          }
        },
      })

      tools.add({
        name: "courier_send",
        description:
          "Deliver a message to another OpenCode session. If that session is idle, OpenCode starts a new turn for it. " +
          "Use it to report back to the session that started you, or to steer a session you started.",
        input: SendInput,
        execute: async (input, context) => {
          const delivered = await send(ports, context.sessionID, input)
          return { content: `Delivered to ${input.sessionID}.`, metadata: delivered }
        },
      })

      tools.add({
        name: "courier_status",
        description:
          "Look once at a session's state and its last reply, e.g. on a scheduled check-in. Not for waiting: " +
          "sessions you started report back on their own.",
        input: StatusInput,
        execute: async (input) => {
          const result = await status(ports, input)
          return { content: JSON.stringify(result, null, 2), metadata: result }
        },
      })
    })
  },
})
