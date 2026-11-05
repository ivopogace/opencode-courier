import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// e2e/real-model-review.mjs on fixture transcripts, read back with --saved: the change, the review session that
// changes nothing, the fix, the root's own test run and its reply (COURIER_SCENARIO=review).
const CHECKER = join(import.meta.dir, "..", "e2e", "real-model-review.mjs")
const FILES = {
  "lib/words.js": "export function capitalize(word) { return word }\nexport function slugify(text) { return text }",
  "test/words.test.js": "// five tests",
}

type Message = Record<string, unknown>
let clock = Date.UTC(2026, 10, 5, 10, 0, 0)
const tick = () => (clock += 1000)
const user = (text: string): Message => ({ type: "user", text, time: { created: tick() } })
const idle = (): Message => ({ type: "idle", time: { created: tick() } })
const step = (finish: "tool-calls" | "stop", ...content: unknown[]): Message => {
  const created = tick()
  return { type: "assistant", finish, content, time: { created, completed: tick() } }
}
const say = (text: string) => ({ type: "text", text })
const tool = (name: string, input: unknown, metadata: unknown = {}) => ({ type: "tool", name, state: { status: "completed", input, metadata, content: [] } })
const spawn = (sessionID: string, input: Record<string, unknown> = {}) => tool("courier_spawn", { task: `the ${sessionID} task`, ...input }, { sessionID })
const send = (sessionID: string, message: string, status?: string) => tool("courier_send", { sessionID, message, ...(status ? { status } : {}) })
const shell = (command: string) => tool("shell", { command })
const report = (from: string, status: string, text: string): Message => ({ type: "synthetic", text: `<courier from="${from}" status="${status}">\n${text}\n</courier>`, time: { created: tick() } })

type Variant = "clean" | "fixed" | "review-edits" | "no-review" | "root-skips-tests" | "root-polls"

/** The transcripts: the root starts the implementer, then the reviewer, then (fixed) a fixer, runs the tests and replies. */
function transcripts(variant: Variant): Record<string, Message[]> {
  const impl = [user("make the change"), step("tool-calls", tool("skill", { id: "test-driven-development" }), tool("write", { path: "lib/words.js" }), tool("edit", { path: "test/words.test.js" }), shell("npm test"), shell("git commit -am slugify"), send("ses_root", "Added slugify with three tests; npm test passes 5.", "done")), step("stop", say("Reported.")), idle()]
  const reviewerTools = [tool("read", { path: "lib/words.js" }), shell("git diff HEAD~1 -- lib test"), shell("npm test 2>&1 | tail -5")]
  if (variant === "review-edits") reviewerTools.push(tool("edit", { path: "lib/words.js" }))
  const finding = variant === "fixed" ? "One finding: slugify keeps a trailing hyphen for input ending in two punctuation marks." : "No findings: the change meets the job."
  const reviewer = [user("review the change"), step("tool-calls", ...reviewerTools, send("ses_root", finding, "done")), step("stop", say("Reported.")), idle()]
  const fixer = [user("fix the finding"), step("tool-calls", tool("edit", { path: "lib/words.js" }), shell("npm test"), send("ses_root", "Fixed the trailing hyphen; 5 tests pass.", "done")), step("stop", say("Reported.")), idle()]
  const root: Message[] = [user("the job"), step("tool-calls", tool("skill", { id: "courier-orchestrate" }), tool("courier_recall", {}), spawn("ses_impl", { agent: "implementer", title: "the change" }), ...(variant === "root-polls" ? [tool("courier_children", {})] : [])), step("stop", say("split: 1 part: the change, then its review.")), idle()]
  root.push(report("ses_impl", "done", "Added slugify with three tests; npm test passes 5."))
  if (variant === "no-review") {
    root.push(step("tool-calls", shell("npm test")), step("stop", say("REVIEWED 5")), idle())
    return { ses_root: root, ses_impl: impl }
  }
  root.push(step("tool-calls", spawn("ses_review", { agent: "reviewer" })), step("stop", say("Review started.")), idle())
  root.push(report("ses_review", "done", finding))
  const tree: Record<string, Message[]> = { ses_root: root, ses_impl: impl, ses_review: reviewer }
  if (variant === "fixed") {
    root.push(step("tool-calls", spawn("ses_fix", { agent: "implementer" })), step("stop", say("Fix started.")), idle())
    root.push(report("ses_fix", "done", "Fixed the trailing hyphen; 5 tests pass."))
    tree.ses_fix = fixer
  }
  root.push(step("tool-calls", ...(variant === "root-skips-tests" ? [tool("read", { path: "lib/words.js" })] : [shell("npm test")])), step("stop", say("REVIEWED 5")), idle())
  return tree
}

type Options = { pass?: number; exit?: number }

