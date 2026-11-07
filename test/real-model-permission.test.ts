import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CHECKER = join(import.meta.dir, "..", "e2e", "real-model-permission.mjs")
const EXPECT = "courier-permission-42"
const COMMAND = "echo courier-permission-$((6 * 7))"
const PROPOSED = "the parent proposed once with courier_answer, without asking the person first"
const PROMPTED = "OpenCode asked the person in the parent's session, for what the child asked, holding courier_answer"
const NOT_AGAIN = "the parent did not ask the person again"

type Message = Record<string, unknown>
let clock = Date.UTC(2026, 10, 7, 10, 0, 0)
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
const answer = () =>
  tool("courier_answer", { sessionID: "ses_child", requestID: "per_one", reply: "once" }, { sessionID: "ses_child", requestID: "per_one", reply: "once", answered: true })
const notice = (native: boolean) =>
  synthetic(
    [
      `<courier from="ses_child" asks="permission" request="per_one"${native ? ' shown="native"' : ""}>`,
      'This session, "Run it", which you started with courier_spawn, is waiting for permission and does nothing until it is answered.',
      "It asks for: shell",
      "On:",
      `- ${COMMAND}`,
      "",
      "(what to do)",
      "</courier>",
    ].join("\n"),
  )
const report = () => synthetic(`<courier from="ses_child" status="done">\nIt printed ${EXPECT}.\n</courier>`)
const child = () => [user("brief"), step("tool-calls", tool("shell", { command: COMMAND }), tool("courier_send", { sessionID: "ses_parent", message: EXPECT, status: "done" })), idle()]

type Shape = "plain" | "form-first" | "native-told" | "native-settled" | "native-proposes"

function parentOf(shape: Shape): Message[] {
  const native = shape.startsWith("native")
  const opening = [user("Have a helper run it."), step("tool-calls", tool("courier_spawn", { task: COMMAND, ...(native ? { native: true } : {}) }, { sessionID: "ses_child" })), step("stop", say("Started.")), idle(), notice(native)]
  const end = [report(), step("stop", say(`RESULT ${EXPECT}`)), idle()]
  if (shape === "form-first")
    return [...opening, step("tool-calls", tool("question", { questions: [] })), step("tool-calls", answer()), step("stop", say("Passed on.")), idle(), ...end]
  if (shape === "plain" || shape === "native-proposes") return [...opening, step("tool-calls", answer()), step("stop", say("Passed on.")), idle(), ...end]
  if (shape === "native-told")
    return [...opening, step("stop", say("The helper waits on your permission.")), idle(), user("Allow it once."), step("tool-calls", answer()), step("stop", say("Passed on.")), idle(), ...end]
  return [...opening, step("stop", say("The helper waits on your permission.")), idle(), synthetic('<courier from="ses_child" request="per_one" answered="once">\nsettled\n</courier>'), step("stop", say("Noted.")), idle(), ...end]
}

function check(shape: Shape, observed?: unknown) {
  const work = mkdtempSync(join(tmpdir(), "rmp-"))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("COURIER_")))
  try {
    writeFileSync(join(work, "parent.json"), JSON.stringify(parentOf(shape)))
    writeFileSync(join(work, "child-ses_child.json"), JSON.stringify(child()))
    if (observed) writeFileSync(join(work, "summary.json"), JSON.stringify({ observed }))
    const run = Bun.spawnSync([process.execPath, CHECKER, "ses_parent", "--saved"], { env: { ...env, WORK: work, COURIER_EXPECT: EXPECT } })
    if (run.exitCode !== 0 && run.exitCode !== 1) throw new Error(`the checker exited ${run.exitCode}: ${run.stderr.toString()}`)
    const summary = JSON.parse(readFileSync(join(work, "summary.json"), "utf8")) as { checks: Record<string, boolean>; notes: string[]; observed?: unknown }
    return { exitCode: run.exitCode, ...summary, failed: Object.entries(summary.checks).flatMap(([name, ok]) => (ok ? [] : [name])) }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

describe("the permission checker re-reading a saved run", () => {
  test("a plain run whose courier_answer proposed once at the notice passes the plain checks, the held prompt read from the transcript", () => {
    const run = check("plain")
    expect(run.checks[PROPOSED]).toBe(true)
    expect(run.checks[PROMPTED]).toBe(true)
    expect(run.failed).toEqual([])
  })
  test("a question form before the proposal is asking first, though the proposal follows in the same turn", () => {
    expect(check("form-first").failed).toEqual([PROPOSED, PROMPTED])
  })
  test("a child the parent made native itself gets the native checks, which its one-line reply and later courier_answer pass", () => {
    const run = check("native-told")
    expect(Object.keys(run.checks)).toContain(NOT_AGAIN)
    expect(Object.keys(run.checks)).not.toContain(PROPOSED)
    expect(run.failed).toEqual([])
    expect(run.notes.some((note) => note.includes("made its child native itself"))).toBe(true)
  })
  test("a native request the person answered in OpenCode's own prompt passes on the settled notice", () => {
    expect(check("native-settled").failed).toEqual([])
  })
  test("courier_answer at a native notice asks the person a second time", () => {
    expect(check("native-proposes").failed).toEqual([NOT_AGAIN])
  })
  test("what the live run saw, kept in summary.json, decides over the transcript, and is kept again", () => {
    const observed = { told: true, notice: 4, noticeText: "", native: false, prompt: null, held: false, form: null, answeredItself: false, questioned: false, askedFirst: true, how: "asked in its reply first", personAt: null, elsewhereSaid: "" }
    const run = check("plain", observed)
    expect(run.failed).toEqual([PROPOSED, PROMPTED])
    expect(run.observed).toEqual(observed)
  })
})
