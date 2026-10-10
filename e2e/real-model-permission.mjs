// The permission scenario of e2e/real-model.sh (node e2e/real-model-permission.mjs <parentSessionID>):
// the parent asks the person about its child's permission request, and the answer reaches the child.
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const [parentID] = process.argv.slice(2)
const server = process.env.SERVER
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`
const work = process.env.WORK
const timeout = Number(process.env.COURIER_TIMEOUT ?? 300) * 1000
const expected = (process.env.COURIER_EXPECT ?? "").trim()
const ANSWER = "Allow it once."
const other = process.env.COURIER_OTHER_SERVER

async function api(path, init = {}, base = server) {
  const response = await fetch(`${base}/api/${path}`, {
    ...init,
    headers: { authorization: auth, "content-type": "application/json", ...init.headers },
  })
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${response.status} ${await response.text()}`)
  return response.status === 204 ? undefined : response.json()
}

async function messages(sessionID) {
  const all = []
  let query = "order=asc"
  for (;;) {
    const page = await api(`session/${sessionID}/message?${query}&limit=50`)
    all.push(...page.data)
    if (page.data.length < 50 || !page.cursor?.next) return all
    query = `cursor=${encodeURIComponent(page.cursor.next)}`
  }
}

const toolsOf = (list) => list.flatMap((message) => (message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : []))
const textOf = (message) =>
  message.type === "assistant" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") : (message.text ?? "")
// Since OpenCode 2.0.22 the transcript also records an `idle` message when a turn ends.
const ended = (message) =>
  message?.type === "idle" ||
  (message?.type === "assistant" && (message.finish !== undefined ? message.finish !== "tool-calls" : message.error !== undefined))
const settled = (list) => ended(list.at(-1)) && (list.at(-1).type === "idle" || list.at(-1).time.completed !== undefined)
const short = (value, max = 160) => {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}
const isNotice = (message) => message.type === "synthetic" && /^<courier from="ses_\w+" asks="permission"/.test(message.text)
const childOf = (part) =>
  part.name === "courier_spawn" && part.state.status === "completed"
    ? (part.state.metadata?.sessionID ?? part.state.metadata?.metadata?.sessionID)
    : undefined
// A message the child sent its parent with courier_send: its envelope carries the status, when it gave one, and nothing else.
const isReport = (message, child) => message.type === "synthetic" && new RegExp(`^<courier from="${child}"( status="\\w+")?>`).test(message.text)
const statusOf = (message) => message.text.match(/^<courier from="ses_\w+" status="(\w+)">/)?.[1]

