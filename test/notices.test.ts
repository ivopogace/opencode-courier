import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { ToolEditor } from "../src/kernel/tool.js"
import * as kernel from "../src/kernel/protocol.js"
import * as skill from "../src/skill.js"
import * as tree from "../src/tree/text.js"
import * as person from "../src/person/text.js"
import * as scheduling from "../src/scheduling/text.js"
import * as webhook from "../src/webhook/text.js"
import * as memory from "../src/memory/text.js"
import { addTreeTools } from "../src/tree/index.js"
import { addPersonTools } from "../src/person/index.js"
import { addSchedulingTools } from "../src/scheduling/index.js"
import { addWebhookTools } from "../src/webhook/index.js"
import { addMemoryTools } from "../src/memory/index.js"
import { githubEvent } from "../src/webhook/receiver.js"

// Every model-facing string, built from fixed inputs and kept in __snapshots__/notices.test.ts.snap: every
// src/**/text.ts, imported each by its path (test/imports.test.ts checks none is missing), the skill and the
// tools. A wording change shows up there as a snapshot diff; after one, rerun e2e/real-model.sh (CLAUDE.md).

const registered: any[] = []
const editor = { add: (tool: unknown) => registered.push(tool) } as unknown as ToolEditor
// In the order src/index.ts adds them.
addTreeTools(editor, {} as never)
addPersonTools(editor, {} as never)
addSchedulingTools(editor, {} as never)
addWebhookTools(editor, {} as never)
addMemoryTools(editor, {} as never)

describe("tools", () => {
  test("are the fourteen courier tools, each a direct tool", () => {
    expect(registered.map((tool) => [tool.name, tool.options])).toMatchSnapshot()
  })

  for (const tool of registered)
    test(tool.name, () => {
      // Closed, as OpenCode renders a tool's schema for the model; Effect 4.0.1 leaves objects open by default.
      const input = Schema.toJsonSchemaDocument(tool.input, { onExcessProperty: "error" }).schema
      expect({ description: tool.description, input }).toMatchSnapshot()
    })
})

