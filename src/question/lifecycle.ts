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
 * Called for OpenCode's `location.shutdown`: the location at `directory` is closing, which
 * withdraws its open forms as if the person had dismissed them (before unloading the plugin
 * there, since OpenCode 2.0.22). The event's location is optional in the schema; without it,
 * the shutdown counts for every location. `at` is when, by the watcher's clock (epoch milliseconds).
 */
export function locationClosing(at: number, directory?: string) {
  shared.shutdowns.set(directory ?? ANYWHERE, at)
  for (const wake of shared.closingWaiters) wake()
}

/**
 * Whether a dismissal just seen in the location at `directory` was that location closing rather
 * than the person: true when it shut down within the dismissal grace before, or does so, or this
 * instance unloads, within the grace from now, by the clock of `ports`. A shutdown reported without a location counts for every
 * location, and with the directory unknown, any location's shutdown counts.
 */
export function closingSoon(ports: QuestionPorts, loaded: () => boolean, directory: string | undefined): Promise<boolean> {
  const ms = ports.timing.dismissalGraceMs
  const closing = () => !loaded() || ports.now() - shutdownAt(directory) <= ms
  if (closing()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = (result: boolean) => {
      clearTimeout(timer)
      shared.closingWaiters.delete(wake)
      resolve(result)
    }
    // Woken by any shutdown or unload: only one that answers the question ends the wait.
    const wake = () => {
      if (closing()) done(true)
    }
    const timer = setTimeout(() => done(false), ms)
    timer.unref?.()
    shared.closingWaiters.add(wake)
  })
}

/** The promise's value, or undefined once `ms` have passed or it failed. */
export function within<T>(promise: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!promise) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

/**
 * A plugin instance whose ports the relay may use, until the returned function is called. A
 * location loading again forgets the shutdown recorded for it, so a dismissal there is not
 * mistaken for that shutdown. One recorded for every location is left alone, since a dismissal
 * held in another location may still need it; it ages out with the grace.
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
 * Called when an event stream may have missed forms being shown: every call still waiting for its
 * form is taken as shown. One still waiting for its permission check is relayed early, which is the
 * lesser harm.
 */
export function formsMayHaveBeenMissed() {
  for (const shown of shared.shown.values()) shown()
  shared.shown.clear()
}

/**
 * Called when an instance starts following OpenCode's events. Every instance is sent every event,
 * so a form shown is missed only while none follows them; then the calls waiting are released, and
 * true is returned, for the caller to release them again on its first event, once it is connected.
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
