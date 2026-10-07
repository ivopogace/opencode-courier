import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// The plugin API is pinned to one exact version in both places: the devDependency is what the build
// and the live suite run on, and the peer dependency picks the copy `opencode plugin add` installs
// next to the plugin on every host (docs/plugin-api-notes.md). A bump of one without the other
// fails here, and CI reads the peer for the CLI it installs, so the two must stay equal and exact.
describe("the @opencode/plugin pin", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    peerDependencies: Record<string, string>
    devDependencies: Record<string, string>
  }

  test("is the same exact version as peer dependency and as devDependency", () => {
    const peer = manifest.peerDependencies["@opencode/plugin"]
    const dev = manifest.devDependencies["@opencode/plugin"]
    expect(peer).toMatch(/^\d+\.\d+\.\d+$/)
    expect(dev).toBe(peer)
  })

  // The README names the pin where a newcomer reads it: the CLI its Quickstart and Install sections
  // install, and the version its "OpenCode V2 native" section says the release is tested on.
  test("is the OpenCode version the README installs and names as tested", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
    const peer = manifest.peerDependencies["@opencode/plugin"]
    const installs = [...readme.matchAll(/@opencode\/cli@(\S+)/g)].map((match) => match[1])
    expect(installs.length).toBeGreaterThanOrEqual(2)
    expect(new Set(installs)).toEqual(new Set([peer]))
    expect(readme).toContain(`tested on **OpenCode ${peer}**`)
  })
})
