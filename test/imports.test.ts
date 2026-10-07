import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = join(import.meta.dir, "..", "src")

/** Each module of src/ with the modules of src/ it imports, type-only imports included. */
function imports() {
  const graph = new Map<string, string[]>()
  for (const file of readdirSync(SRC).filter((name) => name.endsWith(".ts"))) {
    const text = readFileSync(join(SRC, file), "utf8")
    graph.set(file.slice(0, -3), [...text.matchAll(/from "\.\/([\w-]+)\.js"/g)].map((match) => match[1]!))
  }
  return graph
}

test("no module of src/ imports itself through others", () => {
  const graph = imports()
  const cycles: string[] = []
  const visit = (module: string, path: string[]) => {
    for (const next of graph.get(module) ?? []) {
      if (path.includes(next)) cycles.push([...path.slice(path.indexOf(next)), next].join(" -> "))
      else visit(next, [...path, next])
    }
  }
  for (const module of graph.keys()) visit(module, [module])
  expect(cycles).toEqual([])
})

test("notices.ts imports nothing of the plugin's but json.ts, so any module can use it", () => {
  expect(imports().get("notices")).toEqual(["json"])
})