describe("envelope and child brief", () => {
  test("END_TURN", () => expect(kernel.END_TURN).toMatchSnapshot())
  const limits = { maxDepth: 3, maxChildren: 5, maxTotal: 20 }
  test("childBrief", () => {
    expect(tree.childBrief("ses_parent", "Fix the bug\nin src/a.ts", 1, limits)).toMatchSnapshot()
    expect(tree.childBrief("ses_parent", "Fix the bug\nin src/a.ts", 3, limits)).toMatchSnapshot()
    expect(tree.childBrief("ses_parent", "Fix the bug", 1, limits, tree.childBranch("ses_child"))).toMatchSnapshot()
    expect(tree.childBrief("ses_parent", "Fix the bug", 3, limits, tree.childBranch("ses_child"))).toMatchSnapshot()
  })
  test("rolePart", () => {
    for (const depth of [0, 1, 2, 3, null]) expect(tree.rolePart(depth, limits)).toMatchSnapshot()
    for (const depth of [0, 1, 2, 3, null]) expect(tree.rolePart(depth, limits)).toStartWith(tree.ROLE_PREFIX)
  })
  test("the courier-orchestrate skill", () => {
    expect(kernel.SKILL_ID).toBe("courier-orchestrate")
    expect(skill.SKILL_DESCRIPTION).toMatchSnapshot()
    expect(skill.SKILL_CONTENT).toMatchSnapshot()
    // The description is what the model reads in every session's skill list; the content, only once loaded.
    expect(skill.SKILL_DESCRIPTION.length).toBeLessThan(400)
    expect(skill.SKILL_CONTENT).toContain("Never start exactly one session")
    expect(skill.SKILL_CONTENT).toContain("Never hand the checking to another session")
    // The split line reads the same wherever it is asked for: the skill, the brief and the root's pointer.
    expect(skill.SKILL_CONTENT).toContain(kernel.SPLIT_LINE)
    expect(skill.SKILL_CONTENT).toContain("bun run <script>")
    // Step 1 and the root's pointer name one courier_recall before the decision, which the recursive checker allows.
    expect(skill.SKILL_CONTENT).toContain(`First call ${memory.RECALL_TOOL} once`)
    // Step 8 asks the top for one courier_note, none when there is nothing, naming the job it comes from; the brief never
    // mentions it: children write no lesson. The tool, the skill and the input ask for the lesson's scope, not only splitting.
    expect(skill.SKILL_CONTENT).toContain(`one ${memory.NOTE_TOOL} with that one line; none when there is nothing`)
    expect(skill.SKILL_CONTENT).toContain("Name the job it comes from and the reason")
    expect(skill.SKILL_CONTENT).not.toContain("about splitting work here")
    expect(skill.SKILL_CONTENT).toContain("refuses a line over its limit rather than clipping it")
    expect(memory.NOTE_EMPTY).toContain("with the job it comes from and the reason")
    expect(tree.childBrief("ses_parent", "Fix the bug", 1, limits)).not.toContain(memory.NOTE_TOOL)
    expect(tree.rolePart(0, limits)).not.toContain(memory.NOTE_TOOL)
    expect(tree.rolePart(null, limits)).toContain(`call ${memory.RECALL_TOOL} once`)
    expect(tree.childBrief("ses_parent", "Fix the bug", 1, limits)).toContain(kernel.SPLIT_LINE)
    expect(tree.childBrief("ses_parent", "Fix the bug", 3, limits)).not.toContain("split:")
    expect(tree.rolePart(null, limits)).toContain(kernel.SPLIT_LINE)
    expect(tree.rolePart(null, limits)).toContain(kernel.SKILL_ID)
  })
  test("refusals", () => {
    expect(tree.depthRefusal(3, 3)).toMatchSnapshot()
    expect(tree.childrenRefusal(5, 5)).toMatchSnapshot()
    expect(tree.childrenRefusal(1, 1)).toMatchSnapshot()
    expect(tree.totalRefusal(20, 20)).toMatchSnapshot()
  })
  test("envelope", () => {
    expect(kernel.envelope("ses_child", "done")).toMatchSnapshot()
    expect(kernel.envelope("ses_child", "failed", { failed: "provider.auth", request: "per_1" })).toMatchSnapshot()
    expect(kernel.envelope("ses_child", "Fixed it.", { status: "done" })).toMatchSnapshot()
  })
  test("STATUSES", () => expect(kernel.STATUSES).toEqual(["done", "partial", "blocked", "failed"]))
  test("reportBody", () => {
    const artifacts = {
      branch: "fix/checkout",
      commits: ["abc1234 Fix the total", "def5678"],
      files: ["src/checkout.ts", "test/checkout.test.ts"],
      checks: [
        { command: "bun test", result: "412 passed" },
        { command: "bun run typecheck", result: "clean" },
      ],
    }
    expect(tree.reportBody("Fixed the total in checkout.", artifacts)).toMatchSnapshot()
    expect(tree.reportBody("Fixed it.", { branch: "fix/checkout" })).toMatchSnapshot()
    expect(tree.reportBody("Fixed it.", undefined)).toBe("Fixed it.")
    expect(tree.reportBody("Fixed it.", {})).toBe("Fixed it.")
    expect(tree.reportBody("Fixed it.", { branch: "  ", commits: [], files: [], checks: [] })).toBe("Fixed it.")
    // OpenCode does not check the schema: what is not a list of strings, or a check without a command, is left out.
    expect(
      tree.reportBody("Fixed it.", { commits: ["abc", 7, " def "], files: "src/a.ts", checks: [{ command: "bun test" }, { result: "?" }, "lint"] } as never),
    ).toBe("Fixed it.\n\nArtifacts:\n- commits: abc, def\n- checks:\n  - bun test: (no result given)")
  })
})

