import { createHmac, timingSafeEqual } from "node:crypto"
import { readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { homedir } from "node:os"
import { addBounded } from "../platform/bounded.js"
import { sharedState } from "../platform/hub.js"
import { isNotFound, num, obj, str } from "../platform/json.js"
import { envelope } from "../kernel/protocol.js"
import { GENERIC_NAME, keyOf, subscriptions, type WebhookPorts } from "./subscriptions.js"
import { CI_EVENTS, githubSummary, hookSummary, webhookText } from "./text.js"

/** Bodies above this are refused; GitHub's own deliveries are capped at 25 MB, real ones are far smaller. */
export const DEFAULT_MAX_BYTES = 1024 * 1024

/** How many accepted signatures are remembered, so a captured delivery cannot be replayed. */
const REMEMBERED = 1000

/**
 * The webhook receiver, one per process: every instance configured with a `webhook` option joins
 * `instances`, the first one starts the server, and the last one to unload stops it.
 */
export interface Receiver {
  readonly config: WebhookConfig
  readonly instances: Set<WebhookPorts>
  readonly server: Promise<Server | undefined>
}

/** The current receiver, if any, and the previous one while it closes, which a new one waits for. */
export interface Receivers {
  current?: Receiver
  closing?: Promise<void>
}

/** The receiver's settings, from the plugin's `webhook` option. */
export interface WebhookConfig {
  readonly port: number
  readonly host: string
  readonly secret: string
  readonly maxBytes: number
}

/**
 * The HMAC a delivery is signed with: of the raw body for GitHub, and of `<name>\n<body>` for
 * `/hook/<name>`, so a captured generic delivery cannot be replayed to another topic.
 */
function hmac(secret: string, body: string | Uint8Array, name?: string) {
  const mac = createHmac("sha256", secret)
  if (name !== undefined) mac.update(`${name}\n`)
  return mac.update(body).digest()
}

const SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/

/**
 * Checks an `X-Hub-Signature-256` header (`sha256=` + 64 hex digits) in constant time, returning the
 * digest in lowercase hex, or undefined; replays are keyed by that digest, never by the header text.
 */
export function checkSignature(secret: string, body: Uint8Array, header: string | undefined, name?: string) {
  const hex = header?.match(SIGNATURE)?.[1]
  if (!hex) return undefined
  // SIGNATURE admits exactly 64 hex digits, so both sides are 32 bytes, as timingSafeEqual needs.
  const expected = hmac(secret, body, name)
  return timingSafeEqual(Buffer.from(hex, "hex"), expected) ? expected.toString("hex") : undefined
}

/** The `X-Hub-Signature-256` value for a body; give the topic name for `/hook/<name>`. */
export function sign(secret: string, body: string | Uint8Array, name?: string) {
  return `sha256=${hmac(secret, body, name).toString("hex")}`
}

/** What an event means for subscribers: the topics it belongs to and a short summary. */
export interface Event {
  readonly source: string
  readonly name: string
  readonly topics: readonly string[]
  readonly summary: string
}

/** Pull request and issue actions worth a wake-up; edits, labels, assignments and pushes to the branch are not. */
const ITEM_ACTIONS = new Set(["opened", "reopened", "closed", "ready_for_review"])

/** The pull request and issue numbers a GitHub delivery concerns, each with a topic of its own. */
function numbersOf(name: string, body: Record<string, any>): number[] {
  if (Object.hasOwn(CI_EVENTS, name)) {
    const run = obj(body[name])
    const numbers = new Set<number>()
    for (const item of Array.isArray(run.pull_requests) ? run.pull_requests : []) {
      const n = num(obj(item).number)
      if (n !== undefined) numbers.add(n)
    }
    return [...numbers]
  }
  let n: number | undefined
  if (name === "pull_request_review" || name === "pull_request") n = num(obj(body.pull_request).number)
  else if (name === "pull_request_review_comment" || name === "issue_comment") n = num(obj(body.pull_request).number) ?? num(obj(body.issue).number)
  else if (name === "issues") n = num(obj(body.issue).number)
  return n === undefined ? [] : [n]
}

/**
 * Maps a GitHub delivery to its topics (`github:owner/repo`, plus `github:owner/repo#N` for PRs and
 * issues) and a summary; undefined for pings, unfinished CI events and actions outside `ITEM_ACTIONS`.
 */
export function githubEvent(name: string, payload: unknown): Event | undefined {
  const body = obj(payload)
  const repo = str(obj(body.repository).full_name)
  if (name === "ping" || !repo) return undefined
  const action = str(body.action)
  if (Object.hasOwn(CI_EVENTS, name) && action !== "completed") return undefined
  if ((name === "pull_request" || name === "issues") && (!action || !ITEM_ACTIONS.has(action))) return undefined
  const sender = str(obj(body.sender).login)
  const numbers = numbersOf(name, body)
  const lower = repo.toLowerCase()
  return {
    source: "github",
    name,
    topics: [`github:${lower}`, ...numbers.map((n) => `github:${lower}#${n}`)],
    summary: githubSummary({ name, body, repo, action, sender, by: sender ? ` by ${sender}` : "", numbers }),
  }
}

/** A delivery to `/hook/<topic>`: a JSON body's `text`, `summary` or `message` field, else the body itself. */
export function genericEvent(topic: string, body: string): Event {
  let text = body
  try {
    const parsed = obj(JSON.parse(body))
    text = str(parsed.text) ?? str(parsed.summary) ?? str(parsed.message) ?? body
  } catch {}
  return { source: "hook", name: topic, topics: [topic], summary: hookSummary(text) }
}

/**
 * Delivers an event to every session subscribed to one of its topics, once per session. A session
 * OpenCode no longer knows loses its subscriptions.
 */
export async function dispatch(ports: WebhookPorts, event: Event, delivery?: string) {
  const subscribed = (await Promise.all(event.topics.map((topic) => subscriptions(ports, topic)))).flat()
  const sessions = new Set(subscribed.map((item) => item.sessionID))
  let delivered = 0
  let failed = 0
  // Each session gets its own message, so they go out at once rather than one after another.
  const deliver = (sessionID: string) =>
    ports.session
      .synthetic({
        sessionID,
        text: envelope(event.source, webhookText(event.summary), {
          event: event.name,
          ...(delivery ? { delivery } : {}),
        }),
        description: `${event.source} ${event.name}`,
        metadata: { source: "courier", from: event.source, event: event.name, ...(delivery ? { delivery } : {}) },
        delivery: "queue",
      })
      .then(() => delivered++)
      .catch(async (error: unknown) => {
        if (!isNotFound(error)) {
          failed++
          return ports.log(`courier webhook: ${event.name} not delivered to ${sessionID}: ${String(error)}`)
        }
        const gone = subscribed.filter((item) => item.sessionID === sessionID)
        await Promise.all(gone.map((item) => ports.storage.remove(keyOf(item.sessionID, item.topic))))
        ports.log(`courier webhook: ${sessionID} no longer exists; dropped its subscriptions to ${gone.map((item) => item.topic).join(", ")}`)
      })
  await Promise.all([...sessions].map(deliver))
  return { delivered, failed }
}

export interface Request {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly body: Buffer
}

export interface Response {
  readonly status: number
  readonly body: string
}

const header = (request: Request, name: string) => {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

const isResponse = (value: object): value is Response => "status" in value

const decode = (raw: string) => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

/** The topic a request is for: none for `/github`, the name for `/hook/<name>`; else the refusal. */
function route(request: Request): Response | { readonly topic: string | undefined } {
  const generic = /^\/hook\/([^/]+)$/.exec(request.path)
  if (request.path !== "/github" && !generic) return { status: 404, body: "not found" }
  if (request.method !== "POST") return { status: 405, body: "use POST" }
  if (!generic) return { topic: undefined }
  const topic = decode(generic[1]!)
  return topic && GENERIC_NAME.test(topic) ? { topic } : { status: 400, body: "bad topic" }
}

/** The event in a signed request's body, or why there is none to deliver. */
function parseEvent(request: Request, topic: string | undefined): Response | Event {
  if (topic !== undefined) return genericEvent(topic, request.body.toString("utf8"))
  const name = header(request, "x-github-event")
  if (!name || !/^[\w.-]{1,64}$/.test(name)) return { status: 400, body: "missing or bad X-GitHub-Event" }
  let payload: unknown
  try {
    payload = JSON.parse(request.body.toString("utf8"))
  } catch {
    return { status: 400, body: "body is not JSON; set the webhook's content type to application/json" }
  }
  return githubEvent(name, payload) ?? { status: 200, body: `ignored ${name}` }
}

/** Dispatches a delivery `receive` has marked as seen, and unmarks it if it reached nobody. */
async function deliver(ports: WebhookPorts, request: Request, event: Event, digest: string, seen: Set<string>): Promise<Response> {
  const delivery = header(request, "x-github-delivery")?.replace(/[^\w-]/g, "").slice(0, 64) || undefined
  const { delivered, failed } = await dispatch(ports, event, delivery).catch((error: unknown) => {
    seen.delete(digest)
    throw error
  })
  if (failed > 0 && delivered === 0) seen.delete(digest)
  const id = delivery ? ` ${delivery}` : ""
  ports.log(`courier webhook: ${event.source} ${event.name}${id} delivered to ${delivered} session(s)`)
  return { status: 202, body: `delivered to ${delivered} session(s)` }
}

/**
 * Handles one request: `POST /github` with GitHub's headers, or `POST /hook/<name>` signed over name
 * and body; anything unsigned is refused before parsing, and a signature already accepted is ignored.
 */
export async function receive(ports: WebhookPorts, secret: string, request: Request, seen = new Set<string>()): Promise<Response> {
  const routed = route(request)
  if (isResponse(routed)) return routed
  const digest = checkSignature(secret, request.body, header(request, "x-hub-signature-256"), routed.topic)
  if (!digest) return { status: 401, body: "bad or missing X-Hub-Signature-256" }
  if (seen.has(digest)) return { status: 200, body: "already delivered" }
  const event = parseEvent(request, routed.topic)
  if (isResponse(event)) return event
  // Marked with no await since the check above, so a concurrent replay is refused, and unmarked if
  // the delivery reached nobody it was meant for, so a retry or a GitHub Redeliver can still get through.
  addBounded(seen, digest, REMEMBERED)
  return deliver(ports, request, event, digest, seen)
}

class TooLarge extends Error {}

function readBody(request: IncomingMessage, maxBytes: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const declared = Number(request.headers["content-length"])
    if (declared > maxBytes) return reject(new TooLarge())
    const chunks: Buffer[] = []
    let size = 0
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new TooLarge())
        request.removeAllListeners("data")
        request.resume()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks)))
    request.on("error", reject)
  })
}

