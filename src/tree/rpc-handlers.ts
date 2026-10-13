import type { Plugin } from "@opencode/plugin"
import { panel } from "./panel.js"
import type { StopPorts } from "./ports.js"
import { treeRpc } from "./rpc.js"
import { stop } from "./stop.js"
import { summary } from "./summary.js"

/** Serves the tree's RPC at the plugin's location, through the same use cases as the tools; disposed with the plugin. */
export function registerTreeRpc(rpc: Pick<Plugin.Context["rpc"], "register">, ports: StopPorts) {
  return rpc.register(treeRpc, {
    summary: ({ sessionID }) => summary(ports.courier, sessionID),
    tree: ({ sessionID }) => panel(ports.courier, sessionID),
    stop: async ({ sessionID, by }, { error }) => {
      try {
        const { stopped, cancelled } = await stop(ports, by, { sessionID })
        return { stopped: stopped.map(({ sessionID, title, outcome }) => ({ sessionID, title, outcome })), cancelled: cancelled.length }
      } catch (cause) {
        return error("refused", cause instanceof Error ? cause.message : String(cause), {})
      }
    },
  })
}
