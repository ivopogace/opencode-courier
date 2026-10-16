import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { END, releaseOf, replaceTable, START, table } from "../script/compat-table.js"

const v2 = (version: string, pin: string) => ({ version, pin, beta: false })

test("releases on one pin share a row, oldest first, and the rows go newest first", () => {
  expect(table([v2("0.7.0", "2.0.29"), v2("0.7.1", "2.0.30"), v2("0.5.0", "2.0.29"), v2("0.6.0", "2.0.29")]).slice(2)).toEqual([
    "| 0.7.1 | 2.0.30 |",
    "| 0.5.0, 0.6.0, 0.7.0 | 2.0.29 |",
  ])
})

test("versions sort as semver, and a prerelease is left out", () => {
  expect(table([v2("0.9.0", "2.0.30"), v2("0.10.0", "2.0.31"), v2("0.10.1-beta.1", "2.0.32")]).slice(2)).toEqual([
    "| 0.10.0 | 2.0.31 |",
    "| 0.9.0 | 2.0.30 |",
  ])
})

test("a pin the plugin left and came back to gets a row of its own each time", () => {
  expect(table([v2("0.1.0", "2.0.1"), v2("0.2.0", "2.0.2"), v2("0.3.0", "2.0.1")]).slice(2)).toEqual([
    "| 0.3.0 | 2.0.1 |",
    "| 0.2.0 | 2.0.2 |",
    "| 0.1.0 | 2.0.1 |",
  ])
})

test("a release pins whichever plugin API its package.json names, the beta line's noted", () => {
  expect(releaseOf({ version: "0.7.1", peerDependencies: { "@opencode/plugin": "2.0.30", effect: "4.0.1" } })).toEqual(v2("0.7.1", "2.0.30"))
  const beta = releaseOf({ version: "0.1.6", peerDependencies: { "@opencode-ai/plugin": "0.0.0-beta-19271" } })!
  expect(table([beta]).at(-1)).toBe(
    "| 0.1.6 | 0.0.0-beta-19271 (the beta line: `opencode2` from `@opencode-ai/cli`, and `@opencode-ai/plugin`) |",
  )
  expect(releaseOf({ version: "0.0.1" })).toBeUndefined()
})

test("only the lines between the markers are replaced", () => {
  const readme = `before\n${START}\nold\n${END}\nafter\n`
  expect(replaceTable(readme, ["new"])).toBe(`before\n${START}\nnew\n${END}\nafter\n`)
  expect(() => replaceTable("no markers", ["new"])).toThrow("has no")
})

// The table itself is checked against the release tags by `bun script/compat-table.ts --check` in CI.
test("the README holds the table between its markers", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
  expect(readme).toContain(`${START}\n| opencode-courier | OpenCode V2`)
  expect(readme).toContain(`|\n${END}\n`)
})
