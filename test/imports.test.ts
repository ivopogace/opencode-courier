import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, posix } from "node:path"

const SRC = join(import.meta.dir, "..", "src")

/** The source files of src/, `.ts` and `.tsx`, each with its module: its path there without the extension, `/`-separated. */
function sources() {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => ({ file: name, module: name.replace(/\.tsx?$/, "").split("\\").join("/") }))
}

/**
 * Each module of src/, by its path there without `.ts` (`platform/hub`, `person/question/relay`), with the modules of
 * src/ it imports: static, type-only, side-effect and dynamic imports alike.
 */
function imports() {
  const graph = new Map<string, string[]>()
  for (const { file, module } of sources()) {
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
  for (const { file, module } of sources()) {
    const text = readFileSync(join(SRC, file), "utf8")
    for (const match of text.matchAll(/\b(?:import|export)\s+type\s*(?:\{[^}]*\}|[^"'{}]*?)\s*from\s*["'](\.{1,2}\/[\w./-]+)\.js["']/g))
      edges.add(`${module} -> ${posix.normalize(posix.join(posix.dirname(module), match[1]!))}`)
  }
  return edges
}

/** Each module of src/ with the packages it imports, by their specifier: `effect`, `@opencode/plugin/tui`, `node:fs`. */
function packages() {
  const graph = new Map<string, string[]>()
  for (const { file, module } of sources()) {
    const text = readFileSync(join(SRC, file), "utf8")
    graph.set(module, [...text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^."'][^"']*)["']/g)].map((match) => match[1]!))
  }
  return graph
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

