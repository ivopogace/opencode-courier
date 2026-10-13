import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, posix } from "node:path"

const SRC = join(import.meta.dir, "..", "src")

/**
 * Each module of src/, by its path there without `.ts` (`platform/hub`, `person/question/relay`), with the modules of
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
  // But a text.ts's types: it takes them from its module's ports.ts, which re-exports some from the code
  // that imports the text.ts back for its texts (person/'s question relay).
  const exempt = typeOnly()
  const graph = imports()
  const cycles: string[] = []
  const visit = (module: string, path: string[]) => {
    for (const next of graph.get(module) ?? []) {
      if (module.endsWith("/text") && exempt.has(`${module} -> ${next}`)) continue
      if (path.includes(next)) cycles.push([...path.slice(path.indexOf(next)), next].join(" -> "))
      else visit(next, [...path, next])
    }
  }
  for (const module of graph.keys()) visit(module, [module])
  expect(cycles).toEqual([])
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

test("effect is imported only by person/question/, index.ts and the tools.ts files", () => {
  const importing = readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => /(?:from|import)\s*\(?\s*["']effect(?:\/[^"']*)?["']/.test(readFileSync(join(SRC, name), "utf8")))
    .map((name) => name.slice(0, -3).split("\\").join("/"))
    .filter((module) => !module.startsWith("person/question/") && module !== "index" && !/(?:^|\/)tools$/.test(module))
  expect(importing).toEqual([])
})

test("platform/bounded.ts imports nothing of the plugin's, so any module can hold its collections", () => {
  expect(imports().get("platform/bounded")).toEqual([])
})

test("the question relay's modules are found, so the checks above cover them", () => {
  expect(imports().get("index")).toContain("person/index")
  expect(imports().get("person/index")).toContain("person/question/index")
  expect(imports().get("person/question/relay")).toContain("person/question/answer")
})

test("person/ outside person/question/ uses the relay through person/question/index.ts only", () => {
  const reaching = [...imports()]
    .filter(([module]) => module.startsWith("person/") && !module.startsWith("person/question/"))
    .flatMap(([module, imported]) =>
      imported.filter((name) => name.startsWith("person/question/") && name !== "person/question/index").map((name) => `${module} -> ${name}`),
    )
  expect(reaching).toEqual([])
})

/** The modules of src/: each a folder of its own, used from outside through its index.ts. */
const MODULES = ["tree", "person", "scheduling", "webhook"]

/** The module a file of src/ is in, or undefined for `src/index.ts`, `skill.ts`, `kernel/` and `platform/`. */
const moduleOf = (file: string) => MODULES.find((folder) => file.startsWith(`${folder}/`))

test("a module is imported from outside only through its index.ts", () => {
  const reaching = [...imports()].flatMap(([module, imported]) =>
    imported
      .filter((name) => moduleOf(name) !== undefined && moduleOf(name) !== moduleOf(module) && name !== `${moduleOf(name)}/index`)
      .map((name) => `${module} -> ${name}`),
  )
  expect(reaching).toEqual([])
})

test("the only dependency between modules is person/ on tree/", () => {
  const edges = new Set(
    [...imports()].flatMap(([module, imported]) =>
      imported.flatMap((name) => {
        const [from, to] = [moduleOf(module), moduleOf(name)]
        return from && to && from !== to ? [`${from} -> ${to}`] : []
      }),
    ),
  )
  expect([...edges]).toEqual(["person -> tree"])
})

test("every module imports only itself, platform/, kernel/ and the modules it may depend on", () => {
  const outside = [...imports()]
    .filter(([module]) => moduleOf(module) !== undefined)
    .flatMap(([module, imported]) =>
      imported
        .filter((name) => moduleOf(name) === undefined && !name.startsWith("platform/") && !name.startsWith("kernel/"))
        .map((name) => `${module} -> ${name}`),
    )
  expect(outside).toEqual([])
})

test("no file of src/ is outside a folder but index.ts, the composition root, and skill.ts", () => {
  expect([...imports().keys()].filter((module) => !module.includes("/")).sort()).toEqual(["index", "skill"])
})

test("skill.ts imports only kernel/", () => {
  expect((imports().get("skill") ?? []).filter((name) => !name.startsWith("kernel/"))).toEqual([])
})

test("a text.ts imports only kernel/, platform/json.ts and its own module's ports.ts and domain.ts", () => {
  const texts = [...imports()].filter(([module]) => module.endsWith("/text"))
  expect(texts.map(([module]) => module).sort()).toEqual(["person/text", "scheduling/text", "tree/text", "webhook/text"])
  const reaching = texts.flatMap(([module, imported]) => {
    const own = module.slice(0, -"text".length)
    const allowed = (name: string) => name.startsWith("kernel/") || name === "platform/json" || name === `${own}ports` || name === `${own}domain`
    return imported.filter((name) => !allowed(name)).map((name) => `${module} -> ${name}`)
  })
  expect(reaching).toEqual([])
})

test("tree/domain.ts imports only kernel/ and platform/json.ts, so its rules stay pure", () => {
  const imported = imports().get("tree/domain")
  expect(imported).toBeDefined()
  expect(imported!.filter((name) => !name.startsWith("kernel/") && name !== "platform/json")).toEqual([])
})

test("only src/index.ts imports more than one module's index.ts, and nothing imports src/index.ts", () => {
  const graph = [...imports()]
  const several = graph
    .filter(([module]) => module !== "index")
    .filter(([, imported]) => new Set(imported.filter((name) => MODULES.some((folder) => name === `${folder}/index`))).size > 1)
    .map(([module]) => module)
  expect(several).toEqual([])
  expect(graph.filter(([, imported]) => imported.includes("index")).map(([module]) => module)).toEqual([])
})

test("the snapshot test imports every text.ts of src/ by its path", () => {
  const texts = [...imports().keys()].filter((module) => module === "text" || module.endsWith("/text"))
  const snapshot = readFileSync(join(import.meta.dir, "notices.test.ts"), "utf8")
  const imported = new Set([...snapshot.matchAll(/\bfrom\s*["']\.\.\/src\/([\w./-]+)\.js["']/g)].map((match) => match[1]!))
  expect(texts.length).toBeGreaterThan(0)
  expect(texts.filter((module) => !imported.has(module))).toEqual([])
})
