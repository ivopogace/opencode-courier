import { busy } from "./domain.js"
import { groupStandings } from "./group.js"
import type { CourierPorts } from "./ports.js"
import type { Summary } from "./rpc.js"
import { groupStore } from "./store.js"
import { lookUp, type Looked } from "./subtree.js"
import { stalledAmong } from "./wake.js"

type Activity = "running" | "waiting" | "idle" | "stalled"

/**
 * What a session is doing: waiting on a request it made or a form it shows, stalled, running, or idle; undefined when
 * OpenCode no longer knows it. A message waiting in its inbox makes a stalled session look busy.
 */
function activity({ info, pending, forms, entry }: Looked, stalled: ReadonlyMap<string, number>): Activity | undefined {
  if (!info) return undefined
  if (pending.length || forms.length) return "waiting"
  if (stalled.has(entry.sessionID)) return "stalled"
  return busy(info.time) ? "running" : "idle"
}

/**
 * Every session started under a session, counted by what it is doing (the session itself too, when it is stalled), and its
 * open join groups, those of its own children, with how far each has reported.
 */
export async function summary(ports: CourierPorts, sessionID: string): Promise<Summary> {
  const [looked, standings] = await Promise.all([lookUp(ports, sessionID), groupStandings(groupStore(ports.storage), sessionID)])
  const stalled = await stalledAmong(ports, [sessionID, ...looked.map((one) => one.entry.sessionID)])
  const activities = looked.map((one) => activity(one, stalled))
  const count = (kind: Activity) => activities.filter((item) => item === kind).length
  const stalls = count("stalled") + (stalled.has(sessionID) ? 1 : 0)
  return {
    running: count("running"),
    waiting: count("waiting"),
    idle: count("idle"),
    ...(stalls ? { stalled: stalls } : {}),
    groups: standings.map(({ name, reported, members }) => ({ name, reported, members })),
  }
}
