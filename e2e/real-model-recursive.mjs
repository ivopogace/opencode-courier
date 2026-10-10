// The recursive scenario of e2e/real-model.sh (node e2e/real-model-recursive.mjs <rootSessionID>, or
// --saved to re-read WORK): a job of two parts, one of them two halves of its own, so the root splits
// once and one of its children splits again. Waits for the whole tree to settle, saves every
// session's transcript to WORK and checks the shape of the tree, the reports up it and the result.
// Exit 2 means inconclusive: checks failed, but model requests failed too.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [rootID, mode] = process.argv.slice(2)
const saved = mode === "--saved"
const server = process.env.SERVER
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`
const work = process.env.WORK
const timeout = Number(process.env.COURIER_TIMEOUT ?? 300) * 1000
const expected = (process.env.COURIER_EXPECT ?? "").split(/\s+/).filter(Boolean)
const files = (process.env.COURIER_FILES ?? "").split(/\s+/).filter(Boolean)
const maxDepth = Number(process.env.COURIER_MAX_DEPTH ?? 3)
// Calls that look at other sessions; right after spawning, or more than once a turn, that is polling.
const LOOKS = new Set(["courier_status", "courier_children", "courier_tree"])

// A session's whole transcript, oldest first, a page at a time.
async function messages(sessionID) {
  if (saved) return JSON.parse(readFileSync(join(work, sessionID === rootID ? "parent.json" : `child-${sessionID}.json`), "utf8"))
  const all = []
  let query = "order=asc"
  for (;;) {
    const response = await fetch(`${server}/api/session/${sessionID}/message?${query}&limit=50`, { headers: { authorization: auth } })
    if (!response.ok) throw new Error(`messages of ${sessionID}: HTTP ${response.status}`)
    const page = await response.json()
    all.push(...page.data)
    if (page.data.length < 50 || !page.cursor?.next) return all
    // The cursor carries the order; OpenCode refuses both together.
    query = `cursor=${encodeURIComponent(page.cursor.next)}`
  }
}

const toolsOf = (list) => list.flatMap((message) => (message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : []))
const textOf = (message) =>
  message.type === "assistant" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") : (message.text ?? "")
const contentText = (state) => (state.content ?? []).flatMap((item) => (typeof item?.text === "string" ? [item.text] : [])).join("")
const failed = (message) => message.error !== undefined || message.finish === "error" || message.outcome === "failed"
const failedRequest = (message) => message.type === "assistant" && message.error !== undefined
const failedTurn = (message) => message.type === "idle" && message.outcome === "failed"
// A step that ended its turn rather than handing tool results back to the model, or that failed;
// since OpenCode 2.0.22 the transcript also records an `idle` message when a turn ends.
const ended = (message) =>
  message?.type === "idle" ||
  (message?.type === "assistant" && (message.finish !== undefined ? message.finish !== "tool-calls" : message.error !== undefined))
const settled = (list) => ended(list.at(-1)) && (list.at(-1).type === "idle" || list.at(-1).time.completed !== undefined)
const short = (value, max = 160) => {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}
// Splits a transcript into turns: a prompt or delivered message opens one when the last step had
// ended its turn; otherwise it steered the running turn.
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
// A courier_spawn that completed, and the session it started.
function childOf(part) {
  if (part.name !== "courier_spawn" || part.state.status !== "completed") return undefined
  const metadata = part.state.metadata ?? {}
  return metadata.sessionID ?? metadata.metadata?.sessionID ?? contentText(part.state).match(/Started session (ses_\w+)/)?.[1]
}
const spawnsOf = (list) => toolsOf(list).map(childOf).filter(Boolean)
// The sessions whose reports a delivered courier message carries: one, or a join group's members.
const sendersOf = (message) => (message.type === "synthetic" ? (message.text.match(/^<courier from="([^"]+)"/)?.[1].split(",") ?? []) : [])
const groupOf = (message) => message.text?.match(/^<courier from="[^"]*" group="([^"]+)"/)?.[1]
const scheduled = (message) => /^<courier [^>]*scheduled="/.test(message.text ?? "")
// The status a report from `from` carries: as an attribute, or on its own line in a group's message.
const statusOf = (message, from) =>
  groupOf(message)
    ? message.text.match(new RegExp(`^\\[\\d+/\\d+\\] ${from} "[^"]*": (\\w+)$`, "m"))?.[1]
    : message.text.match(/^<courier from="ses_\w+" status="(\w+)">/)?.[1]
