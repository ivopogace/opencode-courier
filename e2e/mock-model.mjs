// A scripted OpenAI-compatible chat model for the end-to-end test. It decides each reply from the
// conversation so far, so the parent, the child and the woken parent each get a predictable turn.
import { appendFileSync } from "node:fs"
import { createServer } from "node:http"

const port = Number(process.env.MOCK_PORT ?? 4599)
const log = process.env.MOCK_LOG
// Holds the child's report (or its failure) back, so the parent's turn has ended and it is idle when it lands.
const childDelay = Number(process.env.MOCK_CHILD_DELAY_MS ?? 0)
// How long a `hold` reply is held back: a turn that is still running when the test stops it.
const holdMs = Number(process.env.MOCK_HOLD_MS ?? 90_000)

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

// The git identity a nested-isolation child commits with, and the branch its brief names.
const GIT = "git -c user.name=courier -c user.email=courier@example.invalid"
const branchIn = (messages) => textOf(messages.find((message) => message.role === "user")?.content).match(/branch (courier\/ses_\w+)/)?.[1]

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
    // The middle session of COURIER-SUBTREE-START has started its leaf and then waits for a model reply that does not come in time.
    if (call?.function?.name === "courier_spawn" && textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-SUBTREE-MID"))
      return { text: "MID HOLDING", hold: true }
    // Any user message, not just the last: a child's report may already have been steered in.
    const roster = messages.some((message) => message.role === "user" && textOf(message.content).includes("COURIER-ROSTER"))
    if (call?.function?.name === "courier_spawn" && roster) {
      const spawned = messages.flatMap((message) => message.tool_calls ?? []).filter((item) => item.function?.name === "courier_spawn")
      return spawned.length < 2 ? spawnChild(false) : { tool: "courier_children", args: {} }
    }
    // COURIER-NEST: an isolated child commits on its branch, starts an isolated grandchild, which commits on its
    // own and reports its branch, and the child merges that branch before it reports.
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
    // The child of COURIER-PROBE, once its permission request is answered, asks two questions in
    // turn, held back like a report, and then cannot reach its model.
    const probes = textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-PROBES")
    if (probes && (call?.function?.name === "shell" || call?.function?.name === "question")) {
      const asked = messages.flatMap((message) => message.tool_calls ?? []).filter((item) => item.function?.name === "question")
      if (asked.length >= 2) return { status: 403, error: "This model is not available in your country" }
      const options = ["Hello", "Hi", "Hey"].map((label) => ({ label, description: `Say ${label}` }))
      return { tool: "question", args: { questions: [{ header: "Greeting", question: "Which greeting?", options, multiple: false }] }, delayed: true }
    }
    // COURIER-GROUP-SPLIT starts its second member a while after the first, which has reported by then,
    // and ends its turn a while after that, when both have.
    if (call?.function?.name === "courier_spawn" && prompt.includes("COURIER-GROUP-SPLIT")) {
      const spawned = messages.flatMap((message) => message.tool_calls ?? []).filter((item) => item.function?.name === "courier_spawn")
      if (spawned.length < 2) return { tool: "courier_spawn", args: { task: "CHILD-QUICK", group: "pair" }, delayed: true }
      return { text: "PARENT SPAWNED BOTH", delayed: true }
    }
    const startedBy = textOf(messages.find((message) => message.role === "user")?.content).match(/You were started by session (ses_\w+)/)
    // The middle session of COURIER-GROUP-NESTED ends its turn a while after starting its group, which has reported by then.
    if (call?.function?.name === "courier_spawn" && startedBy && textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-GROUPS"))
      return { text: "MIDDLE SPAWNED", delayed: true }
    // A leaf of COURIER-DEPTH reports what its courier_spawn call gave.
    if (call?.function?.name === "courier_spawn" && startedBy && textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-LEAF"))
      return { tool: "courier_send", args: { sessionID: startedBy[1], message: `LEAF GOT ${result}`, status: "done" } }
    // The child of COURIER-ASK reports what its shell call gave, run or refused, once it has the answer.
    if ((call?.function?.name === "shell" || call?.function?.name === "websearch") && startedBy)
      return { tool: "courier_send", args: { sessionID: startedBy[1], message: `CHILD DONE ${call.function.name}: ${result}`, status: "done" } }
    if (call?.function?.name === "question") {
      // The child of COURIER-QUESTION reports what its question call gave.
      if (startedBy)
        return {
          tool: "courier_send",
          args: { sessionID: startedBy[1], message: /dismissed this question/.test(result) ? "CHILD DISMISSED" : `CHILD GOT ${JSON.stringify(answersIn(result))}`, status: "done" },
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
  // COURIER-NEST's middle session commits on its branch, then merges the branch its leaf reports.
  const nestBranch = branchIn(messages)
  if (parent && recent.includes("CHILD-NEST-MID"))
    return { tool: "shell", args: { command: `${GIT} switch -c ${nestBranch} && echo mid > mid.txt && git add mid.txt && ${GIT} commit -m "mid work"` } }
  if (parent && recent.includes("CHILD-NEST-LEAF"))
    return { tool: "shell", args: { command: `cp mid.txt leaf-saw-mid.txt && ${GIT} switch -c ${nestBranch} && echo leaf > leaf.txt && git add . && ${GIT} commit -m "leaf work"` } }
  const reported = recent.match(/- branch: (courier\/ses_\w+)/)
  if (reported && textOf(messages.find((message) => message.role === "user")?.content).includes("CHILD-NEST-MID"))
    return { tool: "shell", args: { command: `${GIT} merge --no-edit ${reported[1]} && ls` } }
  if (recent.includes("COURIER-NEST")) return { tool: "courier_spawn", args: { task: "CHILD-NEST-MID", isolate: true } }
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
  // The child of COURIER-SILENT ends its turn with a reply but no report, held back so the parent's turn has ended.
  if (parent && recent.includes("CHILD-SILENT")) return { text: "CHILD SILENT REPLY", delayed: true }
  // A member of COURIER-GROUP-BLOCKED's group needs a decision from its parent, and reports done once nudged.
  if (parent && recent.includes("CHILD-BLOCKS")) return { tool: "courier_send", args: { sessionID: parent[1], message: "CHILD BLOCKED", status: "blocked" } }
  // The middle session of COURIER-GROUP-NESTED starts two quick leaves in one group.
  if (parent && recent.includes("CHILD-GROUPS"))
    return { calls: [0, 1].map(() => ({ tool: "courier_spawn", args: { task: "CHILD-QUICK", group: "pair" } })) }
  // A member of COURIER-GROUP-SPLIT's group reports at once, before its parent's turn has ended.
  if (parent && recent.includes("CHILD-QUICK"))
    return { tool: "courier_send", args: { sessionID: parent[1], message: "CHILD DONE QUICKLY", status: "done" }, quick: true }
  // The child of COURIER-PROGRESS messages its parent without a status, then ends its turn on the tool's result.
  if (parent && recent.includes("CHILD-PROGRESSES")) return { tool: "courier_send", args: { sessionID: parent[1], message: "CHILD HALFWAY" } }
  // The child of COURIER-WAITING schedules a message that tells it to report, and ends its turn to wait for it.
  if (parent && recent.includes("CHILD-WAITS")) return { tool: "courier_later", args: { message: "CHILD-REPORT-NOW", delayMinutes: 0.25 } }
  // The child of COURIER-HOOKED subscribes to a webhook topic and ends its turn to wait for a delivery.
  if (parent && recent.includes("CHILD-HOOKED")) return { tool: "courier_subscribe", args: { topic: "child-ci" } }
  // The middle session of COURIER-DEPTH starts two leaves at once; the second's task makes the probe
  // plugin put courier_spawn back. Each leaf tries to start a session of its own.
  if (parent && recent.includes("CHILD-DEEPENS"))
    return { calls: [{ tool: "courier_spawn", args: { task: "CHILD-LEAF" } }, { tool: "courier_spawn", args: { task: "CHILD-LEAF CHILD-FORCES" } }] }
  if (parent && recent.includes("CHILD-LEAF")) return { tool: "courier_spawn", args: { task: "CHILD-TOO-DEEP" } }
  // The middle session of COURIER-SUBTREE-START starts a leaf, whose turn runs on until the test stops it.
  if (parent && recent.includes("CHILD-SUBTREE-MID")) return { tool: "courier_spawn", args: { task: "CHILD-SUBTREE-LEAF" } }
  if (parent && recent.includes("CHILD-SUBTREE-LEAF")) return { text: "LEAF HOLDING", hold: true }
  // The middle session of COURIER-QUESTION nested starts a child that asks.
  if (parent && recent.includes("CHILD-NESTS")) return { tool: "courier_spawn", args: { task: "CHILD-QUESTION" } }
  // A child whose question was cut off gets the answer as a message, and reports it.
  const answered = recent.match(/<courier from="ses_\w+" answers="question_[\w-]+"( dismissed="true")?>/)
  const startedBy = textOf(messages.find((message) => message.role === "user")?.content).match(/You were started by session (ses_\w+)/)
  // A child the person prompts in its own session answers them, without a report.
  if (startedBy && recent.includes("PERSON-ASKS")) return { text: "CHILD ANSWERS PERSON" }
  // A child its parent told to report does; CHILD-REPORT-PLAIN asks for one without a status, as an older brief would get.
  if (startedBy && recent.includes("CHILD-REPORT-NOW"))
    return { tool: "courier_send", args: { sessionID: startedBy[1], message: "CHILD DONE AFTER NUDGE", status: "done" } }
  if (startedBy && recent.includes("CHILD-REPORT-PLAIN"))
    return { tool: "courier_send", args: { sessionID: startedBy[1], message: "CHILD DONE WITHOUT STATUS" } }
  if (answered && startedBy)
    return {
      tool: "courier_send",
      args: { sessionID: startedBy[1], message: answered[1] ? "CHILD DISMISSED" : `CHILD GOT ${JSON.stringify(answersIn(recent))}`, status: "done" },
    }
  // Any other child reports done, with every kind of artifact.
  if (parent) return { tool: "courier_send", args: { sessionID: parent[1], message: "CHILD DONE", status: "done", artifacts: ARTIFACTS } }
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
  // In the drop scenario, a parent told of a member that ended without a report drops it from the group.
  const dropping = messages.some((message) => message.role === "user" && textOf(message.content).includes("COURIER-GROUP-DROP"))
  if (dropping) {
    const silent = [...recent.matchAll(/<courier from="(ses_\w+)" ended="without-report">/g)].at(-1)
    if (silent) return { tool: "courier_cleanup", args: { sessionID: silent[1] } }
  }
  if (/<courier from="ses_\w+" ended="without-report">/.test(recent)) return { text: "PARENT TOLD SILENT" }
  // A group's reports, in one message, or a member's blocked report, which is not held.
  // A middle session reports its group's message on; a root parent ends its turn on it.
  if (/<courier from="[^"]*" group="/.test(recent) && startedBy)
    return { tool: "courier_send", args: { sessionID: startedBy[1], message: "MIDDLE GOT GROUP", status: "done" } }
  if (/<courier from="[^"]*" group="/.test(recent)) return { text: "PARENT GOT GROUP" }
  if (/<courier from="ses_\w+" status="blocked">/.test(recent)) return { text: "PARENT BLOCKED" }
  if (recent.includes("<courier from=")) return { text: "PARENT WOKE" }
  const nudge = recent.match(/COURIER-NUDGE(-PLAIN)? (ses_\w+)/)
  if (nudge) return { tool: "courier_send", args: { sessionID: nudge[2], message: nudge[1] ? "CHILD-REPORT-PLAIN" : "CHILD-REPORT-NOW" } }
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
  // COURIER-SKILL loads the courier-orchestrate skill with OpenCode's skill tool; a prompt the person
  // attached the skill to carries its text, which the model acknowledges.
  if (recent.includes('<skill_content name="courier-orchestrate">')) return { text: "SKILL SEEN" }
  if (recent.includes("COURIER-SKILL")) return { tool: "skill", args: { id: "courier-orchestrate" } }
  const look = recent.match(/COURIER-STATUS (ses_\w+)/)
  if (look) return { tool: "courier_status", args: { sessionID: look[1] } }
  const clean = recent.match(/COURIER-CLEANUP (ses_\w+)( force)?/)
  if (clean) return { tool: "courier_cleanup", args: { sessionID: clean[1], ...(clean[2] ? { force: true } : {}) } }
  if (recent.includes("COURIER-SUBTREE-START")) return { tool: "courier_spawn", args: { task: "CHILD-SUBTREE-MID" } }
  if (recent.includes("COURIER-SUBTREE-TREE")) return { tool: "courier_tree", args: {} }
  const stopping = recent.match(/COURIER-SUBTREE-STOP (ses_\w+)/)
  if (stopping) return { tool: "courier_stop", args: { sessionID: stopping[1] } }
  const children = recent.match(/COURIER-CHILDREN (ses_\w+)/)
  if (children) return { tool: "courier_children", args: { sessionID: children[1] } }
  if (recent.includes("COURIER-ROSTER")) return spawnChild(false)
  if (recent.includes("COURIER-GROUP-NESTED")) return { tool: "courier_spawn", args: { task: "CHILD-GROUPS" } }
  if (recent.includes("COURIER-GROUP-SPLIT")) return { tool: "courier_spawn", args: { task: "CHILD-QUICK", group: "pair" } }
  // COURIER-GROUP-DROP starts two children at once in one group; the second ends its turn without a report.
  if (recent.includes("COURIER-GROUP-DROP"))
    return {
      calls: [
        { tool: "courier_spawn", args: { task: "Report back to parent.", group: "pair" } },
        { tool: "courier_spawn", args: { task: "CHILD-SILENT", group: "pair" } },
      ],
    }
  // COURIER-GROUP starts two children at once in one group; with -BLOCKED, the second needs a decision first.
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
  if (recent.includes("COURIER-SILENT")) return { tool: "courier_spawn", args: { task: "CHILD-SILENT" } }
  if (recent.includes("COURIER-PROGRESS")) return { tool: "courier_spawn", args: { task: "CHILD-PROGRESSES" } }
  if (recent.includes("COURIER-WAITING")) return { tool: "courier_spawn", args: { task: "CHILD-WAITS" } }
  if (recent.includes("COURIER-HOOKED")) return { tool: "courier_spawn", args: { task: "CHILD-HOOKED" } }
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

// What a child reports as artifacts: one of each kind, so the test sees the whole layout.
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
    if ((reply.tool === "courier_send" || reply.tool === "shell" || reply.status || reply.delayed) && !reply.quick && childDelay)
      await new Promise((resolve) => setTimeout(resolve, childDelay))
    // The session, and the courier role its system prompt names (`root` is the pointer to the skill), for the recursion scenario.
    const session = request.headers["x-opencode-session-id"]
    const system = (body.messages ?? []).filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n")
    const role = system.match(/opencode-courier role: (root orchestrator|sub-orchestrator|leaf|root)/)?.[1] ?? null
    const skills = [...system.matchAll(/<skill>\s*<id>([^<]+)<\/id>/g)].map((match) => match[1])
    if (log) appendFileSync(log, `${JSON.stringify({ url: request.url, stream: !!body.stream, session, role, skills, tools: (body.tools ?? []).map((tool) => tool.function?.name), reply })}\n`)
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
