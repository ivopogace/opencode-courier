import { envelope } from "../kernel/protocol.js"
import { claim } from "../platform/bounded.js"
import { hasCompleteGroup } from "./group.js"
import type { ChildStore, Waits, WatchPorts } from "./ports.js"
import { awaited, reportOf, stoppedSincePrompt } from "./report.js"
import { childStore, groupStore } from "./store.js"
import { reportReminder } from "./text.js"

// experimental.idle's event; its name and shape may change (api-notes)
export interface Idle {
  readonly sessionID: string
  readonly background: ReadonlyArray<{ readonly sessionID: string }>
}

export type NudgePorts = Pick<WatchPorts, "storage" | "session" | "permissions" | "now" | "log">

async function waits(ports: NudgePorts, outside: Waits, sessionID: string, prompt: number) {
  const children = childStore(ports.storage)
  const started = await children.children(sessionID)
  if ((await Promise.all(started.map((entry) => awaited(children, entry.sessionID)))).includes(true)) return true
  if (started.some((entry) => entry.group) && (await hasCompleteGroup(groupStore(ports.storage), sessionID))) return true
  return outside(ports, sessionID, prompt)
}

export async function owedUnwaited(ports: NudgePorts, children: ChildStore, outside: Waits, sessionID: string) {
  const report = await reportOf(children, sessionID)
  if (!report?.owes || (await waits(ports, outside, sessionID, report.prompt))) return undefined
  if (await stoppedSincePrompt(children, sessionID).catch(() => false)) return undefined
  return report
}

export async function nudgeSilent(ports: NudgePorts, seen: Set<string>, outside: Waits, idle: Idle) {
  const { sessionID } = idle
  if (idle.background.some((work) => work.sessionID === sessionID)) return false
  const children = childStore(ports.storage)
  const parentID = await children.indexedParent(sessionID)
  if (parentID === undefined) return false
  const report = await owedUnwaited(ports, children, outside, sessionID)
  if (!report) return false
  const { at: nudgedAt } = await children.nudgeOf(sessionID)
  if ((nudgedAt !== undefined && nudgedAt >= report.prompt) || !claim(seen, `nudge/${sessionID}/${report.prompt}`)) return false
  const at = Math.max(ports.now(), report.prompt)
  // every instance's idle hook runs; delivery matches by inbox id (api-notes)
  await children.nudged(sessionID, at)
  const { id } = await ports.session.synthetic({
    sessionID,
    text: envelope("courier", reportReminder(parentID), { reminder: "report" }),
    description: "Reminded to report",
    metadata: { source: "courier", reminder: "report", resume: false },
    delivery: "steer",
    // input the idle hook admits continues its execution (api-notes)
    resume: false,
  })
  await children.nudged(sessionID, at, id)
  return true
}

// a throwing idle hook fails the execution (api-notes)
export async function onIdle(ports: NudgePorts, seen: Set<string>, outside: Waits, idle: Idle) {
  try {
    return await nudgeSilent(ports, seen, outside, idle)
  } catch (error) {
    ports.log(`courier idle: could not remind ${idle.sessionID} to report: ${String(error)}`)
    return false
  }
}
