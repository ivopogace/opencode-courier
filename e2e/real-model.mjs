// Waits for a real model's fan-out to settle, saves the transcripts to WORK and reports what happened
// (node e2e/real-model.mjs <parentSessionID>, or --saved to re-read WORK). Exit 2 means inconclusive.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [parentID, mode] = process.argv.slice(2)
const saved = mode === "--saved"
const server = process.env.SERVER
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`
const work = process.env.WORK
const timeout = Number(process.env.COURIER_TIMEOUT ?? 300) * 1000
const expected = (process.env.COURIER_EXPECT ?? "").split(/\s+/).filter(Boolean)
// Calls that look at children; right after spawning, or more than once a turn, that is polling.
const LOOKS = new Set(["courier_status", "courier_children"])

// A session's whole transcript, oldest first, a page at a time.
async function messages(sessionID) {
  if (saved) return JSON.parse(readFileSync(join(work, sessionID === parentID ? "parent.json" : `child-${sessionID}.json`), "utf8"))
  const all = []
  let query = "order=asc"
  for (;;) {
    const response = await fetch(`${server}/api/session/${sessionID}/message?${query}&limit=50`, {
      headers: { authorization: auth },
    })
    if (!response.ok) throw new Error(`messages of ${sessionID}: HTTP ${response.status}`)
    const page = await response.json()
    all.push(...page.data)
    if (page.data.length < 50 || !page.cursor?.next) return all
    // The cursor carries the order; OpenCode refuses both together.
    query = `cursor=${encodeURIComponent(page.cursor.next)}`
  }
}

const toolsOf = (list) =>
  list.flatMap((message) => (message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : []))
const textOf = (message) =>
  message.type === "assistant"
    ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    : (message.text ?? "")
const contentText = (state) =>
  (state.content ?? []).flatMap((item) => (typeof item?.text === "string" ? [item.text] : [])).join("")
// Whether the message ending a turn says it failed: a step whose model request failed, as on a rate
// limit, or the idle marker 2.0.22 records after each turn, with its outcome.
const failed = (message) => message.error !== undefined || message.finish === "error" || message.outcome === "failed"
// The two kinds of failure that make a failing run inconclusive, counted apart in the note: a step
// whose model request failed, and a turn whose idle marker says it failed (for whatever reason).
const failedRequest = (message) => message.type === "assistant" && message.error !== undefined
const failedTurn = (message) => message.type === "idle" && message.outcome === "failed"
// A step that ended its turn rather than handing tool results back to the model, or that failed.
// Since OpenCode 2.0.22 the transcript also records an `idle` message when a turn ends.
const ended = (message) =>
  message?.type === "idle" ||
  (message?.type === "assistant" && (message.finish !== undefined ? message.finish !== "tool-calls" : message.error !== undefined))
// Whether a session has finished its turn and nothing has arrived since.
const settled = (list) => ended(list.at(-1)) && (list.at(-1).type === "idle" || list.at(-1).time.completed !== undefined)
const short = (value, max = 160) => {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}
// Splits a transcript into turns: a prompt or delivered message opens one when the last step had ended
// its turn (or, since 2.0.22, an idle marker was recorded); otherwise it steered the running turn.
function turnsOf(list) {
  const turns = []
  let busy = false
  let last
  for (const message of list) {
    const incoming = message.type === "user" || message.type === "synthetic"
    if (incoming && !busy && (!last || last.type === "idle" || (last.time.completed ?? Infinity) <= message.time.created)) {
      turns.push([])
      busy = true
    }
    if (!turns.length) turns.push([])
    turns.at(-1).push(message)
    if (message.type === "assistant" || message.type === "idle") {
      busy = !ended(message)
      last = message
    }
  }
  return turns
}
// A courier_spawn that completed, and the child it started.
function childOf(part) {
  if (part.name !== "courier_spawn" || part.state.status !== "completed") return undefined
  const metadata = part.state.metadata ?? {}
  return metadata.sessionID ?? metadata.metadata?.sessionID ?? contentText(part.state).match(/Started session (ses_\w+)/)?.[1]
}
// A courier message delivered to the parent, and who sent it.
const senderOf = (message) =>
  message.type === "synthetic" ? message.text.match(/^<courier from="(ses_\w+)"/)?.[1] : undefined
// The status a report carries as an attribute, when the child gave one.
const statusOf = (message) => message.text.match(/^<courier from="ses_\w+" status="(\w+)">/)?.[1]
const scheduled = (message) => /^<courier [^>]*scheduled="/.test(message.text ?? "")
// Who sent a report with courier_send; a courier_later check-in, from whoever, is not a report.
const reporterOf = (message) => (scheduled(message) ? undefined : senderOf(message))
// How the timeline names a delivered message.
function deliveryOf(message) {
  const from = senderOf(message)
  if (!from) return message.type === "synthetic" ? "a message" : undefined
  if (scheduled(message)) return `a courier_later check-in from ${from}`
  return children.has(from) ? `the report from ${from}` : `a message from ${from}`
}

// How long everything must have been quiet, with a report missing, before giving up on it: a
// report can reach the parent's transcript a little after its child has finished.
const GRACE_MS = 15_000
const started = Date.now()
let quietSince
let parent = []
let children = new Map()
for (;;) {
  let done = false
  try {
    const latest = await messages(parentID)
    const ids = toolsOf(latest).map(childOf).filter(Boolean)
    children = new Map(await Promise.all(ids.map(async (id) => [id, await messages(id)])))
    parent = latest
    const reported = new Set(parent.map(reporterOf).filter((id) => children.has(id)))
    const quiet = settled(parent) && [...children.values()].every(settled)
    quietSince = quiet ? (quietSince ?? Date.now()) : undefined
    done = saved || (quiet && (reported.size === children.size || Date.now() - quietSince >= GRACE_MS))
  } catch (error) {
    if (saved) throw error
    console.log(`  (could not read the transcripts, trying again: ${error.message})`)
  }
  if (done) break
  if (Date.now() - started > timeout) {
    console.log(`  (gave up waiting after ${timeout / 1000} s)`)
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 3000))
}

writeFileSync(join(work, "parent.json"), JSON.stringify(parent, null, 2))
for (const [id, list] of children) writeFileSync(join(work, `child-${id}.json`), JSON.stringify(list, null, 2))

// What the parent did, turn by turn.
const turns = turnsOf(parent)
const lines = []
for (const [number, turn] of turns.entries()) {
  const opener = turn[0]
  lines.push(`turn ${number + 1} (opened by ${opener.type === "user" ? "the prompt" : (deliveryOf(opener) ?? opener.type)}):`)
  for (const message of turn) {
    if (message.type === "synthetic") lines.push(`  <- ${deliveryOf(message)}: ${short(message.text.replace(/\s+/g, " "))}`)
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type === "tool")
        lines.push(`  ${part.name}(${short(part.state.input, 120)}) -> ${part.state.status}${part.state.status === "error" ? `: ${short(part.state.error)}` : ""}`)
      if (part.type === "text" && part.text.trim()) lines.push(`  says: ${short(part.text.trim())}`)
    }
    if (message.error) lines.push(`  error: ${short(message.error)}`)
  }
  if (ended(turn.at(-1))) lines.push(`  -- turn ended (${turn.at(-1).finish ?? turn.at(-1).outcome})`)
}
for (const [id, list] of children) {
  lines.push(`child ${id}:`)
  for (const part of toolsOf(list)) lines.push(`  ${part.name}(${short(part.state.input, 120)}) -> ${part.state.status}`)
  const last = list.findLast((message) => message.type === "assistant" && textOf(message).trim())
  if (last) lines.push(`  says: ${short(textOf(last).trim())}`)
  lines.push(settled(list) ? `  -- turn ended (${list.at(-1).finish ?? list.at(-1).outcome})` : "  -- still running")
}
const timeline = lines.join("\n")
writeFileSync(join(work, "timeline.txt"), `${timeline}\n`)
console.log(timeline)

// The checks.
const first = turns[0] ?? []
const firstTools = toolsOf(first)
const parentTools = toolsOf(parent)
const spawned = [...children.keys()]
const looksIn = (turn) =>
  toolsOf(turn).filter(
    (part) => LOOKS.has(part.name) || (part.name === "shell" && /\bsleep\b/.test(JSON.stringify(part.state.input))),
  ).length
// Any look in the first turn, right after spawning, is polling; later, a single look per turn is
// the one-off check courier_status is for, and more is a loop.
const polled = looksIn(first) > 0 || turns.slice(1).some((turn) => looksIn(turn) > 1)
const laterLooks = turns.slice(1).reduce((sum, turn) => sum + looksIn(turn), 0)
const sends = new Map(
  spawned.map((id) => [
    id,
    toolsOf(children.get(id)).filter(
      (part) => part.name === "courier_send" && part.state.status === "completed" && part.state.input?.sessionID === parentID,
    ),
  ]),
)
const reports = turns.flatMap((turn, number) =>
  turn.flatMap((message, position) => {
    const from = reporterOf(message)
    if (!from || !children.has(from)) return []
    const answered = turn.slice(position + 1).some((later) => later.type === "assistant" && !failed(later))
    const opened = turn.slice(0, position).every((earlier) => earlier.type === "synthetic")
    return [{ from, turn: number + 1, answered, opened, text: message.text, status: statusOf(message) }]
  }),
)
const reportOf = (id) => reports.find((report) => report.from === id)
const finalText = textOf(parent.findLast((message) => message.type === "assistant" && textOf(message).trim()) ?? {})
const firstText = first.filter((message) => message.type === "assistant").map(textOf).join("\n")

const checks = [
  ["the parent spawned two children with courier_spawn", firstTools.filter(childOf).length >= 2],
  [
    "the parent ended its first turn after spawning, with no reports in it",
    ended(first.at(-1)) && !failed(first.at(-1)) && !first.some(reporterOf),
  ],
  ["the parent did not poll its children (courier_status, courier_children, sleep)", !polled],
  ["both children called courier_send to the parent", spawned.length >= 2 && spawned.every((id) => sends.get(id).length > 0)],
  ["both reports woke the parent: each arrived after its first turn and got a reply", spawned.length >= 2 && spawned.every((id) => reportOf(id)?.turn > 1 && reportOf(id)?.answered)],
  ["each report carries a status, as the brief asks", spawned.length >= 2 && spawned.every((id) => reportOf(id)?.status !== undefined)],
  [
    "each report holds its child's answer",
    spawned.length >= 2 &&
      expected.length > 0 &&
      spawned.every((id) => expected.some((value) => reportOf(id)?.text.includes(value))) &&
      expected.every((value) => spawned.some((id) => reportOf(id)?.text.includes(value))),
  ],
  ["the parent's final reply holds both answers", expected.length > 0 && expected.every((value) => finalText.includes(value))],
]

const notes = []
const native = parentTools.filter((part) => part.name === "subagent")
if (native.length) notes.push(`the parent also used OpenCode's own subagent tool ${native.length} time(s)`)
const selfWorked = expected.filter((value) => firstText.includes(value))
if (selfWorked.length) notes.push(`the parent's first turn already states ${selfWorked.join(", ")} (did it work them out itself?)`)
for (const report of reports)
  notes.push(`report from ${report.from}: turn ${report.turn}, ${report.opened ? "woke the idle parent" : "steered into a running turn"}, ${report.status ? `status ${report.status}` : "no status"}`)
