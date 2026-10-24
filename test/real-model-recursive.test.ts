import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// e2e/real-model-recursive.mjs on fixture transcripts, read back with --saved: the recursive tree, the fault in it
// (COURIER_SCENARIO=recursive-fault), handled or not, the staged core (COURIER_SCENARIO=recursive-staged) and the
// finding passed on (COURIER_SCENARIO=recursive-finding).
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

type Run = { tree: Record<string, Message[]>; files: Record<string, string>; config?: unknown; expect?: string }

/** Runs the checker with --saved on a run directory holding `variant`'s transcripts and files, once per list of flags; the last run's exit code and summary. */
function check(variant: Variant | Run, ...runs: string[][]) {
  const { tree, files, config, expect: expected } = typeof variant === "string" ? { tree: transcripts(variant), files: FILES, config: undefined, expect: undefined } : variant
  const work = mkdtempSync(join(tmpdir(), "rmr-"))
  // The checker reads COURIER_* from its environment: none of the caller's, such as an exported COURIER_MAX_DEPTH.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("COURIER_")))
  try {
    for (const [id, list] of Object.entries(tree)) writeFileSync(join(work, id === "ses_root" ? "parent.json" : `child-${id}.json`), JSON.stringify(list))
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(work, "project", file)), { recursive: true })
      writeFileSync(join(work, "project", file), `${text}\n`)
    }
    if (config) writeFileSync(join(work, "project", "opencode.json"), JSON.stringify(config))
    let exitCode: number | null = null
    for (const flags of runs.length ? runs : [[]]) {
      const run = Bun.spawnSync([process.execPath, CHECKER, "ses_root", "--saved", ...flags], {
        env: { ...env, WORK: work, COURIER_EXPECT: expected ?? Object.values(files).join(" "), COURIER_FILES: Object.keys(files).join(" ") },
      })
      if (run.exitCode !== 0 && run.exitCode !== 1) throw new Error(`the checker exited ${run.exitCode}: ${run.stderr.toString()}`)
      exitCode = run.exitCode
    }
    const summary = JSON.parse(readFileSync(join(work, "summary.json"), "utf8")) as { verdict: string; fault: boolean; staged: boolean; finding: boolean; checks: Record<string, boolean>; notes: string[] }
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

// The staged tree (COURIER_SCENARIO=recursive-staged), on a clock of seconds: the root splits into numbers and count, and
// numbers writes numbers/seed.txt, itself or in session ses_core, and starts the halves ses_a and ses_b.
const STAGED_FILES = { "numbers/seed.txt": "427", "numbers/a.txt": "7259", "numbers/b.txt": "1427", "count/total.txt": "42" }
const START = Date.UTC(2026, 9, 21, 10, 0, 0)
const at = (second: number) => START + second * 1000
const timed = (part: object, from: number, to: number) => ({ ...part, time: { created: at(from), completed: at(to) } })
const userAt = (second: number, text: string): Message => ({ type: "user", text, time: { created: at(second) } })
const syntheticAt = (second: number, text: string): Message => ({ type: "synthetic", text, time: { created: at(second) } })
const idleAt = (second: number): Message => ({ type: "idle", time: { created: at(second) } })
const stepAt = (from: number, to: number, finish: "tool-calls" | "stop", ...content: unknown[]): Message => ({ type: "assistant", finish, content, time: { created: at(from), completed: at(to) } })
const reportAt = (second: number, from: string, status: string) => ({ ...report(from, status, `${from} ${status}`), time: { created: at(second) } })
const releasedAt = (second: number, group: string, reports: ReadonlyArray<readonly [string, string]>) => ({ ...released(group, reports), time: { created: at(second) } })
const spawnOf = (sessionID: string, group?: string) => tool("courier_spawn", { task: `the ${sessionID} part`, ...(group ? { group } : {}) }, { sessionID })
const refusedSkill = () => ({ type: "tool", name: "skill", state: { status: "error", input: { id: "courier-orchestrate" }, error: "Unable to load skill courier-orchestrate" } })
const SEED = "sleep 20; echo $((7 * 61))"
const DENY = { permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "skill", resource: "courier-orchestrate", effect: "deny" }] }

