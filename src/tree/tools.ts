import { Schema } from "effect"
import { STATUSES } from "../kernel/protocol.js"
import { rethrow, type ToolEditor } from "../kernel/tool.js"
import { cleanup } from "./cleanup.js"
import type { CleanupPorts, CourierPorts, StopPorts } from "./ports.js"
import { send } from "./send.js"
import { spawn } from "./spawn.js"
import { listChildren, status } from "./status.js"
import { stop } from "./stop.js"
import { tree } from "./subtree.js"
import { childrenText, cleanupText, sendText, spawnText, statusText, stopText, treeText } from "./text.js"

/**
 * The tree's courier tools: their input schemas, descriptions, and what each returns. The descriptions are
 * model-facing like the texts in `text.ts`, and snapshotted with them in `test/notices.test.ts`.
 */

export const SpawnInput = Schema.Struct({
  task: Schema.String.annotate({ description: "What the new session should do. It is told who started it and how to report back." }),
  title: Schema.optional(Schema.String.annotate({ description: "Session title; defaults to the task's first line." })),
  agent: Schema.optional(Schema.String.annotate({ description: "Agent to run the session with; defaults to the default agent." })),
  isolate: Schema.optional(
    Schema.Boolean.annotate({ description:
        "Run the session in its own git worktree so parallel sessions don't share files. From a session that is itself " +
        "isolated, the worktree starts from your current commit, not your uncommitted changes: commit first. The session " +
        "commits on a branch named courier/<its session ID> and names it in its report; merge that branch yourself.",
    }),
  ),
  group: Schema.optional(
    Schema.String.annotate({
      description:
        "A join group: start the sessions of one batch with the same name, and their reports are held and delivered " +
        "to you in one message once every one of them has reported and your turn has ended, instead of one turn per " +
        "report. A blocked report, a question, a permission request or a failed turn still reaches you at once. Letters, " +
        "digits, dots, dashes and underscores, up to 60; the name is free again once the group has been delivered.",
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
  queue: Schema.optional(
    Schema.Boolean.annotate({ description: "Wait until the target's current turn ends instead of steering it now." }),
  ),
})

export const StatusInput = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The session to look at." }),
})

export const ChildrenInput = Schema.Struct({
  sessionID: Schema.optional(
    Schema.String.annotate({ description: "The session whose children to list; defaults to this one." }),
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

/** What the tree's tools run on: one plugin instance's ports. */
export interface TreeToolPorts {
  readonly courier: CourierPorts
  readonly cleanup: CleanupPorts
  readonly stop: StopPorts
}

/** Adds the tree's courier tools, each a direct tool rather than a code-mode one. */
export function addTreeTools(tools: ToolEditor, ports: TreeToolPorts) {
  tools.add({
    name: "courier_spawn",
    options: { codemode: false },
    description:
      "Start a new OpenCode session on a task and return immediately. It runs on your model. The session reports " +
      "back with courier_send, which wakes this session, and you are told if its turn fails or ends without a report " +
      "instead, it waits for a permission or it asks a question. Give a batch of parallel sessions one group name to " +
      "be woken once, with all their reports, instead of once per report. DO NOT poll it or call courier_status in a " +
      "loop: once you have started the sessions you need, end your turn by replying without calling more tools; each " +
      "report, or each group's reports, starts a new turn in which you carry on. For long tasks, also courier_later a " +
      "check-in for yourself in case it never reports, and courier_cancel it when it does.",
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
      "the artifacts you produced, or to steer a session you started. The status is carried as an attribute of the " +
      "message; without one, a message to the session that started you is progress, not your report. If you were " +
      "started in a group, a report with status done, partial or failed is held and delivered with the group's other " +
      "reports; the result says so, and nothing more is needed from you.",
    input: SendInput,
    execute: async (input, context) => {
      const delivered = await send(ports.courier, context.sessionID, input).catch(rethrow("courier_send"))
      return { content: sendText(input.sessionID, delivered), metadata: delivered }
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
      const result = await status(ports.courier, input).catch(rethrow("courier_status"))
      return { content: statusText(result), metadata: result }
    },
  })

  tools.add({
    name: "courier_children",
    options: { codemode: false },
    description:
      "List the sessions this one started with courier_spawn, with each one's state and last reply, and for one " +
      "started in a group, its group and whether its report is held, still out, or released, e.g. after a " +
      "compaction or restart. Like courier_status, for a one-off look, not for waiting.",
    input: ChildrenInput,
    execute: async (input, context) => {
      const listed = await listChildren(ports.courier, input.sessionID || context.sessionID).catch(rethrow("courier_children"))
      return { content: childrenText(listed), metadata: { children: listed } }
    },
  })

  tools.add({
    name: "courier_tree",
    options: { codemode: false },
    description:
      "List the whole tree of sessions under this one (or under sessionID): every session started with courier_spawn " +
      "from it, directly or through others, each with its depth, what courier_children shows, and whether it still " +
      "owes a report, sent progress, or ended without one. For a one-off look, not for waiting; long trees are cut at maxTotal sessions.",
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
      "Stop a session you started, directly or through others, and every session under it: each running turn is " +
      "interrupted, deepest first, and the messages scheduled for them with courier_later are cancelled. Use it when a " +
      "subtree went wrong or is no longer needed. They do not report back, and you are not told of what you stopped; a " +
      "session between you and the target is. A stopped session can be woken again with courier_send. With " +
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
      "and drop it from courier_children. A worktree with uncommitted changes or commits on no branch is kept and " +
      "the result lists them; commit or branch what you want, or pass force: true to discard it. A session without " +
      "isolate has no worktree and is only dropped from courier_children. Either way, one in a join group that has not " +
      "reported is dropped from it, so the group's other reports reach you without it; use this for a member you no " +
      "longer need a report from. It never deletes the session itself, nor the sessions it started.",
    input: CleanupInput,
    execute: async (input, context) => {
      const result = await cleanup(ports.cleanup, context.sessionID, input).catch(rethrow("courier_cleanup"))
      return { content: cleanupText(result), metadata: result }
    },
  })
}
