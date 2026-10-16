import type { Status } from "../kernel/protocol.js"
import { busy } from "./domain.js"
import type { CourierPorts, ModelWindow, Pending, ShownForm } from "./ports.js"
import { lastStatus, stoppedSincePrompt } from "./report.js"
import type { Row, Tree, Wait } from "./rpc.js"
import { standingIn } from "./status.js"
import { childStore } from "./store.js"
import { readTree, type Listed } from "./subtree.js"
import { stalledAmong } from "./wake.js"

type Messages = Awaited<ReturnType<CourierPorts["session"]["context"]>>

/** The last tool call in a session's messages, and when it was made. */
export function lastTool(messages: Messages) {
  for (const message of messages.toReversed()) {
    if (message.type !== "assistant") continue
    const tool = message.content.findLast((part) => part.type === "tool")
    if (tool?.type === "tool") return { name: tool.name, at: tool.time.ran ?? tool.time.created }
  }
  return undefined
}

/** How full a session's context is, as OpenCode's session view reads it (packages/tui/src/util/session.ts, v2.0.32): the last usage since the last compaction over its model's window. */
export function contextOf(messages: Messages, windows: ReadonlyArray<ModelWindow>) {
  const compacted = messages.findLastIndex((message) => message.type === "compaction" && message.status === "completed")
  const last = messages.findLast((message, index) => index > compacted && message.type === "assistant" && message.tokens !== undefined)
  if (last?.type !== "assistant" || !last.tokens) return undefined
  const { input, output, reasoning, cache } = last.tokens
  const used = input + output + reasoning + cache.read + cache.write
  const window = windows.find((model) => model.providerID === last.model.providerID && model.id === last.model.id)?.context
  return used > 0 && window ? used / window : undefined
}

/** A request as the panel says what a paused session waits on: a permission request, or its first question. */
export const waitOf = (pending: Pending): Wait =>
  pending.type === "permission"
    ? { type: "permission", action: pending.action, resources: [...pending.resources] }
    : { type: "question", question: pending.questions[0]?.question ?? "" }

/** A form a session shows, as the panel says what it waits on. */
export const formWait = (form: ShownForm): Wait => ({ type: "form", title: form.title })

/** A session's report since its last prompt, as the panel shows it; none for one spawned before this was kept. */
function reportRow(report: Listed["report"], status: Status | undefined): Pick<Row, "report"> {
  if (!report) return {}
  if (report.owes) return { report: { state: "owed", progressed: report.progressed } }
  if (report.ended) return { report: { state: "ended", progressed: report.progressed } }
  return { report: { state: "reported", progressed: report.progressed, ...(status ? { status } : {}) } }
}

/**
 * What a session does: waiting on a request to the person or a form it shows them, stalled, running, idle, or gone when
 * OpenCode no longer knows it. A message waiting in its inbox makes a stalled session look busy.
 */
function stateOf(info: unknown, waits: number, stalled: boolean, running: boolean): Row["state"] {
  if (!info) return "gone"
  if (waits) return "waiting"
  if (stalled) return "stalled"
  return running ? "running" : "idle"
}
/** One session of the panel: what it is doing, its report and group standing, its last tool call, context use and cost. */
async function row(ports: CourierPorts, windows: ReadonlyArray<ModelWindow>, { entry, depth, info, pending, forms, report }: Listed, stalled: number | undefined): Promise<Row> {
  const { sessionID } = entry
  const [messages, status, standing, stopped] = await Promise.all([
    ports.session.context({ sessionID }).catch((): Messages => []),
    lastStatus(childStore(ports.storage), sessionID).catch(() => undefined),
    entry.group ? standingIn(ports, entry, entry.group) : undefined,
    stoppedSincePrompt(childStore(ports.storage), sessionID).catch(() => false),
  ])
  const running = info !== undefined && busy(info.time)
  const tool = lastTool(messages)
  const context = contextOf(messages, windows)
  return {
    sessionID,
    parentID: entry.parentID,
    title: info?.title ?? entry.title,
    depth,
    state: stateOf(info, pending.length + forms.length, stalled !== undefined, running),
    ...(stalled !== undefined ? { stalled } : {}),
    ...(info?.outcome ? { outcome: info.outcome } : {}),
    ...(stopped ? { stopped } : {}),
    ...reportRow(report, status),
    ...(entry.group && standing ? { group: { name: entry.group, standing } } : {}),
    isolated: entry.isolated,
    created: info?.time.created ?? entry.createdAt,
    ...(info && !running && info.time.idle !== undefined ? { idle: info.time.idle } : {}),
    ...(info ? { cost: info.cost } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(tool ? { tool } : {}),
    waits: [...pending.map(waitOf), ...forms.map(formWait)],
  }
}

/**
 * The tree panel's rows: the sessions under a session as courier_tree lists them, at most `maxTotal`, the live ones
 * first, then the newest, each as `row` reads it; `truncated` counts the older ones left out, and `stalled` says the root is.
 */
export async function panel(ports: CourierPorts, rootID: string): Promise<Tree> {
  const { kept, leftOut } = await readTree(ports, rootID)
  const stalled = await stalledAmong(ports, [rootID, ...kept.map((node) => node.entry.sessionID)])
  const windows = await ports.windows().catch((): ModelWindow[] => [])
  const rows = await Promise.all(kept.map((node) => row(ports, windows, node, stalled.get(node.entry.sessionID))))
  const own = stalled.get(rootID)
  return { rows, ...(leftOut ? { truncated: leftOut } : {}), ...(own !== undefined ? { stalled: own } : {}) }
}
