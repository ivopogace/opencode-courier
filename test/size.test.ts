import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const read = (file: string) => readFileSync(resolve(root, file), "utf8")

const REFERENCE_WORDS = 5264
const GENERATED_TABLE = /<!-- compat-table:start[\s\S]*?<!-- compat-table:end -->/g
const README_LINES = 170

describe("doc budgets", () => {
  test(`docs/reference.md stays within ${REFERENCE_WORDS} words, its generated version table aside`, () => {
    expect(read("docs/reference.md").replace(GENERATED_TABLE, "").split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(REFERENCE_WORDS)
  })

  test(`README.md stays within ${README_LINES} lines`, () => {
    expect(read("README.md").trimEnd().split("\n").length).toBeLessThanOrEqual(README_LINES)
  })
})
