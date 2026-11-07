import { isNotFound } from "../platform/json.js"
import { describeFailure, envelope } from "../kernel/protocol.js"
import { cleanup } from "./cleanup.js"
import type { CleanupResult, StopPorts } from "./ports.js"
import { lastStatus, reportOf } from "./report.js"
import { syncStanding } from "./standing.js"
import { childStore } from "./store.js"
import { subtree, type Below } from "./subtree.js"
import { blockedStoppedNotice, idleStoppedNotice, stoppedNotice } from "./text.js"
import { forgetWakes } from "./wake.js"

export interface StopInput {
  readonly sessionID: string
  readonly cleanup?: boolean
}

export interface Stopped {
  readonly sessionID: string
  readonly title: string
  readonly depth: number
  readonly outcome: "interrupted" | "idle" | "gone" | "failed"
  readonly error?: string
  readonly subagent?: true
}

export interface StopResult {
  readonly sessionID: string
  readonly stopped: ReadonlyArray<Stopped>
  readonly cancelled: ReadonlyArray<string>
  readonly cleanup?: ReadonlyArray<CleanupResult | { readonly sessionID: string; readonly outcome: "failed"; readonly error: string }>
  readonly told?: string
}

const ROUNDS = 3

export const SETTLE_MS = 2_000

export async function stop(ports: StopPorts, callerID: string, input: StopInput): Promise<StopResult> {
  const { storage, session } = ports.courier
  const { sessionID } = input
  const startedAt = Date.now()
  const chain = await childStore(storage).lineage(sessionID)
  if (!chain.length) throw new Error(`${sessionID} was not started with courier_spawn, so courier_stop cannot stop it.`)
  const target = chain[0]!
  if (!chain.some((entry) => entry.parentID === callerID))
    throw new Error(
      `${callerID} is not above ${sessionID}: only a session above it, in the line of sessions that started it with courier_spawn, can stop it.`,
    )

  const seen = new Set<string>()
  const nodes: Below[] = []
  const results: Stopped[] = []
  const cancelled: string[] = []
  const round = async (pending: Below[], left: number): Promise<void> => {
    if (!pending.length || left === 0) return
    for (const node of pending) seen.add(node.entry.sessionID)
    nodes.push(...pending)
    await Promise.all(pending.map((node) => silence(ports, node, cancelled)))
    results.push(...(await eachDeepestFirst(pending, (node) => interrupt(ports, node))))
    const meanwhile = (await subtree(storage, sessionID, undefined, session)).nodes.filter((node) => !seen.has(node.entry.sessionID))
    return round(meanwhile, left - 1)
  }
  const first = (await subtree(storage, sessionID, undefined, session)).nodes
  const background = await backgroundSubagents(ports, first)
  await round([{ entry: target, depth: 0 }, ...first], ROUNDS)
  await settle(ports, nodes, results, background, startedAt)
  const parents = new Set(nodes.flatMap((node) => (node.subagent ? [] : [node.entry.parentID])))
  await Promise.all([...parents].map((parentID) => syncStanding(ports.courier, parentID)))

  const told = target.parentID === callerID ? undefined : await tellParent(ports, callerID, target, results)
  return {
    sessionID,
    stopped: results,
    cancelled,
    ...(input.cleanup ? { cleanup: await removeWorktrees(ports, nodes) } : {}),
    ...(told ? { told } : {}),
  }
}

function eachDeepestFirst<T>(nodes: ReadonlyArray<Below>, act: (node: Below) => Promise<T>) {
  const depths = [...new Set(nodes.map((node) => node.depth))].sort((a, b) => b - a)
  return depths.reduce(
    (before, depth) => before.then(async (done) => [...done, ...(await Promise.all(nodes.filter((node) => node.depth === depth).map(act)))]),
    Promise.resolve<T[]>([]),
  )
}

async function silence(ports: StopPorts, { entry, subagent }: Below, cancelled: string[]) {
  const { storage, now, log } = ports.courier
  const { sessionID } = entry
  if (!subagent)
    await childStore(storage).stopped(sessionID, now()).catch((error: unknown) => log(`courier_stop: could not note that ${sessionID} was stopped: ${String(error)}`))
  try {
    cancelled.push(...(await ports.cancelScheduled(sessionID)))
  } catch (error) {
    log(`courier_stop: could not cancel the messages scheduled for ${sessionID}: ${String(error)}`)
  }
  await forgetWakes(ports.courier, sessionID).catch((error: unknown) => log(`courier_stop: could not drop the wake watch of ${sessionID}: ${String(error)}`))
}

async function interrupt(ports: StopPorts, { entry, depth, subagent }: Below): Promise<Stopped> {
  const { sessionID, title } = entry
  const { storage, session, now } = ports.courier
  const one = { sessionID, title, depth, ...(subagent ? { subagent } : {}) }
  try {
    const { interrupted } = await session.interrupt({ sessionID })
    // the interrupted event may arrive after this returns
    if (interrupted && !subagent) await childStore(storage).settled(sessionID, "interrupted", now()).catch(() => undefined)
    return { ...one, outcome: interrupted ? "interrupted" : "idle" }
  } catch (error) {
    if (isNotFound(error)) return { ...one, outcome: "gone" }
    return { ...one, outcome: "failed", error: describeFailure("session.interrupt", error).message }
  }
}

