import { Schema } from "effect"
import { STATUSES } from "../kernel/protocol.js"
import { rethrow, type ToolEditor } from "../kernel/tool.js"
import { cleanup } from "./cleanup.js"
import type { CleanupPorts, CourierPorts, StopPorts } from "./ports.js"
import { send } from "./send.js"
import { spawn } from "./spawn.js"
import { stop } from "./stop.js"
import { tree } from "./subtree.js"
import { cleanupText, sendText, spawnText, stopText, treeText } from "./text.js"

export const SpawnInput = Schema.Struct({
  task: Schema.String.annotate({ description: "What the new session should do. It is told who started it and how to report back." }),
  title: Schema.optional(Schema.String.annotate({ description: "Session title; defaults to the task's first line." })),
  agent: Schema.optional(Schema.String.annotate({ description: "Agent to run the session with; defaults to the default agent." })),
  model: Schema.optional(
    Schema.String.annotate({
      description:
        "The model to run the session on, as provider/model (opencode/gpt-5-nano). Leave it unset for your own model, or the " +
        "agent's own if it names one. Refused when OpenCode does not list it here.",
    }),
  ),
  variant: Schema.optional(
    Schema.String.annotate({
      description:
        "The model's variant, its reasoning effort as OpenCode names it (low, medium, high, or another the model has). Leave " +
        "it unset for the chosen model's own; with a model of your own choosing, that is the model's default. Refused when " +
        "the model has no such variant.",
    }),
  ),
  isolate: Schema.optional(
    Schema.Boolean.annotate({ description:
        "Run the session in its own git worktree so parallel sessions don't share files. Commit first: its worktree " +
        "starts from your last commit and sees only committed files and project skills, not your uncommitted changes. The session " +
        "commits on a branch named courier/<its session ID> and names it in its report; merge that branch yourself.",
    }),
  ),
  native: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "true starts the session as your OpenCode subagent: it leaves OpenCode's session lists for your subagent tab, the " +
        "person answers its permission requests and questions in the view of the nearest session above it that is not a " +
        "subagent, usually the top one (only OpenCode's TUI or paired app shows them; under opencode run without --auto " +
        "or a bare API client they are rejected or wait unseen), and deleting your session deletes it. Unset or false starts a " +
        "standalone session. Refused with isolate: true, as a subagent runs in its parent's directory.",
    }),
  ),
})

export const SendInput = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The session to deliver to." }),
  message: Schema.String.annotate({ description: "The message text." }),
  status: Schema.optional(
    Schema.Literals(STATUSES).annotate({
      description:
        "For a report to the session that started you: done, partial (some of the task is left), blocked (you need a " +
        "decision from it; say what) or failed. A message without a status is progress, not your report.",
    }),
  ),
  artifacts: Schema.optional(
    Schema.Struct({
      branch: Schema.optional(Schema.String.annotate({ description: "The branch your work is on." })),
      commits: Schema.optional(Schema.Array(Schema.String).annotate({ description: "The commits you made, as short hashes or subjects." })),
      files: Schema.optional(Schema.Array(Schema.String).annotate({ description: "The files you changed." })),
      checks: Schema.optional(
        Schema.Array(
          Schema.Struct({
            command: Schema.String.annotate({ description: "A command you ran, such as a test suite or a linter." }),
            result: Schema.String.annotate({ description: "What it gave, in a few words." }),
          }),
        ).annotate({ description: "The checks you ran and their results." }),
      ),
    }).annotate({ description: "With a report: what you produced, listed in the message after your text in a fixed layout." }),
  ),
})

export const TreeInput = Schema.Struct({
  sessionID: Schema.optional(Schema.String.annotate({ description: "The session whose subtree to list; defaults to this one." })),
})

export const StopInput = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The session to stop, with every session under it. It must have been started, directly or through others, from this one." }),
  cleanup: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Also remove the worktrees of the stopped sessions that ran in one of their own, as courier_cleanup does: " +
        "one with uncommitted changes or commits on no branch is kept and listed.",
    }),
  ),
})

export const CleanupInput = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The session you started to drop, with its worktree if it is isolated." }),
  force: Schema.optional(
    Schema.Boolean.annotate({
      description: "Remove it even with uncommitted changes or commits on no branch; that work is lost.",
    }),
  ),
})

export interface TreeToolPorts {
  readonly courier: CourierPorts
  readonly cleanup: CleanupPorts
  readonly stop: StopPorts
}

