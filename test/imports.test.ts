import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, posix } from "node:path"

const SRC = join(import.meta.dir, "..", "src")

/**
 * Each module of src/, by its path there without `.ts` (`platform/hub`, `question/relay`), with the modules of
 * src/ it imports: static, type-only, side-effect and dynamic imports alike.
 */
function imports() {
  const graph = new Map<string, string[]>()
  for (const file of readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".ts"))) {
    const module = file.slice(0, -3).split("\\").join("/")
    const text = readFileSync(join(SRC, file), "utf8")
    graph.set(
      module,
      [...text.matchAll(/\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[\w./-]+)\.js["']/g)].map((match) =>
        posix.normalize(posix.join(posix.dirname(module), match[1]!)),
      ),
    )
  }
  return graph
}

/** The modules of src/ each module imports with `import type` or `export type … from` only, as `module -> imported`. */
function typeOnly() {
  const edges = new Set<string>()
  for (const file of readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".ts"))) {
    const module = file.slice(0, -3).split("\\").join("/")
    const text = readFileSync(join(SRC, file), "utf8")
    for (const match of text.matchAll(/\b(?:import|export)\s+type\s*(?:\{[^}]*\}|[^"'{}]*?)\s*from\s*["'](\.{1,2}\/[\w./-]+)\.js["']/g))
      edges.add(`${module} -> ${posix.normalize(posix.join(posix.dirname(module), match[1]!))}`)
  }
  return edges
}

test("no module of src/ imports itself through others, type-only imports included", () => {
  // Until step 5 of #126 dissolves it, notices.ts takes its types from the modules that own them.
  const exempt = typeOnly()
  const graph = imports()
  const cycles: string[] = []
  const visit = (module: string, path: string[]) => {
    for (const next of graph.get(module) ?? []) {
      if (module === "notices" && exempt.has(`${module} -> ${next}`)) continue
      if (path.includes(next)) cycles.push([...path.slice(path.indexOf(next)), next].join(" -> "))
      else visit(next, [...path, next])
    }
  }
  for (const module of graph.keys()) visit(module, [module])
  expect(cycles).toEqual([])
})

test("notices.ts imports nothing of the plugin's at runtime but platform/json.ts, kernel/protocol.ts and the text.ts of the modules that moved", () => {
  const types = typeOnly()
  const runtime = (imports().get("notices") ?? []).filter((name) => !types.has(`notices -> ${name}`))
  expect(runtime.sort()).toEqual(["kernel/protocol", "platform/json", "scheduling/text"])
})

test("platform/ imports only platform/, so the hub and the event loop depend on no feature", () => {
  const platform = [...imports()].filter(([module]) => module.startsWith("platform/"))
  expect(platform.map(([module]) => module)).toContain("platform/hub")
  expect(platform.flatMap(([module, imported]) => imported.filter((name) => !name.startsWith("platform/")).map((name) => `${module} -> ${name}`))).toEqual([])
})

test("kernel/ imports only kernel/ and platform/json.ts, so any module can use it", () => {
  const kernel = [...imports()].filter(([module]) => module.startsWith("kernel/"))
  expect(kernel.map(([module]) => module)).toContain("kernel/protocol")
  expect(kernel.flatMap(([module, imported]) => imported.filter((name) => !name.startsWith("kernel/") && name !== "platform/json").map((name) => `${module} -> ${name}`))).toEqual([])
})

test("effect is imported only by question/, index.ts and the tools.ts files", () => {
  const importing = readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => /(?:from|import)\s*\(?\s*["']effect(?:\/[^"']*)?["']/.test(readFileSync(join(SRC, name), "utf8")))
    .map((name) => name.slice(0, -3).split("\\").join("/"))
    .filter((module) => !module.startsWith("question/") && module !== "index" && !/(?:^|\/)tools$/.test(module))
  expect(importing).toEqual([])
})

test("platform/bounded.ts imports nothing of the plugin's, so any module can hold its collections", () => {
  expect(imports().get("platform/bounded")).toEqual([])
})

test("the question relay's modules are found, so the checks above cover them", () => {
  expect(imports().get("index")).toContain("question/index")
  expect(imports().get("question/relay")).toContain("question/answer")
})

test("modules outside question/ use the relay through question/index.ts only", () => {
  const reaching = [...imports()]
    .filter(([module]) => !module.startsWith("question/"))
    .flatMap(([module, imported]) => imported.filter((name) => name.startsWith("question/") && name !== "question/index").map((name) => `${module} -> ${name}`))
  expect(reaching).toEqual([])
})

/** The modules of src/ that live in a folder of their own with an index.ts, as `folder -> files`. */
const MODULES = ["scheduling"]

test("a module is imported from outside only through its index.ts", () => {
  const reaching = [...imports()].flatMap(([module, imported]) =>
    imported
      .filter((name) => MODULES.some((folder) => name.startsWith(`${folder}/`) && !module.startsWith(`${folder}/`) && name !== `${folder}/index`))
      .filter((name) => !(module === "notices" && name.endsWith("/text")))
      .map((name) => `${module} -> ${name}`),
  )
  expect(reaching).toEqual([])
})

test("scheduling/ and webhook/ import no other feature module, only platform/ and kernel/", () => {
  const modules = [...imports()].filter(([module]) => module.startsWith("scheduling/") || module.startsWith("webhook/"))
  expect(modules.map(([module]) => module)).toContain("scheduling/index")
  const outside = modules.flatMap(([module, imported]) =>
    imported
      .filter((name) => !name.startsWith(`${module.split("/")[0]}/`) && !name.startsWith("platform/") && !name.startsWith("kernel/"))
      .map((name) => `${module} -> ${name}`),
  )
  expect(outside).toEqual([])
})
