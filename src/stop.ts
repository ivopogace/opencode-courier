import { cleanup, type CleanupPorts } from "./cleanup.js"
import { describeFailure, type CourierPorts } from "./courier.js"
import { isNotFound } from "./json.js"
import { cancel, scheduledFor, type LaterPorts } from "./later.js"
import { envelope, stoppedNotice, type CleanupResult } from "./notices.js"
import { settled, stopped } from "./report.js"
import { lineage } from "./roster.js"
import { subtree, type Below } from "./tree.js"

export interface StopPorts {
  readonly courier: CourierPorts
  readonly later: LaterPorts
  readonly cleanup: CleanupPorts
}

export interface StopInput {
  readonly sessionID: string
  readonly cleanup?: boolean
}

/** What happened to one session: its turn was interrupted, it was not running, OpenCode no longer knows it, or the interrupt failed. */
export interface Stopped {
  readonly sessionID: string
  readonly title: string
  readonly depth: number
  readonly outcome: "interrupted" | "idle" | "gone" | "failed"
  readonly error?: string
}

export interface StopResult {
  readonly sessionID: string
  /** Every session stopped, deepest first; the target is the last. */
  readonly stopped: ReadonlyArray<Stopped>
  /** The ids of the courier_later messages cancelled. */
  readonly cancelled: ReadonlyArray<string>
  /** With `cleanup`: what became of each isolated session's worktree, deepest first. */
  readonly cleanup?: ReadonlyArray<CleanupResult | { readonly sessionID: string; readonly outcome: "failed"; readonly error: string }>
  /** The session told that the target was stopped, when that is not the caller. */
  readonly told?: string
}

/** Rounds of looking again for sessions started while others were being stopped. */
const ROUNDS = 3

/**
 * Stops a session and every session under it, deepest first, and cancels the courier_later messages pending for them.
 * Only a session above the target may stop it. A session that does not run is not an error. The caller is not told of
 * what it stopped; the target's parent is, unless that is the caller. Sessions under the target are not told: they are
 * stopped too. A session one of them started meanwhile is found by looking again, a few times.
 */
export async function stop(ports: StopPorts, callerID: string, input: StopInput): Promise<StopResult> {
  const { storage } = ports.courier
  const { sessionID } = input
  const chain = await lineage(storage, sessionID)
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
    // Before any interrupt, so nothing scheduled wakes a session that was just stopped.
    await Promise.all(pending.map((node) => silence(ports, node.entry.sessionID, cancelled)))
    results.push(...(await eachDeepestFirst(pending, (node) => interrupt(ports, node))))
    const meanwhile = (await subtree(storage, sessionID)).nodes.filter((node) => !seen.has(node.entry.sessionID))
    return round(meanwhile, left - 1)
  }
  await round([{ entry: target, depth: 0 }, ...(await subtree(storage, sessionID)).nodes], ROUNDS)

  const told =
    target.parentID !== callerID && results.find((one) => one.sessionID === sessionID)?.outcome === "interrupted"
      ? await tell(ports, callerID, target)
      : undefined
  return {
    sessionID,
    stopped: results,
    cancelled,
    ...(input.cleanup ? { cleanup: await removeWorktrees(ports, nodes) } : {}),
    ...(told ? { told } : {}),
  }
}

/** Runs `act` on the nodes level by level, the deepest level first and the level's nodes at once; the results in that order. */
function eachDeepestFirst<T>(nodes: ReadonlyArray<Below>, act: (node: Below) => Promise<T>) {
  const depths = [...new Set(nodes.map((node) => node.depth))].sort((a, b) => b - a)
  return depths.reduce(
    (before, depth) => before.then(async (done) => [...done, ...(await Promise.all(nodes.filter((node) => node.depth === depth).map(act)))]),
    Promise.resolve<T[]>([]),
  )
}

/** Notes that a session was stopped, so the failure and silent-end notices stay quiet for it, and cancels its pending messages. */
async function silence(ports: StopPorts, sessionID: string, cancelled: string[]) {
  const { storage, now, log } = ports.courier
  await stopped(storage, sessionID, now()).catch((error: unknown) => log(`courier_stop: could not note that ${sessionID} was stopped: ${String(error)}`))
  try {
    const pending = await scheduledFor(storage, sessionID)
    const dropped = await Promise.all(pending.map(async (later) => ((await cancel(ports.later, later.id)) ? later.id : undefined)))
    cancelled.push(...dropped.filter((id) => id !== undefined))
  } catch (error) {
    log(`courier_stop: could not cancel the messages scheduled for ${sessionID}: ${String(error)}`)
  }
}

async function interrupt(ports: StopPorts, { entry, depth }: Below): Promise<Stopped> {
  const { sessionID, title } = entry
  const { storage, session, now } = ports.courier
  try {
    const { interrupted } = await session.interrupt({ sessionID })
    // The event for it says so too; noted here as well, so the end is settled when this returns.
    if (interrupted) await settled(storage, sessionID, "interrupted", now()).catch(() => undefined)
    return { sessionID, title, depth, outcome: interrupted ? "interrupted" : "idle" }
  } catch (error) {
    if (isNotFound(error)) return { sessionID, title, depth, outcome: "gone" }
    return { sessionID, title, depth, outcome: "failed", error: describeFailure("session.interrupt", error).message }
  }
}

/** Tells the target's parent, which is below the caller, that it was stopped; undefined when that could not be done. */
async function tell(ports: StopPorts, callerID: string, target: Below["entry"]) {
  const { session, log } = ports.courier
  try {
    await session.synthetic({
      sessionID: target.parentID,
      text: envelope(target.sessionID, stoppedNotice(target.title, callerID), { ended: "stopped" }),
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

/** Removes the isolated sessions' worktrees, deepest first, through courier_cleanup's checks; a failure is reported, not thrown. */
async function removeWorktrees(ports: StopPorts, nodes: ReadonlyArray<Below>) {
  const isolated = nodes.filter((node) => node.entry.isolated).sort((a, b) => b.depth - a.depth)
  // One at a time: git locks the repository's worktree list while it removes one.
  return isolated.reduce(
    (before, { entry }) =>
      before.then(async (done) => [
        ...done,
        await cleanup(ports.cleanup, entry.parentID, { sessionID: entry.sessionID }).catch((error: unknown) => ({
          sessionID: entry.sessionID,
          outcome: "failed" as const,
          error: describeFailure("courier_cleanup", error).message,
        })),
      ]),
    Promise.resolve<NonNullable<StopResult["cleanup"]>[number][]>([]),
  )
}