/** Starts the HTTP receiver; `ports()` picks a live plugin instance for each request. */
export function listen(config: WebhookConfig, ports: () => WebhookPorts | undefined) {
  // Digests of accepted deliveries, newest last; shared by every request this receiver handles.
  const seen = new Set<string>()
  const server = createServer((request, response) => {
    const reply = ({ status, body }: Response) => {
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" })
      response.end(`${body}\n`)
    }
    const path = (request.url ?? "/").split("?")[0]!
    readBody(request, config.maxBytes)
      .then(async (body) => {
        const live = ports()
        if (!live) return reply({ status: 503, body: "courier is not loaded" })
        reply(await receive(live, config.secret, { method: request.method ?? "GET", path, headers: request.headers, body }, seen))
      })
      .catch((error: unknown) => {
        if (error instanceof TooLarge) return reply({ status: 413, body: `body over ${config.maxBytes} bytes` })
        ports()?.log(`courier webhook: ${path} failed: ${String(error)}`)
        reply({ status: 500, body: "internal error" })
      })
  })
  return new Promise<Server>((resolve, reject) => {
    server.once("error", reject)
    server.listen(config.port, config.host, () => {
      server.off("error", reject)
      resolve(server)
    })
  })
}

/**
 * Reads the `webhook` option, undefined when the receiver is not configured; the secret comes from
 * `secretFile` or the env var `secretEnv` (default `COURIER_WEBHOOK_SECRET`), never from the option.
 */
