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
})
