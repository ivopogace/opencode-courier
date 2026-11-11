import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CHECKER = join(import.meta.dir, "..", "e2e", "real-model-discovery.mjs")
const FIRST = "the root spawned the three parts with courier_spawn in its first turn"
const POLL = "the root did not poll (courier_children, courier_tree, sleep)"
const FOUND = 'what the "schema" session found, amounts in cents, reached the root from that session'
const PASSED_ON = "the root passed it on to each of the other parts, without a status, once it had arrived"
const IN_TIME = "each of those parts had it before it reported, and the root stopped no part and started none a second time"
const FILES = "the files hold the expected values"
const REPLY = "the root's final reply holds every expected result"
const FINDING = "The API prints cents, not euros as the job says."

type Message = Record<string, unknown>
let clock = Date.UTC(2026, 10, 11, 10, 0, 0)
const tick = () => (clock += 1000)
const user = (text: string): Message => ({ type: "user", text, time: { created: tick() } })
const idle = (): Message => ({ type: "idle", time: { created: tick() } })
const step = (finish: "tool-calls" | "stop", ...content: unknown[]): Message => {
  const created = tick()
  return { type: "assistant", finish, content, time: { created, completed: tick() } }
}
const say = (text: string) => ({ type: "text", text })
const tool = (name: string, input: unknown, metadata: unknown = {}) => ({ type: "tool", name, state: { status: "completed", input, metadata, content: [] } })
const send = (sessionID: string, message: string, status?: string) => tool("courier_send", { sessionID, message, ...(status ? { status } : {}) })
const shell = (command: string) => tool("shell", { command })
const plain = (from: string, text: string): Message => ({ type: "synthetic", text: `<courier from="${from}">\n${text}\n</courier>`, time: { created: tick() } })
const report = (from: string, text: string): Message => ({ type: "synthetic", text: `<courier from="${from}" status="done">\n${text}\n</courier>`, time: { created: tick() } })
const TASKS: Record<string, string> = {
  ses_s: "Run `sh api.sh describe` and write what it printed to out/schema.txt.",
  ses_a: "Run `sh api.sh get a` and write the amount, as a whole number of cents, to out/a.txt. The API's amounts are in euros.",
  ses_b: "Run `sh api.sh get b` and write the amount, as a whole number of cents, to out/b.txt. The API's amounts are in euros.",
  ses_a2: "Again: run `sh api.sh get a` and write the amount to out/a.txt.",
}
const spawn = (sessionID: string, input: Record<string, unknown> = {}) => tool("courier_spawn", { task: TASKS[sessionID], ...input }, { sessionID })

type Variant = "relayed" | "in-report" | "not-passed" | "grouped" | "staged" | "restarted" | "polls" | "peeks" | "grouped-other"

