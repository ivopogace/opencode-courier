import type { Plugin } from "@opencode/plugin"
import { describeFailure } from "./protocol.js"

export type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]

export const rethrow =
  (tool: string) =>
  (error: unknown): never => {
    throw describeFailure(tool, error)
  }