test("effect is imported only by person/question/, index.ts, the tools.ts files and the rpc.ts files", () => {
  const importing = [...packages()]
    .filter(([, imported]) => imported.some((name) => name === "effect" || name.startsWith("effect/")))
    .map(([module]) => module)
    .filter((module) => !module.startsWith("person/question/") && module !== "index" && !/(?:^|\/)(?:tools|rpc)$/.test(module))
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
const MODULES = ["tree", "person", "scheduling", "webhook", "memory"]

/** The module a file of src/ is in, or undefined for `src/index.ts`, `skill.ts`, `kernel/` and `platform/`. */
const moduleOf = (file: string) => MODULES.find((folder) => file.startsWith(`${folder}/`))

/** What an entrypoint may take of a module directly, besides its index.ts: its RPC contract, and for `tui` its TUI part. */
const ENTRY_REACH: Record<string, readonly string[]> = { rpc: ["rpc"], tui: ["rpc", "tui"] }

test("a module is imported from outside only through its index.ts, but by the tui and rpc entrypoints", () => {
  const reaching = [...imports()].flatMap(([module, imported]) =>
    imported
      .filter((name) => moduleOf(name) !== undefined && moduleOf(name) !== moduleOf(module) && name !== `${moduleOf(name)}/index`)
      .filter((name) => !(ENTRY_REACH[module] ?? []).some((file) => name === `${moduleOf(name)}/${file}`))
      .map((name) => `${module} -> ${name}`),
  )
  expect(reaching).toEqual([])
})

test("the only dependencies between modules are person/'s and memory/'s on tree/", () => {
  const edges = new Set(
    [...imports()].flatMap(([module, imported]) =>
      imported.flatMap((name) => {
        const [from, to] = [moduleOf(module), moduleOf(name)]
        return from && to && from !== to ? [`${from} -> ${to}`] : []
      }),
    ),
  )
  expect([...edges].toSorted()).toEqual(["memory -> tree", "person -> tree"])
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

test("no file of src/ is outside a folder but index.ts, skill.ts and the rpc.ts and tui.tsx entrypoints", () => {
  const top = [...imports().keys()].filter((module) => !module.includes("/"))
  expect(top).toEqual(expect.arrayContaining(["index", "skill", "rpc", "tui"]))
  expect(top.filter((module) => !["index", "rpc", "skill", "tui"].includes(module))).toEqual([])
})

/** The packages that are the TUI's: the host provides them to a TUI part, and nothing of the server half may import them. */
const isTuiPackage = (name: string) =>
  name === "@opencode/plugin/tui" || name.startsWith("@opencode/plugin/tui/") || name === "solid-js" || name.startsWith("solid-js/") || name.startsWith("@opentui/")

test("a module's tui.tsx imports only the TUI's packages and its own module's rpc.ts, text.ts and mascot.ts", () => {
  const parts = sources().filter(({ file }) => /^[^/\\]+[/\\]tui\.tsx$/.test(file)).map(({ module }) => module)
  expect(parts).toEqual(expect.arrayContaining(["tree/tui", "person/tui", "memory/tui"]))
  const graph = imports()
  const used = packages()
  const reaching = parts.flatMap((module) => {
    const own = module.slice(0, -"tui".length)
    return [
      ...(graph.get(module) ?? []).filter((name) => ![`${own}rpc`, `${own}text`, `${own}mascot`].includes(name)),
      ...(used.get(module) ?? []).filter((name) => !isTuiPackage(name)),
    ].map((name) => `${module} -> ${name}`)
  })
  expect(reaching).toEqual([])
})

test("tree/mascot.ts, Digby's drawings, imports nothing, so the TUI bundle takes nothing else with it", () => {
  expect(imports().get("tree/mascot")).toEqual([])
  expect(packages().get("tree/mascot")).toEqual([])
})

test("a module's rpc.ts imports only @opencode/plugin/rpc and effect, so the TUI bundle takes nothing else of the module", () => {
  const contracts = sources().filter(({ module }) => /^[^/]+\/rpc$/.test(module)).map(({ module }) => module)
  expect(contracts).toEqual(expect.arrayContaining(["tree/rpc", "person/rpc", "memory/rpc"]))
  const graph = imports()
  const used = packages()
  const reaching = contracts.flatMap((module) =>
    [...(graph.get(module) ?? []), ...(used.get(module) ?? []).filter((name) => name !== "@opencode/plugin/rpc" && name !== "effect")].map(
      (name) => `${module} -> ${name}`,
    ),
  )
  expect(reaching).toEqual([])
})

test("the tui entrypoint imports only @opencode/plugin/tui and the modules' tui.tsx and rpc.ts, the rpc entrypoint only their rpc.ts", () => {
  expect(imports().get("tui")).toEqual(expect.arrayContaining(["tree/tui", "person/tui", "memory/tui"]))
  expect(imports().get("rpc")).toEqual(expect.arrayContaining(["tree/rpc", "person/rpc", "memory/rpc"]))
  const reaching = (["tui", "rpc"] as const).flatMap((entry) => {
    const allowed = (name: string) => moduleOf(name) !== undefined && ENTRY_REACH[entry]!.some((file) => name === `${moduleOf(name)}/${file}`)
    return [
      ...(imports().get(entry) ?? []).filter((name) => !allowed(name)),
      ...(packages().get(entry) ?? []).filter((name) => !(entry === "tui" && name === "@opencode/plugin/tui")),
    ].map((name) => `${entry} -> ${name}`)
  })
  expect(reaching).toEqual([])
})

test("only the tui entrypoint and the modules' tui.tsx import the TUI, so the server bundle carries none of it", () => {
  const graph = imports()
  const isTui = (module: string) => module === "tui" || /^[^/]+\/tui$/.test(module)
  const reaching = [
    ...[...graph].flatMap(([module, imported]) => (module === "tui" ? [] : imported.filter(isTui).map((name) => `${module} -> ${name}`))),
    ...[...packages()].flatMap(([module, imported]) => (isTui(module) ? [] : imported.filter(isTuiPackage).map((name) => `${module} -> ${name}`))),
  ]
  expect(reaching).toEqual([])
})

test("skill.ts imports only kernel/", () => {
  expect((imports().get("skill") ?? []).filter((name) => !name.startsWith("kernel/"))).toEqual([])
})

test("a text.ts imports only kernel/, platform/json.ts and its own module's ports.ts and domain.ts", () => {
  const texts = [...imports()].filter(([module]) => module.endsWith("/text"))
  expect(texts.map(([module]) => module).sort()).toEqual(["memory/text", "person/text", "scheduling/text", "tree/text", "webhook/text"])
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

test("tree/store.ts is imported from no file outside tree/, and tree/index.ts re-exports nothing of it", () => {
  const importing = [...imports()].filter(([, imported]) => imported.includes("tree/store")).map(([module]) => module)
  expect(importing).toContain("tree/forget")
  expect(importing.filter((module) => !module.startsWith("tree/") || module === "tree/index")).toEqual([])
})

test("only tree/store.ts names the tree's storage prefixes, so no other file builds its keys", () => {
  const prefix = /\b(?:roster|roster-by-child|report|group)\//
  const naming = sources()
    .filter(({ file }) => prefix.test(readFileSync(join(SRC, file), "utf8")))
    .map(({ file }) => file.split("\\").join("/"))
  expect(naming).toEqual(["tree/store.ts"])
})

test("memory/store.ts is imported from no file outside memory/, and only it names the memory's storage prefix", () => {
  const importing = [...imports()].filter(([, imported]) => imported.includes("memory/store")).map(([module]) => module)
  expect(importing).toContain("memory/record")
  expect(importing).toContain("memory/forget")
  expect(importing).toContain("memory/rpc-handlers")
  expect(importing.filter((module) => !module.startsWith("memory/") || module === "memory/index")).toEqual([])
  const naming = sources()
    .filter(({ file }) => /"memory\//.test(readFileSync(join(SRC, file), "utf8")))
    .map(({ file }) => file.split("\\").join("/"))
  expect(naming).toEqual(["memory/store.ts"])
})