describe("tool results", () => {
  test("spawnText", () => {
    expect(tree.spawnText({ sessionID: "ses_child", directory: "/repo" })).toMatchSnapshot()
    expect(tree.spawnText({ sessionID: "ses_child", directory: "/wt", rosterError: "roster failed: disk full" })).toMatchSnapshot()
    expect(tree.spawnText({ sessionID: "ses_child", directory: "/repo", group: "reviews" })).toMatchSnapshot()
    expect(tree.spawnText({ sessionID: "ses_child", directory: "/repo", groupError: "group failed: disk full" })).toMatchSnapshot()
  })
  test("spawnText for a child started from its parent's HEAD", () => {
    expect(tree.spawnText({ sessionID: "ses_child", directory: "/wt", fromParent: true })).toMatchSnapshot()
    expect(tree.spawnText({ sessionID: "ses_child", directory: "/wt", fromParent: true, uncommitted: true })).toMatchSnapshot()
  })
  test("sendText", () => {
    expect(tree.sendText("ses_parent")).toMatchSnapshot()
    expect(tree.sendText("ses_parent", { report: true, status: "done" })).toMatchSnapshot()
    expect(tree.sendText("ses_parent", { report: true })).toMatchSnapshot()
    expect(tree.sendText("ses_parent", { report: false })).toMatchSnapshot()
    expect(tree.sendText("ses_other", { status: "done" })).toMatchSnapshot()
    expect(tree.sendText("ses_parent", { report: true, status: "done", held: { group: "reviews", reported: 1, members: 3 } })).toMatchSnapshot()
    expect(tree.sendText("ses_parent", { report: true, status: "failed", held: { group: "reviews", reported: 3, members: 3 } })).toMatchSnapshot()
    expect(tree.sendText("ses_parent", { report: true, status: "done", held: { group: "reviews" } })).toMatchSnapshot()
  })
  test("statusText", () => expect(tree.statusText({ sessionID: "ses_child", title: "Fix", idle: 3 })).toMatchSnapshot())
  test("childrenText", () => {
    expect(tree.childrenText([])).toMatchSnapshot()
    expect(tree.childrenText([{ sessionID: "ses_child", isolated: false }])).toMatchSnapshot()
  })
  test("treeText", () => {
    expect(tree.treeText({ sessions: [] })).toMatchSnapshot()
    expect(tree.treeText({ sessions: [{ sessionID: "ses_child", depth: 1 }] })).toMatchSnapshot()
    expect(tree.treeText({ sessions: [{ sessionID: "ses_child", depth: 1 }], truncated: 20 })).toMatchSnapshot()
  })
  test("stopText", () => {
    const stopped = [
      { sessionID: "ses_leaf", outcome: "interrupted" },
      { sessionID: "ses_mid", outcome: "idle" },
      { sessionID: "ses_odd", outcome: "failed", error: "session.interrupt failed: boom" },
    ]
    expect(tree.stopText({ sessionID: "ses_mid", stopped, cancelled: [] })).toMatchSnapshot()
    expect(tree.stopText({ sessionID: "ses_mid", stopped, cancelled: ["later_1", "later_2"], told: "ses_top" })).toMatchSnapshot()
    expect(
      tree.stopText({
        sessionID: "ses_mid",
        stopped,
        cancelled: [],
        cleanup: [
          { sessionID: "ses_leaf", directory: "/wt/leaf", outcome: "removed" },
          { sessionID: "ses_mid", directory: "/wt/mid", outcome: "kept", reason: "1 uncommitted change (a.ts)", changes: ["a.ts"], commits: [] },
          { sessionID: "ses_odd", outcome: "failed", error: "courier_cleanup failed: git broke" },
        ],
      }),
    ).toMatchSnapshot()
    expect(tree.stopText({ sessionID: "ses_mid", stopped, cancelled: [], cleanup: [] })).toMatchSnapshot()
  })
  test("stoppedNotice", () => expect(tree.stoppedNotice("Review a.ts", "ses_root")).toMatchSnapshot())
  test("cleanupText", () => {
    expect(tree.cleanupText({ sessionID: "ses_child", directory: "/wt", outcome: "removed" })).toMatchSnapshot()
    expect(tree.cleanupText({ sessionID: "ses_child", directory: "/wt", outcome: "gone" })).toMatchSnapshot()
    expect(tree.cleanupText({ sessionID: "ses_child", directory: "/wt", outcome: "kept", reason: "1 uncommitted change (a.ts)", changes: ["a.ts"], commits: [] })).toMatchSnapshot()
    expect(tree.cleanupText({ sessionID: "ses_child", directory: "/repo", outcome: "forgotten" })).toMatchSnapshot()
    expect(tree.cleanupText({ sessionID: "ses_child", directory: "/repo", outcome: "forgotten", group: "reviews" })).toMatchSnapshot()
  })
  test("keepReason", () => {
    expect(tree.keepReason({ changes: [], commits: [] })).toBeUndefined()
    expect(tree.keepReason({ changes: ["a.ts"], commits: [] })).toMatchSnapshot()
    expect(tree.keepReason({ changes: ["a", "b", "c", "d", "e", "f"], commits: ["abc1234", "def5678"] })).toMatchSnapshot()
  })
  test("answerText", () => {
    const base = { sessionID: "ses_child", requestID: "per_1" }
    expect(person.answerText({ ...base, reply: "once" as const, answered: false })).toMatchSnapshot()
    expect(person.answerText({ ...base, reply: "once" as const, answered: true })).toMatchSnapshot()
    expect(person.answerText({ ...base, reply: "reject" as const, answered: true })).toMatchSnapshot()
    const question = { sessionID: "ses_child", requestID: "question_1" }
    expect(person.answerText({ ...question, answered: false })).toMatchSnapshot()
    expect(person.answerText({ ...question, answered: true, by: "result", answers: [["Hi"]] })).toMatchSnapshot()
    expect(person.answerText({ ...question, answered: true, by: "message", answers: [["Hi"]] })).toMatchSnapshot()
  })
  test("laterText", () => {
    const entry = { id: "later_1", sessionID: "ses_parent" }
    expect(scheduling.laterText(entry, "2026-10-07T12:00:00.000Z", true)).toMatchSnapshot()
    expect(scheduling.laterText(entry, "2026-10-07T12:00:00.000Z", false)).toMatchSnapshot()
  })
  test("cancelText", () => {
    expect(scheduling.cancelText("later_1", true)).toMatchSnapshot()
    expect(scheduling.cancelText("later_1", false)).toMatchSnapshot()
  })
  test("subscribeText", () => {
    expect(webhook.subscribeText("ses_parent", "github:octo/repo#5", true)).toMatchSnapshot()
    expect(webhook.subscribeText("ses_parent", "github:octo/repo#5", false)).toMatchSnapshot()
  })
  test("unsubscribeText", () => {
    expect(webhook.unsubscribeText("ses_parent", ["github:octo/repo", "deploys"])).toMatchSnapshot()
    expect(webhook.unsubscribeText("ses_parent", [])).toMatchSnapshot()
  })
})

