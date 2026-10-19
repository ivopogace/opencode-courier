import { describe, expect, test } from "bun:test"
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
    const run = parseRun(fixture("pass-b"))
    expect(run).toMatchObject({ verdict: "fail", passed: 1, total: 3, recalls: 0, polled: 2, groups: [], seconds: undefined, rootSplit: undefined, subSplits: [] })
    expect(run.skillLoads.size).toBe(0)
  })

  test("a timeline's span runs from its first start to its last end", () => {
    expect(secondsOf("step 10:00:00.500 -> 10:00:01.000 (0.5 s)\nstep 10:00:02.000 -> …")).toBe(0.5)
    expect(secondsOf("nothing")).toBeUndefined()
  })

  test("a table per condition, runs of one label together, inconclusive runs left out of the means", () => {
    const out = tables([`base=${fixture("pass-a")}`, `base=${fixture("pass-b")}`, `base=${fixture("inconclusive-c")}`, fixture("pass-a")])
    expect(out.match(/^### /gm)).toHaveLength(2)
    expect(out).toContain("### base\n")
    expect(out).toContain("### pass-a\n")
    expect(out).toContain("| pass-a | pass | 2/2 | d0: 1, d1: 1 | 2 | 2 (parts, numbers-halves) | 0 | 26 | 52 s | split: 2 parts \\| numbers, count | split: 2 halves |")
    expect(out).toContain("3 run(s), 2 finished, 1 pass; mean score 1.5/2, 1.0 polled session(s), 22.0 requests.")
  })

  test("an empty condition still prints a table", () => {
    expect(conditionTable("none", [])).toContain("0 run(s), 0 finished, 0 pass; mean score -/-")
  })
})