// The reports of `child` delivered to its parent's transcript, in order: a message with its status.
const deliveriesFrom = (list, child) =>
  list.flatMap((message, index) => (!scheduled(message) && sendersOf(message).includes(child) && statusOf(message, child) ? [{ index, message }] : []))
// A session's reports to its parent: its completed courier_send calls to it with a status, each with the index of its message.
const reportsTo = (list, parentID) =>
  list.flatMap((message, index) =>
    message.type !== "assistant"
      ? []
      : message.content
          .filter((part) => part.type === "tool" && part.name === "courier_send" && part.state.status === "completed" && part.state.input?.sessionID === parentID && part.state.input?.status)
          .map((part) => ({ index, status: part.state.input.status })),
  )

// The tree: every session reached from the root through completed courier_spawn calls, with its
// transcript, parent and depth; read again on each wait, as sessions keep starting sessions.
async function readTree() {
  const sessions = new Map([[rootID, { parentID: undefined, depth: 0, list: await messages(rootID) }]])
  for (const [id, entry] of sessions) {
    if (entry.depth > maxDepth + 1) continue
    for (const child of spawnsOf(entry.list))
      if (!sessions.has(child)) sessions.set(child, { parentID: id, depth: entry.depth + 1, list: await messages(child) })
  }
  return sessions
}