export function readConfig(options: unknown, env: Record<string, string | undefined> = process.env): WebhookConfig | undefined {
  const option = obj(options).webhook
  if (option === undefined || option === false) return undefined
  if (option !== true && obj(option) !== option) throw new Error("webhook must be an object of settings, or true for the defaults")
  const webhook = obj(option)
  const port = webhook.port ?? 4097
  if (num(port) === undefined || port < 0 || port > 65535) throw new Error(`webhook.port is not a port: ${port}`)
  if ("secret" in webhook) throw new Error("webhook.secret is not read; put the secret in a file (webhook.secretFile) or an environment variable")
  const file = str(webhook.secretFile)?.replace(/^~(?=$|\/)/, homedir())
  const secret = (file ? readFileSync(file, "utf8") : env[str(webhook.secretEnv) ?? "COURIER_WEBHOOK_SECRET"])?.trim()
  if (!secret) throw new Error(file ? `webhook.secretFile ${file} is empty` : `${str(webhook.secretEnv) ?? "COURIER_WEBHOOK_SECRET"} is not set`)
  const maxBytes = webhook.maxBytes ?? DEFAULT_MAX_BYTES
  if (num(maxBytes) === undefined || maxBytes <= 0) throw new Error(`webhook.maxBytes is not a positive integer: ${maxBytes}`)
  return { port, host: str(webhook.host) ?? "127.0.0.1", secret, maxBytes }
}

