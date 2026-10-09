import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const words = (text: string) => text.replace(/\s+/g, " ").trim()

// The package description is what npm shows, what the repository description repeats and what the
// README's opening paragraph ends with; it stays short for GitHub's title and og tags built from it.
test("the README's opening paragraph ends with package.json's description", () => {
  const description = words((JSON.parse(read("package.json")) as { description: string }).description)
  const paragraphs = read("README.md").replace(/\r\n/g, "\n").split(/\n\s*\n/)
  const opening = paragraphs.find((paragraph) => paragraph.trim() !== "" && !paragraph.trimStart().startsWith("#"))

  expect(description.length).toBeLessThanOrEqual(100)
  expect(words(opening ?? "")).toEndWith(description)
})
