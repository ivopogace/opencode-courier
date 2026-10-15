import type { Plugin } from "@opencode/plugin"
import { describeFailure } from "../kernel/protocol.js"
import { isNotFound } from "../platform/json.js"
import { cleanup } from "./cleanup.js"
import { panel } from "./panel.js"
import type { StopPorts } from "./ports.js"
import { treeRpc, type Forgotten } from "./rpc.js"
import { stop } from "./stop.js"
import { childStore } from "./store.js"
import { summary } from "./summary.js"

/** Serves the tree's RPC at the plugin's location, through the same use cases as the tools; disposed with the plugin. */
export function registerTreeRpc(rpc: Pick<Plugin.Context["rpc"], "register">, ports: StopPorts) {
  const refused = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
  return rpc.register(treeRpc, {
    summary: ({ sessionID }) => summary(ports.courier, sessionID),
    tree: ({ sessionID }) => panel(ports.courier, sessionID),
    stop: async ({ sessionID, by }, { error }) => {
      try {
        const { stopped, cancelled } = await stop(ports, by, { sessionID })
        return { stopped: stopped.map(({ sessionID, title, outcome }) => ({ sessionID, title, outcome })), cancelled: cancelled.length }
      } catch (cause) {
        return error("refused", refused(cause), {})
      }
    },
    cleanup: async ({ sessionID, by }, { error }) => {
      try {
        return await forget(ports, by, sessionID)
      } catch (cause) {
        return error("refused", refused(cause), {})
      }
    },
  })
}

/**
 * Forgets a session OpenCode no longer knows as courier_cleanup called from its own parent, once `by` is found above it,
 * as courier_stop checks. A session OpenCode still has, or cannot say it lost, is refused: forgetting it loses its report.
 */
async function forget(ports: StopPorts, by: string, sessionID: string): Promise<Forgotten> {
  const chain = await childStore(ports.courier.storage).lineage(sessionID)
  if (!chain.length) throw new Error(`${sessionID} was not started with courier_spawn, so there is nothing to forget.`)
  if (!chain.some((entry) => entry.parentID === by))
    throw new Error(`${by} is not above ${sessionID}: only a session above it, in the line of sessions that started it with courier_spawn, can forget it.`)
  const known = await ports.courier.session.get({ sessionID }).then(
    () => `${sessionID} is still known to OpenCode: only a gone session is forgotten here.`,
    (error: unknown) => (isNotFound(error) ? undefined : describeFailure("session.get", error).message),
  )
  if (known) throw new Error(known)
  const result = await cleanup(ports.cleanup, chain[0]!.parentID, { sessionID })
  return result.outcome === "kept" ? { outcome: "kept", reason: result.reason } : { outcome: result.outcome }
}
