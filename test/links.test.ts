import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

// Every relative Markdown link and #anchor in the docs resolves, so a moved file or heading fails here.
const root = resolve(import.meta.dir, "..")

const markdownUnder = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return markdownUnder(path)
    return entry.name.endsWith(".md") ? [path] : []
  })

const files = ["README.md", "CLAUDE.md", ...markdownUnder("docs"), ...markdownUnder(".claude")]

// Fenced blocks and code spans hold examples, not links.
const unfenced = (text: string) => text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
const prose = (text: string) => unfenced(text).replace(/`+[^`\n]*`+/g, "")

// GitHub's heading ids: lowercased, punctuation dropped, spaces to dashes, repeats numbered.
const anchors = (text: string) => {
  const seen = new Map<string, number>()
  const ids = new Set<string>()
  for (const [, heading] of unfenced(text).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = heading!
      .replace(/`/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-")
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    ids.add(count === 0 ? base : `${base}-${count}`)
  }
  return ids
}

const links = (text: string) =>
  [...prose(text).matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((match) => match[1]!)

describe("relative Markdown links", () => {
  test("cover the docs", () => {
    expect(files).toContain("README.md")
    expect(files.length).toBeGreaterThan(3)
  })

  for (const file of files)
    test(`resolve in ${file}`, () => {
      const broken: string[] = []
      for (const link of links(readFileSync(join(root, file), "utf8"))) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue
        const [path = "", anchor] = link.split("#")
        const target = path === "" ? join(root, file) : resolve(root, dirname(file), decodeURI(path))
        if (!target.startsWith(root) || !existsSync(target)) {
          broken.push(`${link}: no ${relative(root, target)}`)
          continue
        }
        if (anchor === undefined) continue
        if (statSync(target).isDirectory() || !target.endsWith(".md")) broken.push(`${link}: anchor into a non-Markdown file`)
        else if (!anchors(readFileSync(target, "utf8")).has(decodeURIComponent(anchor)))
          broken.push(`${link}: no heading #${anchor} in ${relative(root, target)}`)
      }
      expect(broken).toEqual([])
    })
})