type Messages = Awaited<ReturnType<StopPorts["courier"]["session"]["context"]>>

// a completed background subagent call names its child (api-notes)
async function backgroundSubagents(ports: StopPorts, nodes: ReadonlyArray<Below>): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const parents = [...new Set(nodes.flatMap((node) => (node.subagent ? [node.entry.parentID] : [])))]
  const found = await Promise.all(
    parents.map(async (parentID) => {
      const messages = await ports.courier.session.context({ sessionID: parentID }).catch((): Messages => [])
      const returned = messages.flatMap((message) =>
        message.type === "assistant" ? message.content.flatMap((part) => (part.type === "tool" && part.name === "subagent" && part.state.status === "completed" ? [part] : [])) : [],
      )
      const named = (id: string) => returned.some((part) => part.state.status === "completed" && JSON.stringify([part.state.content, part.state.metadata ?? null]).includes(id))
      const ids = nodes.filter((node) => node.subagent && node.entry.parentID === parentID && named(node.entry.sessionID)).map((node) => node.entry.sessionID)
      return [parentID, new Set(ids)] as const
    }),
  )
  return new Map(found.filter(([, ids]) => ids.size))
}

// a background subagent's end wakes its parent (api-notes)
async function settle(ports: StopPorts, nodes: ReadonlyArray<Below>, results: ReadonlyArray<Stopped>, background: ReadonlyMap<string, ReadonlySet<string>>, since: number) {
  const ended = new Set(results.flatMap((one) => (one.subagent && one.outcome === "interrupted" ? [one.sessionID] : [])))
  await Promise.all(
    [...background].map(async ([parentID, ids]) => {
      const waited = new Set([...ids].filter((id) => ended.has(id)))
      if (!waited.size || !(await told(ports, parentID, waited, since))) return
      const parent = nodes.find((node) => node.entry.sessionID === parentID)
      if (parent && !parent.subagent) await childStore(ports.courier.storage).stopped(parentID, ports.courier.now()).catch(() => undefined)
      if (parent) await interrupt(ports, parent)
    }),
  )
}

async function told(ports: StopPorts, parentID: string, ids: ReadonlySet<string>, since: number): Promise<boolean> {
  const messages = await ports.courier.session.context({ sessionID: parentID }).catch((): Messages => [])
  const noticed = new Set(
    messages.flatMap((message) => (message.type === "synthetic" && message.time.created >= since && typeof message.metadata?.childID === "string" ? [message.metadata.childID] : [])),
  )
  if ([...ids].every((id) => noticed.has(id))) return true
  if (Date.now() - since >= SETTLE_MS) return false
  await new Promise((resolve) => setTimeout(resolve, 50))
  return told(ports, parentID, ids, since)
}

async function tellParent(ports: StopPorts, callerID: string, target: Below["entry"], results: ReadonlyArray<Stopped>) {
  const outcome = results.find((one) => one.sessionID === target.sessionID)?.outcome
  if (outcome === "interrupted") return tell(ports, target, stoppedNotice(target.title, callerID))
  if (outcome !== "idle") return undefined
  const children = childStore(ports.courier.storage)
  const report = await reportOf(children, target.sessionID).catch(() => undefined)
  if (report?.owes) return tell(ports, target, idleStoppedNotice(target.title, callerID))
  const status = report ? await lastStatus(children, target.sessionID).catch(() => undefined) : undefined
  return status === "blocked" ? tell(ports, target, blockedStoppedNotice(target.title, callerID)) : undefined
}

async function tell(ports: StopPorts, target: Below["entry"], notice: string) {
  const { session, log } = ports.courier
  try {
    await session.synthetic({
      sessionID: target.parentID,
      text: envelope(target.sessionID, notice, { ended: "stopped" }),
      description: `Session ${target.sessionID} was stopped`,
      metadata: { source: "courier", from: target.sessionID, ended: "stopped" },
      delivery: "steer",
    })
    return target.parentID
  } catch (error) {
    log(`courier_stop: could not tell ${target.parentID} that ${target.sessionID} was stopped: ${String(error)}`)
    return undefined
  }
}

async function removeWorktrees(ports: StopPorts, nodes: ReadonlyArray<Below>) {
  type Removed = NonNullable<StopResult["cleanup"]>[number]
  const removeNext = async (queue: ReadonlyArray<Below>, done: Removed[]): Promise<Removed[]> => {
    const [next, ...rest] = queue
    if (!next) return done
    const { entry } = next
    const result: Removed = await cleanup(ports.cleanup, entry.parentID, { sessionID: entry.sessionID }).catch((error: unknown) => ({
      sessionID: entry.sessionID,
      outcome: "failed" as const,
      error: describeFailure("courier_cleanup", error).message,
    }))
    return removeNext(rest, [...done, result])
  }
  return removeNext(nodes.filter((node) => node.entry.isolated).sort((a, b) => b.depth - a.depth), [])
}
