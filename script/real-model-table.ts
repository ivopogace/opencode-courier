// One Markdown table per condition from real-model run directories (summary.json, timeline.txt where present):
// `bun script/real-model-table.ts [name=]dir...`; a directory without a name is its own condition, named by its basename.
import { existsSync, readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"

type Summary = {
  verdict: string
  checks: Record<string, boolean>
  notes: string[]
  usage: { requests: number; cacheRead?: number }
}

export type Run = {
  name: string
  verdict: string
  passed: number
  total: number
  skillLoads: Map<number, number>
  recalls: number
  groups: string[]
  polled: number
  requests: number
  /** Cache read tokens per model request, over the whole tree; undefined for a summary written before they were kept. */
  cacheReads?: number
  seconds?: number
  rootSplit?: string
  subSplits: string[]
}

// Who a note is about: "the root", or "session <id>" with its depth in parentheses.
const WHO = String.raw`(the root|session (ses_\w+)(?: \(depth (\d+)\))?)`
const depthOf = (who: string, depth: string | undefined) => (who === "the root" ? 0 : Number(depth ?? 1))

/** The span of a timeline in seconds: its earliest step start to its latest end; undefined without a step, with an unfinished one, or across midnight. */
export function secondsOf(timeline: string): number | undefined {
  const at = (clock: string) => {
    const [h = 0, m = 0, s = 0] = clock.split(":").map(Number)
    return h * 3600 + m * 60 + s
  }
  const spans = [...timeline.matchAll(/step (\d\d:\d\d:\d\d\.\d+) -> (\d\d:\d\d:\d\d\.\d+)/g)]
  if (!spans.length || /step \d\d:\d\d:\d\d\.\d+ -> …/.test(timeline)) return undefined
  const seconds = Math.max(...spans.map((span) => at(span[2]!))) - Math.min(...spans.map((span) => at(span[1]!)))
  // Clock times carry no date: a step that wraps, or a span over twelve hours, crossed midnight.
  return spans.some((span) => at(span[2]!) < at(span[1]!)) || seconds > 12 * 3600 ? undefined : seconds
}

export function parseRun(dir: string): Run {
  const summary: Summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"))
  const checks = Object.values(summary.checks)
  const skillLoads = new Map<number, number>()
  const groups = new Set<string>()
  const subSplits: string[] = []
  let recalls = 0
  let polled = 0
  let rootSplit: string | undefined
  // A sub-orchestrator is a non-root session that started sessions; its split line is the one it stated.
  const subOrchestrators = new Set<string>()
  for (const note of summary.notes) {
    const started = note.match(new RegExp(`^${WHO} started \\d+ session`))
    if (!started) continue
    if (started[2]) subOrchestrators.add(started[2])
    const grouped = note.match(/ in group\(s\) (.+?)(?:, \d+ isolated)?$/)
    if (grouped) for (const name of grouped[1]!.split(", ")) groups.add(name)
  }
  for (const note of summary.notes) {
    const loaded = note.match(new RegExp(`^${WHO} loaded the skill\\(s\\): (.+)$`))
    if (loaded) {
      const depth = depthOf(loaded[1]!, loaded[3])
      skillLoads.set(depth, (skillLoads.get(depth) ?? 0) + loaded[4]!.split(", ").length)
    }
    const recalled = note.match(new RegExp(`^${WHO} called courier_recall (\\d+) time`))
    if (recalled) recalls += Number(recalled[4])
    const poll = note.match(/^polled: (.+)$/)
    if (poll) polled = poll[1]!.split(", ").length
    const stated = note.match(new RegExp(`^${WHO} stated: (.+)$`))
    if (stated) {
      if (stated[1] === "the root") rootSplit = stated[4]
      else if (subOrchestrators.has(stated[2]!)) subSplits.push(stated[4]!)
    }
  }
  const timeline = join(dir, "timeline.txt")
  return {
    name: basename(dir),
    verdict: summary.verdict,
    passed: checks.filter(Boolean).length,
    total: checks.length,
    skillLoads,
    recalls,
    groups: [...groups],
    polled,
    requests: summary.usage.requests,
    ...(summary.usage.cacheRead !== undefined && summary.usage.requests > 0 ? { cacheReads: summary.usage.cacheRead / summary.usage.requests } : {}),
    seconds: existsSync(timeline) ? secondsOf(readFileSync(timeline, "utf8")) : undefined,
    rootSplit,
    subSplits,
  }
}

const cell = (text: string) => text.replaceAll("|", "\\|").replace(/\s+/g, " ")
const loadsOf = (loads: Map<number, number>) =>
  loads.size ? [...loads].toSorted(([a], [b]) => a - b).map(([depth, n]) => `d${depth}: ${n}`).join(", ") : "none"
const mean = (values: number[]) => (values.length ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1) : "-")

/** The Markdown for one condition: a row per run and a line of means over the finished ones. */
export function conditionTable(condition: string, runs: readonly Run[]): string {
  const rows = runs.map((run) =>
    [
      run.name,
      run.verdict,
      `${run.passed}/${run.total}`,
      loadsOf(run.skillLoads),
      String(run.recalls),
      run.groups.length ? `${run.groups.length} (${run.groups.join(", ")})` : "0",
      String(run.polled),
      String(run.requests),
      run.cacheReads === undefined ? "-" : String(Math.round(run.cacheReads)),
      run.seconds === undefined ? "-" : `${Math.round(run.seconds)} s`,
      run.rootSplit ? cell(run.rootSplit) : "-",
      run.subSplits.length ? run.subSplits.map(cell).join("<br>") : "-",
    ].join(" | "),
  )
  const finished = runs.filter((run) => run.verdict !== "inconclusive")
  return [
    `### ${condition}`,
    "",
    "| Run | Verdict | Score | Skill loads | Recalls | Groups | Polled | Requests | Cache reads/request | Duration | Root split | Sub-orchestrator splits |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row} |`),
    "",
    `${runs.length} run(s), ${finished.length} finished, ${finished.filter((run) => run.verdict === "pass").length} pass; mean score ${mean(finished.map((run) => run.passed))}/${mean(finished.map((run) => run.total))}, ` +
      `${mean(finished.map((run) => run.polled))} polled session(s), ${mean(finished.map((run) => run.requests))} requests, ` +
      `${mean(finished.flatMap((run) => (run.cacheReads === undefined ? [] : [run.cacheReads])))} cache reads/request.`,
  ].join("\n")
}

/** Arguments `name=dir` or `dir` as conditions, in order of first appearance; an unusable directory is skipped with a line on stderr. */
export function tables(args: readonly string[]): string {
  const conditions = new Map<string, { label?: string; dir: string; runs: Run[] }>()
  for (const arg of args) {
    // A label has no path separator, so a directory whose path holds an "=" stays a directory.
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
  // An unlabelled directory is a condition of its own, named by its basename, or by its path when two share one.
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
