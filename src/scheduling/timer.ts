import { TICK_MS, tickNow } from "../platform/hub.js"

export const NEAR_MS = 2 * TICK_MS

export interface Alarm {
  readonly set: (run: () => void, ms: number) => unknown
  readonly clear: (handle: unknown) => void
  readonly wake: () => Promise<void>
}

export interface Clock {
  readonly now: () => number
  readonly log: (message: string) => void
}

export interface DueTimer {
  readonly arm: (entry: { readonly id: string; readonly fireAt: number }, clock: Clock) => void
  readonly disarm: (id: string) => void
}

const realAlarm: Alarm = {
  set: (run, ms) => {
    const handle = setTimeout(run, ms)
    handle.unref?.()
    return handle
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  wake: () => tickNow(),
}

export function dueTimer(alarm: Alarm = realAlarm): DueTimer {
  const armed = new Map<string, unknown>()
  return {
    arm: ({ id, fireAt }, clock) => {
      const wait = fireAt - clock.now()
      if (armed.has(id) || wait > NEAR_MS) return
      const fire = () => {
        armed.delete(id)
        void alarm.wake().catch((error: unknown) => clock.log(`courier_later timer: ${id} waits for the next tick: ${String(error)}`))
      }
      armed.set(id, alarm.set(fire, Math.max(0, wait)))
    },
    disarm: (id) => {
      if (!armed.has(id)) return
      alarm.clear(armed.get(id))
      armed.delete(id)
    },
  }
}

export const ownTimer = dueTimer()
