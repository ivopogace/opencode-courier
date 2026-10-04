import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { builtVersions, versionNotice } from "../src/version.js"

const read = (path: string) => JSON.parse(readFileSync(join(import.meta.dir, "..", path), "utf8"))

test("the versions the plugin reports are package.json's: its own, and the @opencode/plugin pin", () => {
  const pkg = read("package.json")

  expect(builtVersions()).toEqual({ plugin: pkg.version, opencode: pkg.devDependencies["@opencode/plugin"] })
})

test("the pin is an exact version, the one installed for the build and the tests", () => {
  const { opencode } = builtVersions()

  expect(opencode).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  expect(opencode).toBe(read("node_modules/@opencode/plugin/package.json").version)
})

test("no notice on the pinned OpenCode, whatever its channel", () => {
  const built = { plugin: "0.2.0", opencode: "2.0.22" }

  expect(versionNotice(built, { version: "2.0.22", channel: "latest" })).toBeUndefined()
  expect(versionNotice(built, { version: "2.0.22", channel: "beta" })).toBeUndefined()
})

test("one line on another OpenCode, naming the plugin, the pin, the running version and channel, and the README table", () => {
  const notice = versionNotice({ plugin: "0.2.0", opencode: "2.0.22" }, { version: "2.0.30", channel: "beta" })

  expect(notice).toBe(
    "opencode-courier 0.2.0 was built and tested against OpenCode 2.0.22; this server is 2.0.30 (channel beta). " +
      "Its tools may fail: see the Supported OpenCode version table in the README, " +
      "https://github.com/ivopogace/opencode-courier#supported-opencode-version",
  )
  expect(notice).not.toContain("\n")
  // An older server too: the check is for equality, not order.
  expect(versionNotice({ plugin: "0.2.0", opencode: "2.0.22" }, { version: "2.0.21", channel: "latest" })).toContain("this server is 2.0.21")
})
