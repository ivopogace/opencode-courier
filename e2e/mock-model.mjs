import { appendFileSync, readFileSync } from "node:fs"
import { createServer } from "node:http"

const port = Number(process.env.MOCK_PORT ?? 4599)
const log = process.env.MOCK_LOG
const childDelay = Number(process.env.MOCK_CHILD_DELAY_MS ?? 0)
const delayFile = process.env.MOCK_CHILD_DELAY_FILE
const currentDelay = () => {
  try {
    const ms = Number.parseInt(readFileSync(delayFile, "utf8"), 10)
    return Number.isFinite(ms) ? ms : childDelay
  } catch {
    return childDelay
  }
}
const holdMs = Number(process.env.MOCK_HOLD_MS ?? 90_000)

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part === "string" ? part : (part.text ?? ""))).join("")
      : ""

const QUESTION_NOTICE = /<courier from="(ses_\w+)" asks="question" request="(question_[\w-]+)"[^>]*>/
const answersIn = (text) => [...text.matchAll(/"[^"]*"="([^"]*)"/g)].map((match) => match[1].split(", "))

const GIT = "git -c user.name=courier -c user.email=courier@example.invalid"
const branchIn = (messages) => textOf(messages.find((message) => message.role === "user")?.content).match(/branch (courier\/ses_\w+)/)?.[1]

const isInstructionUpdate = (message) => /^<system-update>\n/.test(textOf(message.content))

const SUMMARY = "## Objective\n- Courier test"

const TYPED_ENVELOPE = /<courier from="courier" route="prompt" in="ses_\w+">/

const HOST_REPORT = /<subagent sessionID="(ses_\w+)" state="[^"]*"[^>]*>[\s\S]*?<\/subagent>/g

const withoutReportsOf = (started) => (message) => {
  if (message.role !== "user") return message
  const strip = (text) => text.replace(HOST_REPORT, (block, id) => (started.has(id) ? "" : block))
  const content = typeof message.content === "string" ? strip(message.content) : Array.isArray(message.content) ? message.content.map((part) => (typeof part?.text === "string" ? { ...part, text: strip(part.text) } : part)) : message.content
  return { ...message, content }
}

function courierChildReportsDropped(messages) {
  const started = new Set(
    messages.filter((message) => message.role === "tool").flatMap((message) => [...textOf(message.content).matchAll(/Started session (ses_\w+) in /g)].map((match) => match[1])),
  )
  if (!started.size) return messages
  const strip = withoutReportsOf(started)
  return messages.flatMap((message) => {
    const stripped = strip(message)
    return message.role === "user" && textOf(message.content).includes("<subagent ") && !textOf(stripped.content).trim() ? [] : [stripped]
  })
}

