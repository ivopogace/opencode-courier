import { busy } from "./domain.js"
import { groupStandings } from "./group.js"
import type { CourierPorts } from "./ports.js"
import type { Summary } from "./rpc.js"
import { groupStore } from "./store.js"
import { lookUp, type Looked } from "./subtree.js"

type Activity = "running" | "waiting" | "idle"

/** What a session is doing: waiting on a request it made, running, or idle; undefined when OpenCode no longer knows it. */
function activity({ info, pending }: Looked): Activity | undefined {
  if (!info) return undefined
  if (pending.length) return "waiting"
  return busy(info.time) ? "running" : "idle"
}

/**
 * Every session started under a session, counted by what it is doing, and its open join groups, those of its own
 * children, with how far each has reported.
 */
export async function summary(ports: CourierPorts, sessionID: string): Promise<Summary> {
  const [looked, standings] = await Promise.all([lookUp(ports, sessionID), groupStandings(groupStore(ports.storage), sessionID)])
  const activities = looked.map(activity)
  const count = (kind: Activity) => activities.filter((item) => item === kind).length
  return {
    running: count("running"),
    waiting: count("waiting"),
    idle: count("idle"),
    groups: standings.map(({ name, reported, members }) => ({ name, reported, members })),
  }
}
