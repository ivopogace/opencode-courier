import type { Status } from "../kernel/protocol.js"
import { startedAs } from "./domain.js"
import type { CourierPorts, KnownModel, ModelWindow, Pending, ShownForm } from "./ports.js"
import { lastStatus, stoppedSincePrompt } from "./report.js"
import type { Row, Tree, Wait } from "./rpc.js"
import { childStore } from "./store.js"
import { readTop, readTree, type Listed } from "./subtree.js"
import { stalledAmong } from "./wake.js"

type Messages = Awaited<ReturnType<CourierPorts["session"]["context"]>>

export function lastTool(messages: Messages) {
  for (const message of messages.toReversed()) {
    if (message.type !== "assistant") continue
    const tool = message.content.findLast((part) => part.type === "tool")
    if (tool?.type === "tool") return { name: tool.name, at: tool.time.ran ?? tool.time.created }
  }
  return undefined
}

export function contextOf(messages: Messages, windows: ReadonlyArray<ModelWindow>) {
  const compacted = messages.findLastIndex((message) => message.type === "compaction" && message.status === "completed")
  const last = messages.findLast((message, index) => index > compacted && message.type === "assistant" && message.tokens !== undefined)
  if (last?.type !== "assistant" || !last.tokens) return undefined
  const { input, output, reasoning, cache } = last.tokens
  const used = input + output + reasoning + cache.read + cache.write
  const window = windows.find((model) => model.providerID === last.model.providerID && model.id === last.model.id)?.context
  return used > 0 && window ? used / window : undefined
}

export const waitOf = (pending: Pending): Wait =>
  pending.type === "permission"
    ? { type: "permission", action: pending.action, resources: [...pending.resources] }
    : { type: "question", question: pending.questions[0]?.question ?? "" }

export const formWait = (form: ShownForm): Wait => ({ type: "form", title: form.title })

function reportRow(report: Listed["report"], status: Status | undefined): Pick<Row, "report"> {
  if (!report) return {}
  if (report.owes) return { report: { state: "owed", progressed: report.progressed } }
  if (report.ended) return { report: { state: "ended", progressed: report.progressed } }
  return { report: { state: "reported", progressed: report.progressed, ...(status ? { status } : {}) } }
}

function stateOf(info: unknown, waits: number, stalled: boolean, running: boolean): Row["state"] {
  if (!info) return "gone"
  if (waits) return "waiting"
  if (stalled) return "stalled"
  return running ? "running" : "idle"
}
async function row(ports: CourierPorts, windows: ReadonlyArray<ModelWindow>, { entry, depth, subagent, info, running, endedAt, pending, forms, report }: Listed, stalled: number | undefined): Promise<Row> {
  const { sessionID } = entry
  const [messages, status, stopped] = await Promise.all([
    ports.session.context({ sessionID }).catch((): Messages => []),
    lastStatus(childStore(ports.storage), sessionID).catch(() => undefined),
    stoppedSincePrompt(childStore(ports.storage), sessionID).catch(() => false),
  ])
  const tool = lastTool(messages)
  const context = contextOf(messages, windows)
  const state = stateOf(info, pending.length + forms.length, stalled !== undefined, running)
  const resumes = state === "idle" && !stopped && report?.resumesAt !== undefined && report.resumesAt > ports.now() ? report.resumesAt : undefined
  return {
    sessionID,
    parentID: entry.parentID,
    title: info?.title ?? entry.title,
    depth,
    state,
    ...(stalled !== undefined ? { stalled } : {}),
    ...(info?.outcome ? { outcome: info.outcome } : {}),
    ...(resumes !== undefined ? { resumes } : {}),
    ...(stopped ? { stopped } : {}),
    ...reportRow(report, status),
    ...startedAs(entry),
    ...(subagent ? { subagent } : {}),
    created: info?.time.created ?? entry.createdAt,
    ...(info && !running && endedAt !== undefined ? { idle: endedAt } : {}),
    ...(info ? { cost: info.cost } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(tool ? { tool } : {}),
    waits: [...pending.map(waitOf), ...forms.map(formWait)],
  }
}

export async function panel(ports: CourierPorts, rootID: string): Promise<Tree> {
  const [{ kept, leftOut }, root] = await Promise.all([readTree(ports, rootID), readTop(ports, rootID)])
  const stalled = await stalledAmong(ports, [rootID, ...kept.map((node) => node.entry.sessionID)])
  const windows = await ports.models().catch((): KnownModel[] => [])
  const [rows, top] = await Promise.all([
    Promise.all(kept.map((node) => row(ports, windows, node, stalled.get(node.entry.sessionID)))),
    root && row(ports, windows, root, stalled.get(rootID)),
  ])
  const own = stalled.get(rootID)
  return { rows, ...(top ? { top } : {}), ...(leftOut ? { truncated: leftOut } : {}), ...(own !== undefined ? { stalled: own } : {}) }
}
