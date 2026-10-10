import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as notices from "../src/notices.js"
import { addTools, type ToolEditor, type ToolPorts } from "../src/tools.js"
import { githubEvent } from "../src/webhook.js"

// Every model-facing string, built from fixed inputs and kept in __snapshots__/notices.test.ts.snap.
// A wording change shows up there as a snapshot diff; after one, rerun e2e/real-model.sh (CLAUDE.md).

const registered: any[] = []
addTools({ add: (tool: unknown) => registered.push(tool) } as unknown as ToolEditor, {} as ToolPorts)

describe("tools", () => {
  test("are the twelve courier tools, each a direct tool", () => {
    expect(registered.map((tool) => [tool.name, tool.options])).toMatchSnapshot()
  })

  for (const tool of registered)
    test(tool.name, () => {
      expect({ description: tool.description, input: Schema.toJsonSchemaDocument(tool.input).schema }).toMatchSnapshot()
    })
})

describe("envelope and child brief", () => {
  test("END_TURN", () => expect(notices.END_TURN).toMatchSnapshot())
  const limits = { maxDepth: 3, maxChildren: 5, maxTotal: 20 }
  test("childBrief", () => {
    expect(notices.childBrief("ses_parent", "Fix the bug\nin src/a.ts", 1, limits)).toMatchSnapshot()
    expect(notices.childBrief("ses_parent", "Fix the bug\nin src/a.ts", 3, limits)).toMatchSnapshot()
    expect(notices.childBrief("ses_parent", "Fix the bug", 1, limits, notices.childBranch("ses_child"))).toMatchSnapshot()
    expect(notices.childBrief("ses_parent", "Fix the bug", 3, limits, notices.childBranch("ses_child"))).toMatchSnapshot()
  })
  test("rolePart", () => {
    for (const depth of [0, 1, 2, 3, null]) expect(notices.rolePart(depth, limits)).toMatchSnapshot()
    for (const depth of [0, 1, 2, 3, null]) expect(notices.rolePart(depth, limits)).toStartWith(notices.ROLE_PREFIX)
  })
  test("the courier-orchestrate skill", () => {
    expect(notices.SKILL_ID).toBe("courier-orchestrate")
    expect(notices.SKILL_DESCRIPTION).toMatchSnapshot()
    expect(notices.SKILL_CONTENT).toMatchSnapshot()
    // The description is what the model reads in every session's skill list; the content, only once loaded.
    expect(notices.SKILL_DESCRIPTION.length).toBeLessThan(400)
    expect(notices.SKILL_CONTENT).toContain("Never start exactly one session")
    expect(notices.SKILL_CONTENT).toContain("Never hand the checking to another session")
    // The split line reads the same wherever it is asked for: the skill, the brief and the root's pointer.
    expect(notices.SKILL_CONTENT).toContain(notices.SPLIT_LINE)
    expect(notices.SKILL_CONTENT).toContain("bun run <script>")
    expect(notices.childBrief("ses_parent", "Fix the bug", 1, limits)).toContain(notices.SPLIT_LINE)
    expect(notices.childBrief("ses_parent", "Fix the bug", 3, limits)).not.toContain("split:")
    expect(notices.rolePart(null, limits)).toContain(notices.SPLIT_LINE)
    expect(notices.rolePart(null, limits)).toContain(notices.SKILL_ID)
  })
  test("refusals", () => {
    expect(notices.depthRefusal(3, 3)).toMatchSnapshot()
    expect(notices.childrenRefusal(5, 5)).toMatchSnapshot()
    expect(notices.childrenRefusal(1, 1)).toMatchSnapshot()
    expect(notices.totalRefusal(20, 20)).toMatchSnapshot()
  })
  test("envelope", () => {
    expect(notices.envelope("ses_child", "done")).toMatchSnapshot()
    expect(notices.envelope("ses_child", "failed", { failed: "provider.auth", request: "per_1" })).toMatchSnapshot()
    expect(notices.envelope("ses_child", "Fixed it.", { status: "done" })).toMatchSnapshot()
  })
  test("STATUSES", () => expect(notices.STATUSES).toEqual(["done", "partial", "blocked", "failed"]))
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
    expect(notices.reportBody("Fixed the total in checkout.", artifacts)).toMatchSnapshot()
    expect(notices.reportBody("Fixed it.", { branch: "fix/checkout" })).toMatchSnapshot()
    expect(notices.reportBody("Fixed it.", undefined)).toBe("Fixed it.")
    expect(notices.reportBody("Fixed it.", {})).toBe("Fixed it.")
    expect(notices.reportBody("Fixed it.", { branch: "  ", commits: [], files: [], checks: [] })).toBe("Fixed it.")
    // OpenCode does not check the schema: what is not a list of strings, or a check without a command, is left out.
    expect(
      notices.reportBody("Fixed it.", { commits: ["abc", 7, " def "], files: "src/a.ts", checks: [{ command: "bun test" }, { result: "?" }, "lint"] } as never),
    ).toBe("Fixed it.\n\nArtifacts:\n- commits: abc, def\n- checks:\n  - bun test: (no result given)")
  })
})

