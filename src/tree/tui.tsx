import type { Plugin } from "@opencode/plugin/tui"
import type { PanelInput, PanelPresentation } from "@opencode/plugin/tui/context"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createResource, createRoot, createSignal, For, on, onCleanup, onMount, Show, untrack, type Accessor } from "solid-js"
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

/** The panel's settle: each of its asks reads every row's messages, so a busy tree is asked at most once a second. */
export const PANEL_SETTLE_MS = 1000

/** The name of the tree panel in the `session.panel` slot. */
export const PANEL = "courier-tree"

/** How often the panel redraws its running times and how long ago each last tool call was. */
export const TICK_MS = 1000

/**
 * The status entry's text, such as "courier 1 waiting on you · 2 running · group pair 1/2"; empty when there is nothing to show.
 * Within `maxWidth` it keeps whole parts, most important first, and counts the groups it drops: "· +2 groups".
 */
export function summaryLine(summary: Summary, maxWidth = Infinity) {
  const groups = summary.groups.map((group) => `group ${group.name} ${group.reported}/${group.members}`)
  const parts = [
    summary.waiting ? `${summary.waiting} waiting on you` : "",
    summary.running ? `${summary.running} running` : "",
    ...groups,
    summary.idle ? `${summary.idle} idle` : "",
  ].filter(Boolean)
  if (!parts.length) return ""
  const line = (kept: number) => {
    const dropped = groups.filter((group) => parts.indexOf(group) >= kept).length
    return ["courier", parts.slice(0, kept).join(" · "), dropped ? `· +${counted(dropped, "group")}` : ""].filter(Boolean).join(" ")
  }
  for (let kept = parts.length; kept > 0; kept--) if (line(kept).length <= maxWidth) return line(kept)
  // Not even the first part fits with its "courier": it stays without, as the person must see that something waits.
  return parts[0]!
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
  return [stateWord(row), reportWords(row.report), row.group ? `group ${row.group.name} ${row.group.standing}` : "", row.isolated ? "isolated" : ""]
    .filter(Boolean)
    .join(" · ")
}

/** What a session does, an idle one whose last turn failed or was interrupted saying so. */
function stateWord(row: Row) {
  if (row.state === "waiting") return "waiting on you"
  if (row.state === "idle" && (row.outcome === "failed" || row.outcome === "interrupted")) return row.outcome
  return row.state
}

/** A session's report since its last prompt, in words; empty for one spawned before report notes were kept. */
function reportWords(report: Row["report"]) {
  if (!report) return ""
  if (report.state === "owed") return "owes a report"
  if (report.state === "ended") return "ended without a report"
  return ["reported", report.status].filter(Boolean).join(" ")
}

/** `count` and the noun, plural unless it is one: "1 session", "2 sessions". */
const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

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

/** The lines a row shows under its title: an orchestrator's bar, a paused session's requests, or else a live leaf's activity. */
export function detailLines(row: Row, rows: ReadonlyArray<Row>, now: number) {
  const started = parts(rows, row.sessionID)
  if (row.waits.length) return [...(started.started ? [bar(started)] : []), ...row.waits.map(waitLine)]
  if (started.started) return [bar(started)]
  return row.state === "gone" ? [] : [activityLine(row, now)]
}

/** The RPC client and where to ask it about a session: where it runs, which has the plugin loaded. */
function courierOf(ctx: Context) {
  const courier = ctx.client.rpc(treeRpc)
  // A request with no location would go to the server's default.
  const location = (sessionID: string): Location => ctx.data.session.get(sessionID)?.location ?? ctx.location ?? ctx.data.location.default()
  return { courier, location }
}