type Staging = "itself" | "core-session" | "half-before-seed" | "half-before-report" | "skill-denied" | "one-session" | "partial-upward"

/** A half: reads the seed, writes its file, reports done to numbers. */
const half = (file: string, from: number) => [
  userAt(from, `the half for ${file}`),
  stepAt(from + 1, from + 4, "tool-calls", timed(tool("shell", { command: "cat numbers/seed.txt" }), from + 1, from + 2), timed(write(file), from + 2, from + 3), timed(send("ses_num", "written", "done"), from + 3, from + 4)),
  stepAt(from + 4, from + 5, "stop", say("Reported.")),
  idleAt(from + 5),
]

/** The core's session: runs the seed's command, writes the seed (and, alone, both halves' files too) and reports done. */
function coreOf(staging: Staging): Message[] {
  const seed = [timed(tool("shell", { command: SEED }), 6, 26), timed(write("numbers/seed.txt"), 26, 27)]
  const steps =
    staging === "one-session"
      ? [stepAt(6, 30, "tool-calls", ...seed, timed(write("numbers/a.txt"), 27, 28), timed(write("numbers/b.txt"), 28, 29), timed(send("ses_num", "all three", "done"), 29, 30))]
      : staging === "half-before-report"
        ? [stepAt(6, 27, "tool-calls", ...seed), stepAt(27, 45, "tool-calls", timed(tool("read", { path: "numbers/seed.txt" }), 27, 28), timed(send("ses_num", "427", "done"), 44, 45))]
        : [stepAt(6, 28, "tool-calls", ...seed, timed(send("ses_num", "427", "done"), 27, 28))]
  const end = ((steps.at(-1)!.time as { completed: number }).completed - START) / 1000
  return [userAt(5, "the seed"), ...steps, stepAt(end, end + 1, "stop", say("Reported.")), idleAt(end + 1)]
}

/** The numbers session up to the halves' group release. */
function numbersOf(staging: Staging): Message[] {
  const opened = userAt(3, "numbers")
  // The seed itself, then both halves in a step of their own.
  if (staging === "itself")
    return [
      opened,
      stepAt(4, 30, "tool-calls", timed(loadSkill(), 4, 5), timed(tool("shell", { command: SEED }), 5, 25), timed(write("numbers/seed.txt"), 25, 26)),
      stepAt(30, 33, "tool-calls", timed(spawnOf("ses_a", "halves"), 30, 31), timed(spawnOf("ses_b", "halves"), 31, 32)),
      stepAt(33, 34, "stop", say("split: the seed myself, then 2 halves")),
      idleAt(34),
    ]
  // The seed's command and both spawns in one step, the spawns made while the command still ran.
  if (staging === "half-before-seed")
    return [
      opened,
      stepAt(4, 30, "tool-calls", timed(tool("shell", { command: `${SEED} > numbers/seed.txt` }), 4, 24), timed(spawnOf("ses_a", "halves"), 4.5, 5), timed(spawnOf("ses_b", "halves"), 5, 5.5)),
      stepAt(30, 31, "stop", say("split: 2 halves")),
      idleAt(31),
    ]
  const first = [
    opened,
    stepAt(
      4,
      6,
      "tool-calls",
      ...(staging === "skill-denied" ? [timed(refusedSkill(), 4, 4.5)] : []),
      timed(spawnOf("ses_core"), 4.5, 5),
      ...(staging === "half-before-report" ? [timed(tool("courier_later", { delay: 30 }), 5, 6)] : []),
    ),
    stepAt(6, 7, "stop", say("split: the seed first, in one session")),
    idleAt(7),
  ]
  if (staging === "one-session") return first
  // A courier_later check-in finds the seed written and starts the halves before the core's session has reported.
  if (staging === "half-before-report")
    return [
      ...first,
      syntheticAt(35, '<courier from="ses_num" scheduled="2026-10-21T10:00:35.000Z">\nCheck on the seed.\n</courier>'),
      stepAt(36, 40, "tool-calls", timed(tool("read", { path: "numbers/seed.txt" }), 36, 37), timed(spawnOf("ses_a", "halves"), 37, 38), timed(spawnOf("ses_b", "halves"), 38, 39)),
      stepAt(40, 41, "stop", say("Halves started.")),
      idleAt(41),
      reportAt(46, "ses_core", "done"),
      stepAt(47, 48, "stop", say("Waiting for the halves.")),
      idleAt(48),
    ]
  return [
    ...first,
    reportAt(30, "ses_core", "done"),
    stepAt(31, 34, "tool-calls", timed(spawnOf("ses_a", "halves"), 31, 32), timed(spawnOf("ses_b", "halves"), 32, 33)),
    stepAt(34, 35, "stop", say("split: 2 halves")),
    idleAt(35),
  ]
}

