import { described, type CourierPorts } from "./courier.js"
import { lastStatus, reportOf } from "./report.js"
import { children, type RosterEntry, type RosterStorage } from "./roster.js"

/** A session below the one a subtree is read from, with how many levels below it is: a child is at depth 1. */
export interface Below {
  readonly entry: RosterEntry
  readonly depth: number
}

/**
 * The sessions started from a session, directly or through others, read one prefix scan per parent, at most `max`
 * (`truncated` if more), in the order a tree is drawn.
 */
export async function subtree(storage: RosterStorage, rootID: string, max = Number.POSITIVE_INFINITY) {
  const byParent = new Map<string, Below[]>()
  const seen = new Set([rootID])
  let truncated = false
  const expand = async (level: string[], depth: number): Promise<void> => {
    if (!level.length || truncated) return
    const found = await Promise.all(level.map((parentID) => children(storage, parentID)))
    const next: string[] = []
    for (const [index, entries] of found.entries()) {
      const fresh = entries.filter((entry) => !seen.has(entry.sessionID))
      const kept = fresh.slice(0, Math.max(0, max - (seen.size - 1)))
      truncated ||= kept.length < fresh.length
      for (const entry of kept) seen.add(entry.sessionID)
      if (kept.length) byParent.set(level[index]!, kept.map((entry) => ({ entry, depth })))
      next.push(...kept.map((entry) => entry.sessionID))
    }
    return expand(next, depth + 1)
  }
  await expand([rootID], 1)
  return { nodes: drawn(byParent, rootID), truncated }
}

/** The nodes in the order a tree is drawn: each followed by what it started. */
function drawn(byParent: ReadonlyMap<string, Below[]>, parentID: string): Below[] {
  return (byParent.get(parentID) ?? []).flatMap((node) => [node, ...drawn(byParent, node.entry.sessionID)])
}

/**
 * The subtree under a session, at most `maxTotal` sessions: what courier_children shows of each, plus its depth,
 * its parent and its report state.
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
