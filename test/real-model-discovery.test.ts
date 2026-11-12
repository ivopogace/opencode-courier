import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CHECKER = join(import.meta.dir, "..", "e2e", "real-model-discovery.mjs")
const FIRST = "the root spawned the three parts with courier_spawn in its first turn"
const POLL = "the root did not poll (courier_children, courier_tree, sleep)"
const FOUND = 'what the "init" session found, the key that get needs, reached the root from that session'
const PASSED_ON = "the root passed the key on to each of the other parts, without a status, once it had arrived"
const IN_TIME = "each of those parts had it before it reported, and the root stopped no part and started none a second time"
const FILES = "the files hold the expected values"
const REPLY = "the root's final reply holds every expected result"
const KEY = "key-0a1b2c3d"
const FINDING = `get needs a key now, as its last argument: ${KEY}`
const WAIT = "for i in $(seq 150); do [ -e .go-parts ] && break; sleep 1; done"

type Message = Record<string, unknown>
let clock = Date.UTC(2026, 10, 12, 10, 0, 0)
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
  ses_i: "Run `sh api.sh init`, once, and report what it printed.",
  ses_a: `First run \`${WAIT}\` exactly as written, then get the amount of item a from the API and write it to out/a.txt.`,
  ses_b: `First run \`${WAIT}\` exactly as written, then get the amount of item b from the API and write it to out/b.txt.`,
  ses_a2: `Again: get the amount of item a from the API and write it to out/a.txt. The key: ${KEY}`,
}

type Variant = "relayed" | "in-report" | "not-passed" | "vague" | "grouped" | "grouped-other" | "staged" | "restarted" | "polls" | "own-init" | "fenced" | "searched" | "looked" | "carried" | "quoted"

