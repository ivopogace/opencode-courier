import { isNotFound } from "../platform/json.js"
import { busy, bySession, lineageBy } from "./domain.js"
import type { LimitPorts, Reservation } from "./ports.js"
import { reportOf } from "./report.js"
import { childStore } from "./store.js"
import { childrenRefusal, depthRefusal, totalRefusal } from "./text.js"

/**
 * Whether a spawned session counts against the limits: it runs, unless its turn failed or was
 * interrupted since its last prompt, or it owes its parent a report. One OpenCode no longer knows does not.
 */
async function live(ports: Pick<LimitPorts, "session" | "storage">, sessionID: string) {
  const [time, report] = await Promise.all([
    ports.session.get({ sessionID }).then(
      (info) => info.time,
      (error: unknown) => (isNotFound(error) ? null : undefined),
    ),
    reportOf(childStore(ports.storage), sessionID).catch(() => undefined),
  ])
  if (time === null) return false
  // One whose first prompt failed never ran, and has no idle time to tell so.
  const runs = time !== undefined && busy(time) && !report?.ended
  return runs || (report?.owes ?? false)
}

/**
 * Checks the limits for a spawn from `parentID`, then holds its place in `gate` until `release`;
 * throws a refusal naming the limit. Checks run one at a time, so spawns made together count each other.
 */
export async function admit(ports: LimitPorts, parentID: string) {
  const gate = ports.gate
  const checked = gate.turn.then(() => check(ports, parentID))
  gate.turn = checked.catch(() => undefined)
  const { depth, reservation } = await checked
  const release = () => {
    gate.reserved.delete(reservation)
  }
  return { depth, reservation, release }
}

async function check(ports: LimitPorts, parentID: string) {
  const { maxDepth, maxChildren, maxTotal } = ports.limits
  const entries = await childStore(ports.storage).all()
  const parents = bySession(entries)
  const chain = lineageBy(parents, parentID)
  if (chain.length >= maxDepth) throw new Error(depthRefusal(chain.length, maxDepth))
  const top = chain.at(-1)?.parentID ?? parentID
  const chains = new Map(entries.map((entry) => [entry.sessionID, lineageBy(parents, entry.sessionID)]))
  const tree = entries.filter((entry) => chains.get(entry.sessionID)!.at(-1)?.parentID === top)
  const runs = await Promise.all(tree.map((entry) => live(ports, entry.sessionID)))
  // A session waiting on a live descendant is live too: the brief tells it to end its turn meanwhile.
  const active = new Set(
    tree.filter((_, i) => runs[i]).flatMap((entry) => [entry.sessionID, ...chains.get(entry.sessionID)!.map((above) => above.parentID)]),
  )
  const counted = tree.filter((entry) => active.has(entry.sessionID))
  // A spawn whose child is on the roster already is counted there, if it is live, not by its reservation.
  const recorded = new Set(tree.map((entry) => entry.sessionID))
  const pending = [...ports.gate.reserved].filter((held) => held.top === top && !(held.sessionID && recorded.has(held.sessionID)))
  const mine = counted.filter((entry) => entry.parentID === parentID).length + pending.filter((held) => held.parentID === parentID).length
  if (mine >= maxChildren) throw new Error(childrenRefusal(mine, maxChildren))
  if (counted.length + pending.length >= maxTotal) throw new Error(totalRefusal(counted.length + pending.length, maxTotal))
  const reservation: Reservation = { parentID, top }
  ports.gate.reserved.add(reservation)
  return { depth: chain.length + 1, reservation }
}
