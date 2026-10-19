import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// e2e/real-model-recursive.mjs on fixture transcripts, read back with --saved: the recursive tree, and the fault in it
// (COURIER_SCENARIO=recursive-fault), handled or not.
const CHECKER = join(import.meta.dir, "..", "e2e", "real-model-recursive.mjs")
const FILES = { "numbers/a.txt": "391", "numbers/b.txt": "1024", "count/total.txt": "42" }

type Message = Record<string, unknown>
let clock = Date.UTC(2026, 9, 20, 10, 0, 0)
const tick = () => (clock += 1000)
const user = (text: string): Message => ({ type: "user", text, time: { created: tick() } })
const synthetic = (text: string): Message => ({ type: "synthetic", text, time: { created: tick() } })
const idle = (): Message => ({ type: "idle", time: { created: tick() } })
const step = (finish: "tool-calls" | "stop", ...content: unknown[]): Message => {
  const created = tick()
  return { type: "assistant", finish, content, time: { created, completed: tick() } }
}
const say = (text: string) => ({ type: "text", text })
const tool = (name: string, input: unknown, metadata: unknown = {}) => ({ type: "tool", name, state: { status: "completed", input, metadata, content: [] } })
const spawn = (sessionID: string, group: string) => tool("courier_spawn", { task: `the ${sessionID} part`, group }, { sessionID })
const send = (sessionID: string, message: string, status?: string) => tool("courier_send", { sessionID, message, ...(status ? { status } : {}) })
const loadSkill = () => tool("skill", { id: "courier-orchestrate" })
const write = (path: string) => tool("write", { path })
const report = (from: string, status: string, text: string) => synthetic(`<courier from="${from}" status="${status}">\n${text}\n</courier>`)
const released = (group: string, reports: ReadonlyArray<readonly [string, string]>) =>
  synthetic(
    [
      `<courier from="${reports.map(([id]) => id).join(",")}" group="${group}">`,
      `Group "${group}" is complete: ${reports.length} reports of ${reports.length} members. Each report follows, with its status.`,
      ...reports.flatMap(([id, status], index) => ["", `[${index + 1}/${reports.length}] ${id} "${id}": ${status}`, `${id} ${status}`]),
      "</courier>",
    ].join("\n"),
  )

type Variant = "handled" | "reports-early" | "does-it-itself" | "no-fault"

/** The tree's transcripts: the root splits into numbers and count, numbers into halves a and b, and b is the faulty half. */
function transcripts(variant: Variant): Record<string, Message[]> {
  const count = [user("count"), step("tool-calls", tool("shell", { command: "echo 42" }), write("count/total.txt"), send("ses_root", "42", "done")), step("stop", say("Reported.")), idle()]
  const a = [user("half a"), step("tool-calls", tool("shell", { command: "echo 391" }), write("numbers/a.txt"), send("ses_num", "391", "done")), step("stop", say("Reported.")), idle()]
  const bFirst = variant === "no-fault" ? [write("numbers/b.txt"), send("ses_num", "1024", "done")] : [send("ses_num", "1024; writing numbers/b.txt is left", "partial")]
  const b = [user("half b"), step("tool-calls", tool("shell", { command: "echo 1024" }), ...bFirst), step("stop", say("Reported.")), idle()]
  const nudged = variant === "handled" || variant === "reports-early"
  if (nudged)
    b.push(synthetic('<courier from="ses_num">\nFinish: write numbers/b.txt and report done.\n</courier>'), step("tool-calls", write("numbers/b.txt"), send("ses_num", "Wrote numbers/b.txt.", "done")), step("stop", say("Done.")), idle())
  const num = [user("numbers"), step("tool-calls", spawn("ses_a", "halves"), spawn("ses_b", "halves")), step("stop", say("split: 2 halves")), idle()]
  num.push(released("halves", [["ses_a", "done"], ["ses_b", variant === "no-fault" ? "done" : "partial"]]))
  const upward: Array<"partial" | "done"> = []
  if (variant === "handled") num.push(step("tool-calls", send("ses_b", "Finish: write numbers/b.txt and report done.")), step("stop", say("Waiting for b.")), idle())
  if (variant === "reports-early") {
    num.push(step("tool-calls", send("ses_b", "Finish: write numbers/b.txt and report done."), send("ses_root", "b is not written yet", "partial")), step("stop", say("Reported.")), idle())
    upward.push("partial")
  }
  if (variant === "does-it-itself" || variant === "no-fault") {
    num.push(step("tool-calls", ...(variant === "does-it-itself" ? [write("numbers/b.txt")] : []), send("ses_root", "391 and 1024", "done")), step("stop", say("Reported.")), idle())
    upward.push("done")
  }
  if (nudged) {
    num.push(report("ses_b", "done", "Wrote numbers/b.txt."), step("tool-calls", tool("read", { path: "numbers/b.txt" }), send("ses_root", "391 and 1024", "done")), step("stop", say("Reported.")), idle())
    upward.push("done")
  }
  const root = [user("the job"), step("tool-calls", loadSkill(), spawn("ses_num", "parts"), spawn("ses_count", "parts")), step("stop", say("split: 2 parts | numbers, count")), idle()]
  root.push(released("parts", [["ses_num", upward[0]!], ["ses_count", "done"]]))
  for (const status of upward.slice(1)) root.push(report("ses_num", status, "391 and 1024"))
  root.push(step("tool-calls", tool("read", { path: "numbers/a.txt" })), step("stop", say("RESULTS 391 1024 42")), idle())
  return { ses_root: root, ses_num: num, ses_a: a, ses_b: b, ses_count: count }
}