export function addTreeTools(tools: ToolEditor, ports: TreeToolPorts) {
  tools.add({
    name: "courier_spawn",
    options: { codemode: false },
    description:
      "Start a new OpenCode session on a task and return immediately. It runs on your model, unless you name a model or a " +
      "variant (reasoning effort) fit for the task. The session reports " +
      "back with courier_send, which wakes this session, and you are told if its turn fails or ends without a report " +
      "instead, or it waits for a permission or asks a question (at the top of the tree; below it they go to the top). " +
      "Each report wakes you as it comes. DO NOT poll it or call courier_tree in a " +
      "loop: once you have started the sessions you need, end your turn by replying without calling more tools; each " +
      "report starts a new turn in which you carry on. For a long task or batch, also " +
      "courier_later one check-in for yourself, in case the reports never " +
      "come, and courier_cancel it when the last report arrives: a report does not cancel it.",
    input: SpawnInput,
    execute: async (input, context) => {
      const child = await spawn(ports.courier, context.sessionID, input).catch(rethrow("courier_spawn"))
      return { content: spawnText(child), metadata: child }
    },
  })

  tools.add({
    name: "courier_send",
    options: { codemode: false },
    description:
      "Deliver a message to another OpenCode session. If that session is idle, OpenCode starts a new turn for it. " +
      "Use it to report back to the session that started you, with a status (done, partial, blocked or failed) and " +
      "the artifacts you produced, or to steer a session you started: a session that is working reads the message at " +
      "its next step, after the tool call it is running has returned; nothing is interrupted. The status is carried " +
      "as an attribute of the " +
      "message; without one, a message to the session that started you is progress, not your report. A message to a " +
      "session you started carries no status: one given is dropped.",
    input: SendInput,
    execute: async (input, context) => {
      const delivered = await send(ports.courier, context.sessionID, input).catch(rethrow("courier_send"))
      return { content: sendText(input.sessionID, delivered), metadata: delivered }
    },
  })

  tools.add({
    name: "courier_tree",
    options: { codemode: false },
    description:
      "List the whole tree of sessions under this one (or under sessionID): every session started with courier_spawn " +
      "from it, directly or through others, each with its depth, title, state and last reply, and whether it still " +
      "owes a report, sent progress, or ended without one, and the subagents OpenCode's subagent tool started in it, " +
      "marked subagent: true, which owe no report. For a one-off look, not for waiting. A long tree lists at most " +
      "maxTotal sessions, the live ones first, then the newest, and says how many older ones are left out.",
    input: TreeInput,
    execute: async (input, context) => {
      const result = await tree(ports.courier, input.sessionID || context.sessionID).catch(rethrow("courier_tree"))
      return { content: treeText(result), metadata: result }
    },
  })

  tools.add({
    name: "courier_stop",
    options: { codemode: false },
    description:
      "Stop a session you started, directly or through others, and every session under it, subagents included: each " +
      "running turn is interrupted, deepest first, and the messages scheduled for them with courier_later are cancelled. Use it when a " +
      "subtree went wrong or is no longer needed. They do not report back, and you are not told of what you stopped; a " +
      "session between you and the target is, when the target was running, still owed it a report or was waiting on its answer to a blocked report. A stopped session can be woken again with courier_send. With " +
      "cleanup: true their worktrees are removed too, unless they hold work that is on no branch.",
    input: StopInput,
    execute: async (input, context) => {
      const result = await stop(ports.stop, context.sessionID, input).catch(rethrow("courier_stop"))
      return { content: stopText(result), metadata: result }
    },
  })

  tools.add({
    name: "courier_cleanup",
    options: { codemode: false },
    description:
      "Remove the git worktree of a session you started with isolate: true, once you have what you need from it, " +
      "and drop it from your children. A worktree with uncommitted changes or commits on no branch is kept and " +
      "the result lists them, the session staying listed; commit what you want to a branch and call again, or pass " +
      "force: true to discard it. A session without isolate has no worktree and is only dropped from " +
      "your children. It never deletes the session itself, nor the sessions it started.",
    input: CleanupInput,
    execute: async (input, context) => {
      const result = await cleanup(ports.cleanup, context.sessionID, input).catch(rethrow("courier_cleanup"))
      return { content: cleanupText(result), metadata: result }
    },
  })
}
