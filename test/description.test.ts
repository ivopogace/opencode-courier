import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

// The package description is what npm shows, what the repository description repeats and what the
// README's opening states; it stays short, for GitHub's title and og tags (docs/social-preview.py
// draws the same tagline).
test("the README opens with package.json's description", () => {
  const { description } = JSON.parse(read("package.json")) as { description: string }
  const opening = read("README.md").split("\n\n")[1]!.replace(/\s+/g, " ")

  expect(description.length).toBeLessThanOrEqual(100)
  expect(opening).toContain(description)
})
