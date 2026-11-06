import { readFileSync } from "node:fs"
import type { App } from "@opencode/plugin/app"

export interface BuiltVersions {
  readonly plugin: string
  readonly opencode: string
}

const VERSION_TABLE = "https://github.com/ivopogace/opencode-courier/blob/main/docs/reference.md#the-opencode-version"

export function builtVersions(): BuiltVersions {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version?: unknown
    devDependencies?: Record<string, unknown>
  }
  const plugin = pkg.version
  const opencode = pkg.devDependencies?.["@opencode/plugin"]
  if (typeof plugin !== "string") throw new Error("package.json has no version")
  if (typeof opencode !== "string") throw new Error("package.json pins no @opencode/plugin under devDependencies")
  return { plugin, opencode }
}

export function versionNotice(built: BuiltVersions, app: Partial<Pick<App, "version" | "channel">> | undefined): string | undefined {
  const version = typeof app?.version === "string" ? app.version : undefined
  if (version === built.opencode) return undefined
  const running = version === undefined ? "this server reports no version" : `this server is ${version}`
  const channel = typeof app?.channel === "string" ? ` (channel ${app.channel})` : ""
  return (
    `opencode-courier ${built.plugin} was built and tested against OpenCode ${built.opencode}; ${running}${channel}. ` +
    `Its tools may fail: see every release and the OpenCode it is pinned to, ${VERSION_TABLE}`
  )
}