function stagedRun(staging: Staging): Run {
  const denied = staging === "skill-denied"
  const upward = staging === "partial-upward" ? "partial" : "done"
  const tree: Record<string, Message[]> = {
    ses_root: [
      userAt(0, "the job"),
      stepAt(1, 3, "tool-calls", timed(denied ? refusedSkill() : loadSkill(), 1, 2), timed(spawnOf("ses_num", "parts"), 2, 2.5), timed(spawnOf("ses_count", "parts"), 2.5, 3)),
      stepAt(3, 4, "stop", say("split: 2 parts | numbers, count")),
      idleAt(4),
      releasedAt(200, "parts", [["ses_num", upward], ["ses_count", "done"]]),
      stepAt(201, 202, "tool-calls", timed(tool("read", { path: "numbers/seed.txt" }), 201, 202)),
      stepAt(202, 203, "stop", say("RESULTS 427 7259 1427 42")),
      idleAt(204),
    ],
    ses_count: [
      userAt(3, "count"),
      stepAt(4, 26, "tool-calls", timed(tool("shell", { command: "sleep 20; echo $((99 - 57))" }), 4, 24), timed(write("count/total.txt"), 24, 25), timed(send("ses_root", "42", "done"), 25, 26)),
      stepAt(26, 27, "stop", say("Reported.")),
      idleAt(27),
    ],
    ses_num: numbersOf(staging),
  }
  if (staging !== "itself" && staging !== "half-before-seed") tree.ses_core = coreOf(staging)
  if (staging === "one-session")
    tree.ses_num!.push(reportAt(31, "ses_core", "done"), stepAt(32, 34, "tool-calls", timed(send("ses_root", "427 7259 1427", "done"), 32, 34)), stepAt(34, 35, "stop", say("Reported.")), idleAt(35))
  else {
    tree.ses_num!.push(
      releasedAt(60, "halves", [["ses_a", "done"], ["ses_b", "done"]]),
      stepAt(61, 63, "tool-calls", timed(tool("read", { path: "numbers/a.txt" }), 61, 62), timed(send("ses_root", "427 7259 1427", upward), 62, 63)),
      stepAt(63, 64, "stop", say("Reported.")),
      idleAt(64),
    )
    tree.ses_a = half("numbers/a.txt", 40)
    tree.ses_b = half("numbers/b.txt", 41)
  }
  return { tree, files: STAGED_FILES, ...(denied ? { config: DENY } : {}) }
}

const S1 = "no half started before numbers/seed.txt existed, nor, when the core had a session of its own, before that session's report reached the session that staged"
const S2 = "the session that staged started at least two halves together in one turn, after any session for the core: one session for the core is not one for the whole task"
const S3 = "the session that staged reported upward once, with status done"
const BATCH = "at least one child spawned at least two of its own in one turn, and no sub-orchestrator started exactly one in all without work of its own first"

