// Waits for a real model's recursive split to settle, saves every session's transcript to WORK and checks the tree
// (node e2e/real-model-recursive.mjs <rootSessionID> [--saved to re-read WORK] [--fault for recursive-fault] [--staged for recursive-staged]
// [--finding for recursive-finding, which also plays the person telling the "count" session something mid-run]).
// Exit 2 means inconclusive.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [rootID, ...flags] = process.argv.slice(2)
const saved = flags.includes("--saved")
const server = process.env.SERVER
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`
const work = process.env.WORK
// A re-read keeps the checks the run was made with: summary.json records --fault, --staged and --finding.
const savedFlag = (name) => {
  try {
    return JSON.parse(readFileSync(join(work, "summary.json"), "utf8"))[name] === true
  } catch {
    return false
  }
}
const fault = flags.includes("--fault") || (saved && savedFlag("fault"))
const staged = flags.includes("--staged") || (saved && savedFlag("staged"))
const finding = flags.includes("--finding") || (saved && savedFlag("finding"))
// What --finding's person tells the "count" session mid-run, which every file of the job then holds after its number.
const PERSON_NOTE =
  "A change from the person for the whole job, not only for your part: every file this job writes must hold its number " +
  "followed by a space and the word checked, such as 7 checked. Write yours that way."
const SUFFIX = " checked"
const timeout = Number(process.env.COURIER_TIMEOUT ?? 300) * 1000
const expected = (process.env.COURIER_EXPECT ?? "").split(/\s+/).filter(Boolean)
const files = (process.env.COURIER_FILES ?? "").split(/\s+/).filter(Boolean)
const maxDepth = Number(process.env.COURIER_MAX_DEPTH ?? 5)
// Calls that look at other sessions; right after spawning, or more than once a turn, that is polling.
const LOOKS = new Set(["courier_children", "courier_tree"])
// courier_recall counts as a look too, with one allowance: the one call the skill asks of the root, before its split, in its first turn.
const RECALL = "courier_recall"
const SKILL = "courier-orchestrate"
const loadsAnySkill = (part) => part.type === "tool" && part.name === "skill" && part.state.status === "completed"

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
// The "count" part's session, found by its command or its file, since the root briefs it in its own words.
const isCount = (list) => /99 - 57|count\/total\.txt/.test(textOf(list.find((message) => message.type === "user" || message.type === "synthetic") ?? {}))
const short = (value, max = 160) => {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}
// A time field ({ created, ran?, completed? }, epoch ms) as "12:00:01.234 -> 12:00:05.001 (3.8 s)"; "…" while it has not ended.
const clock = (ms) => new Date(ms).toISOString().slice(11, 23)
const spanOf = (time) =>
  time?.created === undefined
    ? ""
    : `${clock(time.created)} -> ${time.completed === undefined ? "…" : `${clock(time.completed)} (${((time.completed - time.created) / 1000).toFixed(1)} s)`}`
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
    ? message.text.match(new RegExp(`^\\[\\d+/\\d+\\] ${from} ".*": (\\w+)$`, "m"))?.[1]
    : message.text.match(/^<courier from="ses_\w+" status="(\w+)">/)?.[1]
// Who sent a report with courier_send; a courier_later check-in, from whoever, is not a report.
const reportersOf = (message) => (scheduled(message) ? [] : sendersOf(message))
// The reports of `child` delivered to its parent's transcript, in order: a message with its status.
const deliveriesFrom = (list, child) =>
  list.flatMap((message, index) => (reportersOf(message).includes(child) && statusOf(message, child) ? [{ index, message }] : []))
// A session's completed courier_send calls to `to`, each with the index of its message and its place among that message's parts.
const sendsTo = (list, to) =>
  list.flatMap((message, index) =>
    message.type !== "assistant"
      ? []
      : message.content.flatMap((part, place) =>
          part.type === "tool" && part.name === "courier_send" && part.state.status === "completed" && part.state.input?.sessionID === to
            ? [{ index, place, status: part.state.input.status, message: part.state.input.message }]
            : [],
        ),
  )
const sentBefore = (one, other) => one.index < other.index || (one.index === other.index && one.place < other.place)
// A session's reports to its parent: its messages to it with a status.
const reportsTo = (list, parentID) => sendsTo(list, parentID).filter((send) => send.status)

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

// How long everything must have been quiet, with a report missing, before giving up on it: two of the
// scheduler's ticks, since a group's release at each level can wait for one.
const GRACE_MS = 30_000
const started = Date.now()
let quietSince
let tree = new Map()
let told = false
for (;;) {
  let done = false
  try {
    tree = await readTree()
    // --finding: the person tells the "count" session, once its turn runs, something the whole job needs.
    const count = finding && !saved && !told ? [...tree].find(([, entry]) => entry.depth === 1 && isCount(entry.list) && entry.list.some((message) => message.type === "assistant") && !settled(entry.list)) : undefined
    if (count) {
      const response = await fetch(`${server}/api/session/${count[0]}/prompt`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ text: PERSON_NOTE }),
      })
      if (!response.ok) throw new Error(`the person's message to ${count[0]}: HTTP ${response.status}`)
      told = true
      console.log(`  (told ${count[0]}, the "count" session, as the person: ${PERSON_NOTE})`)
    }
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
      // The gap a stall shows as: how long after the last thing before this step ended it began.
      const earlier = turn.slice(0, turn.indexOf(message)).flatMap((other) => (other.type === "assistant" ? [other.time.completed, ...other.content.map((part) => part.time?.completed)] : [other.time?.created]))
      const since = Math.max(0, ...earlier.filter((at) => at !== undefined))
      lines.push(`${pad}  step ${spanOf(message.time)}${since ? `, began ${((message.time.created - since) / 1000).toFixed(1)} s after the last event before it` : ""}`)
      for (const part of message.content) {
        if (part.type === "tool") lines.push(`${pad}  ${part.name}(${short(part.state.input, 140)}) -> ${part.state.status}${part.state.status === "error" ? `: ${short(part.state.error)}` : ""}${part.time ? ` [${spanOf(part.time)}]` : ""}`)
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
const sleeps = (part) => part.name === "shell" && /\bsleep\b/.test(JSON.stringify(part.state.input))
// With --staged a session may run the core's command itself: a sleep before it has started any session is that work, not waiting.
const sleepsBeforeSpawn = (list) => {
  const tools = toolsOf(list)
  const firstSpawn = tools.findIndex(childOf)
  return new Set(staged ? tools.slice(0, firstSpawn === -1 ? tools.length : firstSpawn).filter(sleeps) : [])
}
const looksIn = (turn, exempt = new Set()) =>
  toolsOf(turn).filter((part) => LOOKS.has(part.name) || part.name === RECALL || (sleeps(part) && !exempt.has(part))).length
// The one courier_recall call the root's turn may make before its first courier_spawn, which the skill's step 1 asks for; a
// second, one after a spawn, or any below the root, is a look like any other.
const allowedRecall = (id, turn) => {
  if (id !== rootID) return 0
  const tools = toolsOf(turn)
  const firstSpawn = tools.findIndex(childOf)
  const recalls = tools.flatMap((part, index) => (part.name === RECALL ? [index] : []))
  return recalls.length === 1 && (firstSpawn === -1 || recalls[0] < firstSpawn) ? 1 : 0
}
// Any look in the first turn, right after spawning, is polling, but the root's one recall before its split; later, more than one look a turn is a loop.
const polledIn = (id, list) => {
  const [firstTurn = [], ...later] = turnsOf(list)
  const exempt = sleepsBeforeSpawn(list)
  return looksIn(firstTurn, exempt) - allowedRecall(id, firstTurn) > 0 || later.some((turn) => looksIn(turn, exempt) > 1)
}
const pollers = orchestrators.filter(([id, entry]) => polledIn(id, entry.list)).map(([id]) => id)
// The sessions a turn started; a sub-orchestrator starts its batch in one turn, and one session alone only as a stage
// after work of its own (notOneInAll). With --staged the batch may follow a turn that started the core's session.
const spawnsIn = (turn) => toolsOf(turn).filter(childOf).length
const batchIn = (list) => (staged ? turnsOf(list) : turnsOf(list).slice(0, 1)).some((turn) => spawnsIn(turn) >= 2)
// A session that started exactly one session in all is a hop, unless it did work of its own first, as a verifier does before it
// starts one implementor. A heuristic: the transcript shows a tool call that is not the plugin's or the skill tool's, not what it was for.
const own = (part) => !part.name.startsWith("courier_") && part.name !== "skill"
const notOneInAll = (list) => {
  const tools = toolsOf(list)
  const spawns = tools.flatMap((part, index) => (childOf(part) ? [index] : []))
  return spawns.length !== 1 || tools.slice(0, spawns[0]).some(own)
}
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
const fileExpected = expected.map((value) => (finding ? `${value}${SUFFIX}` : value))
// The fault --fault checks for: one leaf told to report partial first and to finish only once its parent messages it, found
// by its first report, not by its task, which the root and the sub-orchestrator pass on in their own words.
const deliveriesOf = (id) => deliveriesFrom(tree.get(tree.get(id).parentID).list, id).map((delivery) => ({ ...delivery, status: statusOf(delivery.message, id) }))
const faulty = spawned.filter(([id, entry]) => entry.parentID !== rootID && (deliveriesOf(id)[0]?.status ?? "done") !== "done")
// How its parent handled it: a courier_send to it after its first report and before the parent's own report upward, its
// next report done after that message, and the parent's reports upward.
const handling = faulty.map(([id, entry]) => {
  const parent = tree.get(entry.parentID)
  const [first, ...later] = deliveriesOf(id)
  const upward = reportsTo(parent.list, parent.parentID)
  const nudge = sendsTo(parent.list, id).find((send) => send.index > first.index && (upward[0] === undefined || sentBefore(send, upward[0])))
  const finished = nudge && later.find((delivery) => delivery.index > nudge.index && delivery.status === "done")
  return { id, entry, parent, first, statuses: [first, ...later].map((delivery) => delivery.status), nudge, finished, upward }
})
const faultChecks = [
  ["the fault reached a leaf: a session below a sub-orchestrator first reported a status other than done", faulty.length > 0],
  ["its parent messaged it with courier_send after that report and before reporting upward", handling.length > 0 && handling.every((one) => one.nudge)],
  ["it then reported done", handling.length > 0 && handling.every((one) => one.finished)],
  [
    "its parent reported upward once, after that done report, with status done",
    handling.length > 0 && handling.every((one) => one.finished && one.upward.length === 1 && one.upward[0].index > one.finished.index && one.upward[0].status === "done"),
  ],
]

// The core --staged checks for: the first of the files, which the halves read. Who wrote it first, and when, from the
// transcripts' timestamps: a write, edit or patch naming it, or a shell command redirecting into it.
const coreFile = files[0] ?? ""
const escaped = coreFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const redirects = new RegExp(String.raw`(?:>>?|\btee\b[^|;&]*?)\s*["']?(?:[^\s"';&|<>]*/)?${escaped}(?![\w./-])`)
const writesCore = (part) =>
  part.type === "tool" &&
  part.state.status === "completed" &&
  coreFile !== "" &&
  (part.name === "shell" ? redirects.test(part.state.input?.command ?? "") : ["write", "edit", "patch"].includes(part.name) && JSON.stringify(part.state.input ?? {}).includes(coreFile))
const partStart = (part, message) => part.time?.created ?? message.time.created
const partEnd = (part, message) => part.time?.completed ?? message.time.completed ?? message.time.created
const coreWrite = [...tree]
  .flatMap(([id, entry]) => entry.list.flatMap((message) => (message.type === "assistant" ? message.content.filter(writesCore).map((part) => ({ id, part, at: partEnd(part, message) })) : [])))
  .sort((one, other) => one.at - other.at)[0]
// The session that staged: the core's writer when it also started sessions, else the parent of the session that wrote it.
const writerIsOrchestrator = coreWrite && orchestrators.some(([id]) => id === coreWrite.id)
const stagerID = coreWrite ? (writerIsOrchestrator ? coreWrite.id : tree.get(coreWrite.id).parentID) : (subOrchestrators.find(([, entry]) => entry.depth === 1) ?? subOrchestrators[0])?.[0]
const stager = stagerID === undefined ? undefined : tree.get(stagerID)
const coreSession = coreWrite && !writerIsOrchestrator && stagerID !== undefined ? coreWrite.id : undefined
// Each courier_spawn of the stager's, with its turn, its place and its time.
const stagerSpawns = stager
  ? turnsOf(stager.list).flatMap((turn, number) =>
      turn.flatMap((message) => (message.type === "assistant" ? message.content.filter(childOf).map((part) => ({ id: childOf(part), part, turn: number, at: partStart(part, message) })) : [])),
    )
  : []
const halves = stagerSpawns.filter((spawn) => spawn.id !== coreSession && tree.has(spawn.id))
const coreSpawn = stagerSpawns.find((spawn) => spawn.id === coreSession)
const coreReport = coreSession ? deliveriesFrom(stager.list, coreSession)[0] : undefined
const coreReady = coreWrite && (coreSession === undefined || coreReport) ? Math.max(coreWrite.at, coreReport?.message.time.created ?? 0) : undefined
const stagerUpward = stager && stager.parentID !== undefined ? reportsTo(stager.list, stager.parentID) : []
const stagedChecks = [
  [
    `no half started before ${coreFile} existed, nor, when the core had a session of its own, before that session's report reached the session that staged`,
    coreReady !== undefined && halves.length > 0 && halves.every((half) => half.at > coreReady),
  ],
  [
    "the session that staged started at least two halves together in one turn, after any session for the core: one session for the core is not one for the whole task",
    halves.length >= 2 && halves.every((half) => half.turn === halves[0].turn) && (coreSpawn === undefined || stagerSpawns.indexOf(coreSpawn) < stagerSpawns.indexOf(halves[0])),
  ],
  ["the session that staged reported upward once, with status done", stagerUpward.length === 1 && stagerUpward[0].status === "done"],
]

// The finding --finding checks for: the person's message in the "count" session, that session's message up without a
// status before its report, the root's message on to the other part, and that part's on to each of its own sessions.
const delivered = (list, from, after = -1) => list.findIndex((message, index) => index > after && sendersOf(message).includes(from) && !groupOf(message) && !statusOf(message, from))
const plainAfter = (list, to, after) => sendsTo(list, to).find((send) => send.index > after && !send.status)
const [countID, countEntry] = [...tree].find(([, entry]) => entry.depth === 1 && isCount(entry.list)) ?? []
const noteAt = countEntry ? countEntry.list.findIndex((message) => message.type === "user" && message.text?.includes(PERSON_NOTE)) : -1
const up = countEntry && noteAt !== -1 ? plainAfter(countEntry.list, rootID, noteAt) : undefined
const countReport = countEntry ? reportsTo(countEntry.list, rootID)[0] : undefined
const atRoot = countID ? delivered(root, countID) : -1
const others = [...tree].filter(([id, entry]) => entry.depth === 1 && id !== countID)
const onward = others.map(([id, entry]) => {
  const sent = atRoot === -1 ? undefined : plainAfter(root, id, atRoot)
  const reached = sent ? delivered(entry.list, rootID) : -1
  const below = spawnsOf(entry.list).filter((child) => tree.has(child))
  const down = below.map((child) => ({ child, sent: reached === -1 ? undefined : plainAfter(entry.list, child, reached) }))
  return { id, sent, reached, below, down }
})
const findingChecks = [
  ['the person\'s message reached the "count" session', noteAt !== -1],
  [
    "that session sent it up to the root with courier_send, without a status, before its report",
    up !== undefined && (countReport === undefined || sentBefore(up, countReport)),
  ],
  ["the root passed it on to the other part, without a status, once it arrived", atRoot !== -1 && onward.length > 0 && onward.every((one) => one.sent && one.reached !== -1)],
  ["that part's session passed it on to each of its own sessions, once it arrived", onward.length > 0 && onward.every((one) => one.below.length > 0 && one.down.every((down) => down.sent))],
]

const checks = [
  ["the root spawned at least two children with courier_spawn in its first turn", spawnsIn(first) >= 2],
  ["the root ended its first turn after spawning, with no reports in it", ended(first.at(-1)) && !failed(first.at(-1)) && !first.some((message) => reportersOf(message).some((from) => tree.has(from)))],
  ["no orchestrator polled (courier_children, courier_tree, sleep)", pollers.length === 0],
  [
    "at least one child spawned at least two of its own in one turn, and no sub-orchestrator started exactly one in all without work of its own first",
    subOrchestrators.some(([, entry]) => batchIn(entry.list)) && subOrchestrators.every(([, entry]) => notOneInAll(entry.list)),
  ],
  [`no session went past maxDepth ${maxDepth}`, [...tree.values()].every((entry) => entry.depth <= maxDepth)],
  ["every spawned session reported to its parent, with a status", spawned.length > 0 && spawned.every(([id]) => reportOf(id) !== undefined)],
  ["each sub-orchestrator reported upward once, after its own children had reported to it", subOrchestrators.length >= 1 && subOrchestrators.every(reportedAfterChildren)],
  ["the files hold the expected values", files.length > 0 && files.length === expected.length && fileTexts.every((text, index) => text === fileExpected[index])],
  ["the root's final reply holds every expected result", expected.length > 0 && expected.every((value) => finalText.includes(value))],
  ...(fault ? faultChecks : []),
  ...(staged ? stagedChecks : []),
  ...(finding ? findingChecks : []),
]

const notes = []
for (const [id, entry] of tree) {
  const loads = toolsOf(entry.list).filter(loadsAnySkill).map((part) => part.state.input?.id)
  if (loads.length) notes.push(`${id === rootID ? "the root" : `session ${id} (depth ${entry.depth})`} loaded the skill(s): ${loads.join(", ")}`)
}
if (![...tree.values()].some((entry) => toolsOf(entry.list).some((part) => part.name === "skill"))) notes.push("no session loaded a skill")
// Whether and when each session called courier_recall (#260): the skill asks the root for one call before its split.
for (const [id, entry] of tree) {
  const turns = turnsOf(entry.list)
  const calls = turns.flatMap((turn, number) => {
    const tools = toolsOf(turn)
    const firstSpawn = tools.findIndex(childOf)
    return tools.flatMap((part, index) => (part.name === RECALL ? [{ turn: number + 1, beforeSplit: firstSpawn === -1 || index < firstSpawn, status: part.state.status }] : []))
  })
  if (!calls.length) continue
  const first = calls[0]
  const when = first.turn === 1 ? (first.beforeSplit ? "in its first turn, before its split" : "in its first turn, after its first spawn") : `in turn ${first.turn}`
  notes.push(`${id === rootID ? "the root" : `session ${id} (depth ${entry.depth})`} called courier_recall ${calls.length} time(s), the first ${when}${calls.some((call) => call.status === "error") ? ", with an error" : ""}`)
}
if (![...tree.values()].some((entry) => toolsOf(entry.list).some((part) => part.name === RECALL))) notes.push("no session called courier_recall")
// The split decision each session's first turn states, as the pointer, the brief and the skill ask (#119): a line that
// begins with `split:` (after any markdown), else one holding it.
const splitLineOf = (text) => (text.match(/^\s*(?:[*_#>`-]+\s*)*split:.*$/im) ?? text.match(/^.*\bsplit:.*$/im))?.[0].trim()
for (const [id, entry] of tree) {
  const decision = splitLineOf((turnsOf(entry.list)[0] ?? []).filter((message) => message.type === "assistant").map(textOf).join("\n"))
  if (decision) notes.push(`${id === rootID ? "the root" : `session ${id} (depth ${entry.depth})`} stated: ${decision.slice(0, 320)}`)
}
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
// Whether each orchestrator had courier-orchestrate loaded when it split: the skill holds steps 5 to 8, the brief does not.
const loadsSkill = (part) => loadsAnySkill(part) && part.state.input?.id === SKILL
for (const [id, entry] of orchestrators) {
  const tools = toolsOf(entry.list)
  const load = tools.findIndex(loadsSkill)
  const when = load === -1 ? `without ${SKILL} loaded` : load < tools.findIndex(childOf) ? `with ${SKILL} loaded before its first spawn` : `with ${SKILL} loaded only after its first spawn`
  notes.push(`${id === rootID ? "the root" : `session ${id} (depth ${entry.depth})`} orchestrated ${when}`)
}
if (fault)
  for (const one of handling) {
    const loaded = one.parent.list.findIndex((message) => message.type === "assistant" && message.content.some(loadsSkill))
    notes.push(`fault: session ${one.id} (depth ${one.entry.depth}) reported ${one.statuses.join(", then ")}`)
    notes.push(
      `fault: its parent ${one.entry.parentID} ${loaded !== -1 && loaded < one.first.index ? "had" : "had not"} loaded ${SKILL} when the ${one.first.status} report reached it, ` +
        (one.nudge ? `and messaged it: ${short(one.nudge.message ?? "", 200)}` : "and did not message it between that report and its own upward"),
    )
    if (one.upward.length) notes.push(`fault: its parent reported upward ${one.upward.map((report) => report.status).join(", then ")}`)
  }
if (finding) {
  if (up) notes.push(`finding: the "count" session sent up: ${short(up.message ?? "", 200)}`)
  else if (countReport) notes.push(`finding: the "count" session sent nothing up without a status; its report: ${short(countReport.message ?? "", 200)}`)
  if (countID && plainAfter(root, countID, atRoot)) notes.push(`finding: the root also messaged the "count" session after the finding arrived`)
}
if (fault && !faulty.length) notes.push("fault: every session below a sub-orchestrator first reported done; the fault did not reach a leaf")
if (staged) {
  const who = (id) => (id === rootID ? "the root" : `session ${id} (depth ${tree.get(id).depth})`)
  if (!coreWrite) notes.push(`staged: no session wrote ${coreFile}`)
  else
    notes.push(
      `staged: ${coreFile} first written by ${who(coreWrite.id)} at ${clock(coreWrite.at)}` +
        (coreSession ? `, ${coreReport ? `its report reaching ${stagerID} at ${clock(coreReport.message.time.created)}` : "which never reported"}` : "") +
        `; halves started at ${halves.length ? halves.map((half) => clock(half.at)).join(", ") : "(none)"}`,
    )
  if (stager) {
    // When the stager had courier-orchestrate loaded: against the core (its write, or its session's spawn) and the halves' first spawn.
    const tools = toolsOf(stager.list)
    const load = tools.findIndex(loadsSkill)
    const core = coreSession ? tools.indexOf(coreSpawn?.part) : coreWrite?.id === stagerID ? tools.indexOf(coreWrite.part) : -1
    const firstHalf = halves.length ? tools.indexOf(halves[0].part) : -1
    const refused = tools.some((part) => part.name === "skill" && part.state.status === "error" && part.state.input?.id === SKILL)
    const when =
      load === -1
        ? `without ${SKILL} loaded${refused ? ", its load refused" : ""}`
        : core !== -1 && load < core
          ? `with ${SKILL} loaded before the core`
          : firstHalf === -1 || load < firstHalf
            ? `with ${SKILL} loaded after the core, before the halves`
            : `with ${SKILL} loaded only after starting the halves`
    notes.push(`staged: ${who(stagerID)} did the core ${coreSession ? `in session ${coreSession}` : coreWrite?.id === stagerID ? "itself" : "nowhere it could be seen"}, ${when}`)
  }
}
// Whether the project's permissions deny the skill, as COURIER_SKILL=deny writes them: the last rule matching wins, as in OpenCode.
const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`)
const skillRule = (() => {
  try {
    const rules = JSON.parse(readFileSync(join(work, "project", "opencode.json"), "utf8")).permissions ?? []
    return rules.findLast((rule) => glob(rule.action).test("skill") && glob(rule.resource).test(SKILL))
  } catch {
    return undefined
  }
})()
if (skillRule?.effect === "deny") notes.push(`the project's permissions deny the skill ${SKILL}`)
if (pollers.length) notes.push(`polled: ${pollers.map((id) => (id === rootID ? "the root" : id)).join(", ")}`)
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
    { verdict, rootID, fault, staged, finding, sessions: Object.fromEntries([...tree].map(([id, entry]) => [id, { parentID: entry.parentID, depth: entry.depth }])), checks: Object.fromEntries(checks), notes, usage, finalText },
    null,
    2,
  ),
)
process.exit(passed ? 0 : verdict === "inconclusive" ? 2 : 1)