/** Runs the checker with --saved on a run directory holding `variant`'s transcripts and files, once per list of flags; the last run's exit code and summary. */
function check(variant: Variant, ...runs: string[][]) {
  const work = mkdtempSync(join(tmpdir(), "rmr-"))
  // The checker reads COURIER_* from its environment: none of the caller's, such as an exported COURIER_MAX_DEPTH.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("COURIER_")))
  try {
    for (const [id, list] of Object.entries(transcripts(variant))) writeFileSync(join(work, id === "ses_root" ? "parent.json" : `child-${id}.json`), JSON.stringify(list))
    for (const [file, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(work, "project", file)), { recursive: true })
      writeFileSync(join(work, "project", file), `${text}\n`)
    }
    let exitCode: number | null = null
    for (const flags of runs.length ? runs : [[]]) {
      const run = Bun.spawnSync([process.execPath, CHECKER, "ses_root", "--saved", ...flags], {
        env: { ...env, WORK: work, COURIER_EXPECT: "391 1024 42", COURIER_FILES: Object.keys(FILES).join(" ") },
      })
      if (run.exitCode !== 0 && run.exitCode !== 1) throw new Error(`the checker exited ${run.exitCode}: ${run.stderr.toString()}`)
      exitCode = run.exitCode
    }
    const summary = JSON.parse(readFileSync(join(work, "summary.json"), "utf8")) as { verdict: string; fault: boolean; checks: Record<string, boolean>; notes: string[] }
    return { exitCode, ...summary, failed: Object.entries(summary.checks).flatMap(([name, ok]) => (ok ? [] : [name])) }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

describe("the recursive checker with --fault", () => {
  test("a fault handled by a message to the leaf, then one done report upward, passes every check", () => {
    const run = check("handled", ["--fault"])
    expect(run.failed).toEqual([])
    expect(Object.keys(run.checks)).toHaveLength(13)
    expect(run.exitCode).toBe(0)
    expect(run.notes).toContain("the root orchestrated with courier-orchestrate loaded before its first spawn")
    expect(run.notes).toContain("session ses_num (depth 1) orchestrated without courier-orchestrate loaded")
    expect(run.notes).toContain("fault: session ses_b (depth 2) reported partial, then done")
    expect(run.notes).toContain(
      "fault: its parent ses_num had not loaded courier-orchestrate when the partial report reached it, and messaged it: Finish: write numbers/b.txt and report done.",
    )
    expect(run.notes).toContain("fault: its parent reported upward done")
  })

  test("a sub-orchestrator that messages the leaf and reports upward in one step fails the checks on its report upward", () => {
    const run = check("reports-early", ["--fault"])
    expect(run.failed).toEqual([
      "each sub-orchestrator reported upward once, after its own children had reported to it",
      "its parent reported upward once, after that done report, with status done",
    ])
    expect(run.notes).toContain("fault: its parent reported upward partial, then done")
    expect(run.notes.some((note) => note.endsWith("and messaged it: Finish: write numbers/b.txt and report done."))).toBe(true)
    expect(run.exitCode).toBe(1)
  })

  test("a sub-orchestrator that does the half itself sends no message, and the leaf never reports done", () => {
    const run = check("does-it-itself", ["--fault"])
    expect(run.failed).toEqual([
      "its parent messaged it with courier_send after that report and before reporting upward",
      "it then reported done",
      "its parent reported upward once, after that done report, with status done",
    ])
    expect(run.notes.some((note) => note.endsWith("and did not message it between that report and its own upward"))).toBe(true)
  })

  test("a fault that never reached a leaf fails the first fault check and the rest with it", () => {
    const run = check("no-fault", ["--fault"])
    expect(run.failed).toEqual([
      "the fault reached a leaf: a session below a sub-orchestrator first reported a status other than done",
      "its parent messaged it with courier_send after that report and before reporting upward",
      "it then reported done",
      "its parent reported upward once, after that done report, with status done",
    ])
    expect(run.notes).toContain("fault: every session below a sub-orchestrator first reported done; the fault did not reach a leaf")
  })
})

test("without --fault the recursive checker makes its nine checks only", () => {
  for (const variant of ["no-fault", "handled"] as const) {
    const run = check(variant)
    expect(run.failed).toEqual([])
    expect(Object.keys(run.checks)).toHaveLength(9)
    expect(run.notes.some((note) => note.startsWith("fault:"))).toBe(false)
  }
})

test("a re-read with --saved keeps the fault checks of a run made with --fault, which summary.json records", () => {
  const run = check("does-it-itself", ["--fault"], [])
  expect(run.fault).toBe(true)
  expect(Object.keys(run.checks)).toHaveLength(13)
  expect(run.failed).toContain("it then reported done")
})