function decide(body) {
  const shown = (body.messages ?? []).filter((message) => !isInstructionUpdate(message))
  const messages = courierChildReportsDropped(shown)
  if (messages.length < shown.length && messages.at(-1)?.role === "assistant") return { text: "NOTED CHILD TURN END" }
  if (!body.tools?.length) return { text: messages.some((message) => textOf(message.content).includes(DEMO_PROMPT)) ? "Fix #12 and #15" : SUMMARY }
  const asked = textOf(messages.findLast((message) => message.role === "user")?.content)
  if (asked.includes("Summarize only what the user and the assistant said") || asked.includes("did not fill in the required summary template")) return { text: SUMMARY }
  const lastAssistant = messages.findLastIndex((message) => message.role === "assistant")
  const last = messages.at(-1)
  const prompt = textOf(messages.findLast((message) => message.role === "user")?.content)
  const relayed = relayFinding(messages, lastAssistant)
  if (relayed) return relayed
  const personRelayed = relayPersonWords(messages, lastAssistant)
  if (personRelayed) return personRelayed
  if (TYPED_ENVELOPE.test(textOf(last?.content))) return decide({ ...body, messages: messages.slice(0, -1) })
  const finding = passFinding(messages, lastAssistant)
  if (finding) return finding
  const demo = demoTree(messages, lastAssistant)
  if (demo) return demo
  const role = roleEntry(messages, lastAssistant)
  if (role) return role
  const down = statusDown(messages, lastAssistant)
  if (down) return down
  if (last?.role === "tool") {
    const call = messages[lastAssistant]?.tool_calls?.find((item) => item.id === last.tool_call_id)
    const result = textOf(last.content)
    const scheduled = result.match(/Scheduled (later_[\w-]+)/)
    if (call?.function?.name === "courier_later" && prompt.includes("COURIER-LATER-CANCEL") && scheduled)
      return { tool: "courier_cancel", args: { id: scheduled[1] } }
    if (call?.function?.name === "courier_spawn" && textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-MID-BREAKS"))
      return { status: 403, error: "This model is not available in your country" }
    if (call?.function?.name === "courier_spawn" && textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-SUBTREE-MID"))
      return { text: "MID HOLDING", hold: true }
    if (call?.function?.name === "courier_spawn" && textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-IDLE-STOP-MID"))
      return { text: "MID SPAWNED SILENT" }
    if (call?.function?.name === "courier_spawn" && textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-BLOCKED-STOP-MID"))
      return { text: "MID SPAWNED BLOCKER" }
    if (call?.function?.name === "subagent" && textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-SUBAGENT-MID"))
      return (call.function.arguments ?? "").includes("SUBAGENT-FIRST")
        ? { tool: "subagent", args: { agent: "general", description: "Look it up", prompt: "SUBAGENT-SECOND" } }
        : { text: "MID HOLDING", hold: true }
    const briefOf = textOf(messages.find((message) => message.role === "user")?.content)
    const noRoot = briefOf.includes("CHILD-SUBAGENT-NO-ROOT") && briefOf.match(/You were started by session (ses_\w+)/)
    if (call?.function?.name === "subagent" && noRoot) return { tool: "courier_send", args: { sessionID: noRoot[1], message: "CHILD SAW " + result, status: "done" } }
    if (call?.function?.name === "courier_send" && noRoot) return { text: "CHILD REPORTED" }
    if (call?.function?.name === "courier_spawn" && prompt.includes("COURIER-STALL")) return { text: "ROOT SPAWNED" }
    const base = call?.function?.name === "skill" && prompt.includes("COURIER-SKILL-READ") ? result.match(/Base directory for this skill: (\S+)/)?.[1] : undefined
    if (base) return { tool: "read", args: { path: `${base}/SKILL.md` } }
    if (call?.function?.name === "courier_spawn" && textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-STALL-MID"))
      return { text: "MID SPAWNED" }
    const roster = messages.some((message) => message.role === "user" && textOf(message.content).includes("COURIER-ROSTER"))
    if (call?.function?.name === "courier_spawn" && roster) {
      const spawned = messages.flatMap((message) => message.tool_calls ?? []).filter((item) => item.function?.name === "courier_spawn")
      return spawned.length < 2 ? spawnChild(false) : { tool: "courier_children", args: {} }
    }
    const first = textOf(messages.find((message) => message.role === "user")?.content)
    const startedByNest = first.match(/You were started by session (ses_\w+)/)
    if (startedByNest && first.includes("CHILD-NEST-MID")) {
      const command = call?.function?.arguments ?? ""
      if (call?.function?.name === "shell" && command.includes("merge"))
        return { tool: "courier_send", args: { sessionID: startedByNest[1], message: `MID MERGED ${result.includes("leaf.txt") ? "leaf.txt" : "nothing"}`, status: "done", artifacts: { branch: branchIn(messages) } } }
      if (call?.function?.name === "shell") return { tool: "courier_spawn", args: { task: "CHILD-NEST-LEAF", isolate: true } }
      if (call?.function?.name === "courier_spawn") return { text: "MID SPAWNED" }
    }
    if (startedByNest && first.includes("CHILD-NEST-LEAF") && call?.function?.name === "shell")
      return { tool: "courier_send", args: { sessionID: startedByNest[1], message: "LEAF DONE", status: "done", artifacts: { branch: branchIn(messages) } } }
    const probes = textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-PROBES")
    if (probes && (call?.function?.name === "shell" || call?.function?.name === "question")) {
      const asked = messages.flatMap((message) => message.tool_calls ?? []).filter((item) => item.function?.name === "question")
      if (asked.length >= 2) return { status: 403, error: "This model is not available in your country" }
      const options = ["Hello", "Hi", "Hey"].map((label) => ({ label, description: `Say ${label}` }))
      return { tool: "question", args: { questions: [{ header: "Greeting", question: "Which greeting?", options, multiple: false }] }, delayed: true }
    }
    if (call?.function?.name === "courier_spawn" && prompt.includes("COURIER-GROUP-SPLIT")) {
      const spawned = messages.flatMap((message) => message.tool_calls ?? []).filter((item) => item.function?.name === "courier_spawn")
      if (spawned.length < 2) return { tool: "courier_spawn", args: { task: "CHILD-QUICK", group: "pair" }, delayed: true }
      return { text: "PARENT SPAWNED BOTH", delayed: true }
    }
    const startedBy = textOf(messages.find((message) => message.role === "user")?.content).match(/You were started by session (ses_\w+)/)
    if (call?.function?.name === "courier_spawn" && startedBy && textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-GROUPS"))
      return { text: "MIDDLE SPAWNED", delayed: true }
    if (startedBy && first.includes("CHILD-EARLY-MID")) {
      if (call?.function?.name === "courier_spawn") return { tool: "shell", args: { command: "sleep 5" } }
      if (call?.function?.name === "shell") return { tool: "courier_send", args: { sessionID: startedBy[1], message: "MID DONE EARLY", status: "done" } }
      if (call?.function?.name === "courier_send") return { text: "MID REPORTED EARLY" }
    }
    if (startedBy && first.includes("CHILD-ROLLING-FIRST")) {
      if (call?.function?.name === "courier_send") return { tool: "shell", args: { command: "sleep 12" }, quick: true }
      if (call?.function?.name === "shell") return { text: "ROLLING FIRST FINISHED" }
    }
    if (call?.function?.name === "courier_spawn" && !startedBy && messages.some((message) => textOf(message.content).includes("ROLLING FIRST DONE")))
      return { text: "ROOT STARTED NEXT" }
    if (startedBy && first.includes("CHILD-CHECKIN-MID")) {
      if (call?.function?.name === "courier_later") return { tool: "courier_send", args: { sessionID: startedBy[1], message: "MID DONE BEFORE CHECK-IN", status: "done" } }
      if (call?.function?.name === "courier_send") return { text: "MID REPORTED" }
    }
    if (startedBy && first.includes("CHILD-NOTES-MID")) {
      if (call?.function?.name === "courier_note") return { tool: "courier_spawn", args: { task: "CHILD-NOTES-LEAF CHILD-FORCES" } }
      if (call?.function?.name === "courier_spawn") return { text: "MID SPAWNED LEAF" }
    }
    if (startedBy && first.includes("CHILD-NOTES-LEAF") && call?.function?.name === "courier_note")
      return { tool: "courier_send", args: { sessionID: startedBy[1], message: `LEAF GOT ${result}`, status: "done" } }
    if (call?.function?.name === "courier_spawn" && startedBy && textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-LEAF"))
      return { tool: "courier_send", args: { sessionID: startedBy[1], message: `LEAF GOT ${result}`, status: "done" } }
    if ((call?.function?.name === "shell" || call?.function?.name === "websearch") && startedBy)
      return { tool: "courier_send", args: { sessionID: startedBy[1], message: `CHILD DONE ${call.function.name}: ${result}`, status: "done" } }
    if (call?.function?.name === "question") {
      if (startedBy)
        return {
          tool: "courier_send",
          args: { sessionID: startedBy[1], message: /dismissed this question/.test(result) ? "CHILD DISMISSED" : `CHILD GOT ${JSON.stringify(answersIn(result))}`, status: "done" },
        }
      if (/do not call courier_answer|nothing to pass on|not passed on; tell the person/i.test(result)) return { text: `PARENT RELAYED: ${result}` }
      const notice = [...messages.flatMap((message) => [...textOf(message.content).matchAll(new RegExp(QUESTION_NOTICE, "g"))])].at(-1)
      if (notice) return { tool: "courier_answer", args: { sessionID: notice[1], requestID: notice[2], answers: answersIn(result) } }
    }
    return { text: `TOOL DONE ${call?.function?.name}: ${result}` }
  }
  const recent = messages
    .slice(lastAssistant + 1)
    .map((message) => textOf(message.content))
    .join("\n")
  if (recent.includes('<courier from="courier" reminder="report">')) {
    const first = textOf(messages.find((message) => message.role === "user")?.content)
    const reportTo = first.match(/You were started by session (ses_\w+)/)
    if (reportTo && first.includes("CHILD-HEEDS"))
      return { tool: "courier_send", args: { sessionID: reportTo[1], message: "CHILD DONE AFTER REMINDER", status: "done" } }
    return { text: textOf(messages[lastAssistant]?.content) || "CHILD IGNORES REMINDER" }
  }
  const saying = recent.match(/COURIER-SAY ([^"\n]+)/)
  if (saying) return { text: saying[1] }
  if (textOf(messages.findLast((message) => message.role === "user")?.content).includes("COURIER-HOLD")) return { text: "HOLDING", hold: true }
  if (recent.includes("SUBAGENT-NO-ROOT-ASK")) return { text: "SUBAGENT NO ROOT DONE" }
  if (recent.includes("You are a subagent spawned by another session.")) return { text: "SUBAGENT HOLDING", hold: true }
  if (/<subagent sessionID="ses_\w+" state=/.test(recent)) return { text: "SAW SUBAGENT END", delayed: true }
  const parent = recent.match(/You were started by session (ses_\w+) through opencode-courier/)
  const nestBranch = branchIn(messages)
  if (parent && recent.includes("CHILD-NEST-MID"))
    return { tool: "shell", args: { command: `${GIT} switch -c ${nestBranch} && echo mid > mid.txt && git add mid.txt && ${GIT} commit -m "mid work"` } }
  if (parent && recent.includes("CHILD-NEST-LEAF"))
    return { tool: "shell", args: { command: `cp mid.txt leaf-saw-mid.txt && ${GIT} switch -c ${nestBranch} && echo leaf > leaf.txt && git add . && ${GIT} commit -m "leaf work"` } }
  const reported = recent.match(/- branch: (courier\/ses_\w+)/)
  if (reported && textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-NEST-MID"))
    return { tool: "shell", args: { command: `${GIT} merge --no-edit ${reported[1]} && ls` } }
  if (recent.includes("COURIER-NEST")) return { tool: "courier_spawn", args: { task: "CHILD-NEST-MID", isolate: true } }
  if (parent && recent.includes("CHILD-FAILS")) return { status: 403, error: "This model is not available in your country" }
  if (parent && recent.includes("CHILD-LIMITED"))
    return { status: 402, error: "You exceeded your current quota", headers: { "retry-after": "1800" } }
  if (parent && recent.includes("CHILD-PROBES")) return { tool: "shell", args: { command: "echo courier-asks probe" } }
  if (parent && recent.includes("CHILD-ASKS")) return { tool: "shell", args: { command: "echo courier-asks" } }
  if (parent && recent.includes("CHILD-SEARCHES")) return { tool: "websearch", args: { query: "courier" }, delayed: true }
  const question = recent.match(/CHILD-QUESTION(-MULTI|-RELABEL|-REWORD)?/)
  if (parent && question) {
    const options = ["Hello", "Hi", "Hey"].map((label) => ({ label, description: `Say ${label}` }))
    const header = question[1] === "-RELABEL" ? "Relabel" : question[1] === "-REWORD" ? "Reword" : "Greeting"
    return {
      tool: "question",
      args: { questions: [{ header, question: "Which greeting?", options, multiple: question[1] === "-MULTI" }] },
      delayed: true,
    }
  }
  if (parent && recent.includes("CHILD-IDLE-STOP-MID")) return { tool: "courier_spawn", args: { task: "CHILD-SILENT", native: false } }
  if (parent && recent.includes("CHILD-BLOCKED-STOP-MID")) return { tool: "courier_spawn", args: { task: "CHILD-BLOCKS", native: false } }
  if (parent && recent.includes("CHILD-SILENT")) return { text: "CHILD SILENT REPLY", delayed: true }
  if (parent && recent.includes("CHILD-BLOCKS")) return { tool: "courier_send", args: { sessionID: parent[1], message: "CHILD BLOCKED", status: "blocked" } }
  if (parent && recent.includes("CHILD-EARLY-MID"))
    return { calls: [0, 1].map(() => ({ tool: "courier_spawn", args: { task: "CHILD-QUICK", group: "pair", native: false } })) }
  if (parent && recent.includes("CHILD-GROUPS"))
    return { calls: [0, 1].map(() => ({ tool: "courier_spawn", args: { task: "CHILD-QUICK", group: "pair" } })) }
  if (parent && recent.includes("CHILD-NOTES-MID")) return { tool: "courier_note", args: { text: "Noted from depth 1" } }
  if (parent && recent.includes("CHILD-NOTES-LEAF")) return { tool: "courier_note", args: { text: "Noted from a leaf" } }
  if (parent && recent.includes("CHILD-QUICK"))
    return { tool: "courier_send", args: { sessionID: parent[1], message: "CHILD DONE QUICKLY", status: "done" }, quick: true }
  if (parent && recent.includes("CHILD-PROGRESSES")) return { tool: "courier_send", args: { sessionID: parent[1], message: "CHILD HALFWAY" } }
  if (parent && recent.includes("CHILD-ROLLING-FIRST"))
    return { tool: "courier_send", args: { sessionID: parent[1], message: "ROLLING FIRST DONE", status: "done" } }
  if (parent && recent.includes("CHILD-CHECKIN-MID")) return { tool: "courier_later", args: { message: "MID-CHECK-IN", delayMinutes: 0.25 } }
  if (parent && recent.includes("CHILD-WAITS")) return { tool: "courier_later", args: { message: "CHILD-REPORT-NOW", delayMinutes: 0.25 } }
  if (parent && recent.includes("CHILD-DEEPENS"))
    return { calls: [{ tool: "courier_spawn", args: { task: "CHILD-LEAF" } }, { tool: "courier_spawn", args: { task: "CHILD-LEAF CHILD-FORCES" } }] }
  if (parent && recent.includes("CHILD-LEAF")) return { tool: "courier_spawn", args: { task: "CHILD-TOO-DEEP" } }
  if (parent && recent.includes("CHILD-SUBAGENT-NO-ROOT"))
    return { tool: "subagent", args: { agent: "general", description: "Answer in one line", prompt: "SUBAGENT-NO-ROOT-ASK" } }
  if (parent && recent.includes("CHILD-SUBAGENT-MID"))
    return { tool: "subagent", args: { agent: "general", description: "Run the checks", prompt: "SUBAGENT-FIRST" } }
  if (parent && recent.includes("CHILD-SUBTREE-MID")) return { tool: "courier_spawn", args: { task: "CHILD-SUBTREE-LEAF" } }
  if (parent && recent.includes("CHILD-SUBTREE-LEAF")) return { text: "LEAF HOLDING", hold: true }
  if (parent && recent.includes("CHILD-MID-BREAKS")) return { tool: "courier_spawn", args: { task: "CHILD-SUBTREE-LEAF" } }
  if (parent && recent.includes("CHILD-NESTS")) return { tool: "courier_spawn", args: { task: "CHILD-QUESTION" } }
  const answered = recent.match(/<courier from="ses_\w+" answers="question_[\w-]+"( dismissed="true")?>/)
  const startedBy = textOf(messages.find((message) => message.role === "user")?.content).match(/You were started by session (ses_\w+)/)
  if (startedBy && recent.includes("MID-CHECK-IN")) return { text: "MID SAW CHECK-IN" }
  if (startedBy && recent.includes("PERSON-ASKS")) return { text: "CHILD ANSWERS PERSON" }
  if (startedBy && recent.includes("CHILD-REPORT-NOW"))
    return { tool: "courier_send", args: { sessionID: startedBy[1], message: "CHILD DONE AFTER NUDGE", status: "done" } }
  if (startedBy && recent.includes("CHILD-STUCK-AGAIN"))
    return { tool: "courier_send", args: { sessionID: startedBy[1], message: "CHILD BLOCKED AGAIN", status: "blocked" } }
  if (startedBy && recent.includes("CHILD-REPORT-PLAIN"))
    return { tool: "courier_send", args: { sessionID: startedBy[1], message: "CHILD DONE WITHOUT STATUS" } }
  if (answered && startedBy)
    return {
      tool: "courier_send",
      args: { sessionID: startedBy[1], message: answered[1] ? "CHILD DISMISSED" : `CHILD GOT ${JSON.stringify(answersIn(recent))}`, status: "done" },
    }
  if (parent && recent.includes("CHILD-STALL-MID")) return { tool: "courier_spawn", args: { task: "CHILD-STALL-LEAF" } }
  if (parent) return { tool: "courier_send", args: { sessionID: parent[1], message: "CHILD DONE", status: "done", artifacts: ARTIFACTS } }
  const shownNative = recent.match(/<courier from="ses_\w+" asks="question" request="(question_[\w-]+)" shown="native">/)
  if (shownNative) return { text: `PARENT TOLD NATIVE QUESTION ${shownNative[1]}` }
  const notice = recent.match(QUESTION_NOTICE)
  if (notice) {
    const args = JSON.parse(recent.split("\n").find((line) => line.startsWith('{"questions"')))
    for (const item of args.questions)
      if (item.header === "Relabel") item.options = item.options.map((option) => ({ ...option, label: option.label.toLowerCase() }))
      else if (item.header === "Reword") item.question = "Which greeting would you like?"
    const started = (task) => messages.some((message) => message.role === "user" && textOf(message.content).includes(task))
    if (started("COURIER-QUESTION-WAIT")) return { text: `PARENT WAITS QUESTION ${notice[2]}` }
    const both = started("COURIER-QUESTION-BOTH")
    if (both) return { calls: [{ tool: "question", args }, { tool: "courier_answer", args: { sessionID: notice[1], requestID: notice[2], answers: [["Hi"]] } }] }
    return { tool: "question", args }
  }
  if (recent.includes("COURIER-ASK-AGAIN")) {
    const line = messages.flatMap((message) => textOf(message.content).split("\n")).findLast((item) => item.startsWith('{"questions"'))
    if (line) return { tool: "question", args: JSON.parse(line) }
  }
  const nativeAsks = recent.match(/<courier from="ses_\w+" asks="permission" request="([^"]+)" shown="native">/)
  if (nativeAsks) return { text: `PARENT TOLD NATIVE PERMISSION ${nativeAsks[1]}` }
  const asks = recent.match(/<courier from="ses_\w+" asks="permission" request="([^"]+)">/)
  if (asks) return { text: `PARENT ASKS ${asks[1]}` }
  const form = recent.match(/<courier from="ses_\w+" asks="form" form="([^"]+)"/)
  if (form) return { text: `PARENT TOLD FORM ${form[1]}` }
  const answer = recent.match(/COURIER-ANSWER (once|always|reject)(?: (.+))?/)
  if (answer) {
    const notices = messages.flatMap((message) => [...textOf(message.content).matchAll(/<courier from="(ses_\w+)" asks="permission" request="([^"]+)">/g)])
    const [, sessionID, requestID] = notices.at(-1) ?? []
    return { tool: "courier_answer", args: { sessionID, requestID, reply: answer[1], ...(answer[2] ? { message: answer[2] } : {}) } }
  }
  if (/<courier from="ses_\w+" (answered|settled)=/.test(recent) && !/<courier from="ses_\w+" status="/.test(recent)) return { text: "PARENT SETTLED" }
  if (!startedBy && recent.includes("ROLLING FIRST DONE")) return { tool: "courier_spawn", args: { task: "CHILD-ROLLING-NEXT", native: false } }
  if (/<courier from="ses_\w+" ended="without-report">/.test(recent)) return { text: "PARENT TOLD SILENT" }
  if (startedBy && /<courier from="ses_\w+" status="done">/.test(recent) && textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-NOTES-MID")) {
    const noteID = messages.flatMap((message) => message.tool_calls ?? []).find((item) => item.function?.name === "courier_note")?.id
    const noted = textOf(messages.find((message) => message.role === "tool" && message.tool_call_id === noteID)?.content)
    return { tool: "courier_send", args: { sessionID: startedBy[1], message: `MID NOTE ${noted.replace(/\s+/g, " ")} MID GOT ${recent.match(/LEAF GOT [^\n]*/)?.[0] ?? "nothing"}`, status: "done" } }
  }
  if (/<courier from="[^"]*" group="/.test(recent) && startedBy && textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-EARLY-MID"))
    return { text: "MID SAW GROUP" }
  if (/<courier from="[^"]*" group="/.test(recent) && startedBy)
    return { tool: "courier_send", args: { sessionID: startedBy[1], message: "MIDDLE GOT GROUP", status: "done" } }
  if (/<courier from="[^"]*" group="/.test(recent)) return { text: "PARENT GOT GROUP" }
  if (/<courier from="ses_\w+" status="blocked">/.test(recent)) return { text: "PARENT BLOCKED" }
  if (recent.includes("<courier from=")) return { text: "PARENT WOKE" }
  const nudge = recent.match(/COURIER-NUDGE(-PLAIN|-BLOCK)? (ses_\w+)/)
  const nudged = { "-PLAIN": "CHILD-REPORT-PLAIN", "-BLOCK": "CHILD-STUCK-AGAIN" }
  if (nudge) return { tool: "courier_send", args: { sessionID: nudge[2], message: nudged[nudge[1]] ?? "CHILD-REPORT-NOW" } }
  const later = recent.match(/COURIER-LATER(-CANCEL|-STRING)? ([\d.]+)/)
  if (later)
    return { tool: "courier_later", args: { message: "CHECK-IN", delayMinutes: later[1] === "-STRING" ? later[2] : Number(later[2]) } }
  if (recent.includes('<skill_content name="courier-orchestrate">')) return { text: "SKILL SEEN" }
  if (recent.includes("COURIER-SKILL")) return { tool: "skill", args: { id: "courier-orchestrate" } }
  if (recent.includes("COURIER-NOTE-BELOW")) return { tool: "courier_spawn", args: { task: "CHILD-NOTES-MID" } }
  const noting = recent.match(/COURIER-NOTE ([^"\n]+)/)
  if (noting) return { tool: "courier_note", args: { text: noting[1] } }
  const recallOf = recent.match(/COURIER-RECALL(?: (ses_\w+))?/)
  if (recallOf) return { tool: "courier_recall", args: recallOf[1] ? { sessionID: recallOf[1] } : {} }
  const clean = recent.match(/COURIER-CLEANUP (ses_\w+)( force)?/)
  if (clean) return { tool: "courier_cleanup", args: { sessionID: clean[1], ...(clean[2] ? { force: true } : {}) } }
  if (recent.includes("COURIER-MID-BREAKS")) return { tool: "courier_spawn", args: { task: "CHILD-MID-BREAKS" } }
  if (recent.includes("COURIER-SUBTREE-START")) return { tool: "courier_spawn", args: { task: "CHILD-SUBTREE-MID" } }
  if (recent.includes("COURIER-IDLE-STOP")) return { tool: "courier_spawn", args: { task: "CHILD-IDLE-STOP-MID", native: false } }
  if (recent.includes("COURIER-BLOCKED-STOP")) return { tool: "courier_spawn", args: { task: "CHILD-BLOCKED-STOP-MID", native: false } }
  if (recent.includes("COURIER-SUBAGENT-START")) return { tool: "courier_spawn", args: { task: "CHILD-SUBAGENT-MID" } }
  if (recent.includes("COURIER-SUBAGENT-NO-ROOT")) return { tool: "courier_spawn", args: { task: "CHILD-SUBAGENT-NO-ROOT" } }
  if (recent.includes("COURIER-STALL")) return { tool: "courier_spawn", args: { task: "CHILD-STALL-MID" } }
  if (recent.includes("COURIER-SUBTREE-TREE")) return { tool: "courier_tree", args: {} }
  const stopping = recent.match(/COURIER-SUBTREE-STOP (ses_\w+)/)
  if (stopping) return { tool: "courier_stop", args: { sessionID: stopping[1] } }
  const children = recent.match(/COURIER-CHILDREN (ses_\w+)/)
  if (children) return { tool: "courier_children", args: { sessionID: children[1] } }
  if (recent.includes("COURIER-ROSTER")) return spawnChild(false)
  if (recent.includes("COURIER-SPAWN-BLOCKS")) return { tool: "courier_spawn", args: { task: "CHILD-BLOCKS", native: false } }
  if (recent.includes("COURIER-ROLLING")) return { tool: "courier_spawn", args: { task: "CHILD-ROLLING-FIRST", native: false } }
  if (recent.includes("COURIER-OWN-CHECKIN")) return { tool: "courier_spawn", args: { task: "CHILD-CHECKIN-MID", native: false } }
  if (recent.includes("COURIER-EARLY-REPORT")) return { tool: "courier_spawn", args: { task: "CHILD-EARLY-MID", native: false } }
  if (recent.includes("COURIER-GROUP-NESTED")) return { tool: "courier_spawn", args: { task: "CHILD-GROUPS" } }
  if (recent.includes("COURIER-GROUP-SPLIT")) return { tool: "courier_spawn", args: { task: "CHILD-QUICK", group: "pair" } }
  if (recent.includes("COURIER-GROUP-DROP"))
    return {
      calls: [
        { tool: "courier_spawn", args: { task: "Report back to your parent.", group: "pair" } },
        { tool: "courier_spawn", args: { task: "CHILD-SILENT", group: "pair" } },
      ],
    }
  if (recent.includes("COURIER-GROUP-DECLINE"))
    return {
      calls: [
        { tool: "courier_spawn", args: { task: "Report back to your parent.", group: "pair" } },
        { tool: "shell", args: { command: "echo courier-asks top" } },
      ],
    }
  if (recent.includes("COURIER-MIXED"))
    return {
      calls: [
        { tool: "courier_spawn", args: { task: "CHILD-ASKS", group: "pair", native: true } },
        { tool: "courier_spawn", args: { task: "CHILD-ASKS", group: "pair", native: false } },
      ],
    }
  if (recent.includes("COURIER-NATIVE-ISOLATE")) return { tool: "courier_spawn", args: { task: "Report back to your parent.", native: true, isolate: true } }
  if (recent.includes("COURIER-TUI"))
    return {
      calls: [
        { tool: "courier_spawn", args: { task: "Report back to your parent.", group: "pair" } },
        { tool: "courier_spawn", args: { task: "CHILD-ASKS", group: "pair" } },
      ],
    }
  if (recent.includes("PARENT-BUSY")) return { tool: "shell", args: { command: "sleep 8" }, quick: true }
  const group = recent.match(/COURIER-GROUP(-BLOCKED)?/)
  if (group)
    return {
      calls: [
        { tool: "courier_spawn", args: { task: "Report back to your parent.", group: "pair" } },
        { tool: "courier_spawn", args: { task: group[1] ? "CHILD-BLOCKS" : "Report back to your parent.", group: "pair" } },
      ],
    }
  if (recent.includes("COURIER-DEPTH")) return { tool: "courier_spawn", args: { task: "CHILD-DEEPENS" } }
  if (recent.includes("COURIER-FAIL")) return { tool: "courier_spawn", args: { task: "CHILD-FAILS" } }
  if (recent.includes("COURIER-LIMIT")) return { tool: "courier_spawn", args: { task: "CHILD-LIMITED" } }
  if (recent.includes("COURIER-SILENT-HEEDS")) return { tool: "courier_spawn", args: { task: "CHILD-SILENT CHILD-HEEDS" } }
  if (recent.includes("COURIER-SILENT")) return { tool: "courier_spawn", args: { task: "CHILD-SILENT" } }
  if (recent.includes("COURIER-PROGRESS")) return { tool: "courier_spawn", args: { task: "CHILD-PROGRESSES" } }
  if (recent.includes("COURIER-WAITING")) return { tool: "courier_spawn", args: { task: "CHILD-WAITS" } }
  const questions = recent.match(/COURIER-QUESTION(-MULTI|-RELABEL|-REWORD|-BOTH|-WAIT)?(?: (isolate|nested))?/)
  if (questions)
    return {
      tool: "courier_spawn",
      args: {
        task: questions[2] === "nested" ? "CHILD-NESTS" : `CHILD-QUESTION${questions[1] === "-BOTH" || questions[1] === "-WAIT" ? "" : (questions[1] ?? "")}`,
        isolate: questions[2] === "isolate",
      },
    }
  if (recent.includes("COURIER-PROBE")) return { tool: "courier_spawn", args: { task: "CHILD-PROBES", isolate: true } }
  if (recent.includes("COURIER-SEARCH")) return { tool: "courier_spawn", args: { task: "CHILD-SEARCHES" } }
  const ask = recent.match(/COURIER-ASK(?: (isolate))?/)
  if (ask) return { tool: "courier_spawn", args: { task: "CHILD-ASKS", isolate: ask[1] === "isolate" } }
  const chosen = recent.match(/COURIER-MODEL ([\w./-]+) ([\w-]+)/)
  if (chosen)
    return {
      tool: "courier_spawn",
      args: { task: "Report back to your parent.", ...(chosen[1] === "-" ? {} : { model: chosen[1] }), ...(chosen[2] === "-" ? {} : { variant: chosen[2] }) },
    }
  const spawn = recent.match(/COURIER-TEST(?: (isolate))?/)
  if (spawn) return spawnChild(spawn[1] === "isolate")
  return { text: "ok" }
}

function relayFinding(messages, lastAssistant) {
  const first = textOf(messages.find((message) => message.role === "user")?.content)
  const sent = messages.flatMap((message) => message.tool_calls ?? []).filter((item) => item.function?.name === "courier_send")
  const briefedBy = first.match(/You were started by session (ses_\w+)/)
  if (briefedBy && first.includes("CHILD-DEEP-FINDING")) {
    if (sent.length === 0) return { tool: "courier_send", args: { sessionID: briefedBy[1], message: "FINDING-UP: the shared config is read-only" } }
    if (sent.length === 1) return { tool: "courier_send", args: { sessionID: briefedBy[1], message: "DEEP DONE", status: "done" } }
    return { text: "DEEP REPORTED" }
  }
  const last = messages.at(-1)
  const call = last?.role === "tool" ? messages[lastAssistant]?.tool_calls?.find((item) => item.id === last.tool_call_id) : undefined
  if (briefedBy && first.includes("CHILD-RELAYS-UP")) {
    if (lastAssistant === -1) return { tool: "courier_spawn", args: { task: "CHILD-DEEP-FINDING" } }
    const later = messages.slice(1).map((message) => textOf(message.content)).join("\n")
    const found = later.match(/<courier from="(ses_\w+)">\n(FINDING-UP:[^\n<]*)/)
    const passed = sent.some((item) => (item.function.arguments ?? "").includes("Passed up from"))
    const reported = sent.some((item) => (item.function.arguments ?? "").includes("MID DONE"))
    if (found && !passed) {
      const told = first.includes("Do the same with one a session you started sends you, when it reaches past your own part.")
      return { tool: "courier_send", args: { sessionID: briefedBy[1], message: told ? `Passed up from ${found[1]}: ${found[2]}` : "BRIEF SAYS NOTHING OF PASSING UP" } }
    }
    if (passed && !reported && /<courier from="ses_\w+" status="done">/.test(later))
      return { tool: "courier_send", args: { sessionID: briefedBy[1], message: "MID DONE", status: "done" } }
    if (call?.function?.name === "courier_spawn") return { text: "MID SPAWNED" }
    return { text: reported ? "MID REPORTED" : passed ? "MID PASSED UP" : "MID WAITS" }
  }
  if (!first.includes("COURIER-RELAY-UP")) return undefined
  if (lastAssistant === -1) return { tool: "courier_spawn", args: { task: "CHILD-RELAYS-UP" } }
  if (call?.function?.name === "courier_spawn") return { text: "ROOT SPAWNED" }
  const recent = messages.slice(lastAssistant + 1).map((message) => textOf(message.content)).join("\n")
  const heard = /<courier from="ses_\w+">\nPassed up from ses_\w+: FINDING-UP:/.test(recent)
  const done = /<courier from="ses_\w+" status="done">/.test(recent)
  if (heard || done) return { text: [heard && "ROOT HEARD FINDING", done && "ROOT GOT REPORT"].filter(Boolean).join(" ") }
  return { text: "ROOT WOKE" }
}

function relayPersonWords(messages, lastAssistant) {
  const first = textOf(messages.find((message) => message.role === "user")?.content)
  const sent = messages.flatMap((message) => message.tool_calls ?? []).filter((item) => item.function?.name === "courier_send")
  const briefedBy = first.match(/You were started by session (ses_\w+)/)
  const last = messages.at(-1)
  const call = last?.role === "tool" ? messages[lastAssistant]?.tool_calls?.find((item) => item.id === last.tool_call_id) : undefined
  const recent = messages.slice(lastAssistant + 1).map((message) => textOf(message.content)).join("\n")
  if (briefedBy && first.includes("CHILD-PERSON-WORDS")) {
    if (recent.includes("PERSON-LATE")) return { text: "LATE HEARD" }
    if (recent.includes("PERSON-SAYS") && sent.length === 0) return { tool: "courier_send", args: { sessionID: briefedBy[1], message: "WORDS DONE", status: "done" } }
    return { text: sent.length ? "WORDS REPORTED" : "LEAF WAITS" }
  }
  if (briefedBy && first.includes("CHILD-RELAYS-PERSON")) {
    if (lastAssistant === -1) return { tool: "courier_spawn", args: { task: "CHILD-PERSON-WORDS", native: true } }
    if (call?.function?.name === "courier_spawn") return { text: "RELAYER SPAWNED" }
    const later = messages.map((message) => textOf(message.content)).join("\n")
    const reported = sent.some((item) => (item.function.arguments ?? "").includes("RELAYER DONE"))
    if (!reported && /<courier from="ses_\w+" status="done">/.test(later)) return { tool: "courier_send", args: { sessionID: briefedBy[1], message: "RELAYER DONE", status: "done" } }
    const replies = [TYPED_ENVELOPE.test(later) && "RELAYER HEARD TYPED", recent.includes('ended="without-report"') && "RELAYER WOKE", reported && "RELAYER REPORTED"]
    return { text: replies.filter(Boolean).join(" ") || "RELAYER WAITS" }
  }
  if (!first.includes("COURIER-RELAY-PERSON")) return undefined
  if (lastAssistant === -1) return { tool: "courier_spawn", args: { task: "CHILD-RELAYS-PERSON", native: false } }
  if (call?.function?.name === "courier_spawn") return { text: "ROOT SPAWNED" }
  const replies = [TYPED_ENVELOPE.test(recent) && "ROOT HEARD TYPED", /<courier from="ses_\w+" status="done">/.test(recent) && "ROOT GOT REPORT"]
  return { text: replies.filter(Boolean).join(" ") || "ROOT WOKE" }
}

function passFinding(messages, lastAssistant) {
  const first = textOf(messages.find((message) => message.role === "user")?.content)
  const sent = messages.flatMap((message) => message.tool_calls ?? []).filter((item) => item.function?.name === "courier_send")
  const briefedBy = first.match(/You were started by session (ses_\w+)/)
  if (briefedBy && first.includes("CHILD-REPORTS-FIRST")) {
    if (sent.length) return { text: "FIRST REPORTED" }
    return { tool: "courier_send", args: { sessionID: briefedBy[1], message: "FIRST DONE", status: "done" }, quick: true }
  }
  if (briefedBy && first.includes("CHILD-FINDS-LAST")) {
    if (sent.length) return { text: "FINDER REPORTED" }
    const told = messages.some((message) => textOf(message.content).includes("REPORT-NOW"))
    const waited = messages.flatMap((message) => message.tool_calls ?? []).filter((item) => item.function?.name === "shell").length
    if (!told && waited < 30) return { tool: "shell", args: { command: "sleep 2" }, quick: true }
    return { tool: "courier_send", args: { sessionID: briefedBy[1], message: "FINDER DONE", status: "done", finding: "FINDING: the shared API returns cents, not euros" }, quick: true }
  }
  if (briefedBy && first.includes("CHILD-FINDS-IN-REPORT")) {
    if (sent.length === 0)
      return { tool: "courier_send", args: { sessionID: briefedBy[1], message: "FINDER DONE", status: "done", finding: "FINDING: the shared API returns cents, not euros" } }
    return { text: "FINDER REPORTED" }
  }
  if (briefedBy && first.includes("CHILD-FINDS")) {
    if (sent.length === 0) return { tool: "courier_send", args: { sessionID: briefedBy[1], message: "FINDING: the shared API returns cents, not euros" } }
    if (sent.length === 1) return { tool: "courier_send", args: { sessionID: briefedBy[1], message: "FINDER DONE", status: "done" } }
    return { text: "FINDER REPORTED" }
  }
  if (briefedBy && first.includes("CHILD-HEARS")) {
    if (sent.length) return { text: "HEARER REPORTED" }
    const heard = messages.map((message) => textOf(message.content)).join("\n").match(/FINDING:[^\n<]*/)
    const waited = messages.flatMap((message) => message.tool_calls ?? []).filter((item) => item.function?.name === "shell").length
    if (!heard && waited < 30) return { tool: "shell", args: { command: "sleep 2" }, quick: true }
    return { tool: "courier_send", args: { sessionID: briefedBy[1], message: heard ? `HEARD ${heard[0]}` : "HEARD NOTHING", status: "done" }, quick: true }
  }
  if (!first.includes("COURIER-FINDING")) return undefined
  const last = messages.at(-1)
  if (last?.role === "tool") {
    const call = messages[lastAssistant]?.tool_calls?.find((item) => item.id === last.tool_call_id)
    return { text: call?.function?.name === "courier_send" ? "PARENT PASSED ON" : "PARENT SPAWNED" }
  }
  const tasks = first.includes("COURIER-FINDING-LAST")
    ? ["CHILD-REPORTS-FIRST", "CHILD-FINDS-LAST"]
    : [first.includes("COURIER-FINDING-IN-REPORT") ? "CHILD-FINDS-IN-REPORT" : "CHILD-FINDS", "CHILD-HEARS"]
  if (lastAssistant === -1) return { calls: tasks.map((task) => ({ tool: "courier_spawn", args: { task, group: "finding" } })) }
  const recent = messages.slice(lastAssistant + 1).map((message) => textOf(message.content)).join("\n")
  if (first.includes("COURIER-FINDING-LAST")) return { text: recent.includes(' group="') ? "PARENT GOT GROUP" : "PARENT WOKE" }
  const found = recent.match(/<courier from="(ses_\w+)"(?: finding="ahead")?>\n(?:A finding from this session's report[^\n]*\n\n)?(FINDING:[^\n]*)/)
  if (found) {
    const started = messages.flatMap((message) => (message.role === "tool" ? [...textOf(message.content).matchAll(/Started session (ses_\w+)/g)] : []))
    const sibling = started.map((match) => match[1]).find((id) => id !== found[1])
    return { tool: "courier_send", args: { sessionID: sibling, message: `Passed on from ${found[1]}: ${found[2]}` } }
  }
  if (recent.includes(' group="')) return { text: "PARENT GOT GROUP" }
  return { text: "PARENT WOKE" }
}

const DEMO_PROMPT = "Fix issues #12 and #15 in parallel"
const DEMO_FINDING = "Finding: the login times out only with remember me on; without it the token is refreshed in time. A test without remember me passes on main."
const DEMO_LEADS = [
  {
    title: "Issue #12",
    task: "Fix issue #12, the login that times out after 30 s: find the cause and a failing test in parallel, then fix it.",
    report: "#12 fixed: the remember-me token is refreshed before the timeout, and the new test passes.",
    workers: [
      { title: "Cause of #12", task: "Find why the login times out after 30 s (issue #12), then report back.", finds: 4, after: 2, report: "Cause: with remember me on, the token is refreshed only after the 30 s timeout." },
      {
        title: "Test for #12",
        task: "Write a test that fails on issue #12, the login timeout, then report back.",
        drafts: "echo 'test/login.test.ts: log in, wait 31 s, expect to be logged in'",
        heeds: "echo 'test/login.test.ts: log in with remember me, wait 31 s, expect to be logged in'",
        after: 2,
        report: "test/login.test.ts logs in with remember me, as the cause worker found, and fails on main.",
      },
    ],
  },
  {
    title: "Issue #15",
    task: "Fix issue #15, the CSV export that drops rows: find the cause and a failing test in parallel, then fix it.",
    report: "#15 fixed: the export pages through every row, and the new test passes.",
    workers: [
      { title: "Cause of #15", task: "Find why the CSV export drops rows (issue #15), then report back.", after: 3, report: "Cause: the export reads only the first page of 500 rows." },
      { title: "Test for #15", task: "Write a test that fails on issue #15, the CSV export, then report back.", after: 4, report: "test/export.test.ts fails on main with 501 rows." },
    ],
  },
]

function demoWorker(worker, messages, parent) {
  const calls = messages.flatMap((message) => message.tool_calls ?? [])
  const sent = calls.filter((item) => item.function?.name === "courier_send")
  const shells = calls.filter((item) => item.function?.name === "shell").map((item) => item.function.arguments ?? "")
  const report = { tool: "courier_send", args: { sessionID: parent, message: worker.report, status: "done" }, slower: worker.after }
  if (sent.some((item) => (item.function.arguments ?? "").includes('"status"'))) return { text: "Reported to my lead." }
  if (worker.finds) return sent.length ? report : { tool: "courier_send", args: { sessionID: parent, message: DEMO_FINDING }, slower: worker.finds }
  if (!worker.drafts) return report
  const heard = messages.some((message) => message.role === "user" && /<courier from="ses_\w+">\n[^]*remember me/.test(textOf(message.content)))
  if (heard && shells.some((command) => command.includes("remember me"))) return report
  if (heard) return { tool: "shell", args: { command: worker.heeds } }
  if (!shells.length) return { tool: "shell", args: { command: worker.drafts }, slower: 3 }
  return shells.length < 20 ? { tool: "shell", args: { command: "sleep 4" }, quick: true } : report
}

function demoLead(lead, messages, lastAssistant, parent) {
  const last = messages.at(-1)
  const call = last?.role === "tool" ? messages[lastAssistant]?.tool_calls?.find((item) => item.id === last.tool_call_id) : undefined
  if (call?.function?.name === "courier_spawn") return { text: "Two workers started, on the cause and on a failing test, in no group: each report wakes me as it comes. I end my turn." }
  if (call?.function?.name === "courier_send")
    return { text: (call.function.arguments ?? "").includes(parent) ? "Reported to the orchestrator." : "Passed the finding on to the test worker, whose test needs it. I end my turn." }
  const recent = messages.slice(lastAssistant + 1).map((message) => textOf(message.content)).join("\n")
  const everything = messages.map((message) => textOf(message.content)).join("\n")
  const found = recent.match(/<courier from="(ses_\w+)">\n(Finding:[^\n]*)/)
  if (found) {
    const started = messages.flatMap((message) => (message.role === "tool" ? [...textOf(message.content).matchAll(/Started session (ses_\w+)/g)] : []))
    const sibling = started.map((match) => match[1]).find((id) => id !== found[1])
    return { tool: "courier_send", args: { sessionID: sibling, message: `From the cause worker: ${found[2].replace("Finding: ", "")} Write the test with remember me on.` }, quick: true }
  }
  if (messages.some((message) => (message.tool_calls ?? []).some((item) => item.function?.name === "courier_send" && (item.function.arguments ?? "").includes(parent)))) return { text: "Reported to the orchestrator." }
  const reported = new Set([...everything.matchAll(/<courier from="(ses_\w+)" status="done"/g)].map((match) => match[1]))
  if (reported.size >= lead.workers.length) return { tool: "courier_send", args: { sessionID: parent, message: lead.report, status: "done" }, quick: true }
  if (lastAssistant === -1) return { calls: lead.workers.map(({ title, task }) => ({ tool: "courier_spawn", args: { title, task } })) }
  return { text: "One part reported; the other still runs. I end my turn." }
}

function demoTree(messages, lastAssistant) {
  const first = textOf(messages.find((message) => message.role === "user")?.content)
  const last = messages.at(-1)
  const called = last?.role === "tool" ? messages[lastAssistant]?.tool_calls?.find((item) => item.id === last.tool_call_id)?.function?.name : undefined
  const recent = messages.slice(lastAssistant + 1).map((message) => textOf(message.content)).join("\n")
  const briefedBy = first.match(/You were started by session (ses_\w+)/)
  const lead = briefedBy && DEMO_LEADS.find((one) => first.includes(one.task))
  if (lead) return demoLead(lead, messages, lastAssistant, briefedBy[1])
  const worker = briefedBy && DEMO_LEADS.flatMap((one) => one.workers).find((one) => first.includes(one.task))
  if (worker) return demoWorker(worker, messages, briefedBy[1])
  if (briefedBy || !first.includes(DEMO_PROMPT)) return undefined
  if (called) return { text: "Two leads started, one per issue, in one group: I need only both results. I end my turn; the group's message will wake me." }
  if (recent.includes(' group="')) return { text: "Both issues fixed: #12 and #15, each with a test that failed before the fix." }
  return { calls: DEMO_LEADS.map(({ title, task }) => ({ tool: "courier_spawn", args: { title, task, group: "issues" } })) }
}

function statusDown(messages, lastAssistant) {
  const first = textOf(messages.find((message) => message.role === "user")?.content)
  const last = messages.at(-1)
  const called = last?.role === "tool" ? messages[lastAssistant]?.tool_calls?.find((item) => item.id === last.tool_call_id)?.function?.name : undefined
  const briefedBy = first.match(/You were started by session (ses_\w+)/)
  if (briefedBy && first.includes("CHILD-STATUS-DOWN")) {
    if (called === "courier_send") return { text: "CHILD REPORTED" }
    const heard = messages.map((message) => textOf(message.content)).join("\n").match(/<courier from="ses_\w+"[^>]*>\nSTEER[^\n]*/)
    const waited = messages.flatMap((message) => message.tool_calls ?? []).filter((item) => item.function?.name === "shell").length
    if (!heard && waited < 30) return { tool: "shell", args: { command: "sleep 2" }, quick: true }
    const said = heard ? `HEARD ${heard[0].replace("\n", " ")}` : "HEARD NOTHING"
    return { tool: "courier_send", args: { sessionID: briefedBy[1], message: said, status: "done" }, quick: true }
  }
  if (!first.includes("COURIER-STATUS-DOWN")) return undefined
  if (called === "courier_spawn") {
    const started = textOf(last.content).match(/Started session (ses_\w+)/)
    return { tool: "courier_send", args: { sessionID: started?.[1], message: "STEER: undo it", status: "blocked" } }
  }
  if (called === "courier_send") return { text: "PARENT STEERED" }
  if (lastAssistant === -1) return { tool: "courier_spawn", args: { task: "CHILD-STATUS-DOWN" } }
  return { text: "PARENT WOKE" }
}

function roleEntry(messages, lastAssistant) {
  const recent = messages.slice(lastAssistant + 1).map((message) => textOf(message.content)).join("\n")
  if (recent.includes("CHILD-ROLE-AGAIN")) return { text: "LEAF AGAIN" }
  if (recent.includes("COURIER-NOTE ")) return undefined
  const first = textOf(messages.find((message) => message.role === "user")?.content)
  const last = messages.at(-1)
  const briefedBy = first.match(/You were started by session (ses_\w+)/)
  const called = last?.role === "tool" ? messages[lastAssistant]?.tool_calls?.find((item) => item.id === last.tool_call_id)?.function?.name : undefined
  if (first.includes("COURIER-ROLE")) {
    if (called) return { text: "ROOT SPAWNED" }
    if (lastAssistant === -1) return { tool: "courier_spawn", args: { task: "CHILD-ROLE-MID" } }
    return { text: "ROOT WOKE" }
  }
  if (briefedBy && first.includes("CHILD-ROLE-MID")) {
    if (called === "courier_send") return { text: "MID REPORTED" }
    if (called) return { text: "MID SPAWNED" }
    if (lastAssistant === -1) return { tool: "courier_spawn", args: { task: "CHILD-ROLE-LEAF" } }
    return { tool: "courier_send", args: { sessionID: briefedBy[1], message: "MID DONE", status: "done" } }
  }
  if (briefedBy && first.includes("CHILD-ROLE-LEAF")) {
    if (called) return { text: "LEAF REPORTED" }
    return { tool: "courier_send", args: { sessionID: briefedBy[1], message: "LEAF DONE", status: "done" } }
  }
  return undefined
}

const ARTIFACTS = {
  branch: "child/work",
  commits: ["abc1234 Do the task"],
  files: ["README.md"],
  checks: [{ command: "echo ok", result: "ok" }],
}

function spawnChild(isolate) {
  return { tool: "courier_spawn", args: { task: "Report back to your parent.", isolate } }
}

function chunk(delta, finish) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 0,
    model: "chat",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
  })}\n\n`
}

createServer((request, response) => {
  let raw = ""
  request.on("data", (data) => (raw += data))
  request.on("end", async () => {
    const body = raw ? JSON.parse(raw) : {}
    const reply = decide(body)
    if (reply.hold) await new Promise((resolve) => setTimeout(resolve, holdMs))
    const delay = currentDelay()
    if ((reply.tool === "courier_send" || reply.tool === "shell" || reply.status || reply.delayed) && !reply.quick && delay)
      await new Promise((resolve) => setTimeout(resolve, delay * (reply.slower ?? 1)))
    const session = request.headers["x-opencode-session-id"]
    const system = (body.messages ?? []).filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n")
    const everything = (body.messages ?? []).map((message) => textOf(message.content)).join("\n")
    const role = (system.match(/opencode-courier role: (root orchestrator|sub-orchestrator|leaf|root)/) ?? everything.match(/opencode-courier role: (root orchestrator|sub-orchestrator|leaf|root)/))?.[1] ?? null
    const roleEntry = /(<|&lt;)context key="role"(>|&gt;)\n\s*opencode-courier role:/.test(everything)
    const rolePart = (system.match(/^opencode-courier role:/gm) ?? []).length > (system.match(/<context key="role">\n\s*opencode-courier role:/g) ?? []).length
    const updateRole = (body.messages ?? []).find(isInstructionUpdate)?.role ?? null
    const lessonsEntry = /(<|&lt;)context key="lessons"(>|&gt;)\n\s*opencode-courier lessons:/.test(everything)
    const standingEntry = /(<|&lt;)context key="standing"(>|&gt;)\n\s*opencode-courier standing:/.test(everything)
    const skills = [...system.matchAll(/<skill>\s*<id>([^<]+)<\/id>/g)].map((match) => match[1])
    const schedules = /opencode[._]schedule_/.test(JSON.stringify(body.tools ?? []) + everything)
    const opencodeTools = Math.max(-1, ...[...everything.matchAll(/^- opencode \((\d+) tools?/gm)].map((match) => Number(match[1])))
    const options = Object.fromEntries(Object.entries(body).filter(([key]) => !["messages", "tools", "stream", "stream_options", "tool_choice"].includes(key)))
    if (log) appendFileSync(log, `${JSON.stringify({ url: request.url, stream: !!body.stream, session, role, roleEntry, rolePart, updateRole, lessonsEntry, standingEntry, skills, schedules, opencodeTools, tools: (body.tools ?? []).map((tool) => tool.function?.name), options, reply })}\n`)
    if (reply.status) {
      response.writeHead(reply.status, { "content-type": "application/json", ...reply.headers })
      response.end(JSON.stringify({ error: { message: reply.error, type: "forbidden" } }))
      return
    }
    const calls = (reply.calls ?? (reply.tool ? [reply] : [])).map((item, index) => ({
      id: `call_${Date.now()}_${index}`,
      type: "function",
      function: { name: item.tool, arguments: JSON.stringify(item.args) },
    }))
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: 0,
          model: "chat",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: reply.text ?? null, ...(calls.length ? { tool_calls: calls } : {}) },
              finish_reason: calls.length ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    if (calls.length) {
      calls.forEach((call, index) => response.write(chunk({ role: "assistant", tool_calls: [{ index, ...call }] }, null)))
      response.write(chunk({}, "tool_calls"))
    } else {
      response.write(chunk({ role: "assistant", content: reply.text }, null))
      response.write(chunk({}, "stop"))
    }
    response.end("data: [DONE]\n\n")
  })
}).listen(port, "127.0.0.1", () => console.log(`mock model on http://127.0.0.1:${port}/v1`))
