import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const read = (file: string) => readFileSync(resolve(root, file), "utf8")

const REFERENCE_WORDS = 5400
const README_LINES = 170

describe("doc budgets", () => {
  test(`docs/reference.md stays within ${REFERENCE_WORDS} words`, () => {
    expect(read("docs/reference.md").split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(REFERENCE_WORDS)
  })

  test(`README.md stays within ${README_LINES} lines`, () => {
    expect(read("README.md").trimEnd().split("\n").length).toBeLessThanOrEqual(README_LINES)
  })
})
