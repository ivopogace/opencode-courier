// The question scenario of e2e/real-model.sh: a real model's child is to find out from the person
// which greeting to use, without being told how to ask. Checks how it asks (its question tool, which
// the plugin relays, or a courier_send to its parent), that the parent asks the person in its own
// session with the child's options rather than answering by itself, plays the person (answering the
// parent's question form, or its question in text, with COURIER_ANSWER), and checks that the answer
// reaches the child, which reports it. Called once the parent has been prompted:
//
//   node e2e/real-model-question.mjs <parentSessionID>
//
// Reads SERVER, OPENCODE_PASSWORD, WORK, COURIER_TIMEOUT (seconds to wait at each stage) and
// COURIER_ANSWER (the greeting the person picks, default Hi). Exits 0 when every check passes, 2 when
// some failed along with model requests (inconclusive), else 1.
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const [parentID] = process.argv.slice(2)
const server = process.env.SERVER
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`
const work = process.env.WORK
const timeout = Number(process.env.COURIER_TIMEOUT ?? 300) * 1000
const ANSWER = process.env.COURIER_ANSWER || "Hi"

async function api(path, init = {}) {
  const response = await fetch(`${server}/api/${path}`, {
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

const forms = async (sessionID) => (await api(`session/${sessionID}/form`)).data
const toolsOf = (list) => list.flatMap((message) => (message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : []))
const textOf = (message) =>
  message.type === "assistant" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") : (message.text ?? "")
// Since OpenCode 2.0.22 the transcript also records an `idle` message when a turn ends.
const ended = (message) =>
  message?.type === "idle" ||
  (message?.type === "assistant" && (message.finish !== undefined ? message.finish !== "tool-calls" : message.error !== undefined))
const settled = (list) => ended(list.at(-1)) && (list.at(-1).type === "idle" || list.at(-1).time.completed !== undefined)
// The last message that is not the idle marker.
const lastStep = (list) => list.findLast((message) => message.type !== "idle") ?? {}
const short = (value, max = 160) => {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}
const metadataOf = (part) => part.state.metadata?.metadata ?? part.state.metadata ?? {}
const childOf = (part) => (part.name === "courier_spawn" && part.state.status === "completed" ? metadataOf(part).sessionID : undefined)
const labels = (form) => JSON.stringify(form.fields.map((field) => (field.options ?? []).map((option) => option.label).sort()))
const isNotice = (message) => message.type === "synthetic" && /^<courier from="ses_\w+" asks="question"/.test(message.text)
const isReport = (message, child) => message.type === "synthetic" && message.text.startsWith(`<courier from="${child}">`)

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

/** The person's pick in a form: the option labelled with the answer, or the answer typed in. */
function answerOf(form) {
  return Object.fromEntries(
    form.fields.map((field) => {
      const option = field.options?.find((item) => item.label.toLowerCase().includes(ANSWER.toLowerCase()))
      const value = option?.value ?? ANSWER
      return [field.key, field.type === "multiselect" ? [value] : value]
    }),
  )
}

// 1. The child asks, with its question tool or a message, and the parent asks the person: a form in
//    the parent's session, or a turn that ends with a question in text.
let child
let childForm
const asked = await until("the parent to ask the person", async () => {
  const list = await messages(parentID)
  child ??= toolsOf(list).map(childOf).find(Boolean)
  if (!child) return undefined
  childForm ??= (await forms(child))[0]
  const form = (await forms(parentID))[0]
  if (form) return { list, form }
  const told = list.findIndex((message) => isNotice(message) || isReport(message, child))
  return told >= 0 && settled(list) && list.length > told + 1 && !list.some((message) => isReport(message, child) && message.text.includes(ANSWER))
    ? { list }
    : undefined
})

const childBefore = child ? await messages(child) : []
const route = toolsOf(childBefore).some((part) => part.name === "question")
  ? "question tool"
  : toolsOf(childBefore).some((part) => part.name === "courier_send")
    ? "courier_send"
    : "none"
const notice = asked?.list.find(isNotice)
const answeredItself = asked
  ? toolsOf(asked.list).some((part) => part.name === "courier_answer") ||
    (route === "courier_send" && toolsOf(asked.list).some((part) => part.name === "courier_send" && JSON.stringify(part.state.input).includes(ANSWER)))
  : false
let how = "did not ask"
let personAt = Infinity

// 2. The person answers, in the parent's form or as a new message.
if (asked && !answeredItself) {
  personAt = Date.now()
  if (asked.form) {
    const answer = answerOf(asked.form)
    how = `asked with a question form: ${short(asked.form.fields.map((field) => ({ question: field.description, options: field.options?.map((option) => option.label) })), 300)}`
    console.log(`  the person answers the parent's form with ${JSON.stringify(answer)}`)
    await api(`session/${parentID}/form/${asked.form.id}/reply`, { method: "POST", body: JSON.stringify({ answer }) })
  } else {
    how = `asked in its reply: ${short(textOf(lastStep(asked.list)).trim(), 300)}`
    console.log(`  the person replies "${ANSWER}"`)
    await api(`session/${parentID}/prompt`, { method: "POST", body: JSON.stringify({ text: ANSWER }) })
  }
}