/** Polls until `ready` returns something, or gives up after the timeout. */
async function until(what, ready) {
  const started = Date.now()
  for (;;) {
    try {
      const value = await ready()
      if (value) return value
    } catch (error) {
      console.log(`  (trying again: ${error.message})`)
    }
    if (Date.now() - started > timeout) {
      console.log(`  (gave up waiting for ${what} after ${timeout / 1000} s)`)
      return undefined
    }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
}

/** The answer a person who wants to allow it once gives to the parent's form. */
function answerOf(form) {
  const once = (options) =>
    options.find((option) => /once/i.test(`${option.value} ${option.label}`)) ??
    options.find((option) => /allow|approve|yes/i.test(`${option.value} ${option.label}`)) ??
    options[0]
  return Object.fromEntries(
    form.fields.flatMap((field) => {
      if (field.type === "boolean") return [[field.key, true]]
      if (field.type === "multiselect") return [[field.key, [once(field.options).value]]]
      if (field.type === "string") return [[field.key, field.options?.length ? once(field.options).value : "once"]]
      return []
    }),
  )
}

// 1. The child asks, the parent is told, and the turn that opens settles or waits on a form.
const told = await until("the parent to be told of the request, and to ask", async () => {
  const list = await messages(parentID)
  const notice = list.findIndex(isNotice)
  if (notice < 0) return undefined
  const forms = (await api(`session/${parentID}/form`)).data
  if (forms.length) return { list, notice, form: forms[0] }
  return settled(list) && list.length > notice + 1 ? { list, notice } : undefined
})

const before = told ? told.list.slice(told.notice + 1) : []
const answeredItself = toolsOf(before).some((part) => part.name === "courier_answer")
const last = told?.list.findLast((message) => message.type !== "idle")
const asked =
  Boolean(told) && !answeredItself && (told.form !== undefined || (ended(last) && !last.error && textOf(last).trim() !== ""))
let how = "did not ask"
let personAt = Infinity

// 2. The person answers, in the form or as a new message; with COURIER_OTHER_SERVER, through that server.
let elsewhereSaid = ""
if (told && !answeredItself && other) {
  if (told.form) {
    how = `asked with a question form, which the person dismissed: ${short(told.form.fields.map((field) => ({ title: field.title, options: field.options?.map((option) => option.label) })), 300)}`
    console.log("  the person dismisses the parent's form")
    await api(`session/${parentID}/form/${told.form.id}`, { method: "DELETE" })
    await until("the parent's turn to end after the dismissal", async () => {
      const list = await messages(parentID)
      const forms = (await api(`session/${parentID}/form`)).data
      for (const form of forms) await api(`session/${parentID}/form/${form.id}`, { method: "DELETE" })
      return forms.length === 0 && settled(list)
    })
  } else how = `asked in its reply: ${short(textOf(last).trim(), 300)}`
  personAt = Date.now()
  console.log(`  the person replies "${ANSWER}" through the other server`)
  await api(`session/${parentID}/prompt`, { method: "POST", body: JSON.stringify({ text: ANSWER }) }, other)
  await until("the parent's turn on the other server to end", async () => {
    const list = await messages(parentID)
    return toolsOf(list.filter((message) => message.time?.created >= personAt)).some((part) => part.name === "courier_answer") && settled(list)
      ? list
      : undefined
  })
  const list = await messages(parentID)
  elsewhereSaid = textOf(list.findLast((message) => message.type === "assistant" && textOf(message).trim()) ?? {}).trim()
  // The person follows the advice: allows the request in the child's own session, on the first server.
  const asking = told.list[told.notice].text
  const childID = asking.match(/<courier from="(ses_\w+)"/)?.[1]
  const request = asking.match(/request="(per_\w+)"/)?.[1]
  console.log(`  the person allows ${request} once in the child's own session`)
  await api(`session/${childID}/permission/${request}/reply`, { method: "POST", body: JSON.stringify({ decision: "once" }) }).catch(
    (error) => console.log(`  (the request could not be answered there: ${error.message})`),
  )
} else if (told && !answeredItself) {
  personAt = Date.now()
  if (told.form) {
    const answer = answerOf(told.form)
    how = `asked with a question form: ${short(told.form.fields.map((field) => ({ title: field.title, options: field.options?.map((option) => option.label) })), 300)}`
    console.log(`  the person answers the form with ${JSON.stringify(answer)}`)
    await api(`session/${parentID}/form/${told.form.id}/reply`, { method: "POST", body: JSON.stringify({ answer }) })
  } else {
    how = `asked in its reply: ${short(textOf(last).trim(), 300)}`
    console.log(`  the person replies "${ANSWER}"`)
    await api(`session/${parentID}/prompt`, { method: "POST", body: JSON.stringify({ text: ANSWER }) })
  }
}

// 3. The answer reaches the child, which runs its command and reports.
let parent = (await messages(parentID).catch(() => [])) ?? []
const child = toolsOf(parent).map(childOf).find(Boolean)
if (told)
  await until("the child's report and the parent's last turn", async () => {
    parent = await messages(parentID)
    return parent.some((message) => isReport(message, child)) && settled(parent)
  })
const childMessages = child ? await messages(child).catch(() => []) : []
writeFileSync(join(work, "parent.json"), JSON.stringify(parent, null, 2))
if (child) writeFileSync(join(work, `child-${child}.json`), JSON.stringify(childMessages, null, 2))

const lines = []
for (const message of parent) {
  if (message.type === "user") lines.push(`-> prompt: ${short(message.text.replace(/\s+/g, " "))}`)
  if (message.type === "synthetic") lines.push(`<- ${short(message.text.replace(/\s+/g, " "), 300)}`)
  if (message.type !== "assistant") continue
  for (const part of message.content) {
    if (part.type === "tool") lines.push(`  ${part.name}(${short(part.state.input, 200)}) -> ${part.state.status}`)
    if (part.type === "text" && part.text.trim()) lines.push(`  says: ${short(part.text.trim(), 300)}`)
  }
  if (message.error) lines.push(`  error: ${short(message.error)}`)
  if (ended(message)) lines.push(`  -- turn ended (${message.finish ?? message.outcome})`)
}
lines.push(`child ${child}:`)
for (const part of toolsOf(childMessages)) lines.push(`  ${part.name}(${short(part.state.input, 120)}) -> ${part.state.status}`)
const timeline = lines.join("\n")
writeFileSync(join(work, "timeline.txt"), `${timeline}\n`)
console.log(timeline)

const answers = toolsOf(parent).filter((part) => part.name === "courier_answer")
const afterPerson = parent.filter((message) => message.type === "assistant" && message.time.created >= personAt)
const passedOn = toolsOf(afterPerson).filter(
  (part) =>
    part.name === "courier_answer" &&
    part.state.status === "completed" &&
    part.state.input?.reply === "once" &&
    part.state.input?.sessionID === child &&
    (part.state.metadata?.answered ?? part.state.metadata?.metadata?.answered) === true,
)
const notPending = toolsOf(afterPerson).filter(
  (part) =>
    part.name === "courier_answer" &&
    part.state.status === "completed" &&
    (part.state.metadata?.answered ?? part.state.metadata?.metadata?.answered) === false &&
    (part.state.content ?? []).some((item) => item.text?.includes("another OpenCode server on the same data directory")),
)
const report = parent.find((message) => isReport(message, child))
const finalText = textOf(parent.findLast((message) => message.type === "assistant" && textOf(message).trim()) ?? {})
const checks = [
  ["the parent spawned a child, which asked for permission, and the parent was told", Boolean(child) && Boolean(told)],
  ["the parent did not answer the request by itself", Boolean(told) && !answeredItself],
  ["the parent asked the person", asked],
  other
    ? ["the parent's courier_answer on the other server passed nothing on and named another server", notPending.length > 0]
    : ["the parent passed on the person's choice (once) with courier_answer", passedOn.length > 0],
  ["the child ran its command and reported what it printed", Boolean(report) && expected !== "" && report.text.includes(expected)],
  ["the parent's final reply holds it", expected !== "" && finalText.includes(expected)],
]
const notes = [`the parent ${how}`]
if (report) notes.push(`the child's report carried ${statusOf(report) ? `status ${statusOf(report)}` : "no status"}`)
if (other) notes.push(`after courier_answer on the other server, the parent said: ${short(elsewhereSaid, 600)}`)
const asChecked = (other ? notPending : passedOn).length
if (answers.length > asChecked) notes.push(`courier_answer was called ${answers.length} time(s), ${asChecked} of them as checked`)
// Failed model requests, or a turn whose idle marker (2.0.22) says it failed: a run that fails its
// checks with any is inconclusive rather than failed. The two are counted apart.
const providerErrors = [...parent, ...childMessages].filter((message) => message.type === "assistant" && message.error !== undefined)
const failedTurns = [...parent, ...childMessages].filter((message) => message.type === "idle" && message.outcome === "failed").length
if (providerErrors.length) notes.push(`${providerErrors.length} model request(s) failed: ${[...new Set(providerErrors.map((message) => message.error.type ?? "error"))].join(", ")}`)
if (failedTurns) notes.push(`${failedTurns} turn(s) ended as failed`)

const passed = checks.every(([, ok]) => ok)
const verdict = passed ? "pass" : providerErrors.length || failedTurns ? "inconclusive" : "fail"
console.log("")
for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"} ${name}`)
for (const note of notes) console.log(`  note: ${note}`)
console.log(`result: ${verdict}${verdict === "inconclusive" ? " (checks failed, but so did model requests; run it again)" : ""}`)
writeFileSync(join(work, "summary.json"), JSON.stringify({ verdict, parentID, child, checks: Object.fromEntries(checks), notes, finalText }, null, 2))
process.exit(passed ? 0 : verdict === "inconclusive" ? 2 : 1)