const checkIns = parentTools.filter((part) => part.name === "courier_later" && part.state.status === "completed").length
const cancelled = parentTools.filter((part) => part.name === "courier_cancel" && part.state.status === "completed").length
if (checkIns) notes.push(`the parent scheduled ${checkIns} courier_later check-in(s) and cancelled ${cancelled}`)
if (laterLooks) notes.push(`the parent looked at its children ${laterLooks} time(s) after being woken`)
for (const id of spawned)
  if (sends.get(id).length > 1) notes.push(`child ${id} called courier_send ${sends.get(id).length} times`)

// Failed model requests (rate limits, mostly, on free tiers), or a turn whose idle marker says it
// failed: a run that fails its checks with any is not the plugin's verdict.
const transcript = [parent, ...children.values()].flat()
const providerErrors = transcript.filter(failedRequest).map((message) => message.error.type ?? "error")
const failedTurns = transcript.filter(failedTurn).length
if (providerErrors.length) notes.push(`${providerErrors.length} model request(s) failed: ${[...new Set(providerErrors)].join(", ")}`)
if (failedTurns) notes.push(`${failedTurns} turn(s) ended as failed`)

const usage = { requests: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
for (const message of [parent, ...children.values()].flat()) {
  if (message.type !== "assistant") continue
  usage.requests += 1
  usage.input += message.tokens?.input ?? 0
  usage.output += message.tokens?.output ?? 0
  usage.reasoning += message.tokens?.reasoning ?? 0
  usage.cacheRead += message.tokens?.cache?.read ?? 0
  usage.cacheWrite += message.tokens?.cache?.write ?? 0
  usage.cost += Number(message.cost ?? 0)
}

const passed = checks.every(([, ok]) => ok)
const verdict = passed ? "pass" : providerErrors.length || failedTurns ? "inconclusive" : "fail"
console.log("")
for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"} ${name}`)
for (const note of notes) console.log(`  note: ${note}`)
console.log(
  `  usage: ${usage.requests} model requests, ${usage.input} input / ${usage.output} output / ${usage.reasoning} reasoning tokens, ` +
    `${usage.cacheRead} cache reads, ${usage.cacheWrite} cache writes, cost $${usage.cost.toFixed(4)}`,
)
console.log(
  `result: ${verdict}${verdict === "inconclusive" ? " (checks failed, but so did model requests; run it again)" : ""}`,
)
writeFileSync(
  join(work, "summary.json"),
  JSON.stringify({ verdict, parentID, children: spawned, checks: Object.fromEntries(checks), notes, usage, finalText }, null, 2),
)
process.exit(passed ? 0 : verdict === "inconclusive" ? 2 : 1)