/** A counter bumped once `settle` ms after the first of a burst of the `types` of events, and its cleanup. */
function changes(ctx: Context, types: ReadonlySet<string>, settle: number) {
  const [changed, setChanged] = createSignal(0)
  let settling: ReturnType<typeof setTimeout> | undefined
  const unlisten = ctx.data.listen(({ details }) => {
    if (!types.has(details.type) || settling) return
    settling = setTimeout(() => {
      settling = undefined
      setChanged((count) => count + 1)
    }, settle)
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
function reason(error: unknown) {
  if (error instanceof Error) return error.message
  return typeof error === "object" && error && "message" in error ? String(error.message) : String(error)
}

/**
 * Adds the tree's entry to the prompt's footer: what the sessions under the open session do, asked of the RPC after each
 * change; nothing on the home screen. Clicked while some wait on the person, it calls `onWaiting` with the open session.
 */
export function addTreeStatus(ctx: Context, onWaiting?: (sessionID: string) => void) {
  const { courier, location } = courierOf(ctx)
  const [changed, stopListening] = changes(ctx, CHANGES, SETTLE_MS)
  const release = ctx.ui.slot({
    append: "prompt.footer.status",
    render: (input) => {
      const [read] = createResource(
        () => (input.sessionID ? { sessionID: input.sessionID, changed: changed() } : undefined),
        ({ sessionID }) =>
          courier.summary({ sessionID }, { location: location(sessionID) }).then(
            (summary) => ({ sessionID, summary, waiting: summary.waiting }),
            // A server without the courier's RPC, or one that fails, leaves the entry empty rather than the footer noisy.
            () => ({ sessionID, summary: undefined, waiting: 0 }),
          ),
      )
      // The latest answer, but only for the session shown: another session's lingers while the new one is asked.
      const shown = () => {
        // Before its first answer `latest` reads the resource, which would suspend an enclosing Suspense boundary.
        const latest = read.state === "ready" || read.state === "refreshing" ? read.latest : undefined
        return latest && latest.sessionID === input.sessionID ? latest : undefined
      }
      // The box's width, which is unknown until it is laid out: the text waits for it rather than flash clipped.
      const [width, setWidth] = createSignal(0)
      const present = () => (shown()?.summary ? summaryLine(shown()!.summary!) : "")
      // The leading space is the entry's own.
      const line = () => (width() && shown()?.summary ? summaryLine(shown()!.summary!, width() - 1) : "")
      const click = () => {
        const latest = shown()
        if (latest?.waiting) onWaiting?.(latest.sessionID)
      }
      return (
        <Show when={present()}>
          <box
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            onSizeChange={function () {
              // A box not laid out yet is 0 wide, which is no measure.
              if (this.width > 0) setWidth(this.width)
            }}
          >
            <text fg={ctx.theme.text.muted} wrapMode="none" onMouseUp={click}>
              {" "}
              {line()}
            </text>
          </box>
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
    `Stopped ${counted(stopped.length, "session")}: ${interrupted} interrupted`,
    failed ? `${failed} failed to stop` : "",
    cancelled ? `${counted(cancelled, "scheduled message")} cancelled` : "",
  ]
    .filter(Boolean)
    .join(", ")
}

/**
 * Asks the person to confirm, then stops `target` and everything under it through courier_stop's path, as `by`, a
 * session above it, would; says what happened in a toast. False when the person did not confirm.
 */
async function confirmStop(ctx: Context, courier: Courier, location: (sessionID: string) => Location, by: string, target: { sessionID: string; title: string; under: number }) {
  const under = target.under ? ` and the ${counted(target.under, "session")} under it` : ""
  const confirmed = await ctx.ui.dialog.confirm({
    title: "Stop session",
    message: `Stop "${target.title}" (${target.sessionID})${under}? Their turns are interrupted and their scheduled messages cancelled, as courier_stop does.`,
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

/** The host's command that gives the keyboard back to the prompt; a newly shown panel takes it. */
const FOCUS_PROMPT = "pane.focus.left"

/**
 * The panel following the person: the session whose tree it shows, the one it is open in (or goes `to` while it looks,
 * or is hidden in, with no tree there), how it was shown, whether it had the keyboard, and the root's tree last read.
 */
type Following = { root: string; at?: string; to?: string; presentation: PanelPresentation; focused: boolean; refocus?: boolean; tree?: Tree }

/** What a panel opened in a session shows: the tree it follows there, and whether to give the keyboard back to the prompt. */
type View = { root: string; tree?: Tree; refocus: boolean; note: (fields: Partial<Following>) => void }

/** The tree panel: the sessions under its root, one row each, the one on screen marked, with the keys to move, open and stop. */
function TreePanel(props: { ctx: Context; input: PanelInput; view: View; courier: Courier; location: (sessionID: string) => Location; changed: Accessor<number> }) {
  const { ctx, input, view, courier, location } = props
  const theme = ctx.theme
  const [read, { refetch }] = createResource(
    () => ({ sessionID: view.root, changed: props.changed() }),
    ({ sessionID }): Promise<{ sessionID: string; tree?: Tree; error?: string }> =>
      courier.tree({ sessionID }, { location: location(sessionID) }).then(
        (tree) => ({ sessionID, tree }),
        (error: unknown) => ({ sessionID, error: reason(error) }),
      ),
  )
  // Until the first answer, the tree last read for this root, so a panel reopened in another session is not blank.
  const latest = () => (read.state === "ready" || read.state === "refreshing" ? read.latest : view.tree && { sessionID: view.root, tree: view.tree })
  const rows = (): ReadonlyArray<Row> => latest()?.tree?.rows ?? []
  createEffect(() => {
    const tree = latest()?.tree
    if (tree) view.note({ tree })
  })
  createEffect(() => view.note({ presentation: input.presentation, focused: input.focused }))
  onMount(() => {
    if (!view.refocus) return
    const giveBack = setTimeout(() => ctx.keymap.dispatch(FOCUS_PROMPT))
    onCleanup(() => clearTimeout(giveBack))
  })
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), TICK_MS)
  onCleanup(() => clearInterval(tick))
  const [selectedID, setSelectedID] = createSignal<string>()
  let placed = false
  createEffect(() => {
    const found = placed ? undefined : rows().find((row) => row.sessionID === input.sessionID)
    if (!found) return
    placed = true
    setSelectedID(found.sessionID)
  })
  let at = 0
  const selected = createMemo(() => {
    const id = selectedID()
    const found = rows().findIndex((row) => row.sessionID === id)
    const index = found >= 0 ? found : Math.min(at, rows().length - 1)
    at = Math.max(index, 0)
    return index
  })
  // A selected session that is gone leaves the selection at its place; take the session now there.
  createEffect(() => {
    const row = rows()[selected()]
    if (row && row.sessionID !== selectedID()) setSelectedID(row.sessionID)
  })
  const current = () => rows()[selected()]
  let scroll: ScrollBoxRenderable | undefined
  createEffect(() => {
    if (selected() >= 0) scroll?.scrollChildIntoView(`courier-row-${selected()}`)
  })
  const move = (by: number) => {
    const next = rows()[Math.max(0, Math.min(rows().length - 1, selected() + by))]
    if (next) setSelectedID(next.sessionID)
  }
  const open = () => {
    const row = current()
    if (row) ctx.ui.router.navigate({ type: "session", sessionID: row.sessionID })
  }
  const stopSelected = () => {
    const row = current()
    if (row) void confirmStop(ctx, courier, location, view.root, { sessionID: row.sessionID, title: row.title, under: reach(rows(), row.sessionID) - 1 })
  }
  ctx.keymap.layer(() => ({
    priority: 10,
    enabled: () => input.focused,
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
  const root = () => parts(rows(), view.root)
  const rowColor = (row: Row) => {
    if (row.state === "waiting") return theme.text.feedback.warning.base
    return row.state === "gone" ? theme.text.muted : theme.text.base
  }
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
            {latest()?.tree?.truncated} older left out
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
            const chosen = () => index() === selected()
            const indent = "  ".repeat(row.depth - 1)
            return (
              <box id={`courier-row-${index()}`} flexDirection="column" flexShrink={0} backgroundColor={chosen() && input.focused ? theme.background.raised.high : undefined}>
                <text fg={rowColor(row)} wrapMode="none">
                  {indent}
                  {chosen() ? "▸ " : "  "}
                  {row.title}
                  {row.sessionID === input.sessionID ? " (on screen)" : ""}
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
 * Adds the tree panel to the `session.panel` slot, opened by `/courier tree` or the palette, which follows the person
 * between sessions until closed, and `/courier stop <session>`, which stops a session under the open one once confirmed.
 */
export function addTreePanel(ctx: Context) {
  const { courier, location } = courierOf(ctx)
  const [changed, stopListening] = changes(ctx, PANEL_CHANGES, PANEL_SETTLE_MS)
  let following: Following | undefined
  let attempt = 0
  const viewOf = (sessionID: string): View => {
    const here = following?.at === sessionID ? following : undefined
    const refocus = here?.refocus === true
    if (here) here.refocus = false
    return {
      root: here?.root ?? sessionID,
      tree: here?.tree,
      refocus,
      note: (fields) => {
        if (here && following === here) Object.assign(here, fields)
      },
    }
  }
  const release = ctx.ui.slot({
    append: "session.panel",
    render: (input) => (
      <Show when={input.name === PANEL}>
        <TreePanel ctx={ctx} input={input} view={viewOf(input.sessionID)} courier={courier} location={location} changed={changed} />
      </Show>
    ),
  })
  const show = (from: Following, at: string, root: string, tree: Tree | undefined) => {
    following = { ...from, root, at, to: undefined, tree, refocus: !from.focused }
    ctx.ui.panel.open(PANEL, { presentation: from.presentation })
  }
  const treeOf = (sessionID: string) => courier.tree({ sessionID }, { location: location(sessionID) }).catch(() => undefined)
  /** Reopens the panel in `sessionID`, which the person moved to while it was open; hidden there when it has no tree. */
  const follow = (from: Following, sessionID: string) => {
    const token = ++attempt
    const under = (tree: Tree | undefined) => tree?.rows.some((row) => row.sessionID === sessionID) === true
    Object.assign(from, { at: undefined, to: sessionID })
    if (sessionID === from.root || under(from.tree)) return show(from, sessionID, from.root, from.tree)
    void (async () => {
      const inside = await treeOf(from.root)
      const own = under(inside) ? undefined : await treeOf(sessionID)
      if (token !== attempt || following !== from) return
      if (under(inside)) show(from, sessionID, from.root, inside)
      else if (own?.rows.length) show(from, sessionID, sessionID, own)
    })()
  }
  /** Hides the panel on the home screen: it comes back in the next session with a tree. */
  const hide = (from: Following) => {
    ++attempt
    Object.assign(from, { at: undefined, to: undefined })
  }
  const stopFollowing = createRoot((dispose) => {
    createEffect(() => {
      const route = ctx.ui.router.current()
      const sessionID = route.type === "session" ? route.sessionID : undefined
      const shown = ctx.ui.panel.current()
      untrack(() => {
        if (!following || (shown && shown.sessionID === sessionID) || (!following.at && following.to === sessionID)) return
        // Closed where it was open, by q or the host: it stays closed.
        if (!shown && sessionID && following.at === sessionID) following = undefined
        else if (!sessionID) hide(following)
        else follow(following, sessionID)
      })
    })
    // Hidden in a session without a tree, it shows once that session starts one, leaving the keyboard to the prompt.
    createEffect(
      on(
        changed,
        () =>
          untrack(() => {
            const route = ctx.ui.router.current()
            if (!following || following.at || route.type !== "session" || following.to !== route.sessionID || ctx.ui.panel.current()) return
            following.focused = false
            follow(following, route.sessionID)
          }),
        { defer: true },
      ),
    )
    return dispose
  })
  const openPanel = () => {
    const route = ctx.ui.router.current()
    const before = following
    if (route.type === "session" && following?.at !== route.sessionID) following = { root: route.sessionID, at: route.sessionID, presentation: "panel", focused: true }
    if (ctx.ui.panel.open(PANEL)) return
    following = before
    ctx.ui.toast.show({ title: "courier", message: "Open a session first", variant: "warning" })
  }
  const stopUnder = async (target: string) => {
    const route = ctx.ui.router.current()
    if (route.type !== "session") return ctx.ui.toast.show({ title: "courier", message: "Open a session first", variant: "warning" })
    const read = await courier.tree({ sessionID: route.sessionID }, { location: location(route.sessionID) }).then(
      (tree) => ({ rows: tree.rows }),
      (error: unknown) => ({ rows: [] as Row[], error }),
    )
    const rows = read.rows
    if (!target && "error" in read) return ctx.ui.toast.show({ title: "courier stop", message: reason(read.error), variant: "error" })
    if (!target && !rows.length)
      return ctx.ui.toast.show({ title: "courier stop", message: "No session started with courier_spawn under this one.", variant: "warning" })
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
    stopFollowing()
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
    if (!group && ctx.data.session.get(from)?.parentID !== undefined) return
    notified.add(inboxID)
    if (notified.size > NOTIFIED_MAX) notified.delete(notified.values().next().value!)
    void (group
      ? ctx.attention.notify({
          title: title(sessionID),
          message: `Group ${group}: ${typeof metadata.reports === "number" ? counted(metadata.reports, "report") : "its reports"} arrived`,
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
