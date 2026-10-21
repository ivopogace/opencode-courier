// TEMPORARY (#344): does Bun run a setImmediate under fake timers once clearImmediate met one that had already run?
import { expect, jest, test } from "bun:test"

const chain = async (count: number) => {
  for (let i = 0; i < count; i++) await new Promise<void>((ok) => setImmediate(ok))
}

for (const stale of [0, 1, 5])
  test(`${stale} stale clearImmediate(s), then 2000 immediates under fake timers`, async () => {
    for (let i = 0; i < stale; i++) {
      const handle = setImmediate(() => {})
      await chain(2)
      clearImmediate(handle)
    }
    jest.useFakeTimers()
    try {
      await chain(2000)
    } finally {
      jest.useRealTimers()
    }
    expect(true).toBe(true)
  }, 2000)

test("an immediate cleared and replaced from a fake timer's callback, 300 times", async () => {
  jest.useFakeTimers()
  try {
    for (let i = 0; i < 300; i++) {
      let handle: ReturnType<typeof setImmediate> | undefined
      setTimeout(() => (handle = setImmediate(() => {})), 10)
      jest.advanceTimersByTime(10)
      for (let j = 0; j < 20; j++) await Promise.resolve()
      clearImmediate(handle!)
      await new Promise<void>((ok) => setImmediate(ok))
    }
  } finally {
    jest.useRealTimers()
  }
}, 2000)
