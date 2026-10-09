import { Deferred, Effect, Exit } from "effect"
import type { QuestionPorts } from "../hub.js"
import { shared } from "./shared.js"

/** The key of a shutdown reported without a location: it counts for every location. */
const ANYWHERE = ""

/** When the location at `directory` (any location, with none) was last reported shutting down; 0 if never. */
const shutdownAt = (directory: string | undefined) =>
  directory === undefined
    ? Math.max(0, ...shared.shutdowns.values())
    : Math.max(shared.shutdowns.get(directory) ?? 0, shared.shutdowns.get(ANYWHERE) ?? 0)

/**
 * For tests: when the location at `directory` was last reported shutting down, if at all; a shutdown
 * reported without a location counts for every directory, and with none given, any location's counts.
 */
export const shutdownReportedAt = (directory?: string) => shutdownAt(directory) || undefined

/**
 * Called for `location.shutdown`: the location at `directory` is closing, which withdraws its open
 * forms as if dismissed; with no location it counts for all. `at` is the watcher's clock, epoch ms.
 */
export function locationClosing(at: number, directory?: string) {
  shared.shutdowns.set(directory ?? ANYWHERE, at)
  for (const wake of shared.closingWaiters) wake()
}

/**
 * Whether a dismissal just seen at `directory` was the location closing rather than the person: it
 * shut down within the grace, before or after, or this instance unloads in it; unknown matches any.
 */
export const closingSoon = (ports: QuestionPorts, loaded: () => boolean, directory: string | undefined): Effect.Effect<boolean> =>
  Effect.suspend(() => {
    const ms = ports.timing.dismissalGraceMs
    const closing = () => !loaded() || ports.now() - shutdownAt(directory) <= ms
    if (closing()) return Effect.succeed(true)
    const closed = Deferred.makeUnsafe<boolean>()
    // Woken by any shutdown or unload: only one that answers the question ends the wait.
    const wake = () => {
      if (closing()) Deferred.doneUnsafe(closed, Exit.succeed(true))
    }
    return Effect.acquireUseRelease(
      // Looked at as the waiter is added, so a shutdown cannot come in between unseen.
      Effect.sync(() => {
        shared.closingWaiters.add(wake)
        wake()
      }),
      () => (Deferred.isDoneUnsafe(closed) ? Effect.succeed(true) : Effect.raceFirst(Deferred.await(closed), Effect.as(Effect.sleep(ms), false))),
      () => Effect.sync(() => shared.closingWaiters.delete(wake)),
    )
  })

/**
 * Adds an instance's ports to `loaded`, which other copies tell cut-off questions through, until the
 * returned function is called. A location loading again forgets the shutdown recorded for it alone.
 */
export function joinRelay(ports: QuestionPorts) {
  shared.loaded.add(ports)
  shared.shutdowns.delete(ports.directory)
  return () => {
    shared.loaded.delete(ports)
    for (const wake of shared.closingWaiters) wake()
  }
}

/** Called for OpenCode's `form.created`: a question call's form is shown, so its question can be relayed. */
export function formShown(event: { readonly data: { readonly form: { readonly sessionID: string; readonly metadata?: unknown } } }) {
  const call = (event.data.form.metadata as { tool?: { id?: unknown } } | undefined)?.tool?.id
  if (typeof call !== "string") return
  const key = `${event.data.form.sessionID} ${call}`
  shared.shown.get(key)?.()
  shared.shown.delete(key)
}

/**
 * Called when an event stream may have missed forms shown: every call still waiting for its form is
 * taken as shown; one still waiting for its permission check is relayed early, the lesser harm.
 */
export function formsMayHaveBeenMissed() {
  for (const shown of shared.shown.values()) shown()
  shared.shown.clear()
}

/**
 * Called when an instance starts following OpenCode's events: a shown form is missed only while none
 * follows, so waiting calls are released; true tells the caller to release again on its first event.
 */
export function eventsFollowed() {
  const missed = shared.following === 0 && shared.followed
  shared.following++
  shared.followed = true
  if (missed) formsMayHaveBeenMissed()
  return missed
}

/** Called when an instance's event stream ended or broke. */
export function eventsLeft() {
  shared.following = Math.max(0, shared.following - 1)
}
