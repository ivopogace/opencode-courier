// A scripted OpenAI-compatible chat model for the end-to-end test. It decides each reply from the
// conversation so far, so the parent, the child and the woken parent each get a predictable turn.
import { appendFileSync } from "node:fs"
import { createServer } from "node:http"

const port = Number(process.env.MOCK_PORT ?? 4599)
const log = process.env.MOCK_LOG
// Holds the child's report (or its failure) back, so the parent's turn has ended and it is idle when it lands.
const childDelay = Number(process.env.MOCK_CHILD_DELAY_MS ?? 0)

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part === "string" ? part : (part.text ?? ""))).join("")
      : ""

// A notice that a child asks a question, or that its question was cut off: the session and the request.
const QUESTION_NOTICE = /<courier from="(ses_\w+)" asks="question" request="(question_[\w-]+)"[^>]*>/
// The answers in the question tool's result text: "Which greeting?"="Hello, Hey" gives [["Hello", "Hey"]].
const answersIn = (text) => [...text.matchAll(/"[^"]*"="([^"]*)"/g)].map((match) => match[1].split(", "))

function decide(body) {
  const messages = body.messages ?? []
  if (!body.tools?.length) return { text: "Courier test" }
  const lastAssistant = messages.findLastIndex((message) => message.role === "assistant")
  const last = messages.at(-1)
  const prompt = textOf(messages.findLast((message) => message.role === "user")?.content)
  if (last?.role === "tool") {
    const call = messages[lastAssistant]?.tool_calls?.find((item) => item.id === last.tool_call_id)
    const result = textOf(last.content)
    const scheduled = result.match(/Scheduled (later_[\w-]+)/)
    if (call?.function?.name === "courier_later" && prompt.includes("COURIER-LATER-CANCEL") && scheduled)
      return { tool: "courier_cancel", args: { id: scheduled[1] } }
    // Any user message, not just the last: a child's report may already have been steered in.
    const roster = messages.some((message) => message.role === "user" && textOf(message.content).includes("COURIER-ROSTER"))
    if (call?.function?.name === "courier_spawn" && roster) {
      const spawned = messages.flatMap((message) => message.tool_calls ?? []).filter((item) => item.function?.name === "courier_spawn")
      return spawned.length < 2 ? spawnChild(false) : { tool: "courier_children", args: {} }
    }
    // The child of COURIER-PROBE, once its permission request is answered, asks two questions in
    // turn, held back like a report, and then cannot reach its model.
    const probes = textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-PROBES")
    if (probes && (call?.function?.name === "shell" || call?.function?.name === "question")) {
      const asked = messages.flatMap((message) => message.tool_calls ?? []).filter((item) => item.function?.name === "question")
      if (asked.length >= 2) return { status: 403, error: "This model is not available in your country" }
      const options = ["Hello", "Hi", "Hey"].map((label) => ({ label, description: `Say ${label}` }))
      return { tool: "question", args: { questions: [{ header: "Greeting", question: "Which greeting?", options, multiple: false }] }, delayed: true }
    }
    const startedBy = textOf(messages.find((message) => message.role === "user")?.content).match(/You were started by session (ses_\w+)/)
    // A leaf of COURIER-DEPTH reports what its courier_spawn call gave.
    if (call?.function?.name === "courier_spawn" && startedBy && textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-LEAF"))
      return { tool: "courier_send", args: { sessionID: startedBy[1], message: `LEAF GOT ${result}` } }
    // The child of COURIER-ASK reports what its shell call gave, run or refused, once it has the answer.
    if ((call?.function?.name === "shell" || call?.function?.name === "websearch") && startedBy)
      return { tool: "courier_send", args: { sessionID: startedBy[1], message: `CHILD DONE ${call.function.name}: ${result}` } }
    if (call?.function?.name === "question") {
      // The child of COURIER-QUESTION reports what its question call gave.
      if (startedBy)
        return {
          tool: "courier_send",
          args: { sessionID: startedBy[1], message: /dismissed this question/.test(result) ? "CHILD DISMISSED" : `CHILD GOT ${JSON.stringify(answersIn(result))}` },
        }
      // A parent whose question was linked to its child's has nothing left to do.
      if (/do not call courier_answer|nothing to pass on|not passed on; tell the person/i.test(result)) return { text: `PARENT RELAYED: ${result}` }
      // Otherwise it passes on what the person chose with courier_answer.
      const notice = [...messages.flatMap((message) => [...textOf(message.content).matchAll(new RegExp(QUESTION_NOTICE, "g"))])].at(-1)
      if (notice) return { tool: "courier_answer", args: { sessionID: notice[1], requestID: notice[2], answers: answersIn(result) } }
    }
    return { text: `TOOL DONE ${call?.function?.name}: ${result}` }
  }
  const recent = messages
    .slice(lastAssistant + 1)
    .map((message) => textOf(message.content))
    .join("\n")
  const parent = recent.match(/You were started by session (ses_\w+) through opencode-courier/)
  // The child of COURIER-FAIL cannot reach its model, as with a model blocked for the account.
  if (parent && recent.includes("CHILD-FAILS")) return { status: 403, error: "This model is not available in your country" }
  // The child of COURIER-PROBE first runs a command the test's permission rules make it ask for.
  if (parent && recent.includes("CHILD-PROBES")) return { tool: "shell", args: { command: "echo courier-asks probe" } }
  // The child of COURIER-ASK runs a command the test's permission rules make it ask for.
  if (parent && recent.includes("CHILD-ASKS")) return { tool: "shell", args: { command: "echo courier-asks" } }
  // The child of COURIER-SEARCH searches the web before any provider was chosen, so OpenCode asks
  // for one with a form. Held back like a report, so the parent's first turn has ended.
  if (parent && recent.includes("CHILD-SEARCHES")) return { tool: "websearch", args: { query: "courier" }, delayed: true }
  // The child of COURIER-QUESTION asks the person which greeting to use, with the question tool.
  const question = recent.match(/CHILD-QUESTION(-MULTI|-RELABEL|-REWORD)?/)
  if (parent && question) {
    const options = ["Hello", "Hi", "Hey"].map((label) => ({ label, description: `Say ${label}` }))
    const header = question[1] === "-RELABEL" ? "Relabel" : question[1] === "-REWORD" ? "Reword" : "Greeting"
    // Held back like a report, so the parent's first turn has ended (and opencode run, which would
    // dismiss a question asked in it, has let go) when the notice lands.
    return {
      tool: "question",
      args: { questions: [{ header, question: "Which greeting?", options, multiple: question[1] === "-MULTI" }] },
      delayed: true,
    }
  }
  // The middle session of COURIER-DEPTH starts two leaves at once; the second's task makes the probe
  // plugin put courier_spawn back. Each leaf tries to start a session of its own.
  if (parent && recent.includes("CHILD-DEEPENS"))
    return { calls: [{ tool: "courier_spawn", args: { task: "CHILD-LEAF" } }, { tool: "courier_spawn", args: { task: "CHILD-LEAF CHILD-FORCES" } }] }
  if (parent && recent.includes("CHILD-LEAF")) return { tool: "courier_spawn", args: { task: "CHILD-TOO-DEEP" } }
  // The middle session of COURIER-QUESTION nested starts a child that asks.
  if (parent && recent.includes("CHILD-NESTS")) return { tool: "courier_spawn", args: { task: "CHILD-QUESTION" } }
  // A child whose question was cut off gets the answer as a message, and reports it.
  const answered = recent.match(/<courier from="ses_\w+" answers="question_[\w-]+"( dismissed="true")?>/)
  const startedBy = textOf(messages.find((message) => message.role === "user")?.content).match(/You were started by session (ses_\w+)/)
  if (answered && startedBy)
    return {
      tool: "courier_send",
      args: { sessionID: startedBy[1], message: answered[1] ? "CHILD DISMISSED" : `CHILD GOT ${JSON.stringify(answersIn(recent))}` },
    }
  if (parent) return { tool: "courier_send", args: { sessionID: parent[1], message: "CHILD DONE" } }
  // A parent told of its child's question asks the person the same with its own question tool; the
  // RELABEL, REWORD and BOTH variants relabel, reword, or also call courier_answer in the same step.
  const notice = recent.match(QUESTION_NOTICE)
  if (notice) {
    const args = JSON.parse(recent.split("\n").find((line) => line.startsWith('{"questions"')))
    for (const item of args.questions)
      if (item.header === "Relabel") item.options = item.options.map((option) => ({ ...option, label: option.label.toLowerCase() }))
      else if (item.header === "Reword") item.question = "Which greeting would you like?"
    const both = messages.some((message) => message.role === "user" && textOf(message.content).includes("COURIER-QUESTION-BOTH"))
    if (both) return { calls: [{ tool: "question", args }, { tool: "courier_answer", args: { sessionID: notice[1], requestID: notice[2], answers: [["Hi"]] } }] }
    return { tool: "question", args }
  }
  // COURIER-ASK-AGAIN: the parent asks the person the last question it was told of once more.
  if (recent.includes("COURIER-ASK-AGAIN")) {
    const line = messages.flatMap((message) => textOf(message.content).split("\n")).findLast((item) => item.startsWith('{"questions"'))
    if (line) return { tool: "question", args: JSON.parse(line) }
  }
  // A parent told that its child waits for permission ends its turn, as if it had asked the person;
  // the test then answers for the person with COURIER-ANSWER.
  const asks = recent.match(/<courier from="ses_\w+" asks="permission" request="([^"]+)">/)
  if (asks) return { text: `PARENT ASKS ${asks[1]}` }
  // Told that its child shows a form only the person can answer, it ends its turn, as if it had told them.
  const form = recent.match(/<courier from="ses_\w+" asks="form" form="([^"]+)"/)
  if (form) return { text: `PARENT TOLD FORM ${form[1]}` }
  if (/<courier from="ses_\w+" (answered|settled)=/.test(recent)) return { text: "PARENT SETTLED" }
  if (recent.includes("<courier from=")) return { text: "PARENT WOKE" }
  const answer = recent.match(/COURIER-ANSWER (once|always|reject)(?: (.+))?/)
  if (answer) {
    const notices = messages.flatMap((message) => [...textOf(message.content).matchAll(/<courier from="(ses_\w+)" asks="permission" request="([^"]+)">/g)])
    const [, sessionID, requestID] = notices.at(-1) ?? []
    return { tool: "courier_answer", args: { sessionID, requestID, reply: answer[1], ...(answer[2] ? { message: answer[2] } : {}) } }
  }
  // COURIER-LATER-STRING sends the delay as a string, as some models do.
  const later = recent.match(/COURIER-LATER(-CANCEL|-STRING)? ([\d.]+)/)
  if (later)
    return { tool: "courier_later", args: { message: "CHECK-IN", delayMinutes: later[1] === "-STRING" ? later[2] : Number(later[2]) } }
  const topic = recent.match(/COURIER-SUBSCRIBE ([\w./#-]+)/)
  if (topic) return { tool: "courier_subscribe", args: { topic: topic[1] } }
  const look = recent.match(/COURIER-STATUS (ses_\w+)/)
  if (look) return { tool: "courier_status", args: { sessionID: look[1] } }
  const clean = recent.match(/COURIER-CLEANUP (ses_\w+)( force)?/)
  if (clean) return { tool: "courier_cleanup", args: { sessionID: clean[1], ...(clean[2] ? { force: true } : {}) } }
  const children = recent.match(/COURIER-CHILDREN (ses_\w+)/)
  if (children) return { tool: "courier_children", args: { sessionID: children[1] } }
  if (recent.includes("COURIER-ROSTER")) return spawnChild(false)
  if (recent.includes("COURIER-DEPTH")) return { tool: "courier_spawn", args: { task: "CHILD-DEEPENS" } }
  if (recent.includes("COURIER-FAIL")) return { tool: "courier_spawn", args: { task: "CHILD-FAILS" } }
  const questions = recent.match(/COURIER-QUESTION(-MULTI|-RELABEL|-REWORD|-BOTH)?(?: (isolate|nested))?/)
  if (questions)
    return {
      tool: "courier_spawn",
      args: {
        task: questions[2] === "nested" ? "CHILD-NESTS" : `CHILD-QUESTION${questions[1] === "-BOTH" ? "" : (questions[1] ?? "")}`,
        isolate: questions[2] === "isolate",
      },
    }
  if (recent.includes("COURIER-PROBE")) return { tool: "courier_spawn", args: { task: "CHILD-PROBES", isolate: true } }
  if (recent.includes("COURIER-SEARCH")) return { tool: "courier_spawn", args: { task: "CHILD-SEARCHES" } }
  const ask = recent.match(/COURIER-ASK(?: (isolate))?/)
  if (ask) return { tool: "courier_spawn", args: { task: "CHILD-ASKS", isolate: ask[1] === "isolate" } }
  const spawn = recent.match(/COURIER-TEST(?: (isolate))?/)
  if (spawn) return spawnChild(spawn[1] === "isolate")
  return { text: "ok" }
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
    if ((reply.tool === "courier_send" || reply.tool === "shell" || reply.status || reply.delayed) && childDelay)
      await new Promise((resolve) => setTimeout(resolve, childDelay))
    // The session, and the courier role its system prompt names, for the recursion scenario.
    const session = request.headers["x-opencode-session-id"]
    const system = (body.messages ?? []).filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n")
    const role = system.match(/opencode-courier role: (root orchestrator|sub-orchestrator|leaf)/)?.[1] ?? null
    if (log) appendFileSync(log, `${JSON.stringify({ url: request.url, stream: !!body.stream, session, role, tools: (body.tools ?? []).map((tool) => tool.function?.name), reply })}\n`)
    if (reply.status) {
      response.writeHead(reply.status, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: reply.error, type: "forbidden" } }))
      return
    }
    // One tool call (`tool`, `args`), or several in one step (`calls`), as a model may emit them.
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
