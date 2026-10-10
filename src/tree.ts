import { described, type CourierPorts } from "./courier.js"
import { lastStatus, reportOf } from "./report.js"
import { children, type RosterEntry, type RosterStorage } from "./roster.js"

/** A session below the one a subtree is read from, with how many levels below it is: a child is at depth 1. */
export interface Below {
  readonly entry: RosterEntry
  readonly depth: number
}

/**
 * The sessions started, directly or through others, from a session, read level by level with one prefix scan per
 * parent, at most `max` of them; `truncated` when there were more. Ordered as a tree is drawn: each session followed
 * by what it started, siblings oldest first.
 */
export async function subtree(storage: RosterStorage, rootID: string, max = Number.POSITIVE_INFINITY) {
  const byParent = new Map<string, Below[]>()
  const seen = new Set([rootID])
  let count = 0
  let truncated = false
  let level = [rootID]
  for (let depth = 1; level.length && !truncated; depth++) {
    const found = await Promise.all(level.map((parentID) => children(storage, parentID)))
    const next: string[] = []
    for (const [index, entries] of found.entries()) {
      const kept: Below[] = []
      for (const entry of entries) {
        if (seen.has(entry.sessionID)) continue
        if (count >= max) {
          truncated = true
          break
        }
        seen.add(entry.sessionID)
        count++
        kept.push({ entry, depth })
        next.push(entry.sessionID)
      }
      if (kept.length) byParent.set(level[index]!, kept)
    }
    level = next
  }
  const nodes: Below[] = []
  const draw = (parentID: string) => {
    for (const node of byParent.get(parentID) ?? []) {
      nodes.push(node)
      draw(node.entry.sessionID)
    }
  }
  draw(rootID)
  return { nodes, truncated }
}

/**
 * The subtree under a session, at most `maxTotal` sessions of it: each with what courier_children shows of a child, its
 * depth, who started it and its report state: whether it owes a report, has sent progress, ended without one, and the
 * status of its last report.
 */
export async function tree(ports: CourierPorts, rootID: string) {
  const { nodes, truncated } = await subtree(ports.storage, rootID, ports.limits.maxTotal)
  const listed = await Promise.all(
    nodes.map(async ({ entry, depth }) => {
      const [info, report, last] = await Promise.all([
        described(ports, entry),
        reportOf(ports.storage, entry.sessionID).catch(() => undefined),
        lastStatus(ports.storage, entry.sessionID).catch(() => undefined),
      ])
      return {
        ...info,
        parentID: entry.parentID,
        depth,
        ...(report
          ? { report: { owes: report.owes, progressed: report.progressed, ended: report.ended, ...(last ? { status: last } : {}) } }
          : {}),
      }
    }),
  )
  return { sessionID: rootID, sessions: listed, ...(truncated ? { truncated: ports.limits.maxTotal } : {}) }
}
