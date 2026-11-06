import { Cause, Clock, Duration, Effect, Exit, Fiber, Option, Scope } from "effect"

const system = Effect.runSync(Clock.clockWith(Effect.succeed))

const MAX_TIMER_MS = 2_147_483_647

const live: Clock.Clock = {
  currentTimeMillisUnsafe: () => system.currentTimeMillisUnsafe(),
  currentTimeMillis: system.currentTimeMillis,
  currentTimeNanosUnsafe: () => system.currentTimeNanosUnsafe(),
  currentTimeNanos: system.currentTimeNanos,
  monotonicTimeNanosUnsafe: () => system.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: system.monotonicTimeNanos,
  sleep: (duration) => sleep(Duration.toMillis(duration)),
}

function sleep(ms: number): Effect.Effect<void> {
  if (ms <= 0) return Effect.yieldNow
  if (!Number.isFinite(ms)) return Effect.never
  const rest = ms > MAX_TIMER_MS ? Effect.suspend(() => sleep(ms - MAX_TIMER_MS)) : Effect.void
  return Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(rest), Math.min(ms, MAX_TIMER_MS))
    // unref'd: OpenCode exits without waiting for the relay's timers
    timer.unref?.()
    return Effect.sync(() => clearTimeout(timer))
  })
}

let clock: Clock.Clock = live
let scope = Scope.makeUnsafe()

const start = <A, E>(effect: Effect.Effect<A, E>) => Effect.runFork(Effect.provideService(effect, Clock.Clock, clock)).pipe(Fiber.runIn(scope))

export function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(Fiber.join(start(effect)))
}

export function background(effect: Effect.Effect<unknown, unknown>, failed: (error: unknown) => void): Promise<void> {
  return Effect.runPromise(Fiber.await(start(effect))).then((exit) => {
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) failed(Cause.squash(exit.cause))
  })
}

export const within = <T>(promise: Promise<T> | undefined, ms: number): Effect.Effect<T | undefined> =>
  promise
    ? Effect.promise(() => promise.then((value): T | undefined => value, () => undefined)).pipe(Effect.timeoutOption(ms), Effect.map(Option.getOrUndefined))
    : Effect.succeed(undefined)

export function useClock(next?: Clock.Clock) {
  clock = next ?? live
}

export async function stopRelay() {
  const ended = scope
  scope = Scope.makeUnsafe()
  clock = live
  await Effect.runPromise(Scope.close(ended, Exit.void))
}