describe("the recursive checker with --staged", () => {
  test("the core done by the numbers session itself, then both halves in one turn, passes every check", () => {
    const run = check(stagedRun("itself"), ["--staged"])
    expect(run.failed).toEqual([])
    expect(Object.keys(run.checks)).toHaveLength(12)
    expect(run.exitCode).toBe(0)
    expect(run.notes).toContain("staged: numbers/seed.txt first written by session ses_num (depth 1) at 10:00:26.000; halves started at 10:00:30.000, 10:00:31.000")
    expect(run.notes).toContain("staged: session ses_num (depth 1) did the core itself, with courier-orchestrate loaded before the core")
    expect(run.notes.some((note) => note.startsWith("polled:"))).toBe(false)
  })

  test("the core in a session of its own, the halves started once it reported, passes every check", () => {
    const run = check(stagedRun("core-session"), ["--staged"])
    expect(run.failed).toEqual([])
    expect(run.notes).toContain(
      "staged: numbers/seed.txt first written by session ses_core (depth 2) at 10:00:27.000, its report reaching ses_num at 10:00:30.000; halves started at 10:00:31.000, 10:00:32.000",
    )
    expect(run.notes).toContain("staged: session ses_num (depth 1) did the core in session ses_core, without courier-orchestrate loaded")
  })

  test("halves started while the seed's command still ran fail the order check only", () => {
    const run = check(stagedRun("half-before-seed"), ["--staged"])
    expect(run.failed).toEqual([S1])
    expect(run.notes).toContain("staged: numbers/seed.txt first written by session ses_num (depth 1) at 10:00:24.000; halves started at 10:00:04.500, 10:00:05.000")
    expect(run.exitCode).toBe(1)
  })

  test("halves started after the seed was written but before the core's session reported fail the order check only", () => {
    const run = check(stagedRun("half-before-report"), ["--staged"])
    expect(run.failed).toEqual([S1])
    expect(run.notes).toContain(
      "staged: numbers/seed.txt first written by session ses_core (depth 2) at 10:00:27.000, its report reaching ses_num at 10:00:46.000; halves started at 10:00:37.000, 10:00:38.000",
    )
  })

  test("with the skill denied, a tree that stages passes, and the notes say the load was refused", () => {
    const run = check(stagedRun("skill-denied"), ["--staged"])
    expect(run.failed).toEqual([])
    expect(run.notes).toContain("the project's permissions deny the skill courier-orchestrate")
    expect(run.notes).toContain("staged: session ses_num (depth 1) did the core in session ses_core, without courier-orchestrate loaded, its load refused")
    expect(run.notes).toContain("the root orchestrated without courier-orchestrate loaded")
  })

  test("one session for the core and both halves is one session for the whole part", () => {
    const run = check(stagedRun("one-session"), ["--staged"])
    expect(run.failed).toEqual([BATCH, S1, S2])
    expect(run.notes).toContain("staged: numbers/seed.txt first written by session ses_core (depth 2) at 10:00:27.000, its report reaching ses_num at 10:00:31.000; halves started at (none)")
  })

  test("a session that staged and reported partial upward fails the status check only", () => {
    expect(check(stagedRun("partial-upward"), ["--staged"]).failed).toEqual([S3])
  })

  test("a re-read with --saved keeps the staged checks, which summary.json records", () => {
    const run = check(stagedRun("half-before-seed"), ["--staged"], [])
    expect(run.staged).toBe(true)
    expect(Object.keys(run.checks)).toHaveLength(12)
    expect(run.failed).toEqual([S1])
  })
})

test("without --staged the recursive checks keep their rules on a staged tree: a sleep before the split is a look, a first turn of one spawn no batch", () => {
  expect(check(stagedRun("itself")).failed).toEqual(["no orchestrator polled (courier_status, courier_children, courier_tree, sleep)"])
  const denied = check(stagedRun("skill-denied"))
  expect(Object.keys(denied.checks)).toHaveLength(9)
  expect(denied.failed).toEqual([BATCH])
  expect(denied.notes).toContain("the project's permissions deny the skill courier-orchestrate")
  expect(denied.notes.some((note) => note.startsWith("staged:"))).toBe(false)
})

// What e2e/real-model-recursive.mjs --finding tells the "count" session as the person.
const PERSON_NOTE =
  "A change from the person for the whole job, not only for your part: every file this job writes must hold its number " +
  "followed by a space and the word checked, such as 7 checked. Write yours that way."
const FINDING = "Every file of the job must hold its number followed by the word checked."
type Finding = "passed" | "not-down" | "in-report"

