import { describe, expect, test } from "bun:test"
import { processWide, scanAll } from "../src/storage.js"

describe("processWide", () => {
  test("makes the value once and hands the same one to every caller", () => {
    const key = `opencode-courier.test.${crypto.randomUUID()}`
    let made = 0
    const create = () => {
      made++
      return new Set<string>()
    }

    const first = processWide(key, create)
    const second = processWide(key, create)

    expect(second).toBe(first)
    expect(made).toBe(1)
    expect((globalThis as Record<symbol, unknown>)[Symbol.for(key)]).toBe(first)
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(key)]
  })

  test("keeps a value an older copy of the plugin put under the key", () => {
    const key = `opencode-courier.test.${crypto.randomUUID()}`
    const older = { kept: true }
    ;(globalThis as Record<symbol, unknown>)[Symbol.for(key)] = older

    expect(processWide(key, () => ({ kept: false }))).toBe(older)
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(key)]
  })
})

describe("scanAll", () => {
  test("follows the pages", async () => {
    const pages: Record<string, { entries: { key: string; value: unknown }[]; next?: string }> = {
      "": { entries: [{ key: "p/a", value: 1 }], next: "p/a" },
      "p/a": { entries: [{ key: "p/b", value: 2 }] },
    }
    const asked: unknown[] = []
    const storage = {
      scan: async (input: { prefix: string; after?: string }) => {
        asked.push(input)
        return pages[input.after ?? ""]!
      },
    }

    expect(await scanAll<number>(storage as never, "p/")).toEqual([1, 2])
    expect(asked).toEqual([{ prefix: "p/" }, { prefix: "p/", after: "p/a" }])
  })
})
