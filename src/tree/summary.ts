import { busy } from "./domain.js"
import { groupStandings } from "./group.js"
import type { CourierPorts } from "./ports.js"
import type { Summary } from "./rpc.js"
import { groupStore } from "./store.js"
import { subtree } from "./subtree.js"

type Activity = "running" | "waiting" | "idle"

/** What a session is doing: waiting on a request it made, running, or idle; undefined when OpenCode no longer knows it. */
async function activity(ports: Pick<CourierPorts, "session" | "pending">, sessionID: string): Promise<Activity | undefined> {
  const [info, pending] = await Promise.all([
    ports.session.get({ sessionID }).catch(() => undefined),
    ports.pending(sessionID).catch(() => []),
  ])
  if (!info) return undefined
  if (pending.length) return "waiting"
  return busy(info.time) ? "running" : "idle"
}

/**
 * The sessions started under a session, at most `maxTotal` as courier_tree reads them, counted by what they
 * are doing, and its open join groups, those of its own children, with how far each has reported.
 */
export async function summary(ports: CourierPorts, sessionID: string): Promise<Summary> {
  const counted = async () => {
    const { nodes, truncated } = await subtree(ports.storage, sessionID, ports.limits.maxTotal)
    return { activities: await Promise.all(nodes.map(({ entry }) => activity(ports, entry.sessionID))), truncated }
  }
  const [{ activities, truncated }, standings] = await Promise.all([counted(), groupStandings(groupStore(ports.storage), sessionID)])
  const count = (kind: Activity) => activities.filter((item) => item === kind).length
  return {
    running: count("running"),
    waiting: count("waiting"),
    idle: count("idle"),
    groups: standings.map(({ name, reported, members }) => ({ name, reported, members })),
    ...(truncated ? { truncated: ports.limits.maxTotal } : {}),
  }
}
