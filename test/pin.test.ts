import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("the @opencode/plugin pin", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    peerDependencies: Record<string, string>
    devDependencies: Record<string, string>
    dependencies?: Record<string, string>
  }

  test("is the same exact version as peer dependency and as devDependency", () => {
    const peer = manifest.peerDependencies["@opencode/plugin"]
    const dev = manifest.devDependencies["@opencode/plugin"]
    expect(peer).toMatch(/^\d+\.\d+\.\d+$/)
    expect(dev).toBe(peer)
  })

  test("pins the effect peer to the devDependency and to the effect @opencode/plugin depends on", () => {
    const api = JSON.parse(
      readFileSync(new URL("../node_modules/@opencode/plugin/package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> }
    const peer = manifest.peerDependencies.effect
    expect(peer).toMatch(/^\d+\.\d+\.\d+$/)
    expect(manifest.devDependencies.effect).toBe(peer)
    expect(api.dependencies.effect).toBe(peer)
    expect(manifest.dependencies?.effect).toBeUndefined()
  })

  test("is the OpenCode version the README installs and names as tested", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
    const peer = manifest.peerDependencies["@opencode/plugin"]
    const installs = [...readme.matchAll(/@opencode\/cli@(\S+)/g)].map((match) => match[1])
    expect(installs.length).toBeGreaterThanOrEqual(2)
    expect(new Set(installs)).toEqual(new Set([peer]))
    expect(readme).toContain(`tested on **OpenCode ${peer}**`)
  })

  test("adds no peer for the TUI part, whose packages are exact devDependencies only, beside effect", () => {
    expect(Object.keys(manifest.peerDependencies)).toEqual(["@opencode/plugin", "effect"])
    for (const name of ["@opentui/core", "@opentui/solid", "solid-js", "@opencode/theme"])
      expect(manifest.devDependencies[name]).toMatch(/^\d+\.\d+\.\d+$/)
    expect(manifest.devDependencies["@opencode/theme"]).toBe(manifest.peerDependencies["@opencode/plugin"])
  })
})
