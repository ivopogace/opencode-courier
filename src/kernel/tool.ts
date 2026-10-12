import type { Plugin } from "@opencode/plugin"
import { describeFailure } from "./protocol.js"

/** The editor OpenCode hands a tool transform. */
export type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]

/** A `.catch` handler that rethrows a failure of `tool` as the error the model reads. */
export const rethrow =
  (tool: string) =>
  (error: unknown): never => {
    throw describeFailure(tool, error)
  }
