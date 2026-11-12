import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [rootID, ...flags] = process.argv.slice(2)
const saved = flags.includes("--saved")
const server = process.env.SERVER
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`
const work = process.env.WORK
const timeout = Number(process.env.COURIER_TIMEOUT ?? 300) * 1000
const expected = (process.env.COURIER_EXPECT ?? "").split(/\s+/).filter(Boolean)
const files = (process.env.COURIER_FILES ?? "").split(/\s+/).filter(Boolean)
const KEY = /\bkey-[0-9a-f]{8}\b/
const GO = ".go-parts"
const LOOKS = new Set(["courier_children", "courier_tree"])
const RECALL = "courier_recall"
const SKILL = "courier-orchestrate"

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
const ended = (message) =>
  message?.type === "idle" ||
  (message?.type === "assistant" && (message.finish !== undefined ? message.finish !== "tool-calls" : message.error !== undefined))
const settled = (list) => ended(list.at(-1)) && (list.at(-1).type === "idle" || list.at(-1).time.completed !== undefined)
const taskOf = (list) => textOf(list.find((message) => message.type === "user" || message.type === "synthetic") ?? {})
const commandsOf = (list) => toolsOf(list).flatMap((part) => (part.name === "shell" ? [part.state.input?.command ?? ""] : []))
const waits = (list) => commandsOf(list).some((command) => command.includes(GO))
const inits = (list) => commandsOf(list).some((command) => /api\.sh init\b/.test(command))
const isConsumer = (list) => waits(list) || (!inits(list) && taskOf(list).includes(GO))
const isInit = (list) => !isConsumer(list) && (inits(list) || /api\.sh init\b/.test(taskOf(list)))
const fileOf = (list) => taskOf(list).match(/out\/[ab]\.txt/)?.[0]
const short = (value, max = 160) => {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}
const clock = (ms) => new Date(ms).toISOString().slice(11, 23)
const spanOf = (time) =>
  time?.created === undefined
    ? ""
    : `${clock(time.created)} -> ${time.completed === undefined ? "…" : `${clock(time.completed)} (${((time.completed - time.created) / 1000).toFixed(1)} s)`}`
function turnsOf(list) {
  const turns = []
  let busy = false
  let last
  for (const message of list) {
    if (message.type === "system") continue
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
function childOf(part) {
  if (part.name !== "courier_spawn" || part.state.status !== "completed") return undefined
  const metadata = part.state.metadata ?? {}
  return metadata.sessionID ?? metadata.metadata?.sessionID ?? contentText(part.state).match(/Started session (ses_\w+)/)?.[1]
}
const spawnsOf = (list) => toolsOf(list).map(childOf).filter(Boolean)
const sendersOf = (message) => (message.type === "synthetic" ? (message.text.match(/^<courier from="([^"]+)"/)?.[1].split(",") ?? []) : [])
const groupOf = (message) => message.text?.match(/^<courier from="[^"]*" group="([^"]+)"/)?.[1]
const scheduled = (message) => /^<courier [^>]*scheduled="/.test(message.text ?? "")
const statusOf = (message, from) =>
  groupOf(message)
    ? message.text.match(new RegExp(`^\\[\\d+/\\d+\\] ${from} ".*": (\\w+)$`, "m"))?.[1]
    : message.text.match(/^<courier from="ses_\w+" status="(\w+)">/)?.[1]
const reportersOf = (message) => (scheduled(message) ? [] : sendersOf(message))
const deliveriesFrom = (list, child) =>
  list.flatMap((message, index) => (reportersOf(message).includes(child) && statusOf(message, child) ? [{ index, message }] : []))
const sendsTo = (list, to) =>
  list.flatMap((message, index) =>
    message.type !== "assistant"
      ? []
      : message.content.flatMap((part, place) =>
          part.type === "tool" && part.name === "courier_send" && part.state.status === "completed" && part.state.input?.sessionID === to
            ? [{ index, place, status: part.state.input.status, message: part.state.input.message ?? "" }]
            : [],
        ),
  )
const reportsTo = (list, parentID) => sendsTo(list, parentID).filter((send) => send.status)
const plainFrom = (list, from, after, key) =>
  list.findIndex((message, index) => index > after && sendersOf(message).includes(from) && !groupOf(message) && !statusOf(message, from) && message.text.includes(key))
const plainAfter = (list, to, after, key) => sendsTo(list, to).find((send) => send.index > after && !send.status && send.message.includes(key))
const spawnedAfter = (list, child, after, key) =>
  list.some((message, index) => index > after && message.type === "assistant" && message.content.some((part) => childOf(part) === child && (part.state.input?.task ?? "").includes(key)))
const toldAfter = (list, child, after, key) => plainAfter(list, child, after, key) ?? (spawnedAfter(list, child, after, key) ? { spawned: true } : undefined)
const sectionOf = (message, from) => {
  if (!groupOf(message)) return message.text
  const lines = message.text.split("\n")
  const header = /^\[\d+\/\d+\] (ses_\w+) "/
  const start = lines.findIndex((line) => line.match(header)?.[1] === from)
  const end = lines.findIndex((line, index) => index > start && header.test(line))
  return start === -1 ? "" : lines.slice(start + 1, end === -1 ? lines.length : end).join("\n")
}
const foundIn = (list, from) => list.findIndex((message) => reportersOf(message).includes(from) && KEY.test(sectionOf(message, from)))
const keyAt = (list, from, index) => (index === -1 ? undefined : sectionOf(list[index], from).match(KEY)[0])
const arrivalOf = (root, init, initID) => {
  const told = foundIn(root, initID)
  const key = sendsTo(init, rootID).map((send) => send.message.match(KEY)?.[0]).find(Boolean) ?? keyAt(root, initID, told)
  const seen = (message) => message.type === "assistant" && message.content.some((part) => part.type === "tool" && LOOKS.has(part.name) && JSON.stringify(part.state).includes(key))
  const looked = key === undefined ? -1 : root.findIndex(seen)
  const first = told === -1 ? looked : looked === -1 ? told : Math.min(told, looked)
  return { foundAt: first, key, looked: looked !== -1 && looked === first }
}

async function readTree() {
  const sessions = new Map([[rootID, { parentID: undefined, depth: 0, list: await messages(rootID) }]])
  for (const [id, entry] of sessions)
    for (const child of spawnsOf(entry.list))
      if (!sessions.has(child) && entry.depth < 4) sessions.set(child, { parentID: id, depth: entry.depth + 1, list: await messages(child) })
  return sessions
}
const rolesOf = (tree) => {
  const parts = [...tree].filter(([, entry]) => entry.depth === 1)
  const [initID] = parts.find(([, entry]) => isInit(entry.list)) ?? []
  return { initID, consumers: parts.filter(([id]) => id !== initID) }
}

const GRACE_MS = 30_000
const started = Date.now()
let quietSince
let released = false
let tree = new Map()
for (;;) {
  let done = false
  try {
    tree = await readTree()
    const root = tree.get(rootID).list
    const { initID, consumers } = rolesOf(tree)
    const init = initID ? tree.get(initID).list : []
    const { foundAt, key } = initID ? arrivalOf(root, init, initID) : { foundAt: -1 }
    const passed = foundAt !== -1 && consumers.every(([id]) => toldAfter(root, id, foundAt, key))
    const answered = foundAt !== -1 && settled(root) && root.slice(foundAt + 1).some((message) => message.type === "assistant")
    const onItsWay = sendsTo(init, rootID).some((send) => !send.status && KEY.test(send.message))
    const held = foundAt === -1 && !onItsWay && settled(init) && reportsTo(init, rootID).length > 0 && settled(root)
    const why = passed ? `the root has given ${consumers.length} parts the key since it arrived` : answered ? "the root ended its turn on the key without passing it on to each part" : held ? 'the "init" session has reported and no key has reached the root' : undefined
    if (!saved && !released && consumers.length >= 2 && why) {
      writeFileSync(join(work, "project", GO), "")
      released = true
      console.log(`  (${why}: created ${GO})`)
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
      lines.push(`${pad}  step ${spanOf(message.time)}`)
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

const root = tree.get(rootID).list
const turns = turnsOf(root)
const first = turns[0] ?? []
const spawned = [...tree].filter(([id]) => id !== rootID)
const { initID, consumers } = rolesOf(tree)
const init = initID ? tree.get(initID).list : []
const spawnsIn = (turn) => toolsOf(turn).filter(childOf).length
const sleeps = (part) => part.name === "shell" && /\bsleep\b/.test(JSON.stringify(part.state.input))
const looksIn = (turn) => toolsOf(turn).filter((part) => LOOKS.has(part.name) || part.name === RECALL || sleeps(part)).length
const allowedRecall = (turn) => {
  const tools = toolsOf(turn)
  const firstSpawn = tools.findIndex(childOf)
  const recalls = tools.flatMap((part, index) => (part.name === RECALL ? [index] : []))
  return recalls.length === 1 && (firstSpawn === -1 || recalls[0] < firstSpawn) ? 1 : 0
}
const segmentsOf = (turn) =>
  turn.reduce((segments, message, index) => {
    if (index > 0 && sendersOf(message).length) segments.push([])
    segments.at(-1).push(message)
    return segments
  }, [[]])
const [opening = [], ...woken] = turns.flatMap(segmentsOf)
const polled = looksIn(opening) - allowedRecall(first) > 0 || woken.some((segment) => looksIn(segment) > 1)
const finalText = textOf(root.findLast((message) => message.type === "assistant" && textOf(message).trim()) ?? {})
const fileText = (file) => {
  try {
    return readFileSync(join(work, "project", file), "utf8").trim()
  } catch {
    return undefined
  }
}
const fileTexts = files.map(fileText)

const { foundAt, key, looked } = initID ? arrivalOf(root, init, initID) : { foundAt: -1 }
const foundSend = sendsTo(init, rootID).find((send) => KEY.test(send.message))
const onward = consumers.map(([id, entry]) => {
  const told = foundAt === -1 ? undefined : toldAfter(root, id, foundAt, key)
  const reached = told?.spawned ? 0 : told ? plainFrom(entry.list, rootID, 0, key) : -1
  const report = reportsTo(entry.list, rootID)[0]
  return { id, entry, told, reached, inTime: reached !== -1 && (report === undefined || reached < report.index) }
})
const outFiles = consumers.map(([, entry]) => fileOf(entry.list)).filter(Boolean)
const startedTwice = outFiles.length !== new Set(outFiles).size
const stopped = toolsOf(root).filter((part) => part.name === "courier_stop" && part.state.status === "completed").length

const checks = [
  ["the root spawned the three parts with courier_spawn in its first turn", spawnsIn(first) >= 3],
  [
    "the root ended its first turn after spawning, without waiting for the reports (one steered into it while it ran is delivered)",
    spawnsIn(first) > 0 && ended(first.at(-1)) && !failed(first.at(-1)),
  ],
  ["the root did not poll (courier_children, courier_tree, sleep)", !polled],
  ["every spawned session reported to its parent, with a status", spawned.length > 0 && spawned.every(([id, entry]) => deliveriesFrom(tree.get(entry.parentID).list, id).length > 0)],
  ['what the "init" session found, the key that get needs, reached the root from that session', foundAt !== -1],
  ["the root passed the key on to each of the other parts, without a status, once it had arrived", onward.length >= 2 && onward.every((one) => one.told)],
  ["each of those parts had it before it reported, and the root stopped no part and started none a second time", onward.length >= 2 && onward.every((one) => one.inTime) && !startedTwice && stopped === 0],
  ["the files hold the expected values", files.length > 0 && files.length === expected.length && fileTexts.every((text, index) => text === expected[index])],
  ["the root's final reply holds every expected result", expected.length > 0 && expected.every((value) => new RegExp(`(?<![\\d.,])${value}(?![\\d.,]*\\d)`).test(finalText))],
]

const notes = []
const who = (id) => (id === rootID ? "the root" : `session ${id} (depth ${tree.get(id).depth})`)
const loadsAnySkill = (part) => part.type === "tool" && part.name === "skill" && part.state.status === "completed"
for (const [id, entry] of tree) {
  const loads = toolsOf(entry.list).filter(loadsAnySkill).map((part) => part.state.input?.id)
  if (loads.length) notes.push(`${who(id)} loaded the skill(s): ${loads.join(", ")}`)
}
if (![...tree.values()].some((entry) => toolsOf(entry.list).some((part) => part.name === "skill"))) notes.push("no session loaded a skill")
const recalls = toolsOf(root).filter((part) => part.name === RECALL).length
notes.push(recalls ? `the root called courier_recall ${recalls} time(s)` : "no session called courier_recall")
const splitLineOf = (text) => (text.match(/^\s*(?:[*_#>`-]+\s*)*split:.*$/im) ?? text.match(/^.*\bsplit:.*$/im))?.[0].trim()
const decision = splitLineOf(first.filter((message) => message.type === "assistant").map(textOf).join("\n"))
if (decision) notes.push(`the root stated: ${decision.slice(0, 320)}`)
for (const [id, entry] of [...tree].filter(([, entry]) => spawnsOf(entry.list).length > 0)) {
  const groups = [...new Set(toolsOf(entry.list).filter((part) => childOf(part) && part.state.input?.group).map((part) => part.state.input.group))]
  notes.push(`${who(id)} started ${spawnsOf(entry.list).length} session(s)${groups.length ? ` in group(s) ${groups.join(", ")}` : ", in no group"}`)
}
const rootTools = toolsOf(root)
const load = rootTools.findIndex((part) => loadsAnySkill(part) && part.state.input?.id === SKILL)
notes.push(`the root orchestrated ${load === -1 ? `without ${SKILL} loaded` : load < rootTools.findIndex(childOf) ? `with ${SKILL} loaded before its first spawn` : `with ${SKILL} loaded only after its first spawn`}`)
if (polled) notes.push("polled: the root")
if (!initID) notes.push('discovery: no session at depth 1 has the task for the "init" part')
else if (!foundSend) notes.push(`discovery: the "init" session sent the root no key; its sends: ${short(sendsTo(init, rootID).map((send) => send.message), 240)}`)
else notes.push(`discovery: the "init" session sent it ${foundSend.status ? `in its report, status ${foundSend.status}` : "without a status, before its report"}: ${short(foundSend.message, 200)}`)
if (initID && foundAt !== -1) {
  const arrival = root[foundAt]
  const running = consumers.filter(([, entry]) => reportsTo(entry.list, rootID).every((send) => entry.list[send.index].time.created > arrival.time.created)).length
  notes.push(`discovery: it reached the root ${looked ? "through its own look with courier_children or courier_tree, the report still held" : groupOf(arrival) ? `in the reports of group "${groupOf(arrival)}"` : "in a message of its own"}, with ${running} of ${consumers.length} other parts yet to report`)
}
for (const one of onward) {
  if (one.told?.spawned) notes.push(`discovery: the root started ${one.id} only after the finding had arrived: staged, nothing to pass on mid-run`)
  else if (one.told) notes.push(`discovery: the root told ${one.id}: ${short(one.told.message, 200)}`)
  else notes.push(`discovery: the root sent ${one.id} no message without a status that holds the key`)
  const own = toolsOf(one.entry.list).filter((part) => part.name === "shell" && /api\.sh init\b|\.api-key|share\/opencode|server\.log|probe\.log|key-\[/.test(part.state.input?.command ?? ""))
  if (own.length) notes.push(`discovery: ${one.id} ran init, touched the key's file or searched outside the project for the key, ${own.length} call(s): what it wrote does not show the relay`)
}
if (startedTwice) notes.push("discovery: the root started a part a second time")
if (stopped) notes.push(`discovery: the root stopped ${stopped} session(s)`)
const touched = [...tree].filter(([, entry]) => toolsOf(entry.list).some((part) => part.name === "shell" && /(touch|>|rm)\s[^|;&]*\.go-parts/.test(part.state.input?.command ?? ""))).map(([id]) => id)
if (touched.length) notes.push(`discovery: ${touched.map(who).join(", ")} created or removed ${GO}`)
for (const [id, entry] of spawned) {
  const report = deliveriesFrom(tree.get(entry.parentID).list, id)[0]
  if (report) notes.push(`report from ${id} (depth ${entry.depth})${groupOf(report.message) ? ` in group "${groupOf(report.message)}"` : ""}: status ${statusOf(report.message, id)}`)
}
if (files.length) notes.push(`files: ${files.map((file, index) => `${file}=${fileTexts[index] ?? "(missing)"}`).join(", ")}`)

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