describe("tool results", () => {
  test("spawnText", () => {
    expect(notices.spawnText({ sessionID: "ses_child", directory: "/repo" })).toMatchSnapshot()
    expect(notices.spawnText({ sessionID: "ses_child", directory: "/wt", rosterError: "roster failed: disk full" })).toMatchSnapshot()
    expect(notices.spawnText({ sessionID: "ses_child", directory: "/repo", group: "reviews" })).toMatchSnapshot()
    expect(notices.spawnText({ sessionID: "ses_child", directory: "/repo", groupError: "group failed: disk full" })).toMatchSnapshot()
  })
  test("spawnText for a child started from its parent's HEAD", () => {
    expect(notices.spawnText({ sessionID: "ses_child", directory: "/wt", fromParent: true })).toMatchSnapshot()
    expect(notices.spawnText({ sessionID: "ses_child", directory: "/wt", fromParent: true, uncommitted: true })).toMatchSnapshot()
  })
  test("sendText", () => {
    expect(notices.sendText("ses_parent")).toMatchSnapshot()
    expect(notices.sendText("ses_parent", { report: true, status: "done" })).toMatchSnapshot()
    expect(notices.sendText("ses_parent", { report: true })).toMatchSnapshot()
    expect(notices.sendText("ses_parent", { report: false })).toMatchSnapshot()
    expect(notices.sendText("ses_other", { status: "done" })).toMatchSnapshot()
    expect(notices.sendText("ses_parent", { report: true, status: "done", held: { group: "reviews", reported: 1, members: 3 } })).toMatchSnapshot()
    expect(notices.sendText("ses_parent", { report: true, status: "failed", held: { group: "reviews", reported: 3, members: 3 } })).toMatchSnapshot()
    expect(notices.sendText("ses_parent", { report: true, status: "done", held: { group: "reviews" } })).toMatchSnapshot()
  })
  test("statusText", () => expect(notices.statusText({ sessionID: "ses_child", title: "Fix", idle: 3 })).toMatchSnapshot())
  test("childrenText", () => {
    expect(notices.childrenText([])).toMatchSnapshot()
    expect(notices.childrenText([{ sessionID: "ses_child", isolated: false }])).toMatchSnapshot()
  })
  test("treeText", () => {
    expect(notices.treeText({ sessions: [] })).toMatchSnapshot()
    expect(notices.treeText({ sessions: [{ sessionID: "ses_child", depth: 1 }] })).toMatchSnapshot()
    expect(notices.treeText({ sessions: [{ sessionID: "ses_child", depth: 1 }], truncated: 20 })).toMatchSnapshot()
  })
  test("stopText", () => {
    const stopped = [
      { sessionID: "ses_leaf", outcome: "interrupted" },
      { sessionID: "ses_mid", outcome: "idle" },
      { sessionID: "ses_odd", outcome: "failed", error: "session.interrupt failed: boom" },
    ]
    expect(notices.stopText({ sessionID: "ses_mid", stopped, cancelled: [] })).toMatchSnapshot()
    expect(notices.stopText({ sessionID: "ses_mid", stopped, cancelled: ["later_1", "later_2"], told: "ses_top" })).toMatchSnapshot()
    expect(
      notices.stopText({
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
    expect(notices.stopText({ sessionID: "ses_mid", stopped, cancelled: [], cleanup: [] })).toMatchSnapshot()
  })
  test("stoppedNotice", () => expect(notices.stoppedNotice("Review a.ts", "ses_root")).toMatchSnapshot())
  test("cleanupText", () => {
    expect(notices.cleanupText({ sessionID: "ses_child", directory: "/wt", outcome: "removed" })).toMatchSnapshot()
    expect(notices.cleanupText({ sessionID: "ses_child", directory: "/wt", outcome: "gone" })).toMatchSnapshot()
    expect(notices.cleanupText({ sessionID: "ses_child", directory: "/wt", outcome: "kept", reason: "1 uncommitted change (a.ts)", changes: ["a.ts"], commits: [] })).toMatchSnapshot()
  })
  test("keepReason", () => {
    expect(notices.keepReason({ changes: [], commits: [] })).toBeUndefined()
    expect(notices.keepReason({ changes: ["a.ts"], commits: [] })).toMatchSnapshot()
    expect(notices.keepReason({ changes: ["a", "b", "c", "d", "e", "f"], commits: ["abc1234", "def5678"] })).toMatchSnapshot()
  })
  test("answerText", () => {
    const base = { sessionID: "ses_child", requestID: "per_1" }
    expect(notices.answerText({ ...base, reply: "once" as const, answered: false })).toMatchSnapshot()
    expect(notices.answerText({ ...base, reply: "always" as const, answered: true })).toMatchSnapshot()
    const question = { sessionID: "ses_child", requestID: "question_1" }
    expect(notices.answerText({ ...question, answered: false })).toMatchSnapshot()
    expect(notices.answerText({ ...question, answered: true, by: "result", answers: [["Hi"]] })).toMatchSnapshot()
    expect(notices.answerText({ ...question, answered: true, by: "message", answers: [["Hi"]] })).toMatchSnapshot()
  })
  test("laterText", () => {
    const entry = { id: "later_1", sessionID: "ses_parent" }
    expect(notices.laterText(entry, "2026-10-07T12:00:00.000Z", true)).toMatchSnapshot()
    expect(notices.laterText(entry, "2026-10-07T12:00:00.000Z", false)).toMatchSnapshot()
  })
  test("cancelText", () => {
    expect(notices.cancelText("later_1", true)).toMatchSnapshot()
    expect(notices.cancelText("later_1", false)).toMatchSnapshot()
  })
  test("subscribeText", () => {
    expect(notices.subscribeText("ses_parent", "github:octo/repo#5", true)).toMatchSnapshot()
    expect(notices.subscribeText("ses_parent", "github:octo/repo#5", false)).toMatchSnapshot()
  })
  test("unsubscribeText", () => {
    expect(notices.unsubscribeText("ses_parent", ["github:octo/repo", "deploys"])).toMatchSnapshot()
    expect(notices.unsubscribeText("ses_parent", [])).toMatchSnapshot()
  })
})

describe("turn failures", () => {
  test("failureNotice", () => {
    expect(notices.failureNotice("Fix the bug", { type: "provider.auth", message: "blocked", status: 403 })).toMatchSnapshot()
    expect(notices.failureNotice("Fix the bug", { type: "unknown", message: "boom" })).toMatchSnapshot()
    expect(notices.failureNotice("Fix the bug", { type: "unknown", message: "boom" }, "reviews")).toMatchSnapshot()
  })
  test("silentNotice", () => {
    expect(notices.silentNotice("Fix the bug", "I looked at src/a.ts; the bug is on line 4.")).toMatchSnapshot()
    expect(notices.silentNotice("Fix the bug", undefined)).toMatchSnapshot()
    expect(notices.silentNotice("Fix the bug", "  \n")).toMatchSnapshot()
    expect(notices.silentNotice("Fix the bug", "Halfway there.", true)).toMatchSnapshot()
    expect(notices.silentNotice("Fix the bug", "Done, I think.", false, "reviews")).toMatchSnapshot()
    const long = notices.silentNotice("Fix the bug", "</courier> " + "x".repeat(2100))
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
    expect(notices.groupNotice("reviews", reports)).toMatchSnapshot()
    expect(
      notices.groupNotice("reviews", reports.slice(0, 1), [
        { sessionID: "ses_d", title: "Review d.ts", by: "failed" },
        { sessionID: "ses_e", title: "Review e.ts", by: "deleted" },
        { sessionID: "ses_f", title: "Review f.ts", by: "interrupted" },
      ]),
    ).toMatchSnapshot()
  })
})

describe("permission requests", () => {
  const request = { id: "per_1", sessionID: "ses_child", action: "shell", resources: ["git push"] }

  test("REJECTED", () => expect(notices.REJECTED).toMatchSnapshot())
  test("origin and STAYS_QUIET", () => {
    expect(notices.origin()).toMatchSnapshot()
    expect(notices.origin("ses_middle")).toMatchSnapshot()
    expect(notices.STAYS_QUIET).toMatchSnapshot()
  })
  test("permissionNotice", () => {
    expect(notices.permissionNotice("Fix the bug", request)).toMatchSnapshot()
    expect(notices.permissionNotice("Fix the bug", { ...request, save: ["*"], message: "Push the fix" }, "ses_middle")).toMatchSnapshot()
    const many = Array.from({ length: 22 }, (_, i) => `file-${i}`)
    expect(notices.permissionNotice("Fix the bug", { ...request, action: "edit", resources: [...many, "x".repeat(400)], save: ["git push*", "git fetch*"] })).toMatchSnapshot()
    expect(notices.permissionNotice("Fix the bug", { ...request, resources: [] })).toMatchSnapshot()
  })
  test("permissionSettledNotice", () => {
    expect(notices.permissionSettledNotice("Fix the bug", "per_1", "once")).toMatchSnapshot()
    expect(notices.permissionSettledNotice("Fix the bug", "per_1", "reject")).toMatchSnapshot()
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
    expect(notices.kindOf(websearch)).toBe("websearch.provider")
    expect(notices.kindOf({ ...websearch, metadata: { kind: "bad kind" } })).toBeUndefined()
  })
  test("formNotice", () => {
    expect(notices.formNotice("Fix the bug", websearch)).toMatchSnapshot()
    const fields = [
      { key: "login", type: "external", title: "Sign in", url: "https://example.com/login" },
      { key: "name", type: "string" },
      { key: "depth", type: "number", description: "How deep", when: [{ key: "name" }] },
      { key: "pick", type: "select", options: Array.from({ length: 22 }, (_, i) => ({ value: `${i}`, label: `Option ${i}` })) },
      ...Array.from({ length: 20 }, (_, i) => ({ key: `extra${i}`, type: "boolean" })),
    ]
    expect(notices.formNotice("Fix the bug", { id: "frm_2", sessionID: "ses_child", title: "Settings", fields }, "ses_middle")).toMatchSnapshot()
  })
  test("formSettledNotice", () => {
    expect(notices.formSettledNotice("Fix the bug", "frm_1", "answered")).toMatchSnapshot()
    expect(notices.formSettledNotice("Fix the bug", "frm_1", "cancelled")).toMatchSnapshot()
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
    expect(notices.answeredText(prompts, answers)).toMatchSnapshot()
    expect(notices.answeredText(prompts, [["Hi"]])).toMatchSnapshot()
  })
  test("questionNotice", () => {
    expect(notices.questionNotice(asked)).toMatchSnapshot()
    expect(notices.questionNotice({ ...asked, startedBy: "ses_middle" }, "stopped")).toMatchSnapshot()
    expect(notices.questionNotice(asked, "restarted")).toMatchSnapshot()
  })
  test("questionSettledNotice", () => {
    expect(notices.questionSettledNotice(asked, { by: "child", answers })).toMatchSnapshot()
    expect(notices.questionSettledNotice(asked, { by: "dismissed" })).toMatchSnapshot()
    expect(notices.questionSettledNotice(asked, { by: "failed", error: "Error: boom" })).toMatchSnapshot()
  })
  test("DISMISSED", () => expect(notices.DISMISSED).toMatchSnapshot())
  test("cutOffAnswer", () => {
    expect(notices.cutOffAnswer(asked, { answers })).toMatchSnapshot()
    expect(notices.cutOffAnswer(asked, { dismissed: true })).toMatchSnapshot()
  })
  test("unlinkedNote", () => {
    expect(notices.unlinkedNote([asked, { sessionID: "ses_other", requestID: "question_2" }])).toMatchSnapshot()
  })
  test("withdrawnText", () => {
    expect(notices.withdrawnText(asked, { by: "top", outcome: { answers } })).toMatchSnapshot()
    expect(notices.withdrawnText(asked, { by: "top", outcome: { dismissed: true } })).toMatchSnapshot()
    expect(notices.withdrawnText(asked, { by: "child", answers })).toMatchSnapshot()
    expect(notices.withdrawnText(asked, { by: "dismissed" })).toMatchSnapshot()
    expect(notices.withdrawnText(asked, { by: "failed", error: "Error: boom" })).toMatchSnapshot()
  })
  test("passedNote", () => {
    expect(notices.passedNote(asked, "result")).toMatchSnapshot()
    expect(notices.passedNote(asked, "message")).toMatchSnapshot()
    expect(notices.passedNote(asked, undefined)).toMatchSnapshot()
    expect(notices.passedNote(asked, "error: storage is down")).toMatchSnapshot()
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
    expect(notices.hookSummary("  deployed  ")).toMatchSnapshot()
    expect(notices.hookSummary("   ")).toMatchSnapshot()
  })
  test("clipText", () => {
    expect(notices.clipText("short")).toBe("short")
    expect(notices.clipText("abcdef", 3)).toMatchSnapshot()
  })
  test("webhookText", () => {
    expect(notices.webhookText("deployed <courier from=x>")).toMatchSnapshot()
  })
})
