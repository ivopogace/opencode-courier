import type { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createResource, createSignal, For, onCleanup, Show, type Accessor } from "solid-js"
import { treeRpc, type Row, type Stopped, type Summary, type Tree, type Wait } from "./rpc.js"

type Context = Plugin.Context
type Location = ReturnType<Context["data"]["location"]["default"]>
type Courier = ReturnType<typeof courierOf>["courier"]

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

/** The panel also follows each session's tool calls, cost and title, which its rows show. */
const PANEL_CHANGES = new Set<string>([
  ...CHANGES,
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.usage.updated",
  "session.renamed",
])

/** How long after the first of a burst of changes the entry asks the server again. */
export const SETTLE_MS = 250

/** The name of the tree panel in the `session.panel` slot. */
export const PANEL = "courier-tree"

/** How often the panel redraws its running times and how long ago each last tool call was. */
export const TICK_MS = 1000

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

/** A span of time, coarsest first: "45s", "3m 05s", "2h 07m". */
export function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const pad = (value: number) => String(value).padStart(2, "0")
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor(seconds / 60) % 60)}m`
}

/** How many of a session's children have reported, out of those it started, among the rows read. */
export function parts(rows: ReadonlyArray<Row>, parentID: string) {
  const children = rows.filter((row) => row.parentID === parentID)
  return { reported: children.filter((row) => row.report?.state === "reported").length, started: children.length }
}

/** A bar of parts reported, `width` cells wide: "[████░░░░░░] 2/5 reported". */
export function bar({ reported, started }: { reported: number; started: number }, width = 10) {
  const filled = started ? Math.round((reported / started) * width) : 0
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${reported}/${started} reported`
}

/** What a paused session waits on, such as "asks permission: shell echo hi". */
export function waitLine(wait: Wait) {
  return wait.type === "permission" ? `asks permission: ${[wait.action, ...wait.resources].join(" ")}` : `asks: ${wait.question}`
}

/** What a row's session is doing, its report and its group standing: "idle · reported done · group pair held". */
export function statusLine(row: Row) {
  const state =
    row.state === "waiting"
      ? "waiting on you"
      : row.state === "idle" && (row.outcome === "failed" || row.outcome === "interrupted")
        ? row.outcome
        : row.state
  const report = !row.report
    ? ""
    : row.report.state === "owed"
      ? "owes a report"
      : row.report.state === "ended"
        ? "ended without a report"
        : `reported${row.report.status ? ` ${row.report.status}` : ""}`
  return [state, report, row.group ? `group ${row.group.name} ${row.group.standing}` : "", row.isolated ? "isolated" : ""].filter(Boolean).join(" · ")
}

