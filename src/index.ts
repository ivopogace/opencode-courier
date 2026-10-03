import { Plugin } from "@opencode-ai/plugin"
import { Schema } from "effect"
import { randomUUID } from "node:crypto"
import { describeFailure, listChildren, send, spawn, status, type CourierPorts } from "./courier.js"
import { cleanup, inspectWorktree, type CleanupPorts, type CleanupResult } from "./cleanup.js"
import { cancel, deliverDue, schedule, TICK_MS, type LaterPorts } from "./later.js"
import { pruneExpired } from "./roster.js"

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

const ChildrenInput = Schema.Struct({
  sessionID: Schema.optional(
    Schema.String.annotate({ description: "The session whose children to list; defaults to this one." }),
  ),
})

const CleanupInput = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The isolated child whose worktree to remove." }),
  force: Schema.optional(
    Schema.Boolean.annotate({
      description: "Remove it even with uncommitted changes or commits on no branch; that work is lost.",
    }),
  ),
})

const LaterInput = Schema.Struct({
  message: Schema.String.annotate({ description: "The message to deliver." }),
  delayMinutes: Schema.optional(
    Schema.Number.annotate({ description: "Deliver this many minutes from now. Give this or at." }),
  ),
  at: Schema.optional(Schema.String.annotate({ description: "Deliver at this ISO 8601 time. Give this or delayMinutes." })),
  sessionID: Schema.optional(Schema.String.annotate({ description: "The session to deliver to; defaults to this one." })),
})

const CancelInput = Schema.Struct({
  id: Schema.String.annotate({ description: "The id courier_later returned." }),
})

// One claim set for every instance in the process: OpenCode sets the plugin up once per project
// location, and those instances share one storage.
const claimed: Set<string> = ((globalThis as Record<symbol, unknown>)[Symbol.for("opencode-courier.claimed")] ??=
  new Set<string>()) as Set<string>

const rethrow =
  (tool: string) =>
  (error: unknown): never => {
    throw describeFailure(tool, error)
  }

function describeCleanup(result: CleanupResult) {
  if (result.outcome === "removed") return `Removed the worktree ${result.directory} of ${result.sessionID}.`
  if (result.outcome === "gone")
    return `The worktree ${result.directory} of ${result.sessionID} was already gone; dropped it from courier_children.`
  return `Kept the worktree ${result.directory} of ${result.sessionID}: it has ${result.reason}. Commit or branch what you want to keep, or call courier_cleanup again with force: true to discard it.`
}

export default Plugin.define({
  id: "courier",
  setup: async (ctx) => {
    const ports: CourierPorts = {
      session: ctx.session,
      worktree: ctx.worktree,
      storage: ctx.storage,
      directory: ctx.location.directory,
      now: Date.now,
    }
    const cleanupPorts: CleanupPorts = {
      storage: ctx.storage,
      worktree: ctx.worktree,
      directory: ctx.location.directory,
      inspect: inspectWorktree,
    }
    const later: LaterPorts = {
      storage: ctx.storage,
      session: ctx.session,
      now: Date.now,
      newID: () => `later_${randomUUID()}`,
      log: (message) => console.error(message),
    }

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "courier_spawn",
        options: { codemode: false },
        description:
          "Start a new OpenCode session on a task and return immediately. The session reports back with courier_send, " +
          "which wakes this session. DO NOT poll it or call courier_status in a loop; end your turn and wait. For long " +
          "tasks, also courier_later a check-in for yourself in case it never reports, and courier_cancel it when it does.",
        input: SpawnInput,
        execute: async (input, context) => {
          const child = await spawn(ports, context.sessionID, input).catch(rethrow("courier_spawn"))
          const warning = child.rosterError ? ` It is not on your courier_children list: ${child.rosterError}` : ""
          return {
            content: `Started session ${child.sessionID} in ${child.directory}. It will report back with courier_send.${warning}`,
            metadata: child,
          }
        },
      })

      tools.add({
        name: "courier_send",
        options: { codemode: false },
        description:
          "Deliver a message to another OpenCode session. If that session is idle, OpenCode starts a new turn for it. " +
          "Use it to report back to the session that started you, or to steer a session you started.",
        input: SendInput,
        execute: async (input, context) => {
          const delivered = await send(ports, context.sessionID, input).catch(rethrow("courier_send"))
          return { content: `Delivered to ${input.sessionID}.`, metadata: delivered }
        },
      })

      tools.add({
        name: "courier_status",
        options: { codemode: false },
        description:
          "Look once at a session's state and its last reply, e.g. on a scheduled check-in. Not for waiting: " +
          "sessions you started report back on their own.",
        input: StatusInput,
        execute: async (input) => {
          const result = await status(ports, input).catch(rethrow("courier_status"))
          return { content: JSON.stringify(result, null, 2), metadata: result }
        },
      })

      tools.add({
        name: "courier_children",
        options: { codemode: false },
        description:
          "List the sessions this one started with courier_spawn, with each one's state and last reply, e.g. after a " +
          "compaction or restart. Like courier_status, for a one-off look, not for waiting.",
        input: ChildrenInput,
        execute: async (input, context) => {
          const listed = await listChildren(ports, input.sessionID || context.sessionID).catch(rethrow("courier_children"))
          return {
            content: listed.length ? JSON.stringify(listed, null, 2) : "No sessions started with courier_spawn.",
            metadata: { children: listed },
          }
        },
      })

      tools.add({
        name: "courier_cleanup",
        options: { codemode: false },
        description:
          "Remove the git worktree of a session you started with isolate: true, once you have what you need from it, " +
          "and drop it from courier_children. A worktree with uncommitted changes or commits on no branch is kept and " +
          "the result lists them; commit or branch what you want, or pass force: true to discard it.",
        input: CleanupInput,
        execute: async (input, context) => {
          const result = await cleanup(cleanupPorts, context.sessionID, input).catch(rethrow("courier_cleanup"))
          return { content: describeCleanup(result), metadata: result }
        },
      })

      tools.add({
        name: "courier_later",
        options: { codemode: false },
        description:
          "Schedule a message for a session (this one by default), delivered when due and waking it if idle. " +
          "Use it as a safety net when you start sessions: schedule a check-in, end your turn, and cancel it with " +
          "courier_cancel if the child reports first. Survives server restarts; may arrive up to ~15 seconds late.",
        input: LaterInput,
        execute: async (input, context) => {
          const entry = await schedule(later, context.sessionID, input).catch(rethrow("courier_later"))
          const fireAt = new Date(entry.fireAt).toISOString()
          return {
            content: `Scheduled ${entry.id} for ${fireAt}, to ${entry.sessionID}. Cancel it with courier_cancel.`,
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
          return {
            content: cancelled ? `Cancelled ${input.id}.` : `Nothing pending under ${input.id}; it may have been delivered.`,
            metadata: { id: input.id, cancelled },
          }
        },
      })
    })

    void pruneExpired(ctx.storage, Date.now()).catch((error: unknown) => console.error(`courier roster prune: ${String(error)}`))

    let ticking = false
    const tick = async () => {
      if (ticking) return
      ticking = true
      await deliverDue(later, claimed)
        .catch((error: unknown) => later.log(`courier_later scheduler: ${String(error)}`))
        .finally(() => (ticking = false))
    }
    void tick()
    const timer = setInterval(tick, TICK_MS)
    return () => clearInterval(timer)
  },
})