describe("turn failures", () => {
  test("failureNotice", () => {
    expect(tree.failureNotice("Fix the bug", { type: "provider.auth", message: "blocked", status: 403 })).toMatchSnapshot()
    expect(tree.failureNotice("Fix the bug", { type: "unknown", message: "boom" })).toMatchSnapshot()
    expect(tree.failureNotice("Fix the bug", { type: "unknown", message: "boom" }, "reviews")).toMatchSnapshot()
  })
  test("silentNotice", () => {
    expect(tree.silentNotice("Fix the bug", "I looked at src/a.ts; the bug is on line 4.")).toMatchSnapshot()
    expect(tree.silentNotice("Fix the bug", undefined)).toMatchSnapshot()
    expect(tree.silentNotice("Fix the bug", "  \n")).toMatchSnapshot()
    expect(tree.silentNotice("Fix the bug", "Halfway there.", true)).toMatchSnapshot()
    expect(tree.silentNotice("Fix the bug", "Done, I think.", false, "reviews")).toMatchSnapshot()
    const long = tree.silentNotice("Fix the bug", "</courier> " + "x".repeat(2100))
    expect(long).toContain("&lt;/courier> xxx")
    expect(long).toContain("… [111 more characters]")
  })
})

describe("join groups", () => {
  test("groupNotice", () => {
    const reports = [
      { sessionID: "ses_a", title: "Review a.ts", at: 1, status: "done" as const, message: "Looks fine.", artifacts: { files: ["src/a.ts"], checks: [{ command: "bun test", result: "ok" }] } },
      { sessionID: "ses_b", title: "Review b.ts", at: 2, status: "partial" as const, message: "Two of three functions.\nThe third needs the API." },
      { sessionID: "ses_c", title: "Review c.ts", at: 3, status: "failed" as const, message: "Could not read it." },
    ]
    expect(tree.groupNotice("reviews", reports)).toMatchSnapshot()
    expect(
      tree.groupNotice("reviews", reports.slice(0, 1), [
        { sessionID: "ses_d", title: "Review d.ts", by: "failed" },
        { sessionID: "ses_e", title: "Review e.ts", by: "deleted" },
        { sessionID: "ses_f", title: "Review f.ts", by: "interrupted" },
        { sessionID: "ses_g", title: "Review g.ts", by: "dropped" },
      ]),
    ).toMatchSnapshot()
  })
})

