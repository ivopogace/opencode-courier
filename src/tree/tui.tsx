import type { Plugin } from "@opencode/plugin/tui"
import { createResource, createSignal, Show } from "solid-js"
import { treeRpc, type Summary } from "./rpc.js"

/** The events after which a summary may read differently: a turn started or ended, a request or form, a session made or removed. */
const CHANGES = new Set<string>([
  "session.created",
  "session.deleted",
  "session.status",
  "session.idle",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.delivered",
  "session.synthetic",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
])

/** How long after the first of a burst of changes the entry asks the server again. */
export const SETTLE_MS = 250

/** The status entry's text, such as "courier 2 running · 1 waiting on you · group pair 1/2"; empty when there is nothing to show. */
export function summaryLine(summary: Summary) {
  const parts = [
    summary.running ? `${summary.running} running` : "",
    summary.waiting ? `${summary.waiting} waiting on you` : "",
    summary.idle ? `${summary.idle} idle` : "",
    ...summary.groups.map((group) => `group ${group.name} ${group.reported}/${group.members}`),
    summary.truncated ? `first ${summary.truncated} counted` : "",
  ].filter(Boolean)
  return parts.length ? `courier ${parts.join(" · ")}` : ""
}

/**
 * Adds the tree's entry to the prompt's footer: what the sessions started under the open session are doing, asked
 * of the server's RPC and asked again after each change. It shows nothing on the home screen, which has no session.
 */
export function addTreeStatus(ctx: Plugin.Context) {
  const courier = ctx.client.rpc(treeRpc)
  // Where the session runs, which has the plugin loaded; a request with no location would go to the server's default.
  const location = (sessionID: string) => ctx.data.session.get(sessionID)?.location ?? ctx.location ?? ctx.data.location.default()
  const [changed, setChanged] = createSignal(0)
  let settling: ReturnType<typeof setTimeout> | undefined
  const unlisten = ctx.data.listen(({ details }) => {
    if (!CHANGES.has(details.type) || settling) return
    settling = setTimeout(() => {
      settling = undefined
      setChanged((count) => count + 1)
    }, SETTLE_MS)
  })
  const release = ctx.ui.slot({
    append: "prompt.footer.status",
    render: (input) => {
      const [read] = createResource(
        () => (input.sessionID ? { sessionID: input.sessionID, changed: changed() } : undefined),
        ({ sessionID }) =>
          courier.summary({ sessionID }, { location: location(sessionID) }).then(
            (summary) => ({ sessionID, line: summaryLine(summary) }),
            // A server without the courier's RPC, or one that fails, leaves the entry empty rather than the footer noisy.
            () => ({ sessionID, line: "" }),
          ),
      )
      // The latest answer, but only for the session shown: another session's lingers while the new one is asked.
      const line = () => {
        // Before its first answer `latest` reads the resource, which would suspend an enclosing Suspense boundary.
        const latest = read.state === "ready" || read.state === "refreshing" ? read.latest : undefined
        return latest && latest.sessionID === input.sessionID ? latest.line : ""
      }
      return (
        <Show when={line()}>
          <text fg={ctx.theme.text.muted} wrapMode="none">
            {" "}
            {line()}
          </text>
        </Show>
      )
    },
  })
  return () => {
    clearTimeout(settling)
    unlisten()
    release()
  }
}