/** Runs the checker with --saved on a run directory holding `variant`'s transcripts, the files and a stand-in test runner; the exit code and the summary. */
function check(variant: Variant, { pass = 5, exit = 0 }: Options = {}) {
  const work = mkdtempSync(join(tmpdir(), "rmv-"))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("COURIER_")))
  try {
    for (const [id, list] of Object.entries(transcripts(variant))) writeFileSync(join(work, id === "ses_root" ? "parent.json" : `child-${id}.json`), JSON.stringify(list))
    for (const [file, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(work, "project", file)), { recursive: true })
      writeFileSync(join(work, "project", file), `${text}\n`)
    }
    // The stand-in for the project's test runner: TAP totals and an exit code, run by the checker in the project.
    writeFileSync(join(work, "project", "tests.js"), `console.log("# pass ${pass}\\n# fail ${exit === 0 ? 0 : 1}"); process.exit(${exit})`)
    const run = Bun.spawnSync([process.execPath, CHECKER, "ses_root", "--saved"], {
      env: { ...env, WORK: work, COURIER_EXPECT: "slugify", COURIER_FILES: Object.keys(FILES).join(" "), COURIER_TESTS: "5", COURIER_TEST_COMMAND: "bun tests.js" },
    })
    if (run.exitCode !== 0 && run.exitCode !== 1) throw new Error(`the checker exited ${run.exitCode}: ${run.stderr.toString()}`)
    const summary = JSON.parse(readFileSync(join(work, "summary.json"), "utf8")) as { verdict: string; checks: Record<string, boolean>; notes: string[]; tests: { command: string; exit: number; pass?: number; fail?: number } }
    return { exitCode: run.exitCode, ...summary, failed: Object.entries(summary.checks).flatMap(([name, ok]) => (ok ? [] : [name])) }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

describe("the review checker", () => {
  test("a change, a review that found nothing, the root's own test run and its reply pass every check", () => {
    const run = check("clean")
    expect(run.failed).toEqual([])
    expect(run.exitCode).toBe(0)
    expect(Object.keys(run.checks)).toHaveLength(10)
    expect(run.tests).toEqual({ command: "bun tests.js", exit: 0, pass: 5, fail: 0 })
    expect(run.notes).toContain("the root started ses_impl in turn 1 for the change: agent implementer, titled \"the change\"")
    expect(run.notes).toContain("the root started ses_review in turn 2 for the review: agent reviewer")
    expect(run.notes).toContain("after the review, the root changed nothing and started no session")
    expect(run.notes.some((note) => note.startsWith("the change: ses_impl made 3 changing call(s) and committed 1 time(s)"))).toBe(true)
    expect(run.notes.some((note) => note.startsWith("the review: ses_review made 1 read call(s) and 2 shell call(s)"))).toBe(true)
  })

  test("a finding fixed by a session the root started after the review passes, and is noted", () => {
    const run = check("fixed")
    expect(run.failed).toEqual([])
    expect(run.notes).toContain("after the review, the root started 1 session(s): ses_fix (agent implementer)")
    expect(run.notes).toContain("the root started ses_fix in turn 3 for after the review: agent implementer")
  })

  test("a review session that edited a file fails the review check, and the note names the call", () => {
    const run = check("review-edits")
    expect(run.failed).toEqual(["the review session changed nothing: no file tool, no shell command that writes, commits or installs, and nothing it started did either"])
    expect(run.notes.some((note) => note.startsWith("the review changed the checkout: ses_review edit("))).toBe(true)
  })

  test("a root that ran the tests and replied without a review session fails the review checks", () => {
    const run = check("no-review")
    expect(run.failed).toEqual([
      "once the change was reported, the root started a review session, in a later turn",
      "the review session changed nothing: no file tool, no shell command that writes, commits or installs, and nothing it started did either",
      "the review session reported to the root with a status, before the root's final reply",
      "the root ran the project's tests itself, after the review had reported",
    ])
  })

  test("a root that did not run the tests after the review fails that check alone", () => {
    const run = check("root-skips-tests")
    expect(run.failed).toEqual(["the root ran the project's tests itself, after the review had reported"])
  })

  test("a look right after spawning is polling", () => {
    const run = check("root-polls")
    expect(run.failed).toEqual(["no orchestrator polled (courier_children, courier_tree, sleep)"])
  })

  test("failing tests, or fewer than asked, fail the tests check and the reply check", () => {
    expect(check("clean", { exit: 1 }).failed).toEqual(["the tests pass in the root's checkout, 5 or more of them"])
    const few = check("clean", { pass: 4 })
    expect(few.failed).toEqual(["the tests pass in the root's checkout, 5 or more of them", "the root's final reply holds REVIEWED and the number of passing tests"])
    expect(few.verdict).toBe("fail")
  })
})
