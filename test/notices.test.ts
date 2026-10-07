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
  test("are the ten courier tools, each a direct tool", () => {
    expect(registered.map((tool) => [tool.name, tool.options])).toMatchSnapshot()
  })

  for (const tool of registered)
    test(tool.name, () => {
      expect({ description: tool.description, input: Schema.toJsonSchemaDocument(tool.input).schema }).toMatchSnapshot()
    })
})

describe("envelope and child brief", () => {
  test("END_TURN", () => expect(notices.END_TURN).toMatchSnapshot())
  test("childBrief", () => expect(notices.childBrief("ses_parent", "Fix the bug\nin src/a.ts")).toMatchSnapshot())
  test("envelope", () => {
    expect(notices.envelope("ses_child", "done")).toMatchSnapshot()
    expect(notices.envelope("ses_child", "failed", { failed: "provider.auth", request: "per_1" })).toMatchSnapshot()
  })
})

describe("tool results", () => {
  test("spawnText", () => {
    expect(notices.spawnText({ sessionID: "ses_child", directory: "/repo" })).toMatchSnapshot()
    expect(notices.spawnText({ sessionID: "ses_child", directory: "/wt", rosterError: "roster failed: disk full" })).toMatchSnapshot()
  })
  test("sendText", () => expect(notices.sendText("ses_parent")).toMatchSnapshot())
  test("statusText", () => expect(notices.statusText({ sessionID: "ses_child", title: "Fix", idle: 3 })).toMatchSnapshot())
  test("childrenText", () => {
    expect(notices.childrenText([])).toMatchSnapshot()
    expect(notices.childrenText([{ sessionID: "ses_child", isolated: false }])).toMatchSnapshot()
  })
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
