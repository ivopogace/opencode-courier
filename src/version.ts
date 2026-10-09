import { readFileSync } from "node:fs"
import type { App } from "@opencode/plugin/app"

/** The versions a build of the plugin carries: its own, and the OpenCode it was built and tested against. */
export interface BuiltVersions {
  readonly plugin: string
  readonly opencode: string
}

const README_TABLE = "https://github.com/ivopogace/opencode-courier#supported-opencode-version"

/**
 * Reads from the package's own package.json, next to `dist/` as to `src/`: `version` and the exact
 * `@opencode/plugin` devDependency version, which the peer repeats. Throws if either is missing.
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
 * The server-log line for an OpenCode other than the plugin was built against, undefined when it is;
 * logged once per load, never in a tool result. A context without a version is still told the pin.
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