/** The recursive tree with --finding's person telling "count" mid-run; `not-down` skips half b, `in-report` sends it up only in the report. */
function findingRun(variant: Finding): Run {
  const plain = variant !== "in-report"
  const count = [
    user("count: run `sleep 20; echo $((99 - 57))`, write it to count/total.txt"),
    step("tool-calls", tool("shell", { command: "sleep 20; echo $((99 - 57))" })),
    user(PERSON_NOTE),
    step("tool-calls", write("count/total.txt"), ...(plain ? [send("ses_root", FINDING)] : []), send("ses_root", plain ? "42 checked" : `42 checked. ${FINDING}`, "done")),
    step("stop", say("Reported.")),
    idle(),
  ]
  const half = (id: string, value: string, told: boolean) => [
    user(`half ${id}`),
    step("tool-calls", tool("shell", { command: `sleep 150; echo ${value}` })),
    ...(told ? [synthetic(`<courier from="ses_num">\n${FINDING}\n</courier>`)] : []),
    step("tool-calls", write(`numbers/${id}.txt`), send("ses_num", `${value} checked`, "done")),
    step("stop", say("Reported.")),
    idle(),
  ]
  const num = [user("numbers"), step("tool-calls", spawn("ses_a", "halves"), spawn("ses_b", "halves")), step("stop", say("split: 2 halves")), idle()]
  if (plain)
    num.push(
      synthetic(`<courier from="ses_root">\n${FINDING}\n</courier>`),
      step("tool-calls", send("ses_a", FINDING), ...(variant === "not-down" ? [] : [send("ses_b", FINDING)])),
      step("stop", say("Passed on.")),
      idle(),
    )
  num.push(released("halves", [["ses_a", "done"], ["ses_b", "done"]]), step("tool-calls", send("ses_root", "391 checked and 1024 checked", "done")), step("stop", say("Reported.")), idle())
  const root = [user("the job"), step("tool-calls", loadSkill(), spawn("ses_num", "parts"), spawn("ses_count", "parts")), step("stop", say("split: 2 parts | numbers, count")), idle()]
  if (plain) root.push(synthetic(`<courier from="ses_count">\n${FINDING}\n</courier>`), step("tool-calls", send("ses_num", FINDING)), step("stop", say("Passed on.")), idle())
  root.push(released("parts", [["ses_num", "done"], ["ses_count", "done"]]), step("tool-calls", tool("read", { path: "numbers/a.txt" })), step("stop", say("RESULTS 391 1024 42")), idle())
  const told = variant === "passed" || variant === "not-down"
  const files = Object.fromEntries(Object.entries(FILES).map(([file, value]) => [file, `${value} checked`]))
  return { tree: { ses_root: root, ses_num: num, ses_a: half("a", "391", told), ses_b: half("b", "1024", variant === "passed"), ses_count: count }, files, expect: Object.values(FILES).join(" ") }
}

const F2 = "that session sent it up to the root with courier_send, without a status, before its report"
const F3 = "the root passed it on to the other part, without a status, once it arrived"
const F4 = "that part's session passed it on to each of its own sessions, once it arrived"

describe("the recursive checker with --finding", () => {
  test("a finding sent up without a status and passed on down to every half passes every check", () => {
    const run = check(findingRun("passed"), ["--finding"])
    expect(run.failed).toEqual([])
    expect(Object.keys(run.checks)).toHaveLength(13)
    expect(run.exitCode).toBe(0)
    expect(run.notes).toContain(`finding: the "count" session sent up: ${FINDING}`)
  })

  test("a part's session that passes it on to one half of two fails only that check", () => {
    expect(check(findingRun("not-down"), ["--finding"]).failed).toEqual([F4])
  })

  test("a finding sent up only inside the report reaches no one in time: the last three checks fail", () => {
    const run = check(findingRun("in-report"), ["--finding"])
    expect(run.failed).toEqual([F2, F3, F4])
    expect(run.notes.some((note) => note.startsWith('finding: the "count" session sent nothing up without a status'))).toBe(true)
  })

  test("the files must hold each number with the suffix, and a re-read with --saved keeps the finding checks", () => {
    const run = check({ ...findingRun("passed"), files: FILES }, ["--finding"], [])
    expect(run.finding).toBe(true)
    expect(run.failed).toEqual(["the files hold the expected values"])
  })
})
