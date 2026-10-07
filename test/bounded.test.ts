import { describe, expect, test } from "bun:test"
import { addBounded, setBounded } from "../src/bounded.js"

describe("addBounded", () => {
  test("adds a value once: false when it was there already", () => {
    const set = new Set<string>()
    expect(addBounded(set, "a", 3)).toBe(true)
    expect(addBounded(set, "a", 3)).toBe(false)
    expect([...set]).toEqual(["a"])
  })

  test("keeps at most the bound, dropping the oldest first", () => {
    const set = new Set<string>()
    for (const value of ["a", "b", "c", "d", "e"]) addBounded(set, value, 3)
    expect([...set]).toEqual(["c", "d", "e"])
  })

  test("a value added again does not move up, so it is still dropped first", () => {
    const set = new Set<string>()
    for (const value of ["a", "b", "c"]) addBounded(set, value, 3)
    expect(addBounded(set, "a", 3)).toBe(false)
    addBounded(set, "d", 3)
    expect([...set]).toEqual(["b", "c", "d"])
  })

  test("a value dropped past the bound can be added again", () => {
    const set = new Set<string>()
    for (const value of ["a", "b", "c"]) addBounded(set, value, 2)
    expect(addBounded(set, "a", 2)).toBe(true)
    expect([...set]).toEqual(["c", "a"])
  })

  test("works on the plain Set the process shares, which an older copy of the plugin still reads", () => {
    const set = new Set<string>(["old"])
    expect(addBounded(set, "new", 1_000)).toBe(true)
    expect(set).toBeInstanceOf(Set)
    expect(set.has("old") && set.has("new")).toBe(true)
  })

  test("the watcher's bound of 1000: the 1001st value drops the first", () => {
    const set = new Set<string>()
    addBounded(set, "a", 1_000)
    for (let i = 0; i < 1_000; i++) addBounded(set, `v${i}`, 1_000)
    expect(set.size).toBe(1_000)
    expect(set.has("a")).toBe(false)
    expect(set.has("v0")).toBe(true)
  })
})

describe("setBounded", () => {
  test("keeps at most the bound, dropping the oldest key first", () => {
    const map = new Map<string, number>()
    for (const [index, key] of ["a", "b", "c", "d"].entries()) setBounded(map, key, index, 3)
    expect([...map]).toEqual([
      ["b", 1],
      ["c", 2],
      ["d", 3],
    ])
  })

  test("an existing key takes the new value and keeps its place", () => {
    const map = new Map<string, number>()
    for (const [index, key] of ["a", "b", "c"].entries()) setBounded(map, key, index, 3)
    setBounded(map, "a", 9, 3)
    expect([...map]).toEqual([
      ["a", 9],
      ["b", 1],
      ["c", 2],
    ])
    setBounded(map, "d", 3, 3)
    expect([...map.keys()]).toEqual(["b", "c", "d"])
  })
})