// How long everything must have been quiet, with a report missing, before giving up on it.
const GRACE_MS = 15_000
const started = Date.now()
let quietSince
let tree = new Map()
for (;;) {
  let done = false
  try {
    tree = await readTree()
    const spawned = [...tree].filter(([id]) => id !== rootID)
    const reported = spawned.filter(([id, entry]) => deliveriesFrom(tree.get(entry.parentID).list, id).length > 0)
    const quiet = [...tree.values()].every((entry) => settled(entry.list))
    quietSince = quiet ? (quietSince ?? Date.now()) : undefined
    done = saved || (quiet && (reported.length === spawned.length || Date.now() - quietSince >= GRACE_MS))
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

for (const [id, entry] of tree) writeFileSync(join(work, id === rootID ? "parent.json" : `child-${id}.json`), JSON.stringify(entry.list, null, 2))

// What each session did, turn by turn, the root first and each session's children after it.
const lines = []
function describe(id, indent) {
  const entry = tree.get(id)
  const pad = " ".repeat(indent)
  lines.push(`${pad}${id === rootID ? "root" : `depth ${entry.depth}`} ${id}:`)
  for (const [number, turn] of turnsOf(entry.list).entries()) {
    const opener = turn[0]
    const by = opener.type === "user" ? "the prompt" : opener.type === "synthetic" ? `a message from ${sendersOf(opener).join(", ") || "?"}` : opener.type
    lines.push(`${pad}turn ${number + 1} (opened by ${by}):`)
    for (const message of turn) {
      if (message.type === "synthetic") lines.push(`${pad}  <- ${short(message.text.replace(/\s+/g, " "), 200)}`)
      if (message.type !== "assistant") continue
      for (const part of message.content) {
        if (part.type === "tool") lines.push(`${pad}  ${part.name}(${short(part.state.input, 140)}) -> ${part.state.status}${part.state.status === "error" ? `: ${short(part.state.error)}` : ""}`)
        if (part.type === "text" && part.text.trim()) lines.push(`${pad}  says: ${short(part.text.trim())}`)
      }
      if (message.error) lines.push(`${pad}  error: ${short(message.error)}`)
    }
    if (ended(turn.at(-1))) lines.push(`${pad}  -- turn ended (${turn.at(-1).finish ?? turn.at(-1).outcome})`)
  }
  if (!settled(entry.list)) lines.push(`${pad}  -- still running`)
  for (const child of spawnsOf(entry.list)) if (tree.has(child)) describe(child, indent + 2)
}
describe(rootID, 0)
const timeline = lines.join("\n")
writeFileSync(join(work, "timeline.txt"), `${timeline}\n`)
console.log(timeline)

// The checks.
const root = tree.get(rootID).list
const rootTurns = turnsOf(root)
const first = rootTurns[0] ?? []
const spawned = [...tree].filter(([id]) => id !== rootID)
const orchestrators = [...tree].filter(([, entry]) => spawnsOf(entry.list).length > 0)
const subOrchestrators = orchestrators.filter(([id]) => id !== rootID)
const looksIn = (turn) =>
  toolsOf(turn).filter((part) => LOOKS.has(part.name) || (part.name === "shell" && /\bsleep\b/.test(JSON.stringify(part.state.input)))).length
// Any look in the first turn, right after spawning, is polling; later, more than one look a turn is a loop.
const polled = looksIn(first) > 0 || rootTurns.slice(1).some((turn) => looksIn(turn) > 1)
const finalText = textOf(root.findLast((message) => message.type === "assistant" && textOf(message).trim()) ?? {})
// A session's report, as its parent got it; the first one, since the brief asks for exactly one.
const reportOf = (id) => deliveriesFrom(tree.get(tree.get(id).parentID).list, id)[0]
// Whether a sub-orchestrator's one report to its parent came after every report of its own children reached it.
const reportedAfterChildren = ([id, entry]) => {
  const own = reportsTo(entry.list, entry.parentID)
  const children = spawnsOf(entry.list)
  return own.length === 1 && children.every((child) => deliveriesFrom(entry.list, child).some((delivery) => delivery.index < own[0].index))
}
const fileText = (file) => {
  try {
    return readFileSync(join(work, "project", file), "utf8").trim()
  } catch {
    return undefined
  }
}
const fileTexts = files.map(fileText)

const checks = [
  ["the root spawned at least two children with courier_spawn", spawnsOf(root).length >= 2],
  ["the root ended its first turn after spawning, with no reports in it", ended(first.at(-1)) && !failed(first.at(-1)) && !first.some((message) => sendersOf(message).some((from) => tree.has(from)))],
  ["the root did not poll (courier_status, courier_children, courier_tree, sleep)", !polled],
  ["at least one child spawned at least two of its own, and no session started exactly one", subOrchestrators.length >= 1 && orchestrators.every(([, entry]) => spawnsOf(entry.list).length >= 2)],
  [`no session went past maxDepth ${maxDepth}`, [...tree.values()].every((entry) => entry.depth <= maxDepth)],
  ["every spawned session reported to its parent, with a status", spawned.length > 0 && spawned.every(([id]) => reportOf(id) !== undefined)],
  ["each sub-orchestrator reported upward once, after its own children had reported to it", subOrchestrators.length >= 1 && subOrchestrators.every(reportedAfterChildren)],
  ["the files hold the expected values", files.length > 0 && files.length === expected.length && fileTexts.every((text, index) => text === expected[index])],
  ["the root's final reply holds every expected result", expected.length > 0 && expected.every((value) => finalText.includes(value))],
]

const notes = []
for (const [id, entry] of tree) {
  const loads = toolsOf(entry.list).filter((part) => part.name === "skill" && part.state.status === "completed").map((part) => part.state.input?.id)
  if (loads.length) notes.push(`${id === rootID ? "the root" : `session ${id} (depth ${entry.depth})`} loaded the skill(s): ${loads.join(", ")}`)
}
if (![...tree.values()].some((entry) => toolsOf(entry.list).some((part) => part.name === "skill"))) notes.push("no session loaded a skill")
for (const [id, entry] of orchestrators) {
  const groups = [...new Set(toolsOf(entry.list).filter((part) => childOf(part) && part.state.input?.group).map((part) => part.state.input.group))]
  const isolated = toolsOf(entry.list).filter((part) => childOf(part) && part.state.input?.isolate).length
  notes.push(`${id === rootID ? "the root" : `session ${id} (depth ${entry.depth})`} started ${spawnsOf(entry.list).length} session(s)${groups.length ? ` in group(s) ${groups.join(", ")}` : ", in no group"}${isolated ? `, ${isolated} isolated` : ""}`)
  const checkIns = toolsOf(entry.list).filter((part) => part.name === "courier_later" && part.state.status === "completed").length
  const cancelled = toolsOf(entry.list).filter((part) => part.name === "courier_cancel" && part.state.status === "completed").length
  if (checkIns) notes.push(`${id === rootID ? "the root" : `session ${id}`} scheduled ${checkIns} courier_later check-in(s) and cancelled ${cancelled}`)
  const refused = toolsOf(entry.list).filter((part) => part.name === "courier_spawn" && part.state.status === "error")
  if (refused.length) notes.push(`${id === rootID ? "the root" : `session ${id}`} had ${refused.length} courier_spawn call(s) refused: ${short(refused[0].state.error, 100)}`)
}
for (const [id, entry] of spawned) {
  const report = reportOf(id)
  if (report) notes.push(`report from ${id} (depth ${entry.depth})${groupOf(report.message) ? ` in group "${groupOf(report.message)}"` : ""}: status ${statusOf(report.message, id)}`)
  const sends = reportsTo(entry.list, entry.parentID).length
  if (sends > 1) notes.push(`session ${id} reported ${sends} times`)
}
if (files.length) notes.push(`files: ${files.map((file, index) => `${file}=${fileTexts[index] ?? "(missing)"}`).join(", ")}`)
const subagents = [...tree.values()].reduce((n, entry) => n + toolsOf(entry.list).filter((part) => part.name === "subagent").length, 0)
if (subagents) notes.push(`OpenCode's own subagent tool was used ${subagents} time(s)`)

// Failed model requests (rate limits, mostly, on free tiers), or a turn whose idle marker says it
// failed: a run that fails its checks with any is not the plugin's verdict.
const transcript = [...tree.values()].flatMap((entry) => entry.list)
const providerErrors = transcript.filter(failedRequest).map((message) => message.error.type ?? "error")
const failedTurns = transcript.filter(failedTurn).length
if (providerErrors.length) notes.push(`${providerErrors.length} model request(s) failed: ${[...new Set(providerErrors)].join(", ")}`)
if (failedTurns) notes.push(`${failedTurns} turn(s) ended as failed`)

const usage = { requests: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
for (const message of transcript) {
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
  `  usage: ${tree.size} sessions, ${usage.requests} model requests, ${usage.input} input / ${usage.output} output / ${usage.reasoning} reasoning tokens, ` +
    `${usage.cacheRead} cache reads, ${usage.cacheWrite} cache writes, cost $${usage.cost.toFixed(4)}`,
)
console.log(`result: ${verdict}${verdict === "inconclusive" ? " (checks failed, but so did model requests; run it again)" : ""}`)
writeFileSync(
  join(work, "summary.json"),
  JSON.stringify(
    { verdict, rootID, sessions: Object.fromEntries([...tree].map(([id, entry]) => [id, { parentID: entry.parentID, depth: entry.depth }])), checks: Object.fromEntries(checks), notes, usage, finalText },
    null,
    2,
  ),
)
process.exit(passed ? 0 : verdict === "inconclusive" ? 2 : 1)
