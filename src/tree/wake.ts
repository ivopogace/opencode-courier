/**
 * The missed-wake watch: a message the courier delivers to an idle session owes it a turn, and a turn that
 * does not start within a short grace is re-woken once by the scheduler, then flagged as stalled for the
 * person. The expectation is durable in the storage, so the scheduler's owner can act on it, a restart loses
 * nothing, and any server's watch clears it when a turn starts.
 */
import { sharedState, type TickJob } from "../platform/hub.js"
import type { RosterStorage, WatchPorts } from "./ports.js"
import { childStore, wakeKey } from "./store.js"

/** How long after a delivery a turn is expected before its wake is missed: two ticks of the 15 s scheduler. */
export const GRACE_MS = 30_000

/**
 * The sessions with a turn under way — a `started` with no terminal since — which the watch keeps and the
 * deliveries and the missed-wake job read. Process-wide like the inbox, so every copy and instance agrees.
 */
export const running = sharedState("running", () => new Set<string>())

/**
 * Notes that a message the courier delivered owes `sessionID` a turn, unless its turn is already under way —
 * a running turn takes the message at its next step, so no turn is owed until it ends — or one is already
 * expected, which the re-wake points at.
 */
export async function expectWake(storage: RosterStorage, now: () => number, sessionID: string, text: string): Promise<void> {
  if (running.has(sessionID)) return
  await childStore(storage).expectWake(sessionID, now(), text)
}

/**
 * The scheduler's missed-wake job, the third tick job after `dueJob` and `deliverReleased`: every expectation
 * the storage holds whose grace has passed without a turn is re-woken once, and one whose re-woken grace has
 * passed is flagged stalled. Only the scheduler's owner runs it.
 */
export const wakeJob: TickJob = (owner) => checkWakes(owner.watch as WatchPorts)

async function checkWakes(ports: WatchPorts) {
  const children = childStore(ports.storage)
  for (const [sessionID, keys] of await children.reported()) {
    if (!keys.includes(wakeKey(sessionID))) continue
    const note = await children.wake(sessionID)
    if (!note) continue
    // A turn under way takes the message at its next step, whatever the events said.
    if (running.has(sessionID)) {
      await children.forgetWake(sessionID).catch(() => undefined)
      continue
    }
    const past = ports.now() - note.at
    if (note.state === "due" && past >= GRACE_MS) {
      // Marked before the re-wake, so the same episode is never re-woken twice; if the mark cannot be
      // written, the re-wake waits for a later tick rather than risking a second one.
      const marked = await children.noteWake(sessionID, { ...note, state: "rewoken", at: ports.now() }).then(
        () => true,
        (error: unknown) => {
          ports.log(`courier wake: could not note the re-wake of ${sessionID}: ${String(error)}`)
          return false
        },
      )
      if (marked)
        await reWake(ports, sessionID, note.text).catch((error: unknown) =>
          ports.log(`courier wake: could not re-woken ${sessionID}: ${String(error)}`),
        )
    } else if (note.state === "rewoken" && past >= GRACE_MS) {
      await children.noteWake(sessionID, { ...note, state: "stalled" }).catch((error: unknown) =>
        ports.log(`courier wake: could not note the stall of ${sessionID}: ${String(error)}`),
      )
    }
  }
}

/**
 * Re-wakes a session whose missed wake left a message waiting in its inbox: exactly one synthetic, pointing at
 * that message — the delivered text, which the expectation stored. The re-wake is this detector's own action,
 * not an owed wake, so it is a raw synthetic rather than a `send`, `spawn` or `release`, and is not tracked.
 */
async function reWake(ports: WatchPorts, sessionID: string, text: string) {
  await ports.session.synthetic({
    sessionID,
    text,
    description: `Session ${sessionID} did not start its turn`,
    metadata: { source: "courier", wake: "rewoken" },
    delivery: "steer",
  })
}

/** Whether a session's wake expectation is stalled — re-woken, and still no turn; the panel and footer flag it. */
export async function stalled(storage: RosterStorage, sessionID: string): Promise<boolean> {
  return (await childStore(storage).wake(sessionID))?.state === "stalled"
}