function transcripts(variant: Variant): { tree: Record<string, Message[]>; values: [string, string] } {
  const grouped = variant === "grouped" || variant === "grouped-other"
  const informed = variant !== "not-passed" && variant !== "vague" && !grouped
  const values: [string, string] = informed ? ["1999", "2550"] : ["error", "error"]
  const early = variant !== "in-report" && !grouped && variant !== "staged"
  const inReport = variant === "grouped-other" ? "init ran." : `init ran. ${FINDING}`
  const tasks: Record<string, string> = {
    ...TASKS,
    ...(variant === "fenced" ? { ses_i: `Do not create, remove or look at .go-parts. ${TASKS.ses_i}` } : {}),
    ...(variant === "staged" ? { ses_a: `${TASKS.ses_a} The key: ${KEY}`, ses_b: `${TASKS.ses_b} The key: ${KEY}` } : {}),
  }
  const spawn = (sessionID: string, input: Record<string, unknown> = {}) => tool("courier_spawn", { task: tasks[sessionID], ...input }, { sessionID })
  const init = [
    user(tasks.ses_i!),
    step("tool-calls", shell("sh api.sh init"), ...(early ? [send("ses_root", FINDING)] : [])),
    step("tool-calls", send("ses_root", early ? "init ran." : inReport, "done")),
    step("stop", say("Reported.")),
    idle(),
  ]
  const group = grouped ? { group: "parts" } : {}
  const root: Message[] = [user("the job")]
  if (variant === "staged") root.push(step("tool-calls", spawn("ses_i")), step("stop", say("init first.")), idle())
  else root.push(step("tool-calls", spawn("ses_i", group), spawn("ses_a", group), spawn("ses_b", group), ...(variant === "polls" ? [tool("courier_children", {})] : [])), step("stop", say("split: 3 parts.")), idle())

  const consumer = (id: "ses_a" | "ses_b", value: string, told: string | undefined) => {
    const item = id.at(-1)
    const list: Message[] = [user(tasks[id]!), step("tool-calls", shell(WAIT))]
    if (told) list.push(plain("ses_root", told))
    if (variant === "own-init" && id === "ses_a") list.push(step("tool-calls", shell("rm .api-key; sh api.sh init")))
    if (variant === "searched" && id === "ses_a") list.push(step("tool-calls", shell("grep -rho 'key-[0-9a-f]\\{8\\}' ../home/.local/share/opencode ../server.log")))
    if (variant === "searched" && id === "ses_b") list.push(step("tool-calls", shell("cd /root/courier-runs/discovery-1/project && ls out")))
    list.push(step("tool-calls", shell(`sh api.sh get ${item}${informed ? ` ${KEY}` : ""}`), tool("write", { path: `out/${item}.txt` }), send("ses_root", value, "done")), step("stop", say("Reported.")), idle())
    return list
  }
  const words = variant === "vague" ? "The API changed: get needs a key now." : FINDING
  const tell = step("tool-calls", send("ses_a", words), send("ses_b", words))
  const tree: Record<string, Message[]> = { ses_root: root, ses_i: init }

  if (variant === "looked" || variant === "carried" || variant === "quoted") {
    const heldPart = variant === "quoted" ? ` I found ${KEY} in server.log; is it the one?` : variant === "carried" ? `\n\nHeld with group "parts" so far, 1 report, shown now in case what this session needs is in it.\n\n- ses_i "init": done\n${inReport}` : ""
    const look = { type: "tool", name: "courier_children", state: { status: "completed", input: {}, metadata: {}, content: [{ type: "text", text: `ses_i: its report is held with group "parts": init ran. ${FINDING}` }] } }
    const finish = (item: string) => [step("tool-calls", shell(`sh api.sh get ${item} ${KEY}`), tool("write", { path: `out/${item}.txt` }), send("ses_root", item === "a" ? "1999" : "2550", "done")), step("stop", say("Reported.")), idle()]
    root.splice(1, root.length - 1, step("tool-calls", spawn("ses_i", { group: "parts" }), spawn("ses_a", { group: "parts" }), spawn("ses_b", { group: "parts" })), step("stop", say("split: 3 parts.")), idle())
    init.splice(1, init.length - 1, step("tool-calls", shell("sh api.sh init"), send("ses_root", inReport, "done")), step("stop", say("Reported.")), idle())
    tree.ses_b = [user(tasks.ses_b!), step("tool-calls", shell(WAIT)), step("tool-calls", shell("sh api.sh get b"), send("ses_root", "I need the key that get asks for.", "blocked")), step("stop", say("Blocked.")), idle()]
    tree.ses_a = [user(tasks.ses_a!), step("tool-calls", shell(WAIT))]
    root.push({ type: "synthetic", text: `<courier from="ses_b" status="blocked">\nI need the key that get asks for.${heldPart}\n</courier>`, time: { created: tick() } })
    root.push(...(variant === "looked" ? [step("tool-calls", look)] : []), step("tool-calls", send("ses_a", FINDING), send("ses_b", FINDING)), step("stop", say("Passed on.")), idle())
    tree.ses_a.push(plain("ses_root", FINDING), ...finish("a"))
    tree.ses_b.push(plain("ses_root", FINDING), ...finish("b"))
    root.push({
      type: "synthetic",
      text: `<courier from="ses_i,ses_a,ses_b" group="parts" reports="3">\n[1/3] ses_i "init": done\n${inReport}\n[2/3] ses_a "a": done\n1999\n[3/3] ses_b "b": done\n2550\n</courier>`,
      time: { created: tick() },
    })
    root.push(step("tool-calls", tool("read", { path: "out/a.txt" }), tool("read", { path: "out/b.txt" })), step("stop", say("RESULTS 1999 2550")), idle())
    return { tree, values: ["1999", "2550"] }
  }
  if (grouped) {
    tree.ses_a = consumer("ses_a", values[0], undefined)
    tree.ses_b = consumer("ses_b", values[1], undefined)
    const other = variant === "grouped-other" ? "get wants a key such as key-00000000, which I was not given" : values[0]
    root.push({
      type: "synthetic",
      text: `<courier from="ses_i,ses_a,ses_b" group="parts" reports="3">\n[1/3] ses_i "init": done\n${inReport}\n[2/3] ses_a "a": done\n${other}\n[3/3] ses_b "b": done\n${values[1]}\n</courier>`,
      time: { created: tick() },
    })
    root.push(tell)
    for (const id of ["ses_a", "ses_b"] as const) tree[id]!.push(plain("ses_root", FINDING), step("stop", say("Already reported.")), idle())
  } else if (variant === "staged") {
    root.push(report("ses_i", inReport), step("tool-calls", spawn("ses_a"), spawn("ses_b")), step("stop", say("Now the two amounts.")), idle())
    tree.ses_a = consumer("ses_a", values[0], undefined)
    tree.ses_b = consumer("ses_b", values[1], undefined)
    root.push(report("ses_a", values[0]), step("stop", say("a is in.")), idle(), report("ses_b", values[1]))
  } else {
    root.push(early ? plain("ses_i", FINDING) : report("ses_i", inReport))
    if (variant === "not-passed") root.push(step("stop", say("Noted.")), idle())
    else root.push(tell, ...(variant === "restarted" ? [step("tool-calls", tool("courier_stop", { sessionID: "ses_a" }), spawn("ses_a2"))] : []), step("stop", say("Passed on.")), idle())
    if (early) root.push(report("ses_i", "init ran."), step("stop", say("init is in.")), idle())
    const told = variant === "not-passed" ? undefined : words
    tree.ses_a = consumer("ses_a", values[0], told)
    tree.ses_b = consumer("ses_b", values[1], told)
    if (variant === "restarted") tree.ses_a2 = [user(tasks.ses_a2!), step("tool-calls", tool("write", { path: "out/a.txt" }), send("ses_root", values[0], "done")), step("stop", say("Reported.")), idle()]
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
  test("a key sent without a status, passed on by the root to both waiting parts, passes every check", () => {
    const run = check("relayed")
    expect(run.failed).toEqual([])
    expect(run.exitCode).toBe(0)
    expect(Object.keys(run.checks)).toHaveLength(9)
    expect(run.notes).toContain(`discovery: the "init" session sent it without a status, before its report: ${FINDING}`)
    expect(run.notes).toContain("discovery: it reached the root in a message of its own, with 2 of 2 other parts yet to report")
    expect(run.notes).toContain(`discovery: the root told ses_a: ${FINDING}`)
    expect(run.notes).toContain("the root started 3 session(s), in no group")
  })

  test("a key that came in the init session's report passes too, and the note says how it came", () => {
    const run = check("in-report")
    expect(run.failed).toEqual([])
    expect(run.notes).toContain(`discovery: the "init" session sent it in its report, status done: init ran. ${FINDING}`)
  })

  test("a root that kept the key to itself fails the passing on, and the files and the reply show it", () => {
    const run = check("not-passed")
    expect(run.failed).toEqual([PASSED_ON, IN_TIME, FILES, REPLY])
    expect(run.notes).toContain("discovery: the root sent ses_a no message without a status that holds the key")
    expect(run.verdict).toBe("fail")
  })

  test("a root that told the parts of the change without the key has not passed it on", () => {
    expect(check("vague").failed).toEqual([PASSED_ON, IN_TIME, FILES, REPLY])
  })

  test("a key held in a join group's reports reaches the root after the parts reported: passing it on then is too late", () => {
    const run = check("grouped")
    expect(run.failed).toEqual([IN_TIME, FILES, REPLY])
    expect(run.notes).toContain('discovery: it reached the root in the reports of group "parts", with 0 of 2 other parts yet to report')
    expect(run.notes).toContain("the root started 3 session(s) in group(s) parts")
  })

  test("a join group's reports that name a key only in another part's report are no finding from the init session", () => {
    const run = check("grouped-other")
    expect(run.failed).toEqual([FOUND, PASSED_ON, IN_TIME, FILES, REPLY])
    expect(run.notes.some((note) => note.startsWith('discovery: the "init" session sent the root no key'))).toBe(true)
  })

  test("an init task that names the parts' wait file in a prohibition is still the init part, by the command it ran", () => {
    const run = check("fenced")
    expect(run.failed).toEqual([])
    expect(run.notes).toContain(`discovery: the "init" session sent it without a status, before its report: ${FINDING}`)
  })

  test("a root that ran the init part first and started the others after it, the key in their tasks, fails only the first-turn check", () => {
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

  test("a part that ran init itself is noted, and is still that part", () => {
    const run = check("own-init")
    expect(run.failed).toEqual([])
    expect(run.notes).toContain("discovery: ses_a ran init, touched the key's file or searched outside the project for the key, 1 call(s): what it wrote does not show the relay")
  })

  test("a part that searched the server's files for the key is noted; its own project path is not a search", () => {
    const run = check("searched")
    expect(run.notes).toContain("discovery: ses_a ran init, touched the key's file or searched outside the project for the key, 1 call(s): what it wrote does not show the relay")
    expect(run.notes.some((note) => note.startsWith("discovery: ses_b ran init"))).toBe(false)
  })

  test("a key the root read with courier_children while a join group held the report counts from that look, and the parts it then told are told", () => {
    const run = check("looked")
    expect(run.failed).toEqual([IN_TIME])
    expect(run.notes).toContain("discovery: it reached the root through its own look with courier_children or courier_tree, the report still held, with 1 of 2 other parts yet to report")
    expect(run.notes).toContain(`discovery: the root told ses_b: ${FINDING}`)
  })

  test("a key that came with another part's blocked report, among the reports its group held, counts from that report", () => {
    const run = check("carried")
    expect(run.failed).toEqual([IN_TIME])
    expect(run.notes).toContain("discovery: it reached the root with another part's blocked report, among the reports its group held, with 1 of 2 other parts yet to report")
    expect(run.notes).toContain(`discovery: the root told ses_a: ${FINDING}`)
  })

  test("a key a part quotes in its own blocked report did not come from the init session: it arrives with the group's reports", () => {
    const run = check("quoted")
    expect(run.failed).toEqual([PASSED_ON, IN_TIME])
    expect(run.notes).toContain('discovery: it reached the root in the reports of group "parts", with 0 of 2 other parts yet to report')
  })
})
