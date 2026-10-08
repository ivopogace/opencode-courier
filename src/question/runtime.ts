import { Cause, Clock, Duration, Effect, Exit, Fiber, Option, Scope } from "effect"

// What the relay's own fibers run with: this copy's state, not the hub's. A copy of the plugin
// loaded next to this one has its own, and they meet only in the shared fields of the hub.

const system = Effect.runSync(Clock.clockWith(Effect.succeed))

/** Largest delay a timer takes; a longer one would fire at once. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * The system clock, whose sleeps do not keep the process running: OpenCode exits without waiting
 * for a dismissal held, a notice told later or an answer waiting its turn.
 */
const live: Clock.Clock = {
  currentTimeMillisUnsafe: () => system.currentTimeMillisUnsafe(),
  currentTimeMillis: system.currentTimeMillis,
  currentTimeNanosUnsafe: () => system.currentTimeNanosUnsafe(),
  currentTimeNanos: system.currentTimeNanos,
  monotonicTimeNanosUnsafe: () => system.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: system.monotonicTimeNanos,
  sleep: (duration) => {
    const ms = Duration.toMillis(duration)
    if (ms <= 0) return Effect.yieldNow
    if (!Number.isFinite(ms)) return Effect.never
    return Effect.callback<void>((resume) => {
      const timer = setTimeout(() => resume(Effect.void), Math.min(ms, MAX_TIMER_MS))
      timer.unref?.()
      return Effect.sync(() => clearTimeout(timer))
    })
  },
}

let clock: Clock.Clock = live
/** The fibers the relay starts, which run as long as the process unless a test ends them. */
let scope = Scope.makeUnsafe()

/** Starts an effect of the relay in a fiber of its own, by the relay's clock, in the relay's scope. */
const start = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runSync(Effect.forkIn(Effect.provideService(effect, Clock.Clock, clock), scope, { startImmediately: true }))

/**
 * Runs an effect of the relay in a fiber of its own, by the relay's clock, which is the clock of
 * its ports (`ports.now`): the promise settles as the effect ends, and is rejected if it fails or
 * is interrupted. Interrupting what waits on the promise does not stop the fiber.
 */
export function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(Fiber.join(start(effect)))
}

/**
 * Runs an effect of the relay in the background, as `run` does; the promise resolves once it ended,
 * however it ended. A failure is logged with `failed`; an interruption, by a test ending, is not.
 */
export function background(effect: Effect.Effect<unknown, unknown>, failed: (error: unknown) => void): Promise<void> {
  return Effect.runPromise(Fiber.await(start(effect))).then((exit) => {
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) failed(Cause.squash(exit.cause))
  })
}

/** The promise's value, or undefined once `ms` have passed or it failed. */
export const within = <T>(promise: Promise<T> | undefined, ms: number): Effect.Effect<T | undefined> =>
  promise
    ? Effect.promise(() => promise.then((value): T | undefined => value, () => undefined)).pipe(Effect.timeoutOption(ms), Effect.map(Option.getOrUndefined))
    : Effect.succeed(undefined)

/**
 * For tests: the clock the relay runs by from now on, a `TestClock` whose time `ports.now` reads,
 * or the system clock again with none.
 */
export function useClock(next?: Clock.Clock) {
  clock = next ?? live
}

/** For tests: interrupts every fiber the relay started, and goes back to the system clock. */
export async function stopRelay() {
  const ended = scope
  scope = Scope.makeUnsafe()
  clock = live
  await Effect.runPromise(Scope.close(ended, Exit.void))
}