describe("permission requests", () => {
  const request = { id: "per_1", sessionID: "ses_child", action: "shell", resources: ["git push"] }

  test("REJECTED", () => expect(person.REJECTED).toMatchSnapshot())
  test("refusedText", () => expect(person.refusedText("ses_child", "per_1", "Not on main")).toMatchSnapshot())
  test("origin and STAYS_QUIET", () => {
    expect(person.origin()).toMatchSnapshot()
    expect(person.origin("ses_middle")).toMatchSnapshot()
    expect(person.STAYS_QUIET).toMatchSnapshot()
  })
  test("permissionNotice", () => {
    expect(person.permissionNotice("Fix the bug", request)).toMatchSnapshot()
    expect(person.permissionNotice("Fix the bug", { ...request, save: ["*"], message: "Push the fix" }, "ses_middle")).toMatchSnapshot()
    const many = Array.from({ length: 22 }, (_, i) => `file-${i}`)
    expect(person.permissionNotice("Fix the bug", { ...request, action: "edit", resources: [...many, "x".repeat(400)], save: ["git push*", "git fetch*"] })).toMatchSnapshot()
    expect(person.permissionNotice("Fix the bug", { ...request, resources: [] })).toMatchSnapshot()
    expect(person.permissionNotice("Fix the bug", { ...request, save: ["*"] }, undefined, true)).toMatchSnapshot()
  })
  test("permissionSettledNotice", () => {
    expect(person.permissionSettledNotice("Fix the bug", "per_1", "once")).toMatchSnapshot()
    expect(person.permissionSettledNotice("Fix the bug", "per_1", "reject")).toMatchSnapshot()
  })
})

describe("forms", () => {
  const websearch = {
    id: "frm_1",
    sessionID: "ses_child",
    title: "Search the web?",
    metadata: { kind: "websearch.provider" },
    fields: [
      {
        key: "provider",
        type: "select",
        title: "Provider",
        description: "Where to search",
        options: [
          { value: "exa", label: "Exa", description: "Free" },
          { value: "none", label: "Don't search" },
        ],
      },
      { key: "token", type: "string", hidden: true },
    ],
  }

  test("kindOf", () => {
    expect(person.kindOf(websearch)).toBe("websearch.provider")
    expect(person.kindOf({ ...websearch, metadata: { kind: "bad kind" } })).toBeUndefined()
  })
  test("formNotice", () => {
    expect(person.formNotice("Fix the bug", websearch)).toMatchSnapshot()
    const fields = [
      { key: "login", type: "external", title: "Sign in", url: "https://example.com/login" },
      { key: "name", type: "string" },
      { key: "depth", type: "number", description: "How deep", when: [{ key: "name" }] },
      { key: "pick", type: "select", options: Array.from({ length: 22 }, (_, i) => ({ value: `${i}`, label: `Option ${i}` })) },
      ...Array.from({ length: 20 }, (_, i) => ({ key: `extra${i}`, type: "boolean" })),
    ]
    expect(person.formNotice("Fix the bug", { id: "frm_2", sessionID: "ses_child", title: "Settings", fields }, "ses_middle")).toMatchSnapshot()
  })
  test("formNotice of a native child", () => {
    expect(person.formNotice("Fix the bug", websearch, undefined, "ses_parent", "ses_parent")).toMatchSnapshot()
    expect(person.formNotice("Fix the bug", websearch, "ses_middle", "ses_middle", "ses_root")).toMatchSnapshot()
  })
  test("formSettledNotice", () => {
    expect(person.formSettledNotice("Fix the bug", "frm_1", "answered")).toMatchSnapshot()
    expect(person.formSettledNotice("Fix the bug", "frm_1", "cancelled")).toMatchSnapshot()
  })
})

