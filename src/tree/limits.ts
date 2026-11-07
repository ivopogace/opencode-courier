import { isNotFound, millis } from "../platform/json.js"
import { bySession, lineageBy } from "./domain.js"
import type { LimitPorts, Reservation } from "./ports.js"
import { reportOf } from "./report.js"
import { runs } from "./running.js"
import { childStore } from "./store.js"
import { childrenRefusal, depthRefusal, totalRefusal } from "./text.js"
import { waitsInInbox } from "./wake.js"

async function live(ports: Pick<LimitPorts, "session" | "storage">, sessionID: string) {
  const [time, report] = await Promise.all([
    ports.session.get({ sessionID }).then(
      (info) => info.time,
      (error: unknown) => (isNotFound(error) ? null : undefined),
    ),
    reportOf(childStore(ports.storage), sessionID).catch(() => undefined),
  ])
  if (time === null) return false
  const inTurn = report?.reportedAt !== undefined && !(millis(time?.idle) >= report.reportedAt)
  const running = time !== undefined && !report?.ended && !inTurn && (await runs(ports.session, sessionID, time))
  // a waiting inbox item is in no transcript until delivered (api-notes)
  return running || (report?.owes ?? false) || (report?.blocked ?? false) || (await waitsInInbox(ports, sessionID, { stalled: false }).catch(() => true))
}

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
  const counting = await Promise.all(tree.map((entry) => live(ports, entry.sessionID)))
  const active = new Set(
    tree.filter((_, i) => counting[i]).flatMap((entry) => [entry.sessionID, ...chains.get(entry.sessionID)!.map((above) => above.parentID)]),
  )
  const counted = tree.filter((entry) => active.has(entry.sessionID))
  const recorded = new Set(tree.map((entry) => entry.sessionID))
  const pending = [...ports.gate.reserved].filter((held) => held.top === top && !(held.sessionID && recorded.has(held.sessionID)))
  const mine = counted.filter((entry) => entry.parentID === parentID).length + pending.filter((held) => held.parentID === parentID).length
  if (mine >= maxChildren) throw new Error(childrenRefusal(mine, maxChildren))
  if (counted.length + pending.length >= maxTotal) throw new Error(totalRefusal(counted.length + pending.length, maxTotal, mine))
  const reservation: Reservation = { parentID, top }
  ports.gate.reserved.add(reservation)
  return { depth: chain.length + 1, reservation }
}

export async function liveBelow(ports: Pick<LimitPorts, "session" | "storage">, sessionID: string) {
  const entries = await childStore(ports.storage).all()
  const parents = bySession(entries)
  const below = [...parents.values()].filter(
    (entry) => entry.sessionID !== sessionID && lineageBy(parents, entry.sessionID).some((above) => above.parentID === sessionID),
  )
  const counting = await Promise.all(below.map((entry) => live(ports, entry.sessionID)))
  return below.filter((_, i) => counting[i])
}
