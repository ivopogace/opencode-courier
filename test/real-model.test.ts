import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CHECKER = join(import.meta.dir, "..", "e2e", "real-model.mjs")
const FIRST_TURN = "the parent ended its first turn after spawning, without waiting for the reports (one steered into it while it ran is delivered)"
const POLL = "the parent did not poll its children (courier_children, courier_tree, sleep)"
const WOKE = "both reports reached the parent, each waking it or steered into its running turn, and got a reply"

type Message = Record<string, unknown>
let clock = Date.UTC(2026, 10, 7, 10, 0, 0)
const tick = () => (clock += 1000)
const user = (text: string): Message => ({ type: "user", text, time: { created: tick() } })
const idle = (): Message => ({ type: "idle", time: { created: tick() } })
const step = (finish: "tool-calls" | "stop", ...content: unknown[]): Message => {
  const created = tick()
  return { type: "assistant", finish, content, time: { created, completed: tick() } }
}
const say = (text: string) => ({ type: "text", text })
const tool = (name: string, input: unknown, metadata: unknown = {}) => ({ type: "tool", name, state: { status: "completed", input, metadata, content: [] } })
const report = (from: string, text: string): Message => ({ type: "synthetic", text: `<courier from="${from}" status="done">\n${text}\n</courier>`, time: { created: tick() } })
const child = (value: string) => [user("brief"), step("tool-calls", tool("shell", { command: `echo ${value}` }), tool("courier_send", { sessionID: "ses_parent", message: value, status: "done" })), step("stop", say("Reported.")), idle()]

type Shape = "apart" | "steered" | "steered-look" | "look-first"

function parentOf(shape: Shape): Message[] {
  const spawns = step("tool-calls", tool("courier_spawn", { task: "a" }, { sessionID: "ses_a" }), tool("courier_spawn", { task: "b" }, { sessionID: "ses_b" }))
  const look = step("tool-calls", tool("courier_children", {}))
  if (shape === "apart")
    return [user("fan out"), spawns, step("stop", say("Both started.")), idle(), report("ses_a", "391"), step("stop", say("a is in.")), idle(), report("ses_b", "1024"), step("stop", say("RESULTS 391 1024")), idle()]
  return [
    user("fan out"),
    spawns,
    ...(shape === "look-first" ? [look] : []),
    report("ses_a", "391"),
    ...(shape === "steered-look" ? [look] : []),
    step("stop", say("a is in; b still runs.")),
    idle(),
    report("ses_b", "1024"),
    step("stop", say("RESULTS 391 1024")),
    idle(),
  ]
}

function check(shape: Shape) {
  const work = mkdtempSync(join(tmpdir(), "rmf-"))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("COURIER_")))
  try {
    writeFileSync(join(work, "parent.json"), JSON.stringify(parentOf(shape)))
    writeFileSync(join(work, "child-ses_a.json"), JSON.stringify(child("391")))
    writeFileSync(join(work, "child-ses_b.json"), JSON.stringify(child("1024")))
    const run = Bun.spawnSync([process.execPath, CHECKER, "ses_parent", "--saved"], { env: { ...env, WORK: work, COURIER_EXPECT: "391 1024" } })
    if (run.exitCode !== 0 && run.exitCode !== 1) throw new Error(`the checker exited ${run.exitCode}: ${run.stderr.toString()}`)
    const summary = JSON.parse(readFileSync(join(work, "summary.json"), "utf8")) as { checks: Record<string, boolean>; notes: string[] }
    return { exitCode: run.exitCode, notes: summary.notes, checks: summary.checks, failed: Object.entries(summary.checks).flatMap(([name, ok]) => (ok ? [] : [name])) }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

describe("the fan-out checker and a report that reaches the parent while its first turn runs", () => {
  test("reports that each wake the idle parent pass every check", () => {
    const run = check("apart")
    expect(run.failed).toEqual([])
    expect(run.exitCode).toBe(0)
  })
  test("a report steered into the first turn is delivered: the turn still ended after spawning, and the report got a reply", () => {
    const run = check("steered")
    expect(run.checks[FIRST_TURN]).toBe(true)
    expect(run.checks[WOKE]).toBe(true)
    expect(run.failed).toEqual([])
    expect(run.notes).toContain("1 report(s) reached the parent while its first turn still ran")
  })
  test("one look after the steered report is no poll; one before any report is", () => {
    expect(check("steered-look").failed).toEqual([])
    expect(check("look-first").failed).toEqual([POLL])
  })
})