describe("questions", () => {
  const prompts = [
    {
      question: "Which greeting?",
      header: "Greeting",
      options: [
        { label: "Hi", description: "Short" },
        { label: "Hello", description: "" },
      ],
    },
    { question: "Which languages?", header: "Languages", options: [{ label: "English", description: "" }], multiple: true },
  ]
  const asked = {
    requestID: "question_1",
    sessionID: "ses_child",
    top: "ses_parent",
    title: "Fix the bug",
    questions: prompts,
    askedAt: 0,
  }
  const answers = [["Hi"], ["English", "German"]]

  test("answeredText", () => {
    expect(person.answeredText(prompts, answers)).toMatchSnapshot()
    expect(person.answeredText(prompts, [["Hi"]])).toMatchSnapshot()
  })
  test("questionNotice", () => {
    expect(person.questionNotice(asked)).toMatchSnapshot()
    expect(person.questionNotice({ ...asked, startedBy: "ses_middle" }, "stopped")).toMatchSnapshot()
    expect(person.questionNotice(asked, "restarted")).toMatchSnapshot()
  })
  test("questionSettledNotice", () => {
    expect(person.questionSettledNotice(asked, { by: "child", answers })).toMatchSnapshot()
    expect(person.questionSettledNotice(asked, { by: "dismissed" })).toMatchSnapshot()
    expect(person.questionSettledNotice(asked, { by: "failed", error: "Error: boom" })).toMatchSnapshot()
    expect(person.questionSettledNotice(asked, { by: "child", answers, via: "inbox" })).toMatchSnapshot()
  })
  test("question notices of a native child", () => {
    expect(person.nativeQuestionNotice({ ...asked, native: true })).toMatchSnapshot()
    expect(person.questionSettledNotice({ ...asked, native: true }, { by: "child", answers })).toMatchSnapshot()
    expect(person.questionSettledNotice({ ...asked, native: true }, { by: "dismissed" })).toMatchSnapshot()
  })
  test("DISMISSED", () => expect(person.DISMISSED).toMatchSnapshot())
  test("cutOffAnswer", () => {
    expect(person.cutOffAnswer(asked, { answers })).toMatchSnapshot()
    expect(person.cutOffAnswer(asked, { dismissed: true })).toMatchSnapshot()
  })
  test("unlinkedNote", () => {
    expect(person.unlinkedNote([asked, { sessionID: "ses_other", requestID: "question_2" }])).toMatchSnapshot()
  })
  test("withdrawnText", () => {
    expect(person.withdrawnText(asked, { by: "top", outcome: { answers } })).toMatchSnapshot()
    expect(person.withdrawnText(asked, { by: "top", outcome: { dismissed: true } })).toMatchSnapshot()
    expect(person.withdrawnText(asked, { by: "child", answers })).toMatchSnapshot()
    expect(person.withdrawnText(asked, { by: "dismissed" })).toMatchSnapshot()
    expect(person.withdrawnText(asked, { by: "failed", error: "Error: boom" })).toMatchSnapshot()
    expect(person.withdrawnText(asked, { by: "child", answers, via: "inbox" })).toMatchSnapshot()
  })
  test("passedNote", () => {
    expect(person.passedNote(asked, "result")).toMatchSnapshot()
    expect(person.passedNote(asked, "message")).toMatchSnapshot()
    expect(person.passedNote(asked, undefined)).toMatchSnapshot()
    expect(person.passedNote(asked, "error: storage is down")).toMatchSnapshot()
  })
})

