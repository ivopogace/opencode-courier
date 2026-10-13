import type { Plugin } from "@opencode/plugin"
import type { CourierPorts } from "./ports.js"
import { treeRpc } from "./rpc.js"
import { summary } from "./summary.js"

/** Serves the tree's RPC at the plugin's location, through the same use cases as the tools; disposed with the plugin. */
export function registerTreeRpc(rpc: Pick<Plugin.Context["rpc"], "register">, ports: CourierPorts) {
  return rpc.register(treeRpc, {
    summary: ({ sessionID }) => summary(ports, sessionID),
  })
}