// 3. The answer reaches the child, which reports it, and the parent's turn settles.
let parent = (await messages(parentID).catch(() => [])) ?? []
if (asked)
  await until("the child's report and the parent's last turn", async () => {
    parent = await messages(parentID)
    return parent.some((message) => isReport(message, child) && message.text.includes(ANSWER)) && settled(parent)
  })
const childMessages = child ? await messages(child).catch(() => []) : []
writeFileSync(join(work, "parent.json"), JSON.stringify(parent, null, 2))
if (child) writeFileSync(join(work, `child-${child}.json`), JSON.stringify(childMessages, null, 2))

const lines = []
for (const [name, list] of [["parent", parent], [`child ${child}`, childMessages]]) {
  lines.push(`${name}:`)
  for (const message of list) {
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
}
const timeline = lines.join("\n")
writeFileSync(join(work, "timeline.txt"), `${timeline}\n`)
console.log(timeline)

const question = toolsOf(childMessages).find((part) => part.name === "question")
// Over the whole transcript: the parent's own question call starts before the person answers it, and
// a courier_answer before that already fails "did not answer by itself".
const passedOn = toolsOf(parent).filter(
  (part) =>
    (part.name === "question" && metadataOf(part).passed === true) ||
    (part.name === "courier_answer" && part.state.status === "completed" && metadataOf(part).answered === true) ||
    (part.name === "courier_send" && part.state.input?.sessionID === child && JSON.stringify(part.state.input).includes(ANSWER)),
)
const report = parent.find((message) => isReport(message, child) && message.text.includes(ANSWER))
const finalText = textOf(parent.findLast((message) => message.type === "assistant" && textOf(message).trim()) ?? {})
const checks = [
  ["the parent spawned a child, which asked, and the parent asked the person", Boolean(child) && Boolean(asked)],
  ["the parent did not answer by itself", Boolean(asked) && !answeredItself],
  [
    "the parent asked with the child's options",
    (Boolean(asked?.form) && (route !== "question tool" || (childForm !== undefined && labels(asked.form) === labels(childForm)))) ||
      (Boolean(asked) && !asked.form && ["Hello", "Hi", "Hey"].every((option) => textOf(lastStep(asked.list)).includes(option))),
  ],
  ["the parent passed on the person's answer", passedOn.length > 0],
  ["the child got the answer and reported it", Boolean(report)],
  ["the parent's final reply holds it", finalText.includes(ANSWER)],
]
const notes = [`the child asked with: ${route}`, `the parent ${how}`]
if (route === "question tool") {
  notes.push(`the parent was ${notice ? "" : "not "}told with a question notice`)
  const result = question?.state.content?.map((part) => part.text ?? "").join("") || question?.state.error || ""
  notes.push(`the child's question call ended ${question?.state.status}: ${short(result, 200)}`)
}
notes.push(`passed on with: ${[...new Set(passedOn.map((part) => (part.name === "question" ? "the linked question" : part.name)))].join(", ") || "nothing"}`)
if (personAt !== Infinity && report) notes.push(`from the person's answer to the child's report: ${Math.round((report.time.created - personAt) / 1000)} s`)
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
writeFileSync(join(work, "summary.json"), JSON.stringify({ verdict, parentID, child, route, checks: Object.fromEntries(checks), notes, finalText }, null, 2))
process.exit(passed ? 0 : verdict === "inconclusive" ? 2 : 1)