describe("webhook deliveries", () => {
  /** The summary a subscribed session gets for a GitHub delivery, as the receiver makes it. */
  const summary = (name: string, body: Record<string, any>, action?: string, sender?: string) =>
    githubEvent(name, { ...body, repository: { full_name: "octo/repo" }, ...(action ? { action } : {}), ...(sender ? { sender: { login: sender } } : {}) })
      ?.summary

  test("githubSummary", () => {
    const run = { name: "CI", head_sha: "0123456789abcdef", conclusion: "failure", html_url: "https://ci/1", pull_requests: [{ number: 5 }, { number: 5 }, { number: 7 }] }
    expect(summary("check_run", { check_run: run }, "completed")).toMatchSnapshot()
    expect(summary("check_suite", { check_suite: { app: { name: "Actions" }, head_sha: "0123456789", details_url: "https://ci/2" } }, "completed")).toMatchSnapshot()
    expect(summary("workflow_run", { workflow_run: {} }, "completed")).toMatchSnapshot()
    const review = { user: { login: "alice" }, state: "changes_requested", html_url: "https://gh/r", body: "Please fix" }
    expect(summary("pull_request_review", { review, pull_request: { number: 5, title: "Fix" } }, "submitted", "alice")).toMatchSnapshot()
    expect(summary("pull_request_review", {}, undefined)).toMatchSnapshot()
    const comment = { user: { login: "bob" }, path: "src/a.ts", line: 12, html_url: "https://gh/c", body: "x".repeat(1600) }
    expect(summary("pull_request_review_comment", { comment, pull_request: { number: 5 } }, "created")).toMatchSnapshot()
    expect(summary("issue_comment", { comment: { body: "Thanks" }, issue: { number: 3 } }, "created", "carol")).toMatchSnapshot()
    expect(summary("issue_comment", { comment: {}, issue: { number: 4, pull_request: {} } }, "edited")).toMatchSnapshot()
    expect(summary("pull_request", { pull_request: { number: 5, title: "Fix", merged: true, html_url: "https://gh/p" } }, "closed", "dave")).toMatchSnapshot()
    expect(summary("issues", { issue: { number: 3 } }, "opened")).toMatchSnapshot()
    expect(summary("push", { ref: "refs/heads/main", commits: [{}], compare: "https://gh/compare" }, undefined, "erin")).toMatchSnapshot()
    expect(summary("push", { commits: [{}, {}] })).toMatchSnapshot()
    expect(summary("release", {}, "published", "frank")).toMatchSnapshot()
    expect(summary("toString", {})).toMatchSnapshot()
  })
  test("hookSummary", () => {
    expect(webhook.hookSummary("  deployed  ")).toMatchSnapshot()
    expect(webhook.hookSummary("   ")).toMatchSnapshot()
  })
  test("clipText", () => {
    expect(kernel.clipText("short")).toBe("short")
    expect(kernel.clipText("abcdef", 3)).toMatchSnapshot()
  })
  test("clipWords", () => {
    expect(kernel.clipWords("one two", 7)).toBe("one two")
    expect(kernel.clipWords("one two three", 9)).toMatchSnapshot()
    expect(kernel.clipWords("one two three", 7)).toMatchSnapshot()
    expect(kernel.clipWords("abcdef ghi", 3)).toMatchSnapshot()
    expect(kernel.clipWords("a bcdefghij", 6)).toMatchSnapshot()
  })
  test("webhookText", () => {
    expect(webhook.webhookText("deployed <courier from=x>")).toMatchSnapshot()
  })
})