function transcripts(variant: Variant): { tree: Record<string, Message[]>; values: [string, string] } {
  const grouped = variant === "grouped" || variant === "grouped-other"
  const informed = variant !== "not-passed" && !grouped
  const found = variant === "grouped-other" ? "" : ` ${FINDING}`
  const values: [string, string] = informed ? ["1999", "2550"] : ["199900", "255000"]
  const early = variant !== "in-report" && !grouped && variant !== "staged"
  const schema = [
    user(TASKS.ses_s!),
    step("tool-calls", shell("sh api.sh describe"), ...(early ? [send("ses_root", FINDING)] : [])),
    step("tool-calls", tool("write", { path: "out/schema.txt" }), send("ses_root", early ? "Wrote out/schema.txt." : `Wrote out/schema.txt.${found}`, "done")),
    step("stop", say("Reported.")),
    idle(),
  ]
  const group = grouped ? { group: "parts" } : {}
  const root: Message[] = [user("the job")]
  if (variant === "staged") root.push(step("tool-calls", spawn("ses_s")), step("stop", say("The schema first.")), idle())
  else root.push(step("tool-calls", spawn("ses_s", group), spawn("ses_a", group), spawn("ses_b", group), ...(variant === "polls" ? [tool("courier_children", {})] : [])), step("stop", say("split: 3 parts.")), idle())

  const consumer = (id: "ses_a" | "ses_b", value: string, told: boolean) => {
    const list: Message[] = [user(TASKS[id]!), step("tool-calls", shell(`for i in $(seq 150); do [ -e .go-parts ] && break; sleep 1; done; sh api.sh get ${id.at(-1)}`))]
    if (told) list.push(plain("ses_root", FINDING))
    if (variant === "peeks" && id === "ses_a") list.push(step("tool-calls", shell("sh api.sh describe")))
    list.push(step("tool-calls", tool("write", { path: `out/${id.at(-1)}.txt` }), send("ses_root", value, "done")), step("stop", say("Reported.")), idle())
    return list
  }
  const tell = step("tool-calls", send("ses_a", FINDING), send("ses_b", FINDING))
  const tree: Record<string, Message[]> = { ses_root: root, ses_s: schema }

  if (grouped) {
    tree.ses_a = consumer("ses_a", values[0], false)
    tree.ses_b = consumer("ses_b", values[1], false)
    root.push({
      type: "synthetic",
      text: `<courier from="ses_s,ses_a,ses_b" group="parts" reports="3">\n[1/3] ses_s "schema": done\nWrote out/schema.txt.${found}\n[2/3] ses_a "a": done\nWrote ${values[0]} cents to out/a.txt\n[3/3] ses_b "b": done\n${values[1]}\n</courier>`,
      time: { created: tick() },
    })
    root.push(tell)
    for (const id of ["ses_a", "ses_b"] as const) tree[id]!.push(plain("ses_root", FINDING), step("stop", say("Already reported.")), idle())
  } else if (variant === "staged") {
    root.push(report("ses_s", `Wrote out/schema.txt. ${FINDING}`), step("tool-calls", spawn("ses_a"), spawn("ses_b")), step("stop", say("Now the two amounts.")), idle())
    tree.ses_a = consumer("ses_a", values[0], false)
    tree.ses_b = consumer("ses_b", values[1], false)
    root.push(report("ses_a", values[0]), step("stop", say("a is in.")), idle(), report("ses_b", values[1]))
  } else {
    root.push(early ? plain("ses_s", FINDING) : report("ses_s", `Wrote out/schema.txt. ${FINDING}`))
    if (variant === "not-passed") root.push(step("stop", say("Noted.")), idle())
    else root.push(tell, ...(variant === "restarted" ? [step("tool-calls", tool("courier_stop", { sessionID: "ses_a" }), spawn("ses_a2"))] : []), step("stop", say("Passed on.")), idle())
    if (early) root.push(report("ses_s", "Wrote out/schema.txt."), step("stop", say("schema is in.")), idle())
    tree.ses_a = consumer("ses_a", values[0], informed)
    tree.ses_b = consumer("ses_b", values[1], informed)
    if (variant === "restarted") tree.ses_a2 = [user(TASKS.ses_a2!), step("tool-calls", tool("write", { path: "out/a.txt" }), send("ses_root", values[0], "done")), step("stop", say("Reported.")), idle()]
    root.push(report("ses_a", values[0]), step("stop", say("a is in.")), idle(), report("ses_b", values[1]))
    if (variant === "restarted") root.push(step("stop", say("b is in.")), idle(), report("ses_a2", values[0]))
  }
  root.push(step("tool-calls", tool("read", { path: "out/a.txt" }), tool("read", { path: "out/b.txt" })), step("stop", say(`RESULTS ${values[0]} ${values[1]}`)), idle())
  return { tree, values }
}

