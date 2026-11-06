import { Deferred, Effect, Exit } from "effect"
import type { QuestionPorts } from "./types.js"
import { shared } from "./shared.js"

const ANYWHERE = ""

const shutdownAt = (directory: string | undefined) =>
  directory === undefined
    ? Math.max(0, ...shared.shutdowns.values())
    : Math.max(shared.shutdowns.get(directory) ?? 0, shared.shutdowns.get(ANYWHERE) ?? 0)

export const shutdownReportedAt = (directory?: string) => shutdownAt(directory) || undefined

export function locationClosing(at: number, directory?: string) {
  shared.shutdowns.set(directory ?? ANYWHERE, at)
  for (const wake of shared.closingWaiters) wake()
}

export const closingSoon = (ports: QuestionPorts, loaded: () => boolean, directory: string | undefined): Effect.Effect<boolean> =>
  Effect.suspend(() => {
    const ms = ports.timing.dismissalGraceMs
    const closing = () => !loaded() || ports.now() - shutdownAt(directory) <= ms
    if (closing()) return Effect.succeed(true)
    const closed = Deferred.makeUnsafe<boolean>()
    const wake = () => {
      if (closing()) Deferred.doneUnsafe(closed, Exit.succeed(true))
    }
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        shared.closingWaiters.add(wake)
        wake()
      }),
      () => (Deferred.isDoneUnsafe(closed) ? Effect.succeed(true) : Effect.raceFirst(Deferred.await(closed), Effect.as(Effect.sleep(ms), false))),
      () => Effect.sync(() => shared.closingWaiters.delete(wake)),
    )
  })

export function joinRelay(ports: QuestionPorts) {
  shared.loaded.add(ports)
  shared.shutdowns.delete(ports.directory)
  return () => {
    shared.loaded.delete(ports)
    for (const wake of shared.closingWaiters) wake()
  }
}

export function formShown(event: { readonly data: { readonly form: { readonly sessionID: string; readonly metadata?: unknown } } }) {
  const call = (event.data.form.metadata as { tool?: { id?: unknown } } | undefined)?.tool?.id
  if (typeof call !== "string") return
  const key = `${event.data.form.sessionID} ${call}`
  shared.shown.get(key)?.()
  shared.shown.delete(key)
}

export function formsMayHaveBeenMissed() {
  for (const shown of shared.shown.values()) shown()
  shared.shown.clear()
}

export function eventsFollowed() {
  const missed = shared.following === 0 && shared.followed
  shared.following++
  shared.followed = true
  if (missed) formsMayHaveBeenMissed()
  return missed
}

export function eventsLeft() {
  shared.following = Math.max(0, shared.following - 1)
}