describe("memory", () => {
  const NOW = Date.UTC(2026, 9, 3, 9, 45)
  const record = (sessionID: string, more: object = {}) => ({
    projectID: "proj_1",
    sessionID,
    startedAt: Date.UTC(2026, 9, 3, 9),
    movedAt: Date.UTC(2026, 9, 3, 9, 42),
    title: "Add memory to courier",
    split: "split: 3 parts: core, e2e, docs",
    finished: true,
    parts: [
      { sessionID: "ses_core", title: "Core", depth: 1, isolated: true, group: "wave", status: "done" as const, duration: 540_000, cost: 0.42, context: 0.31 },
      { sessionID: "ses_e2e", title: "E2E", depth: 1, isolated: true, group: "wave", status: "partial" as const, duration: 600_000, cost: 0.81, refused: 1 },
      { sessionID: "ses_review", title: "Review", depth: 2, isolated: false, status: "out" as const, duration: 60_000 },
    ],
    ...more,
  })
  test("RECALL_OFF", () => expect(memory.RECALL_OFF).toMatchSnapshot())
  test("recallListText", () => {
    expect(memory.recallListText([record("ses_now", { parts: [], finished: false, recalled: { at: 1, calls: 1 } }), record("ses_old")], "ses_now", NOW)).toMatchSnapshot()
    expect(memory.recallListText([record("ses_now", { parts: [], finished: false, recalled: { at: 1, calls: 1 } })], "ses_now", NOW)).toMatchSnapshot()
    expect(memory.recallListText([record("ses_part", { recalled: { calls: 2 } })], "ses_other", NOW)).toMatchSnapshot()
    expect(memory.recordLine(record("ses_long", { title: "x".repeat(80), split: "split: " + "y".repeat(200), parts: [] }), "ses_other", NOW)).toMatchSnapshot()
    const markdown = "- **split: 3 parts: the core of the memory record, its end-to-end scenario in the live suite, and the reference's Memory section, each in a session of its own.**"
    expect(memory.recordLine(record("ses_md", { split: markdown, parts: [] }), "ses_other", NOW)).toMatchSnapshot()
  })
  test("recordLine with a gone part", () => {
    const gone = { sessionID: "ses_goner", title: "Goner", depth: 1, isolated: true, status: "gone" as const, duration: 30_000 }
    expect(memory.recordLine(record("ses_old", { parts: [...record("ses_old").parts.slice(0, 2), gone] }), "ses_other", NOW)).toMatchSnapshot()
  })
  test("recordLine with a revised split line", () => {
    const revisions = [
      { text: "split: 2 parts: core, e2e", at: Date.UTC(2026, 9, 3, 9, 10), parts: 0 },
      { text: "**split: 2 parts: its tests, its docs**", at: Date.UTC(2026, 9, 3, 9, 30), parts: 1 },
    ]
    expect(memory.recordLine(record("ses_staged", { split: "split: 1 part: the core", revisions }), "ses_other", NOW)).toMatchSnapshot()
    const long = [{ text: "split: " + "y".repeat(200), at: Date.UTC(2026, 9, 3, 9, 30), parts: 2 }]
    expect(memory.recordLine(record("ses_long", { revisions: long, parts: [] }), "ses_other", NOW)).toMatchSnapshot()
  })
  test("recallRecordText", () => expect(memory.recallRecordText(record("ses_old"))).toMatchSnapshot())
  test("recallRecordText with revisions", () =>
    expect(memory.recallRecordText(record("ses_staged", { split: "split: 1 part: the core", revisions: [{ text: "split: 2 parts: its tests, its docs", at: Date.UTC(2026, 9, 3, 9, 30), parts: 1 }] }))).toMatchSnapshot())
  test("recallMissingText", () => expect(memory.recallMissingText("ses_none")).toMatchSnapshot())
  const lesson = { text: "The docs part was ten lines; next time do it yourself.", at: Date.UTC(2026, 9, 3, 9, 40) }
  test("recordLine with a lesson", () => {
    expect(memory.recordLine(record("ses_old", { lesson }), "ses_other", NOW)).toMatchSnapshot()
    expect(memory.recordLine(record("ses_old", { lesson: { ...lesson, depth: 2 } }), "ses_other", NOW)).toMatchSnapshot()
  })
  test("recordLine and recallListText with a pinned record", () => {
    const pinned = record("ses_pinned", { pinned: { at: Date.UTC(2026, 9, 3, 9, 44) }, reads: { shown: 7, read: 1, at: Date.UTC(2026, 9, 3, 9, 44) }, lesson })
    expect(memory.recordLine(pinned, "ses_other", NOW)).toMatchSnapshot()
    expect(memory.recallListText([pinned, record("ses_now", { parts: [], finished: false, recalled: { at: 1, calls: 1 } }), record("ses_old")], "ses_now", NOW)).toMatchSnapshot()
    expect(memory.recallRecordText(pinned)).toMatchSnapshot()
  })
  test("noteText", () => {
    expect(memory.noteText("ses_top", lesson, undefined)).toMatchSnapshot()
    expect(memory.noteText("ses_top", { text: "x".repeat(300), at: lesson.at, depth: 1 }, lesson)).toMatchSnapshot()
  })
  test("NOTE_OFF", () => expect(memory.NOTE_OFF).toMatchSnapshot())
  test("noteLeafRefusal", () => expect(memory.noteLeafRefusal(3, 3)).toMatchSnapshot())
  test("NOTE_EMPTY", () => expect(memory.NOTE_EMPTY).toMatchSnapshot())
  test("noteLongRefusal", () => expect(memory.noteLongRefusal(312)).toMatchSnapshot())
  test("noteUnrecordedRefusal", () => expect(memory.noteUnrecordedRefusal("ses_top")).toMatchSnapshot())
})
