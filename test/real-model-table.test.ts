import { describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { conditionTable, parseRun, secondsOf, tables } from "../script/real-model-table.js"

const fixture = (name: string) => join(import.meta.dir, "fixtures", "real-model", name)

describe("real-model-table", () => {
  test("reads a passing run's summary and timeline", () => {
    const run = parseRun(fixture("pass-a"))
    expect(run).toMatchObject({ name: "pass-a", verdict: "pass", passed: 2, total: 2, recalls: 2, polled: 0, requests: 26, seconds: 52 })
    expect([...run.skillLoads]).toEqual([[0, 1], [1, 1]])
    expect(run.groups).toEqual(["parts", "numbers-halves"])
    expect(run.rootSplit).toBe("split: 2 parts | numbers, count")
    expect(run.subSplits).toEqual(["split: 2 halves"])
  })

  test("reads a failing run with no skill, no group and two polled sessions", () => {
    const run = parseRun(fixture("fail-b"))
    expect(run).toMatchObject({ verdict: "fail", passed: 1, total: 3, recalls: 0, polled: 2, groups: [], seconds: undefined, rootSplit: undefined, subSplits: [] })
    expect(run.skillLoads.size).toBe(0)
  })

  test("a timeline's span runs from its first start to its last end", () => {
    expect(secondsOf("step 10:00:00.500 -> 10:00:01.000 (0.5 s)\nstep 10:00:00.700 -> 10:00:01.200 (0.5 s)")).toBeCloseTo(0.7)
    expect(secondsOf("nothing")).toBeUndefined()
  })

  test("a table per condition, runs of one label together, inconclusive runs left out of the means", () => {
    const out = tables([`base=${fixture("pass-a")}`, `base=${fixture("fail-b")}`, `base=${fixture("inconclusive-c")}`, fixture("pass-a")])
    expect(out.match(/^### /gm)).toHaveLength(2)
    expect(out).toContain("### base\n")
    expect(out).toContain("### pass-a\n")
    expect(out).toContain("| pass-a | pass | 2/2 | d0: 1, d1: 1 | 2 | 2 (parts, numbers-halves) | 0 | 26 | 52 s | split: 2 parts \\| numbers, count | split: 2 halves |")
    expect(out).toContain("3 run(s), 2 finished, 1 pass; mean score 1.5/2.5, 1.0 polled session(s), 22.0 requests.")
  })

  test("an empty condition still prints a table", () => {
    expect(conditionTable("none", [])).toContain("0 run(s), 0 finished, 0 pass; mean score -/-")
  })
})

describe("real-model-table, unusable arguments", () => {
  test("a path without a summary.json is skipped, not fatal", () => {
    const out = tables([fixture("pass-a"), fixture("missing"), join(fixture("pass-a"), "summary.json")])
    expect(out.match(/^### /gm)).toHaveLength(1)
  })

  test("only step spans count towards the duration", () => {
    expect(secondsOf("step 10:00:00.000 -> 10:00:01.000 (1.0 s)\n  tool() -> completed [10:00:00.500 -> 10:00:09.000 (8.5 s)]")).toBe(1)
  })
})

test("a timeline has no duration across midnight or with an unfinished step", () => {
  expect(secondsOf("step 23:59:50.000 -> 00:00:10.000 (20.0 s)")).toBeUndefined()
  expect(secondsOf("step 23:59:00.000 -> 23:59:30.000 (30.0 s)\nstep 00:00:10.000 -> 00:00:20.000 (10.0 s)")).toBeUndefined()
  expect(secondsOf("step 12:00:00.000 -> 12:00:05.000 (5.0 s)\nstep 12:00:06.000 -> …")).toBeUndefined()
})

test("an absolute path holding an = is a directory, not a label", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "rmt-")), "x=y")
  cpSync(fixture("pass-a"), dir, { recursive: true })
  expect(tables([dir]).startsWith("### x=y\n")).toBe(true)
})

test("unlabelled directories with one basename stay conditions of their own, named by path", () => {
  const root = mkdtempSync(join(tmpdir(), "rmt-"))
  for (const parent of ["a", "b"]) cpSync(fixture("pass-a"), join(root, parent, "1"), { recursive: true })
  const out = tables([join(root, "a", "1"), join(root, "b", "1")])
  expect(out.match(/^### /gm)).toHaveLength(2)
  expect(out).toContain(`### ${join(root, "a", "1")}\n`)
})

test("a recall is counted from a note about a session, not from a model's text quoted in another note", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmt-"))
  const notes = ["the root called courier_recall 1 time(s), the first in its first turn, before its split", "fault: its parent ses_num had not loaded courier-orchestrate when the partial report reached it, and messaged it: I called courier_recall 5 times"]
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ verdict: "pass", checks: { a: true }, notes, usage: { requests: 1 } }))
  expect(parseRun(dir).recalls).toBe(1)
})

test("a label with no directory, or a summary.json that is not one, is skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmt-"))
  writeFileSync(join(dir, "summary.json"), '{ "verdict": "pass" }')
  expect(tables(["base=", dir, fixture("pass-a")]).match(/^### /gm)).toHaveLength(1)
})

// The parser reads these strings of the checker's notes (e2e/real-model-recursive.mjs); a change there fails here, so the parser is changed with it.
test("the checker still writes the notes the parser reads", () => {
  const checker = readFileSync(join(import.meta.dir, "..", "e2e", "real-model-recursive.mjs"), "utf8")
  const who = '${id === rootID ? "the root" : `session ${id} (depth ${entry.depth})`}'
  for (const note of [
    "notes.push(`" + who + " loaded the skill(s): ${loads.join(\", \")}`)",
    "notes.push(`" + who + " called courier_recall ${calls.length} time(s), the first ${when}",
    "notes.push(`" + who + " stated: ${decision.slice(0, 320)}`)",
    "notes.push(`" + who + " started ${spawnsOf(entry.list).length} session(s)${groups.length ? ` in group(s) ${groups.join(\", \")}` : \", in no group\"}",
    'notes.push(`polled: ${pollers.map((id) => (id === rootID ? "the root" : id)).join(", ")}`)',
    "checks: Object.fromEntries(checks)",
  ])
    expect(checker).toContain(note)
})
