import { existsSync, readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"

type Summary = {
  verdict: string
  checks: Record<string, boolean>
  notes: string[]
  usage: { requests: number; input?: number; cacheRead?: number }
}

export type Run = {
  name: string
  verdict: string
  passed: number
  total: number
  skillLoads: Map<number, number>
  polled: number
  requests: number
  cacheReads?: number
  uncached?: number
  seconds?: number
}

const WHO = String.raw`(the root|session (ses_\w+)(?: \(depth (\d+)\))?)`
const depthOf = (who: string, depth: string | undefined) => (who === "the root" ? 0 : Number(depth ?? 1))

export function secondsOf(timeline: string): number | undefined {
  const at = (clock: string) => {
    const [h = 0, m = 0, s = 0] = clock.split(":").map(Number)
    return h * 3600 + m * 60 + s
  }
  const spans = [...timeline.matchAll(/step (\d\d:\d\d:\d\d\.\d+) -> (\d\d:\d\d:\d\d\.\d+)/g)]
  if (!spans.length || /step \d\d:\d\d:\d\d\.\d+ -> …/.test(timeline)) return undefined
  const seconds = Math.max(...spans.map((span) => at(span[2]!))) - Math.min(...spans.map((span) => at(span[1]!)))
  return spans.some((span) => at(span[2]!) < at(span[1]!)) || seconds > 12 * 3600 ? undefined : seconds
}

export function parseRun(dir: string): Run {
  const summary: Summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"))
  const checks = Object.values(summary.checks)
  const skillLoads = new Map<number, number>()
  let polled = 0
  for (const note of summary.notes) {
    const loaded = note.match(new RegExp(`^${WHO} loaded the skill\\(s\\): (.+)$`))
    if (loaded) {
      const depth = depthOf(loaded[1]!, loaded[3])
      skillLoads.set(depth, (skillLoads.get(depth) ?? 0) + loaded[4]!.split(", ").length)
    }
    const poll = note.match(/^polled: (.+)$/)
    if (poll) polled = poll[1]!.split(", ").length
  }
  const timeline = join(dir, "timeline.txt")
  return {
    name: basename(dir),
    verdict: summary.verdict,
    passed: checks.filter(Boolean).length,
    total: checks.length,
    skillLoads,
    polled,
    requests: summary.usage.requests,
    ...(summary.usage.cacheRead !== undefined && summary.usage.requests > 0 ? { cacheReads: summary.usage.cacheRead / summary.usage.requests } : {}),
    ...(summary.usage.input !== undefined && summary.usage.requests > 0 ? { uncached: summary.usage.input / summary.usage.requests } : {}),
    seconds: existsSync(timeline) ? secondsOf(readFileSync(timeline, "utf8")) : undefined,
  }
}

const cell = (text: string) => text.replaceAll("|", "\\|").replace(/\s+/g, " ")
const loadsOf = (loads: Map<number, number>) =>
  loads.size ? [...loads].toSorted(([a], [b]) => a - b).map(([depth, n]) => `d${depth}: ${n}`).join(", ") : "none"
const mean = (values: number[]) => (values.length ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1) : "-")

export function conditionTable(condition: string, runs: readonly Run[]): string {
  const rows = runs.map((run) =>
    [
      run.name,
      run.verdict,
      `${run.passed}/${run.total}`,
      loadsOf(run.skillLoads),
      String(run.polled),
      String(run.requests),
      run.cacheReads === undefined ? "-" : String(Math.round(run.cacheReads)),
      run.uncached === undefined ? "-" : String(Math.round(run.uncached)),
      run.seconds === undefined ? "-" : `${Math.round(run.seconds)} s`,
    ].join(" | "),
  )
  const finished = runs.filter((run) => run.verdict !== "inconclusive")
  return [
    `### ${condition}`,
    "",
    "| Run | Verdict | Score | Skill loads | Polled | Requests | Cache reads/request | Uncached input/request | Duration |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row} |`),
    "",
    `${runs.length} run(s), ${finished.length} finished, ${finished.filter((run) => run.verdict === "pass").length} pass; mean score ${mean(finished.map((run) => run.passed))}/${mean(finished.map((run) => run.total))}, ` +
      `${mean(finished.map((run) => run.polled))} polled session(s), ${mean(finished.map((run) => run.requests))} requests, ` +
      `${mean(finished.flatMap((run) => (run.cacheReads === undefined ? [] : [run.cacheReads])))} cache reads/request, ` +
      `${mean(finished.flatMap((run) => (run.uncached === undefined ? [] : [run.uncached])))} uncached input tokens/request.`,
  ].join("\n")
}

export function tables(args: readonly string[]): string {
  const conditions = new Map<string, { label?: string; dir: string; runs: Run[] }>()
  for (const arg of args) {
    const label = arg.match(/^([^/\\=]+)=/)?.[1]
    const dir = label === undefined ? arg : arg.slice(label.length + 1)
    let run: Run
    try {
      if (!dir || !existsSync(join(dir, "summary.json"))) throw new Error("no summary.json")
      run = parseRun(dir)
    } catch (error) {
      console.error(`skipping ${dir || arg}: ${error instanceof Error ? error.message : error}`)
      continue
    }
    const key = label ?? resolve(dir)
    const condition = conditions.get(key) ?? { label, dir, runs: [] }
    condition.runs.push(run)
    conditions.set(key, condition)
  }
  const unlabelled = [...conditions.values()].filter((condition) => condition.label === undefined).map((condition) => basename(condition.dir))
  const nameOf = ({ label, dir }: { label?: string; dir: string }) => label ?? (unlabelled.filter((name) => name === basename(dir)).length > 1 ? dir : basename(dir))
  return [...conditions.values()].map((condition) => conditionTable(nameOf(condition), condition.runs)).join("\n\n")
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (!args.length) {
    console.error("usage: bun script/real-model-table.ts [name=]run-directory...")
    process.exit(1)
  }
  console.log(tables(args))
}