/** A leaf's activity: how long it has run, its last tool call and how long ago, and its cost. */
export function activityLine(row: Row, now: number) {
  return [
    `ran ${duration((row.idle ?? now) - row.created)}`,
    row.tool ? `last ${row.tool.name} ${duration(now - row.tool.at)} ago` : "no tool call yet",
    row.cost !== undefined ? `$${row.cost.toFixed(2)}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

/** The lines a row shows under its title: an orchestrator's bar, a paused session's requests, or else a leaf's activity. */
export function detailLines(row: Row, rows: ReadonlyArray<Row>, now: number) {
  const started = parts(rows, row.sessionID)
  return [
    ...(started.started ? [bar(started)] : []),
    ...(row.waits.length ? row.waits.map(waitLine) : started.started ? [] : [activityLine(row, now)]),
  ]
}

/** The RPC client and where to ask it about a session: where it runs, which has the plugin loaded. */
function courierOf(ctx: Context) {
  const courier = ctx.client.rpc(treeRpc)
  // A request with no location would go to the server's default.
  const location = (sessionID: string): Location => ctx.data.session.get(sessionID)?.location ?? ctx.location ?? ctx.data.location.default()
  return { courier, location }
}

/** A counter bumped once `SETTLE_MS` after the first of a burst of the `types` of events, and its cleanup. */
function changes(ctx: Context, types: ReadonlySet<string>) {
  const [changed, setChanged] = createSignal(0)
  let settling: ReturnType<typeof setTimeout> | undefined
  const unlisten = ctx.data.listen(({ details }) => {
    if (!types.has(details.type) || settling) return
    settling = setTimeout(() => {
      settling = undefined
      setChanged((count) => count + 1)
    }, SETTLE_MS)
  })
  return [
    changed,
    () => {
      clearTimeout(settling)
      unlisten()
    },
  ] as const
}

/** Why a call failed, from an RPC error or anything thrown. */
const reason = (error: unknown) => (error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String(error.message) : String(error))

/**
 * Adds the tree's entry to the prompt's footer: what the sessions started under the open session are doing, asked
 * of the server's RPC and asked again after each change. It shows nothing on the home screen, which has no session.
 */
export function addTreeStatus(ctx: Context) {
  const { courier, location } = courierOf(ctx)
  const [changed, stopListening] = changes(ctx, CHANGES)
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
    stopListening()
    release()
  }
}

/** How many sessions a stop of `row` reaches: it and those under it, among the rows read. */
function reach(rows: ReadonlyArray<Row>, sessionID: string): number {
  return 1 + rows.filter((row) => row.parentID === sessionID).reduce((total, row) => total + reach(rows, row.sessionID), 0)
}

/** The toast after a stop: how many sessions were interrupted, and how many scheduled messages were cancelled. */
export function stoppedLine({ stopped, cancelled }: Stopped) {
  const interrupted = stopped.filter((one) => one.outcome === "interrupted").length
  const failed = stopped.filter((one) => one.outcome === "failed").length
  return [
    `Stopped ${stopped.length} session${stopped.length === 1 ? "" : "s"}: ${interrupted} interrupted`,
    failed ? `${failed} failed to stop` : "",
    cancelled ? `${cancelled} scheduled message${cancelled === 1 ? "" : "s"} cancelled` : "",
  ]
    .filter(Boolean)
    .join(", ")
}

/**
 * Asks the person to confirm, then stops `target` and everything under it through courier_stop's path, as `by`, a
 * session above it, would; says what happened in a toast. False when the person did not confirm.
 */
async function confirmStop(ctx: Context, courier: Courier, location: (sessionID: string) => Location, by: string, target: { sessionID: string; title: string; under: number }) {
  const confirmed = await ctx.ui.dialog.confirm({
    title: "Stop session",
    message: `Stop "${target.title}" (${target.sessionID})${target.under ? ` and the ${target.under} session${target.under === 1 ? "" : "s"} under it` : ""}? Their turns are interrupted and their scheduled messages cancelled, as courier_stop does.`,
    label: { confirm: "Stop", cancel: "Keep running" },
  })
  if (!confirmed) return false
  try {
    const result = await courier.stop({ sessionID: target.sessionID, by }, { location: location(by) })
    ctx.ui.toast.show({ title: "courier", message: stoppedLine(result), variant: "success" })
  } catch (error) {
    ctx.ui.toast.show({ title: "courier stop", message: reason(error), variant: "error" })
  }
  return true
}

/** The tree panel: the sessions under the panel's session, one row each, with the keys to move, open and stop. */
function TreePanel(props: { ctx: Context; input: PanelInput; courier: Courier; location: (sessionID: string) => Location; changed: Accessor<number> }) {
  const { ctx, input, courier, location } = props
  const theme = ctx.theme
  const [read, { refetch }] = createResource(
    () => ({ sessionID: input.sessionID, changed: props.changed() }),
    ({ sessionID }): Promise<{ sessionID: string; tree?: Tree; error?: string }> =>
      courier.tree({ sessionID }, { location: location(sessionID) }).then(
        (tree) => ({ sessionID, tree }),
        (error: unknown) => ({ sessionID, error: reason(error) }),
      ),
  )
  const latest = () => (read.state === "ready" || read.state === "refreshing" ? read.latest : undefined)
  const rows = (): ReadonlyArray<Row> => latest()?.tree?.rows ?? []
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), TICK_MS)
  onCleanup(() => clearInterval(tick))
  const [selected, setSelected] = createSignal(0)
  const current = () => rows()[Math.min(selected(), rows().length - 1)]
  let scroll: ScrollBoxRenderable | undefined
  createEffect(() => {
    const index = Math.min(selected(), rows().length - 1)
    if (index >= 0) scroll?.scrollChildIntoView(`courier-row-${index}`)
  })
  const move = (by: number) => setSelected((index) => Math.max(0, Math.min(rows().length - 1, Math.min(index, rows().length - 1) + by)))
  const open = () => {
    const row = current()
    if (row) ctx.ui.router.navigate({ type: "session", sessionID: row.sessionID })
  }
  const stopSelected = () => {
    const row = current()
    if (row) void confirmStop(ctx, courier, location, input.sessionID, { sessionID: row.sessionID, title: row.title, under: reach(rows(), row.sessionID) - 1 })
  }
  ctx.keymap.layer(() => ({
    priority: 10,
    commands: [
      { bind: "up", title: "Previous session", group: "Courier", run: () => move(-1) },
      { bind: "k", title: "Previous session", group: "Courier", run: () => move(-1) },
      { bind: "down", title: "Next session", group: "Courier", run: () => move(1) },
      { bind: "j", title: "Next session", group: "Courier", run: () => move(1) },
      { bind: "return", title: "Open session", group: "Courier", run: open },
      { bind: "s", title: "Stop session and those under it", group: "Courier", run: stopSelected },
      { bind: "r", title: "Refresh", group: "Courier", run: () => void refetch() },
      { bind: "f", title: "Toggle fullscreen", group: "Courier", run: () => input.toggleFullscreen() },
      { bind: "q", title: "Close courier tree", group: "Courier", run: () => input.close() },
    ],
  }))
  const root = () => parts(rows(), input.sessionID)
  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" flexShrink={0} gap={2}>
        <text fg={theme.text.base} wrapMode="none">
          courier tree
        </text>
        <Show when={root().started}>
          <text fg={theme.text.muted} wrapMode="none">
            {bar(root())}
          </text>
        </Show>
        <Show when={latest()?.tree?.truncated}>
          <text fg={theme.text.feedback.warning.base} wrapMode="none">
            first {latest()?.tree?.truncated} shown
          </text>
        </Show>
      </box>
      <Show when={latest()?.error}>
        <text fg={theme.text.feedback.error.base}>courier RPC failed: {latest()?.error}</text>
      </Show>
      <Show when={latest()?.tree && !rows().length}>
        <text fg={theme.text.muted}>No session started with courier_spawn under this one.</text>
      </Show>
      <scrollbox ref={(value: ScrollBoxRenderable) => (scroll = value)} flexGrow={1}>
        <For each={rows()}>
          {(row, index) => {
            const chosen = () => index() === Math.min(selected(), rows().length - 1)
            const indent = "  ".repeat(row.depth - 1)
            return (
              <box id={`courier-row-${index()}`} flexDirection="column" flexShrink={0} backgroundColor={chosen() && input.focused ? theme.background.raised.high : undefined}>
                <text fg={row.state === "waiting" ? theme.text.feedback.warning.base : row.state === "gone" ? theme.text.muted : theme.text.base} wrapMode="none">
                  {indent}
                  {chosen() ? "▸ " : "  "}
                  {row.title}
                  {"  "}
                  <span style={{ fg: theme.text.muted }}>{statusLine(row)}</span>
                </text>
                <For each={detailLines(row, rows(), now())}>
                  {(line) => (
                    <text fg={theme.text.muted} wrapMode="none">
                      {indent}
                      {"    "}
                      {line}
                    </text>
                  )}
                </For>
              </box>
            )
          }}
        </For>
      </scrollbox>
      <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
        ↑↓ select · enter open · s stop · r refresh · f fullscreen · q close
      </text>
    </box>
  )
}

/** The usage the `/courier` command shows for an input it does not know. */
export const USAGE = "/courier tree opens the session tree; /courier stop [session] stops a session and those under it"

/**
 * Adds the tree panel to the `session.panel` slot, opened by `/courier tree` or the command palette, and `/courier
 * stop <session>`, which stops a session under the open one after the person confirms.
 */
export function addTreePanel(ctx: Context) {
  const { courier, location } = courierOf(ctx)
  const [changed, stopListening] = changes(ctx, PANEL_CHANGES)
  const release = ctx.ui.slot({
    append: "session.panel",
    render: (input) => (
      <Show when={input.name === PANEL}>
        <TreePanel ctx={ctx} input={input} courier={courier} location={location} changed={changed} />
      </Show>
    ),
  })
  const openPanel = () => {
    if (!ctx.ui.panel.open(PANEL)) ctx.ui.toast.show({ title: "courier", message: "Open a session first", variant: "warning" })
  }
  const stopUnder = async (target: string) => {
    const route = ctx.ui.router.current()
    if (route.type !== "session") return ctx.ui.toast.show({ title: "courier", message: "Open a session first", variant: "warning" })
    const rows = await courier.tree({ sessionID: route.sessionID }, { location: location(route.sessionID) }).then(
      (tree) => tree.rows,
      (): Row[] => [],
    )
    const sessionID =
      target ||
      (await ctx.ui.dialog.select({
        title: "Stop which session?",
        options: rows.map((row) => ({ title: row.title, value: row.sessionID, description: `${row.sessionID} · ${statusLine(row)}` })),
      }))
    if (!sessionID) return
    const row = rows.find((one) => one.sessionID === sessionID)
    await confirmStop(ctx, courier, location, route.sessionID, { sessionID, title: row?.title ?? sessionID, under: row ? reach(rows, sessionID) - 1 : 0 })
  }
  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "courier.command",
        title: "Courier",
        description: USAGE,
        group: "Courier",
        slash: { name: "courier", arguments: true },
        run: async (input) => {
          const [verb = "tree", target = ""] = (input ?? "").trim().split(/\s+/).filter(Boolean)
          if (verb === "tree") return openPanel()
          if (verb === "stop") return stopUnder(target)
          ctx.ui.toast.show({ title: "courier", message: USAGE, variant: "warning" })
        },
      },
      { id: "courier.tree", title: "Courier session tree", group: "Courier", palette: true, run: openPanel },
    ],
  }))
  return () => {
    stopListening()
    release()
  }
}

/** The ids of the deliveries already notified, at most this many. */
const NOTIFIED_MAX = 500

/**
 * Draws the person's attention when reports arrive: a join group's reports, released to the session that started them,
 * and a child's report to its parent, with the `subagent_done` sound. Read from the courier's own delivery metadata.
 */
export function addTreeAttention(ctx: Context) {
  const notified = new Set<string>()
  const title = (sessionID: string) => ctx.data.session.get(sessionID)?.title
  return ctx.data.on("session.inbox.enqueued", (event) => {
    const { sessionID, inboxID, item } = event.data
    const metadata: Record<string, unknown> = item.type === "synthetic" ? (item.payload.metadata ?? {}) : {}
    if (metadata.source !== "courier" || notified.has(inboxID)) return
    const group = typeof metadata.group === "string" ? metadata.group : undefined
    const status = typeof metadata.status === "string" ? metadata.status : undefined
    const from = typeof metadata.from === "string" ? metadata.from : ""
    if (!group && !status) return
    notified.add(inboxID)
    if (notified.size > NOTIFIED_MAX) notified.delete(notified.values().next().value!)
    void (group
      ? ctx.attention.notify({
          title: title(sessionID),
          message: `Group ${group}: ${String(metadata.reports ?? "its")} report${metadata.reports === 1 ? "" : "s"} arrived`,
          notification: { when: "blurred" },
          sound: { name: "done", when: "always" },
        })
      : ctx.attention.notify({
          title: title(sessionID),
          message: `${title(from) ?? from} reported ${status}`,
          notification: false,
          sound: { name: "subagent_done", when: "always" },
        })
    ).catch(() => undefined)
  })
}
