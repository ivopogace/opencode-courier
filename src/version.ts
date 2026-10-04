import { readFileSync } from "node:fs"
import type { App } from "@opencode/plugin/app"

/** The versions a build of the plugin carries: its own, and the OpenCode it was built and tested against. */
export interface BuiltVersions {
  readonly plugin: string
  readonly opencode: string
}

const README_TABLE = "https://github.com/ivopogace/opencode-courier#supported-opencode-version"

/**
 * Reads the versions from the package's own package.json, which sits next to `dist/` in the
 * published package as it does next to `src/` in the repository: `version`, and the exact
 * `@opencode/plugin` version under devDependencies, the one installed for the build and both test
 * suites; the peer dependency names the same exact version, as the copy of the plugin API that
 * `opencode plugin add` installs next to the plugin. Throws when the file cannot be read or does
 * not hold both.
 */
export function builtVersions(): BuiltVersions {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown
    devDependencies?: Record<string, unknown>
  }
  const plugin = pkg.version
  const opencode = pkg.devDependencies?.["@opencode/plugin"]
  if (typeof plugin !== "string") throw new Error("package.json has no version")
  if (typeof opencode !== "string") throw new Error("package.json pins no @opencode/plugin under devDependencies")
  return { plugin, opencode }
}

/**
 * The line for the server log when the running OpenCode is not the one the plugin was built
 * against; undefined when it is. Logged once per plugin load, never in a tool result. An OpenCode
 * whose plugin context does not report a version, as one from before the pinned API or after a
 * change to it may not, is the case the line is for, so it still names the pin then.
 */
export function versionNotice(built: BuiltVersions, app: Partial<Pick<App, "version" | "channel">> | undefined): string | undefined {
  const version = typeof app?.version === "string" ? app.version : undefined
  if (version === built.opencode) return undefined
  const running = version === undefined ? "this server reports no version" : `this server is ${version}`
  const channel = typeof app?.channel === "string" ? ` (channel ${app.channel})` : ""
  return (
    `opencode-courier ${built.plugin} was built and tested against OpenCode ${built.opencode}; ${running}${channel}. ` +
    `Its tools may fail: see the Supported OpenCode version table in the README, ${README_TABLE}`
  )
}