function check(variant: Variant) {
  const work = mkdtempSync(join(tmpdir(), "rmd-"))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("COURIER_")))
  try {
    const { tree, values } = transcripts(variant)
    for (const [id, list] of Object.entries(tree)) writeFileSync(join(work, id === "ses_root" ? "parent.json" : `child-${id}.json`), JSON.stringify(list))
    mkdirSync(join(work, "project", "out"), { recursive: true })
    writeFileSync(join(work, "project", "out", "a.txt"), `${values[0]}\n`)
    writeFileSync(join(work, "project", "out", "b.txt"), `${values[1]}\n`)
    const run = Bun.spawnSync([process.execPath, CHECKER, "ses_root", "--saved"], { env: { ...env, WORK: work, COURIER_EXPECT: "1999 2550", COURIER_FILES: "out/a.txt out/b.txt" } })
    if (run.exitCode !== 0 && run.exitCode !== 1) throw new Error(`the checker exited ${run.exitCode}: ${run.stderr.toString()}`)
    const summary = JSON.parse(readFileSync(join(work, "summary.json"), "utf8")) as { verdict: string; checks: Record<string, boolean>; notes: string[] }
    return { exitCode: run.exitCode, ...summary, failed: Object.entries(summary.checks).flatMap(([name, ok]) => (ok ? [] : [name])) }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

describe("the discovery checker", () => {
  test("a finding sent without a status, passed on by the root to both running parts, passes every check", () => {
    const run = check("relayed")
    expect(run.failed).toEqual([])
    expect(run.exitCode).toBe(0)
    expect(Object.keys(run.checks)).toHaveLength(9)
    expect(run.notes).toContain(`discovery: the "schema" session sent it without a status, before its report: ${FINDING}`)
    expect(run.notes).toContain("discovery: it reached the root in a message of its own, with 2 of 2 other parts yet to report")
    expect(run.notes).toContain(`discovery: the root told ses_a: ${FINDING}`)
    expect(run.notes).toContain("the root started 3 session(s), in no group")
  })

  test("a finding that came in the schema session's report passes too, and the note says how it came", () => {
    const run = check("in-report")
    expect(run.failed).toEqual([])
    expect(run.notes).toContain(`discovery: the "schema" session sent it in its report, status done: Wrote out/schema.txt. ${FINDING}`)
  })

  test("a root that kept the finding to itself fails the passing on, and the files and the reply show it", () => {
    const run = check("not-passed")
    expect(run.failed).toEqual([PASSED_ON, IN_TIME, FILES, REPLY])
    expect(run.notes).toContain("discovery: the root sent ses_a nothing without a status after the finding")
    expect(run.verdict).toBe("fail")
  })

  test("a finding held in a join group's reports reaches the root after the parts wrote: passing it on then is too late", () => {
    const run = check("grouped")
    expect(run.failed).toEqual([IN_TIME, FILES, REPLY])
    expect(run.notes).toContain('discovery: it reached the root in the reports of group "parts", with 0 of 2 other parts yet to report')
    expect(run.notes).toContain("the root started 3 session(s) in group(s) parts")
  })

  test("a join group's reports that name cents only in another part's report are no finding from the schema session", () => {
    const run = check("grouped-other")
    expect(run.failed).toEqual([FOUND, PASSED_ON, IN_TIME, FILES, REPLY])
    expect(run.notes.some((note) => note.startsWith('discovery: the "schema" session sent the root nothing about cents'))).toBe(true)
  })

  test("a root that ran the schema part first and started the others after it fails only the first-turn check", () => {
    const run = check("staged")
    expect(run.failed).toEqual([FIRST])
    expect(run.notes).toContain("discovery: the root started ses_a only after the finding had arrived: staged, nothing to pass on mid-run")
  })

  test("a root that stopped a part and started it again fails the check on the parts changing course", () => {
    const run = check("restarted")
    expect(run.failed).toEqual([IN_TIME])
    expect(run.notes).toContain("discovery: the root started a part a second time")
    expect(run.notes).toContain("discovery: the root stopped 1 session(s)")
  })

  test("a look right after spawning is polling", () => {
    expect(check("polls").failed).toEqual([POLL])
  })

  test("a part that read the API's description itself is noted", () => {
    const run = check("peeks")
    expect(run.failed).toEqual([])
    expect(run.notes).toContain("discovery: ses_a looked at the API's description itself, 1 call(s): what it wrote does not show the relay")
    expect(run.checks[FOUND]).toBe(true)
  })
})
