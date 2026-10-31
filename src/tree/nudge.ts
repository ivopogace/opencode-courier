import { envelope } from "../kernel/protocol.js"
import { claim } from "../platform/bounded.js"
import { hasCompleteGroup } from "./group.js"
import type { ChildStore, Waits, WatchPorts } from "./ports.js"
import { awaited, reportOf, stoppedSincePrompt } from "./report.js"
import { childStore, groupStore } from "./store.js"
import { reportReminder } from "./text.js"

/** OpenCode's `experimental.idle` hook event: a session about to go idle, and the background work still running for it or below it. */
export interface Idle {
  readonly sessionID: string
  readonly background: ReadonlyArray<{ readonly sessionID: string }>
}

/** The ports the reminder is sent through: the watcher's. */
export type NudgePorts = Pick<WatchPorts, "storage" | "session" | "permissions" | "now" | "log">

/**
 * Whether a session prompted at `prompt` waits: on an untold report of a session it started, a complete group of
 * its about to be delivered, or what `outside` says it waits on. Cheapest first.
 */
async function waits(ports: NudgePorts, outside: Waits, sessionID: string, prompt: number) {
  const children = childStore(ports.storage)
  const started = await children.children(sessionID)
  if ((await Promise.all(started.map((entry) => awaited(children, entry.sessionID)))).includes(true)) return true
  // A group with a member still out is waited on through that member, above; one whose every out member was told of is not.
  if (started.some((entry) => entry.group) && (await hasCompleteGroup(groupStore(ports.storage), sessionID))) return true
  return outside(ports, sessionID, prompt)
}

/**
 * The report a spawned session owes since its last prompt, unless it waits or courier_stop stopped it since: what the
 * silent-turn notice tells the parent of, and the reminder reminds the session of.
 */
export async function owedUnwaited(ports: NudgePorts, children: ChildStore, outside: Waits, sessionID: string) {
  const report = await reportOf(children, sessionID)
  if (!report?.owes || (await waits(ports, outside, sessionID, report.prompt))) return undefined
  if (await stoppedSincePrompt(children, sessionID).catch(() => false)) return undefined
  return report
}

/**
 * Reminds a spawned session about to go idle owing a report it does not wait on, once per prompt, so it reports in the
 * same execution; one with background work of its own is woken again by it. Returns whether it was reminded.
 */
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
  // Noted before it is sent, so a second hook never sends another, and with its id after, before the turn takes it.
  await children.nudged(sessionID, at)
  const { id } = await ports.session.synthetic({
    sessionID,
    text: envelope("courier", reportReminder(parentID), { reminder: "report" }),
    description: "Reminded to report",
    metadata: { source: "courier", reminder: "report", resume: false },
    delivery: "steer",
    // The hook's own execution takes it: no wake, and the missed-wake watch leaves it be.
    resume: false,
  })
  await children.nudged(sessionID, at, id)
  return true
}

/** `nudgeSilent` as the hook runs it: a hook that fails fails the execution, so a failure is logged, never thrown. */
export async function onIdle(ports: NudgePorts, seen: Set<string>, outside: Waits, idle: Idle) {
  try {
    return await nudgeSilent(ports, seen, outside, idle)
  } catch (error) {
    ports.log(`courier idle: could not remind ${idle.sessionID} to report: ${String(error)}`)
    return false
  }
}
