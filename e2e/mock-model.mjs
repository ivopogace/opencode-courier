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
    return { text: `TOOL DONE ${call?.function?.name}: ${result}` }
  }
  const recent = messages
    .slice(lastAssistant + 1)
    .map((message) => textOf(message.content))
    .join("\n")
  const parent = recent.match(/You were started by session (ses_\w+) through opencode-courier/)
  // The child of COURIER-FAIL cannot reach its model, as with a model blocked for the account.
  if (parent && recent.includes("CHILD-FAILS")) return { status: 403, error: "This model is not available in your country" }
  if (parent) return { tool: "courier_send", args: { sessionID: parent[1], message: "CHILD DONE" } }
  if (recent.includes("<courier from=")) return { text: "PARENT WOKE" }
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
  if (recent.includes("COURIER-FAIL")) return { tool: "courier_spawn", args: { task: "CHILD-FAILS" } }
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
    if ((reply.tool === "courier_send" || reply.status) && childDelay) await new Promise((resolve) => setTimeout(resolve, childDelay))
    if (log) appendFileSync(log, `${JSON.stringify({ url: request.url, stream: !!body.stream, tools: (body.tools ?? []).map((tool) => tool.function?.name), reply })}\n`)
    if (reply.status) {
      response.writeHead(reply.status, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: reply.error, type: "forbidden" } }))
      return
    }
    const call = reply.tool && { id: `call_${Date.now()}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }
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
              message: { role: "assistant", content: reply.text ?? null, ...(call ? { tool_calls: [call] } : {}) },
              finish_reason: call ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    if (call) {
      response.write(chunk({ role: "assistant", tool_calls: [{ index: 0, ...call }] }, null))
      response.write(chunk({}, "tool_calls"))
    } else {
      response.write(chunk({ role: "assistant", content: reply.text }, null))
      response.write(chunk({}, "stop"))
    }
    response.end("data: [DONE]\n\n")
  })
}).listen(port, "127.0.0.1", () => console.log(`mock model on http://127.0.0.1:${port}/v1`))
