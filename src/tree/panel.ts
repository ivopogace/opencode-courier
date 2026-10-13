import type { Status } from "../kernel/protocol.js"
import { busy } from "./domain.js"
import type { CourierPorts, Pending, RosterEntry } from "./ports.js"
import { lastStatus, reportOf } from "./report.js"
import type { Row, Tree, Wait } from "./rpc.js"
import { standingIn } from "./status.js"
import { childStore } from "./store.js"
import { subtree } from "./subtree.js"

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

/** A request as the panel says what a paused session waits on: a permission request, or its first question. */
export const waitOf = (pending: Pending): Wait =>
  pending.type === "permission"
    ? { type: "permission", action: pending.action, resources: [...pending.resources] }
    : { type: "question", question: pending.questions[0]?.question ?? "" }

/** A session's report since its last prompt, as the panel shows it; none for one spawned before this was kept. */
function reportRow(report: Awaited<ReturnType<typeof reportOf>>, status: Status | undefined): Pick<Row, "report"> {
  if (!report) return {}
  if (report.owes) return { report: { state: "owed", progressed: report.progressed } }
  if (report.ended) return { report: { state: "ended", progressed: report.progressed } }
  return { report: { state: "reported", progressed: report.progressed, ...(status ? { status } : {}) } }
}

/** What a session does: waiting on a request to the person, running, idle, or gone when OpenCode no longer knows it. */
function stateOf(info: unknown, waits: number, running: boolean): Row["state"] {
  if (!info) return "gone"
  if (waits) return "waiting"
  return running ? "running" : "idle"
}
/** One session of the panel: what it is doing, its report and group standing, its last tool call and its cost. */
async function row(ports: CourierPorts, entry: RosterEntry, depth: number): Promise<Row> {
  const { sessionID } = entry
  const children = childStore(ports.storage)
  const [info, messages, pending, report, status, standing] = await Promise.all([
    ports.session.get({ sessionID }).catch(() => undefined),
    ports.session.context({ sessionID }).catch((): Messages => []),
    ports.pending(sessionID).catch((): ReadonlyArray<Pending> => []),
    reportOf(children, sessionID).catch(() => undefined),
    lastStatus(children, sessionID).catch(() => undefined),
    entry.group ? standingIn(ports, entry, entry.group) : undefined,
  ])
  const running = info !== undefined && busy(info.time)
  const tool = lastTool(messages)
  return {
    sessionID,
    parentID: entry.parentID,
    title: info?.title ?? entry.title,
    depth,
    state: stateOf(info, pending.length, running),
    ...(info?.outcome ? { outcome: info.outcome } : {}),
    ...reportRow(report, status),
    ...(entry.group && standing ? { group: { name: entry.group, standing } } : {}),
    isolated: entry.isolated,
    created: info?.time.created ?? entry.createdAt,
    ...(info && !running && info.time.idle !== undefined ? { idle: info.time.idle } : {}),
    ...(info ? { cost: info.cost } : {}),
    ...(tool ? { tool } : {}),
    waits: pending.map(waitOf),
  }
}

/** The tree panel's rows: the sessions courier_tree reads under a session, at most `maxTotal`, each as `row` reads it. */
export async function panel(ports: CourierPorts, rootID: string): Promise<Tree> {
  const { nodes, truncated } = await subtree(ports.storage, rootID, ports.limits.maxTotal)
  const rows = await Promise.all(nodes.map(({ entry, depth }) => row(ports, entry, depth)))
  return { rows, ...(truncated ? { truncated: ports.limits.maxTotal } : {}) }
}