/**
 * The webhook receiver, one per process: instances with a `webhook` option join `instances`, the first
 * starts the server and the last to unload stops it; one that could not listen is dropped for a retry.
 */
const receivers = sharedState<Receivers>("receiver", () => ({}))

const sameSettings = (a: WebhookConfig, b: WebhookConfig) =>
  a.port === b.port && a.host === b.host && a.secret === b.secret && a.maxBytes === b.maxBytes

function startReceiver(config: WebhookConfig, log: (message: string) => void) {
  const instances = new Set<WebhookPorts>()
  const receiver: Receiver = {
    config,
    instances,
    server: (receivers.closing ?? Promise.resolve())
      .then(() => listen(config, () => instances.values().next().value))
      .then(
        (server) => {
          log(`courier webhook: listening on http://${config.host}:${(server.address() as { port: number }).port}`)
          return server
        },
        (error: unknown) => {
          log(`courier webhook: cannot listen on ${config.host}:${config.port}: ${String(error)}`)
          if (receivers.current === receiver) receivers.current = undefined
          return undefined
        },
      ),
  }
  receivers.current = receiver
  return receiver
}

/** Joins this instance to the process's receiver, starting it if there is none; returns the leave. */
export function joinReceiver(config: WebhookConfig, ports: WebhookPorts) {
  const receiver = receivers.current ?? startReceiver(config, ports.log)
  if (!sameSettings(receiver.config, config))
    ports.log(
      `courier webhook: already running on ${receiver.config.host}:${receiver.config.port} with other settings ` +
        "(port, host, secret or maxBytes); this location's are ignored. Set the webhook option once, in the global config.",
    )
  receiver.instances.add(ports)
  return async () => {
    receiver.instances.delete(ports)
    if (receiver.instances.size > 0 || receivers.current !== receiver) return
    receivers.current = undefined
    const closing = receiver.server.then(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server) return resolve()
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    )
    receivers.closing = closing
    await closing
    if (receivers.closing === closing) receivers.closing = undefined
  }
}

/** Whether a webhook receiver runs in this server. */
export const receiving = async () => (await receivers.current?.server) !== undefined
