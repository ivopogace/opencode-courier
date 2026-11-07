import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [parentID, ...flags] = process.argv.slice(2)
const saved = flags.includes("--saved")
const server = process.env.SERVER
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`
const work = process.env.WORK
const timeout = Number(process.env.COURIER_TIMEOUT ?? 300) * 1000
const expected = (process.env.COURIER_EXPECT ?? "").trim()
const ANSWER = "Allow it once."
const other = process.env.COURIER_OTHER_SERVER
const NATIVE = process.env.COURIER_NATIVE === "1"

async function api(path, init = {}, base = server) {
  const response = await fetch(`${base}/api/${path}`, {
    ...init,
    headers: { authorization: auth, "content-type": "application/json", ...init.headers },
  })
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${response.status} ${await response.text()}`)
  return response.status === 204 ? undefined : response.json()
}

async function messages(sessionID) {
  if (saved) return JSON.parse(readFileSync(join(work, sessionID === parentID ? "parent.json" : `child-${sessionID}.json`), "utf8"))
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
// since OpenCode 2.0.22 a turn's end is also an `idle` message
const ended = (message) =>
  message?.type === "idle" ||
  (message?.type === "assistant" && (message.finish !== undefined ? message.finish !== "tool-calls" : message.error !== undefined))
const settled = (list) => ended(list.at(-1)) && (list.at(-1).type === "idle" || list.at(-1).time.completed !== undefined)
const short = (value, max = 160) => {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}
const isNotice = (message) => message.type === "synthetic" && /^<courier from="ses_\w+" asks="permission"/.test(message.text)
const promptFor = async (request) => (await api(`session/${parentID}/permission`)).data.find((item) => item.metadata?.requestID === request)
const lastAnswer = (list) => toolsOf(list).findLast((part) => part.name === "courier_answer")
const childOf = (part) =>
  part.name === "courier_spawn" && part.state.status === "completed"
    ? (part.state.metadata?.sessionID ?? part.state.metadata?.metadata?.sessionID)
    : undefined
const isReport = (message, child) => message.type === "synthetic" && new RegExp(`^<courier from="${child}"( status="\\w+")?>`).test(message.text)
const statusOf = (message) => message.text.match(/^<courier from="ses_\w+" status="(\w+)">/)?.[1]

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

const nativeSpawn = (list) => toolsOf(list).some((part) => part.name === "courier_spawn" && part.state.input?.native === true)
const proposesOnce = (message) =>
  message.type === "assistant" && message.content.some((part) => part.type === "tool" && part.name === "courier_answer" && part.state.input?.reply === "once")
const savedSummary = (() => {
  if (!saved) return undefined
  try {
    return JSON.parse(readFileSync(join(work, "summary.json"), "utf8"))
  } catch {
    return undefined
  }
})()
// What the person saw live, kept in summary.json since the checker could re-read a run; without it (an older run), read
// from the transcript: the parent's turn after the notice, where a courier_answer proposing once stands for the held prompt.
const kept = savedSummary?.observed
function toldFromTranscript(list) {
  const notice = list.findIndex(isNotice)
  if (notice < 0) return undefined
  const end = list.findIndex((message, index) => index > notice && ended(message))
  const turn = list.slice(notice + 1, end === -1 ? list.length : end + 1)
  const proposal = turn.findIndex(proposesOnce)
  if (proposal !== -1) {
    const at = notice + 1 + proposal
    const lines = list[notice].text.split("\n")
    const on = lines.indexOf("On:")
    const resources = on === -1 ? [] : lines.slice(on + 1, lines.indexOf("", on)).map((line) => line.replace(/^- /, ""))
    const pending = structuredClone(list[at])
    for (const part of pending.content) if (part.type === "tool" && part.name === "courier_answer") part.state.status = "running"
    return { list: [...list.slice(0, at), pending], notice, prompt: { action: lines.find((line) => line.startsWith("It asks for: "))?.slice(13), resources }, held: true }
  }
  if (toolsOf(turn).some((part) => part.name === "question")) return { list: list.slice(0, notice + 1 + turn.length), notice, form: { fields: [] } }
  return end === -1 ? undefined : { list: list.slice(0, end + 1), notice }
}
function personAtFromTranscript(list, told) {
  if (!told) return Infinity
  const after = list.slice(told.list.length)
  const answer = told.prompt ? told.list.at(-1) : after.find((message) => message.type === "user" || / answered="\w+"/.test(message.text ?? ""))
  return answer?.time.created ?? Infinity
}

const told = kept
  ? kept.told && { notice: kept.notice, prompt: kept.prompt ?? undefined, held: kept.held, form: kept.form ?? undefined }
  : saved
    ? toldFromTranscript(await messages(parentID))
    : await until("the parent to be told of the request, and to propose or ask", async () => {
        const list = await messages(parentID)
        const notice = list.findIndex(isNotice)
        if (notice < 0) return undefined
        const request = list[notice].text.match(/request="(per_\w+)"/)?.[1]
        const prompt = await promptFor(request)
        if (prompt) return { list, notice, prompt, held: lastAnswer(list)?.state.status === "running" }
        const forms = (await api(`session/${parentID}/form`)).data
        if (forms.length) return { list, notice, form: forms[0] }
        return settled(list) && list.length > notice + 1 ? { list, notice } : undefined
      })

const before = told?.list ? told.list.slice(told.notice + 1) : []
const answeredItself = kept ? kept.answeredItself : toolsOf(before).some((part) => part.name === "courier_answer" && part.state.status !== "running")
const questioned = kept ? kept.questioned : toolsOf(before).some((part) => part.name === "question")
const last = told?.list?.findLast((message) => message.type !== "idle")
const askedFirst = kept
  ? kept.askedFirst
  : Boolean(told) && !told.prompt && !answeredItself && (told.form !== undefined || (ended(last) && !last.error && textOf(last).trim() !== ""))
const noticeText = kept ? (kept.noticeText ?? "") : told ? told.list[told.notice].text : ""
// The parent may choose a native child on its own: courier_spawn's native, or the notice's shown="native", says so.
const native = kept ? kept.native : NATIVE || noticeText.includes('shown="native"') || nativeSpawn(told?.list ?? [])
let how = "did not ask"
let personAt = Infinity
const childIDOf = (text) => text.match(/<courier from="(ses_\w+)"/)?.[1]
const requestOf = (text) => text.match(/request="(per_\w+)"/)?.[1]
async function answerPrompt(decision) {
  const prompt = told.prompt ?? (await until("OpenCode's prompt in the parent's session", () => promptFor(requestOf(noticeText))))
  if (!prompt) return false
  console.log(`  the person answers OpenCode's prompt in the parent's session (${prompt.action}: ${prompt.resources.join(", ")}) with ${decision}`)
  await api(`session/${parentID}/permission/${prompt.id}/reply`, { method: "POST", body: JSON.stringify({ decision }) })
  return true
}

let elsewhereSaid = ""
if (kept) {
  how = kept.how
  personAt = kept.personAt ?? Infinity
  elsewhereSaid = kept.elsewhereSaid ?? ""
} else if (native && told && !answeredItself) {
  how = told.prompt
    ? "proposed once with courier_answer all the same, so OpenCode asked the person a second time, in the parent's session"
    : told.form
      ? "asked the person all the same, with a question form"
      : `did not ask with its question tool; it said: ${short(textOf(last).trim(), 300)}`
  if (!saved) {
    personAt = Date.now()
    const childID = childIDOf(noticeText)
    const request = requestOf(noticeText)
    console.log(`  the person allows ${request} once in OpenCode's own prompt`)
    await api(`session/${childID}/permission/${request}/reply`, { method: "POST", body: JSON.stringify({ decision: "once" }) })
    if (told.prompt) await answerPrompt("reject")
  }
} else if (told && !answeredItself && other) {
  if (told.prompt) {
    how = "proposed once with courier_answer, whose prompt the person rejected without a reason"
    if (!saved) {
      await answerPrompt("reject")
      await until("the parent's turn to end after the rejection", async () => settled(await messages(parentID)))
    }
  } else if (told.form) {
    how = `asked with a question form, which the person dismissed: ${short(told.form.fields.map((field) => ({ title: field.title, options: field.options?.map((option) => option.label) })), 300)}`
    if (!saved) {
      console.log("  the person dismisses the parent's form")
      await api(`session/${parentID}/form/${told.form.id}`, { method: "DELETE" })
      await until("the parent's turn to end after the dismissal", async () => {
        const list = await messages(parentID)
        const forms = (await api(`session/${parentID}/form`)).data
        for (const form of forms) await api(`session/${parentID}/form/${form.id}`, { method: "DELETE" })
        return forms.length === 0 && settled(list)
      })
    }
  } else how = `asked in its reply: ${short(textOf(last).trim(), 300)}`
  if (!saved) {
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
    const childID = childIDOf(noticeText)
    const request = requestOf(noticeText)
    console.log(`  the person allows ${request} once in the child's own session`)
    await api(`session/${childID}/permission/${request}/reply`, { method: "POST", body: JSON.stringify({ decision: "once" }) }).catch(
      (error) => console.log(`  (the request could not be answered there: ${error.message})`),
    )
  }
} else if (told && !answeredItself) {
  if (!saved) personAt = Date.now()
  if (told.prompt) {
    how = `proposed once with courier_answer${told.held ? ", which was held" : ""}, and OpenCode asked the person in its session`
  } else if (told.form) {
    const answer = answerOf(told.form)
    how = `asked with a question form first: ${short(told.form.fields.map((field) => ({ title: field.title, options: field.options?.map((option) => option.label) })), 300)}`
    if (!saved) {
      console.log(`  the person answers the form with ${JSON.stringify(answer)}`)
      await api(`session/${parentID}/form/${told.form.id}/reply`, { method: "POST", body: JSON.stringify({ answer }) })
    }
  } else {
    how = `asked in its reply first: ${short(textOf(last).trim(), 300)}`
    if (!saved) {
      console.log(`  the person replies "${ANSWER}"`)
      await api(`session/${parentID}/prompt`, { method: "POST", body: JSON.stringify({ text: ANSWER }) })
    }
  }
  if (!saved) await answerPrompt("once")
}
if (saved && !kept) personAt = personAtFromTranscript(await messages(parentID), told)

let parent = (await messages(parentID).catch(() => [])) ?? []
const child = toolsOf(parent).map(childOf).find(Boolean)
if (told && !saved)
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
const completedAfter = (part) => (part.state.time?.end ?? personAt) >= personAt
const passedOn = toolsOf(parent).filter(
  (part) =>
    part.name === "courier_answer" &&
    part.state.status === "completed" &&
    completedAfter(part) &&
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
const askedAgain = Boolean(told?.form) || Boolean(native && told?.prompt) || questioned
const settledOnce = parent.some((message) => message.type === "synthetic" && / answered="once"/.test(message.text))
const passedOnWhenTold = passedOn.filter((part) => toolsOf(afterPerson).includes(part))
const prompted = Boolean(told?.prompt) && told.prompt.action === "shell" && told.prompt.resources.some((item) => item.includes("courier-permission"))
const checks = native
  ? [
      ["the parent spawned a child, which asked for permission, and the parent was told that OpenCode shows it", Boolean(child) && noticeText.includes('shown="native"')],
      ["the parent did not answer the request by itself", Boolean(told) && !answeredItself],
      ["the parent did not ask the person again", Boolean(told) && !askedAgain],
      [
        "the request was settled: the parent was told so, or passed once on with courier_answer after the person told it to",
        settledOnce || passedOnWhenTold.length > 0,
      ],
      ["the child ran its command and reported what it printed", Boolean(report) && expected !== "" && report.text.includes(expected)],
      ["the parent's final reply holds it", expected !== "" && finalText.includes(expected)],
    ]
  : [
      ["the parent spawned a child, which asked for permission, and the parent was told", Boolean(child) && Boolean(told)],
      ["nothing was passed on before the person had answered", Boolean(told) && !answeredItself],
      ["the parent proposed once with courier_answer, without asking the person first", Boolean(told?.prompt) && !askedFirst],
      ["OpenCode asked the person in the parent's session, for what the child asked, holding courier_answer", prompted && Boolean(told?.held)],
      other
        ? ["the parent's courier_answer on the other server passed nothing on and named another server", notPending.length > 0]
        : ["courier_answer passed once on after the person allowed it", passedOn.length > 0],
      ["the child ran its command and reported what it printed", Boolean(report) && expected !== "" && report.text.includes(expected)],
      ["the parent's final reply holds it", expected !== "" && finalText.includes(expected)],
    ]
const notes = [`the parent ${how}`]
if (native && !NATIVE) notes.push("the parent made its child native itself (courier_spawn with native: true, or a notice with shown=\"native\"), so the native path's checks apply")
if (report) notes.push(`the child's report carried ${statusOf(report) ? `status ${statusOf(report)}` : "no status"}`)
if (other) notes.push(`after courier_answer on the other server, the parent said: ${short(elsewhereSaid, 600)}`)
const asChecked = (other ? notPending : passedOn).length
if (answers.length > asChecked) notes.push(`courier_answer was called ${answers.length} time(s), ${asChecked} of them as checked`)
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
// what only the live run could see (OpenCode's prompt and form in the parent's session), for --saved
const observed = kept ?? {
  told: Boolean(told),
  notice: told?.notice,
  noticeText,
  native,
  prompt: told?.prompt ? { action: told.prompt.action, resources: told.prompt.resources } : null,
  held: Boolean(told?.held),
  form: told?.form ? { fields: told.form.fields.map((field) => ({ title: field.title, options: field.options?.map((option) => ({ label: option.label })) })) } : null,
  answeredItself,
  questioned,
  askedFirst,
  how,
  personAt: Number.isFinite(personAt) ? personAt : null,
  elsewhereSaid,
}
writeFileSync(
  join(work, "summary.json"),
  JSON.stringify({ verdict, parentID, child, checks: Object.fromEntries(checks), notes, finalText, ...(saved && !kept ? {} : { observed }) }, null, 2),
)
process.exit(passed ? 0 : verdict === "inconclusive" ? 2 : 1)
