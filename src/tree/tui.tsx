import type { Plugin } from "@opencode/plugin/tui"
import type { PanelInput, PanelPresentation } from "@opencode/plugin/tui/context"
import { MouseButton, RGBA, Timeline, type EasingFunctions, type ScrollBoxRenderable } from "@opentui/core"
import { batch, createEffect, createMemo, createResource, createRoot, createSignal, For, Index, on, onCleanup, onMount, Show, untrack, type Accessor } from "solid-js"
import { art as artOf, cells, glyph, MASCOT_EVERY, type Cell, type MascotState, type Token } from "./mascot.js"
import { treeRpc, type Forgotten, type Row, type Stopped, type Summary, type Tree, type Wait } from "./rpc.js"

type Context = Plugin.Context
type Location = ReturnType<Context["data"]["location"]["default"]>
type Courier = ReturnType<typeof courierOf>["courier"]

export const CHANGES = new Set<string>([
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
  "session.archived",
  "session.unarchived",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
])

const PANEL_CHANGES = new Set<string>([
  ...CHANGES,
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.usage.updated",
  "session.renamed",
])

export const SETTLE_MS = 250

export const PANEL_SETTLE_MS = 1000

export const PANEL = "courier-tree"

export const TICK_MS = 1000

export const FRAME_MS = 90

export const FLASH_MS = 1500

export const BAR_MS = 450

export function animationsOn(options: Readonly<Record<string, unknown>> | undefined) {
  return options?.animations !== false
}

export type Tween = { readonly value: () => number; readonly done: () => boolean }

export type Motion = {
  readonly enabled: boolean
  readonly frame: Accessor<number>
  readonly animates: (when: Accessor<boolean>, every?: number) => void
  readonly tween: (from: number, to: number, duration: number, ease: EasingFunctions) => Tween
}

export function createMotion(enabled: boolean): Motion {
  const [frame, setFrame] = createSignal(0)
  const [keepers, setKeepers] = createSignal<ReadonlyArray<{ when: Accessor<boolean>; every: number }>>([])
  type Moving = Tween & { step: (ms: number) => void }
  const [moving, setMoving] = createSignal<ReadonlyArray<Moving>>([])
  const cadence = createMemo(() => {
    if (!enabled) return undefined
    if (moving().length) return 1
    const wanted = keepers().filter((one) => one.when())
    return wanted.length ? Math.min(...wanted.map((one) => one.every)) : undefined
  })
  createEffect(() => {
    const every = cadence()
    if (every === undefined) return
    const timer = setInterval(
      () =>
        batch(() => {
          const now = untrack(moving)
          for (const one of now) one.step(FRAME_MS * every)
          setFrame((count) => count + every)
          const left = now.filter((one) => !one.done())
          if (left.length !== now.length) setMoving(left)
        }),
      FRAME_MS * every,
    )
    onCleanup(() => clearInterval(timer))
  })
  const tween = (from: number, to: number, duration: number, ease: EasingFunctions): Tween => {
    if (!enabled || from === to) return { value: () => to, done: () => true }
    const target = { value: from }
    const timeline = new Timeline({ duration, autoplay: false })
    timeline.add(target, { duration, ease, value: to })
    timeline.play()
    let elapsed = 0
    const one: Moving = {
      value: () => {
        frame()
        return target.value
      },
      done: () => {
        frame()
        return elapsed >= duration
      },
      step: (ms) => {
        elapsed += ms
        timeline.update(ms)
      },
    }
    setMoving((all) => [...all, one])
    return one
  }
  return { enabled, frame, animates: (when, every = 1) => setKeepers((all) => [...all, { when, every }]), tween }
}

export function createFlashes(motion: Motion, rows: Accessor<ReadonlyArray<Row>>) {
  const [flashes, setFlashes] = createSignal<ReadonlyMap<string, Tween>>(new Map())
  let seen: ReadonlyMap<string, string | undefined> | undefined
  createEffect(() => {
    const read = rows()
    const before = seen
    seen = new Map(read.map((row) => [row.sessionID, row.report?.state]))
    if (!before || !motion.enabled) return
    const arrived = read.filter((row) => row.report?.state === "reported" && before.has(row.sessionID) && before.get(row.sessionID) !== "reported")
    if (!arrived.length) return
    const next = new Map([...untrack(flashes)].filter(([, one]) => !untrack(one.done)))
    for (const row of arrived) next.set(row.sessionID, motion.tween(1, 0, FLASH_MS, "outQuad"))
    setFlashes(next)
  })
  const strength = (sessionID: string) => {
    const one = flashes().get(sessionID)
    return one && !one.done() ? one.value() : 0
  }
  const reported = () => [...flashes().values()].some((one) => !one.done())
  return { strength, reported }
}

export function createBarFill(motion: Motion, counts: Accessor<{ reported: number; started: number }>) {
  const target = createMemo(() => filledCells(counts()))
  const [easing, setEasing] = createSignal<Tween>()
  let last: { cells: number; shown: boolean } | undefined
  createEffect(() => {
    const cells = target()
    const shown = counts().started > 0
    if (last && cells !== last.cells) {
      const from = untrack(() => easing()?.value()) ?? last.cells
      setEasing(last.shown ? motion.tween(from, cells, BAR_MS, "outQuad") : undefined)
    }
    last = { cells, shown }
  })
  return () => easing()?.value() ?? target()
}

export function createSpawns(motion: Motion, rows: Accessor<ReadonlyArray<Row> | undefined>) {
  const [hold, setHold] = createSignal<Tween>()
  let seen: ReadonlySet<string> | undefined
  createEffect(() => {
    const read = rows()
    if (!read) return
    const before = seen
    seen = new Set(read.map((row) => row.sessionID))
    if (before && motion.enabled && read.some((row) => !before.has(row.sessionID))) setHold(motion.tween(1, 0, FLASH_MS, "linear"))
  })
  return () => {
    const one = hold()
    return one !== undefined && !one.done()
  }
}

export function mascotState(rows: ReadonlyArray<Row>, { top, reported = false, spawned = false }: { top?: Row; reported?: boolean; spawned?: boolean } = {}): MascotState {
  if (reported) return "report"
  if (spawned) return "spawn"
  const live = top ? [top, ...rows] : rows
  if (live.some((row) => row.state === "waiting")) return "waiting"
  if (live.some((row) => row.state === "stalled")) return "stalled"
  if (live.some((row) => row.state === "running")) return "running"
  return rows.length && rows.every((row) => row.state === "gone") ? "gone" : "idle"
}

export function countsLine(rows: ReadonlyArray<Row>) {
  const count = (state: Row["state"]) => rows.filter((row) => row.state === state).length
  return [
    count("waiting") ? `${count("waiting")} waiting on you` : "",
    count("stalled") ? `${count("stalled")} stalled` : "",
    count("running") ? `${count("running")} running` : "",
    count("idle") ? `${count("idle")} idle` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

export const GLYPH_ROWS = 12
export const GLYPH_COLUMNS = 54

export const ART_ROWS = 14

export const BELOW_ROWS = 10

export function blend(tint: RGBA, rest: RGBA, amount: number) {
  const mix = (a: number, b: number) => b + (a - b) * amount
  return RGBA.fromValues(mix(tint.r, rest.r), mix(tint.g, rest.g), mix(tint.b, rest.b), mix(tint.a, rest.a))
}

export function summaryLine(summary: Summary, maxWidth = Infinity) {
  const groups = summary.groups.map((group) => `group ${group.name} ${group.reported}/${group.members}`)
  const parts = [
    summary.waiting ? `${summary.waiting} waiting on you` : "",
    summary.stalled ? `${summary.stalled} stalled` : "",
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
  return parts[0]!
}

export function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const pad = (value: number) => String(value).padStart(2, "0")
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor(seconds / 60) % 60)}m`
}

export function parts(rows: ReadonlyArray<Row>, parentID: string) {
  const children = rows.filter((row) => row.parentID === parentID && !row.subagent)
  return { reported: children.filter((row) => row.report?.state === "reported").length, started: children.length }
}

export function filledCells({ reported, started }: { reported: number; started: number }, width = 10) {
  return started ? Math.round((reported / started) * width) : 0
}

export function bar(counts: { reported: number; started: number }, width = 10, filled = filledCells(counts, width)) {
  const cells = Math.max(0, Math.min(width, Math.round(filled)))
  return `[${"█".repeat(cells)}${"░".repeat(width - cells)}] ${counts.reported}/${counts.started} reported`
}

export function waitLine(wait: Wait) {
  if (wait.type === "permission") return `asks permission: ${[wait.action, ...wait.resources].join(" ")}`
  return wait.type === "form" ? `shows a form: ${wait.title}` : `asks: ${wait.question}`
}

export function statusLine(row: Row, now = Date.now()) {
  return statusParts(row, now)
    .map((part) => part.text)
    .join(" · ")
}

export function statusParts(row: Row, now = Date.now()) {
  const parts: Array<{ text: string; kind: "state" | "report" | "plain" }> = [
    { text: stateWord(row, now), kind: "state" },
    { text: reportWords(row.report, row.stopped), kind: "report" },
    { text: row.group ? `group ${row.group.name} ${row.group.standing}` : "", kind: "plain" },
    { text: row.isolated ? "isolated" : "", kind: "plain" },
    { text: row.native ? "native" : "", kind: "plain" },
    { text: row.subagent ? "subagent" : "", kind: "plain" },
    { text: row.model ?? "", kind: "plain" },
  ]
  return parts.filter((part) => part.text)
}

type Feedback<Color> = { text: { feedback: Record<"error" | "warning" | "success" | "info", { base: Color }> } }

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function rowMark<Color>(row: Row, theme: Feedback<Color>, frame?: number): { mark: string; color: Color | undefined } {
  const { error, warning, success, info } = theme.text.feedback
  if (row.state === "gone") return { mark: " ", color: undefined }
  if (row.state === "stalled") return { mark: "!", color: error.base }
  if (row.state === "waiting") return { mark: "●", color: warning.base }
  if (row.state === "running") return { mark: frame === undefined ? "•" : SPINNER[frame % SPINNER.length]!, color: info.base }
  if (!row.stopped && (row.outcome === "failed" || row.outcome === "interrupted")) return { mark: "✗", color: error.base }
  if (row.report?.state === "reported") return { mark: "✓", color: success.base }
  return { mark: " ", color: undefined }
}

function resumeTime(at: number, now: number) {
  const time = new Date(at)
  const pad = (value: number) => String(value).padStart(2, "0")
  const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}`
  return time.toDateString() === new Date(now).toDateString() ? clock : `${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${clock}`
}

function stateWord(row: Row, now: number) {
  if (row.state === "waiting") return "waiting on you"
  if (row.state === "stalled") return "stalled"
  if (row.state === "idle" && row.stopped) return "stopped"
  if (row.state === "idle" && row.outcome === "failed" && row.resumes !== undefined && row.resumes > now) return `limit, resumes ${resumeTime(row.resumes, now)}`
  if (row.state === "idle" && (row.outcome === "failed" || row.outcome === "interrupted")) return row.outcome
  return row.state
}

function reportWords(report: Row["report"], stopped?: boolean) {
  if (!report) return ""
  if (report.state === "owed") return "owes a report"
  if (report.state === "ended") return stopped ? "" : "ended without a report"
  return ["reported", report.status].filter(Boolean).join(" ")
}

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

export const CONTEXT_WARN = 0.8

export function activityParts(row: Row, now: number) {
  return [
    `ran ${duration((row.idle ?? now) - row.created)}`,
    row.tool ? `last ${row.tool.name} ${duration(now - row.tool.at)} ago` : "no tool call yet",
    row.context !== undefined ? `ctx ${Math.round(row.context * 100)}%` : "",
    row.cost !== undefined ? `$${row.cost.toFixed(2)}` : "",
  ].filter(Boolean)
}

export const activityLine = (row: Row, now: number) => activityParts(row, now).join(" · ")

export function stalledLine(since: number, now: number) {
  return `a message waits in its inbox since ${duration(now - since)}, woken again in vain`
}

export function detailLines(row: Row, rows: ReadonlyArray<Row>, now: number) {
  const started = parts(rows, row.sessionID)
  if (row.waits.length) return [...(started.started ? [bar(started)] : []), ...row.waits.map(waitLine)]
  if (row.stalled !== undefined) return [...(started.started ? [bar(started)] : []), stalledLine(row.stalled, now)]
  if (started.started) return [bar(started)]
  return row.state === "gone" ? [] : [activityLine(row, now)]
}

export function guides(rows: ReadonlyArray<Row>, base: number) {
  const byID = new Map(rows.map((row) => [row.sessionID, row]))
  const later = new Set<string>()
  const parents = new Set<string>()
  rows.forEach((row, index) => {
    if (rows.slice(index + 1).some((next) => next.parentID === row.parentID)) later.add(row.sessionID)
    parents.add(row.parentID)
  })
  const above = (row: Row): Row[] => {
    const parent = row.depth > base + 1 ? byID.get(row.parentID) : undefined
    return parent ? [...above(parent), parent] : []
  }
  const line = (row: Row) => (later.has(row.sessionID) ? "│ " : "  ")
  const branch = (row: Row) => (later.has(row.sessionID) ? "├ " : "└ ")
  return new Map(
    rows.map((row) => {
      const through = above(row).map(line).join("")
      const below = row.depth > base
      const down = parents.has(row.sessionID) ? "│ " : "  "
      return [row.sessionID, { row: through + (below ? branch(row) : ""), detail: through + (below ? line(row) : "") + down }]
    }),
  )
}

function courierOf(ctx: Context) {
  const courier = ctx.client.rpc(treeRpc)
  const location = (sessionID: string): Location => ctx.data.session.get(sessionID)?.location ?? ctx.location ?? ctx.data.location.default()
  return { courier, location }
}

export const REREAD_MS = 15_000

function changes(ctx: Context, types: ReadonlySet<string>, settle: number) {
  const [changed, setChanged] = createSignal(0)
  const reread = setInterval(() => setChanged((count) => count + 1), REREAD_MS)
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
      clearInterval(reread)
      unlisten()
    },
  ] as const
}

function reason(error: unknown) {
  if (error instanceof Error) return error.message
  return typeof error === "object" && error && "message" in error ? String(error.message) : String(error)
}

export const UNAVAILABLE_MS = 1000
const UNAVAILABLE_TRIES = 10

async function whenLoaded<T>(call: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await call()
    } catch (error) {
      const unavailable = typeof error === "object" && error !== null && "type" in error && error.type === "rpc.unavailable"
      if (!unavailable || tries >= UNAVAILABLE_TRIES) throw error
      await new Promise((resolve) => setTimeout(resolve, UNAVAILABLE_MS))
    }
  }
}

export function addTreeStatus(ctx: Context, onWaiting?: (sessionID: string) => void) {
  const { courier, location } = courierOf(ctx)
  const [changed, stopListening] = changes(ctx, CHANGES, SETTLE_MS)
  const release = ctx.ui.slot({
    append: "prompt.footer.status",
    render: (input) => {
      const [read] = createResource(
        () => (input.sessionID ? { sessionID: input.sessionID, changed: changed() } : undefined),
        ({ sessionID }) =>
          whenLoaded(() => courier.summary({ sessionID }, { location: location(sessionID) })).then(
            (summary) => ({ sessionID, summary, waiting: summary.waiting }),
            () => ({ sessionID, summary: undefined, waiting: 0 }),
          ),
      )
      const shown = () => {
        const latest = read.state === "ready" || read.state === "refreshing" ? read.latest : undefined
        return latest && latest.sessionID === input.sessionID ? latest : undefined
      }
      const [width, setWidth] = createSignal(0)
      const present = () => (shown()?.summary ? summaryLine(shown()!.summary!) : "")
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

function reach(rows: ReadonlyArray<Row>, sessionID: string): number {
  return 1 + rows.filter((row) => row.parentID === sessionID).reduce((total, row) => total + reach(rows, row.sessionID), 0)
}

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

export function forgottenLine(title: string, result: Forgotten) {
  const name = `"${oneLine(title)}"`
  if (result.outcome === "kept") return `Kept ${name} and its worktree: ${result.reason}`
  if (result.outcome === "removed") return `Forgot ${name} and removed its worktree`
  return result.outcome === "gone" ? `Forgot ${name}; its worktree was already gone` : `Forgot ${name}`
}

async function confirmForget(
  ctx: Context,
  courier: Courier,
  location: (sessionID: string) => Location,
  by: string,
  target: { sessionID: string; title: string; isolated: boolean },
  done: () => void,
) {
  const what = target.isolated
    ? "Its worktree is removed unless it has uncommitted changes or commits found nowhere else."
    : "It leaves this tree and courier_children."
  const confirmed = await ctx.ui.dialog.confirm({
    title: "Forget session",
    message: `Forget "${oneLine(target.title)}" (${target.sessionID})? ${what}`,
    label: { confirm: "Forget", cancel: "Keep" },
  })
  if (!confirmed) return false
  try {
    const result = await courier.cleanup({ sessionID: target.sessionID, by }, { location: location(by) })
    ctx.ui.toast.show({ title: "courier", message: forgottenLine(target.title, result), variant: result.outcome === "kept" ? "warning" : "success" })
    if (result.outcome !== "kept") done()
  } catch (error) {
    ctx.ui.toast.show({ title: "courier forget", message: reason(error), variant: "error" })
  }
  return true
}

const FOCUS_PROMPT = "pane.focus.left"

const SPLIT_WIDTH = 108

type Following = { root: string; at?: string; to?: string; presentation: PanelPresentation; focused: boolean; refocus?: boolean; tree?: Tree }

const oneLine = (title: string) => title.replace(/[\r\n]+/g, " ")

type View = { root: string; tree?: Tree; refocus: boolean; note: (fields: Partial<Following>) => void }

export const digbyColours = (theme: Context["theme"]): Record<Token, RGBA> => ({
  b: theme.text.base,
  k: theme.background.base,
  g: theme.background.raised.max,
  m: theme.text.muted,
  a: theme.text.action.primary.selected,
  w: theme.text.feedback.warning.base,
  e: theme.text.feedback.error.base,
  s: theme.text.feedback.success.base,
})

const DIGBY_UNDER = RGBA.fromValues(0, 0, 0, 0)

export function restBackground(theme: Context["theme"], { selected, hovered }: { selected: boolean; hovered: boolean }) {
  if (selected) return theme.background.raised.high
  return hovered ? theme.background.raised.base : undefined
}

function TreePanel(props: {
  ctx: Context
  input: PanelInput
  view: View
  courier: Courier
  location: (sessionID: string) => Location
  changed: Accessor<number>
  animations: boolean
}) {
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
  const latest = () => (read.state === "ready" || read.state === "refreshing" ? read.latest : view.tree && { sessionID: view.root, tree: view.tree })
  const rows = (): ReadonlyArray<Row> => latest()?.tree?.rows ?? []
  const top = () => latest()?.tree?.top
  const listed = (): ReadonlyArray<Row> => {
    const own = top()
    return own ? [own, ...rows()] : rows()
  }
  createEffect(() => {
    const tree = latest()?.tree
    if (tree) view.note({ tree })
  })
  createEffect(() => {
    const { presentation, focused } = input
    view.note(ctx.renderer.width >= SPLIT_WIDTH ? { presentation, focused } : { focused })
  })
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
    const found = placed ? undefined : listed().find((row) => row.sessionID === input.sessionID)
    if (!found) return
    placed = true
    setSelectedID(found.sessionID)
  })
  let at = 0
  const selected = createMemo(() => {
    const id = selectedID()
    const found = listed().findIndex((row) => row.sessionID === id)
    const index = found >= 0 ? found : Math.min(at, listed().length - 1)
    at = Math.max(index, 0)
    return index
  })
  createEffect(() => {
    const row = listed()[selected()]
    if (row && row.sessionID !== selectedID()) setSelectedID(row.sessionID)
  })
  const current = () => listed()[selected()]
  let scroll: ScrollBoxRenderable | undefined
  createEffect(() => {
    if (selected() >= 0) scroll?.scrollChildIntoView(`courier-row-${selected()}`)
  })
  const move = (by: number) => {
    const next = listed()[Math.max(0, Math.min(listed().length - 1, selected() + by))]
    if (next) setSelectedID(next.sessionID)
  }
  const openRow = (row: Row) => ctx.ui.router.navigate({ type: "session", sessionID: row.sessionID })
  const open = () => {
    const row = current()
    if (row) openRow(row)
  }
  const [hovered, setHovered] = createSignal<string>()
  createEffect(() => {
    const id = hovered()
    if (id !== undefined && !listed().some((row) => row.sessionID === id)) setHovered(undefined)
  })
  let pressed: string | undefined
  const click = (row: Row) => {
    setSelectedID(row.sessionID)
    openRow(row)
  }
  const ownRow = (row: Row, key: string) => {
    if (row.subagent) {
      ctx.ui.toast.show({ title: "courier", message: `${key} acts on a session started with courier_spawn; "${oneLine(row.title)}" is a subagent, stopped with the one above it.`, variant: "warning" })
      return true
    }
    if (row.sessionID !== view.root) return false
    ctx.ui.toast.show({ title: "courier", message: `${key} acts on a session under "${oneLine(row.title)}", the panel's own.`, variant: "warning" })
    return true
  }
  const stopSelected = () => {
    const row = current()
    if (row && !ownRow(row, "s")) void confirmStop(ctx, courier, location, view.root, { sessionID: row.sessionID, title: row.title, under: reach(rows(), row.sessionID) - 1 })
  }
  const forgetSelected = () => {
    const row = current()
    if (!row || ownRow(row, "x")) return
    if (row.state !== "gone")
      return ctx.ui.toast.show({ title: "courier", message: `x forgets only a gone session; "${oneLine(row.title)}" is ${row.state}.`, variant: "warning" })
    void confirmForget(ctx, courier, location, view.root, { sessionID: row.sessionID, title: row.title, isolated: row.isolated }, () => void refetch())
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
      { bind: "x", title: "Forget gone session", group: "Courier", run: forgetSelected },
      { bind: "r", title: "Refresh", group: "Courier", run: () => void refetch() },
      { bind: "f", title: "Toggle fullscreen", group: "Courier", run: () => input.toggleFullscreen() },
      { bind: "q", title: "Close courier tree", group: "Courier", run: () => input.close() },
    ],
  }))
  const root = () => parts(rows(), view.root)
  const motion = createMotion(props.animations)
  motion.animates(() => listed().some((row) => row.state === "running"))
  const flashes = createFlashes(motion, rows)
  const filled = createBarFill(motion, root)
  const frame = () => (motion.enabled ? motion.frame() : undefined)
  const spawned = createSpawns(motion, () => latest()?.tree?.rows)
  const [size, setSize] = createSignal({ width: 0, height: 0 })
  const height = () => size().height
  const empty = () => Boolean(latest()?.tree && !rows().length)
  const glyphShown = () => height() >= GLYPH_ROWS && size().width >= GLYPH_COLUMNS
  const artShown = () => empty() && height() >= ART_ROWS
  const [listHeight, setListHeight] = createSignal(0)
  const lines = (row: Row) => detailLines(row, row.depth ? rows() : [], now())
  const guided = createMemo(() => guides(listed(), top() ? 0 : 1))
  const treeLines = () => listed().reduce((count, row) => count + 1 + lines(row).length, 0)
  const belowShown = () => rows().length > 0 && listHeight() - treeLines() >= BELOW_ROWS
  const headerGlyph = () => glyphShown() && !artShown() && !belowShown()
  const mascot = createMemo(() => mascotState(rows(), { top: top(), reported: flashes.reported(), spawned: spawned() }))
  motion.animates(() => (glyphShown() || artShown() || belowShown()) && mascot() !== "gone", MASCOT_EVERY)
  const mascotFrame = () => (motion.enabled ? Math.floor(motion.frame() / MASCOT_EVERY) : undefined)
  const header = createMemo(() => cells(glyph(mascot(), mascotFrame())))
  const art = createMemo(() => artOf(mascot(), mascotFrame()))
  const tokens = digbyColours(theme)
  const drawn = (line: Accessor<ReadonlyArray<Cell>>) => (
    <text wrapMode="none" flexShrink={0}>
      <Index each={line()}>{(one) => <span style={{ fg: one().fg && tokens[one().fg!], bg: one().bg ? tokens[one().bg!] : DIGBY_UNDER }}>{one().char}</span>}</Index>
    </text>
  )
  const rowBackground = (row: Row, chosen: boolean) => {
    const rest = restBackground(theme, { selected: chosen && input.focused, hovered: hovered() === row.sessionID })
    const strength = flashes.strength(row.sessionID)
    return strength > 0 ? blend(theme.background.feedback.success.base, rest ?? theme.background.base, strength) : rest
  }
  const rowColor = (row: Row) => {
    if (row.state === "stalled") return theme.text.feedback.error.base
    if (row.state === "waiting") return theme.text.feedback.warning.base
    return row.state === "gone" ? theme.text.muted : theme.text.base
  }
  const partColor = (row: Row, kind: "state" | "report" | "plain") => {
    const marked = rowMark(row, theme)
    if (kind === "state" && row.state === "running") return marked.color
    if (kind === "report" && row.report?.state === "reported") return theme.text.feedback.success.base
    return theme.text.muted
  }
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      paddingLeft={1}
      paddingRight={1}
      onSizeChange={function () {
        setSize({ width: this.width, height: this.height })
      }}
      onMouseDrag={() => (pressed = undefined)}
    >
      <box flexDirection="row" flexShrink={0} gap={2}>
        <Show when={headerGlyph()}>{drawn(() => header()[0]!)}</Show>
        <text fg={tokens.a} wrapMode="none">
          courier tree
        </text>
        <Show when={root().started}>
          <text fg={tokens.a} wrapMode="none">
            {bar(root(), 10, filled())}
          </text>
        </Show>
        <Show when={latest()?.tree?.truncated}>
          <text fg={theme.text.feedback.warning.base} wrapMode="none">
            {latest()?.tree?.truncated} older left out
          </text>
        </Show>
      </box>
      <Show when={glyphShown()}>
        <box flexDirection="row" flexShrink={0} gap={2}>
          <Show when={headerGlyph()}>{drawn(() => header()[1]!)}</Show>
          <text fg={theme.text.muted} wrapMode="none">
            {countsLine(rows())}
          </text>
        </box>
      </Show>
      <Show when={latest()?.error}>
        <text fg={theme.text.feedback.error.base}>courier RPC failed: {latest()?.error}</text>
      </Show>
      <Show when={!top() && latest()?.tree?.stalled}>
        <text fg={theme.text.feedback.error.base}>This session is stalled: {stalledLine(latest()!.tree!.stalled!, now())}</text>
      </Show>
      <scrollbox
        ref={(value: ScrollBoxRenderable) => (scroll = value)}
        flexGrow={1}
        onSizeChange={function () {
          setListHeight(this.height)
        }}
      >
        <For each={listed()}>
          {(row, index) => {
            const chosen = () => index() === selected()
            return (
              <box
                id={`courier-row-${index()}`}
                flexDirection="column"
                flexShrink={0}
                backgroundColor={rowBackground(row, chosen())}
                onMouseOver={() => setHovered(row.sessionID)}
                onMouseOut={() => setHovered((id) => (id === row.sessionID ? undefined : id))}
                onMouseDown={(event) => (pressed = event.button === MouseButton.LEFT ? row.sessionID : undefined)}
                onMouseUp={(event) => {
                  if (event.button !== MouseButton.LEFT) return
                  event.stopPropagation()
                  const down = pressed
                  pressed = undefined
                  if (down === row.sessionID) click(row)
                }}
              >
                <box flexDirection="row" flexShrink={0}>
                  <text fg={rowColor(row)} wrapMode="none" flexShrink={0}>
                    {chosen() ? "▸ " : "  "}
                  </text>
                  <Show when={guided().get(row.sessionID)?.row}>
                    {(guide: Accessor<string>) => (
                      <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
                        {guide()}
                      </text>
                    )}
                  </Show>
                  <text fg={rowMark(row, theme).color} wrapMode="none" flexShrink={0}>
                    {rowMark(row, theme, frame()).mark}{" "}
                  </text>
                  <text fg={rowColor(row)} wrapMode="none" flexShrink={1} minWidth={0}>
                    {oneLine(row.title)}
                    {row.sessionID === input.sessionID ? " (on screen)" : ""}
                  </text>
                  <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
                    {"  "}
                  </text>
                  <For each={statusParts(row, now())}>
                    {(part, at) => (
                      <>
                        <Show when={at()}>
                          <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
                            {" · "}
                          </text>
                        </Show>
                        <text fg={partColor(row, part.kind)} wrapMode="none" flexShrink={0}>
                          {part.text}
                        </text>
                      </>
                    )}
                  </For>
                </box>
                <For each={lines(row)}>
                  {(line) => (
                    <text fg={theme.text.muted} wrapMode="none">
                      {"  "}
                      {guided().get(row.sessionID)?.detail ?? "  "}
                      <Show when={row.context !== undefined && Math.round(row.context * 100) > CONTEXT_WARN * 100} fallback={line}>
                        <For each={line.split(" · ")}>
                          {(part, at) => (
                            <>
                              {at() ? " · " : ""}
                              {part === `ctx ${Math.round(row.context! * 100)}%` ? <span style={{ fg: theme.text.feedback.warning.base }}>{part}</span> : part}
                            </>
                          )}
                        </For>
                      </Show>
                    </text>
                  )}
                </For>
              </box>
            )
          }}
        </For>
        <Show when={latest()?.tree && !rows().length}>
          <text fg={theme.text.muted}>
            {top() ? "    " : ""}No session started with courier_spawn under this one.
          </text>
          <Show when={artShown()}>
            <box flexDirection="column" flexShrink={0} paddingTop={1}>
              <Index each={art()}>{(line) => drawn(line)}</Index>
            </box>
          </Show>
        </Show>
        <Show when={belowShown()}>
          <box flexDirection="column" flexShrink={0} paddingTop={1}>
            <Index each={art()}>{(line) => drawn(line)}</Index>
          </box>
        </Show>
      </scrollbox>
      <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
        ↑↓ select · enter open · s stop · x forget · r refresh · f fullscreen · q close
      </text>
    </box>
  )
}

export const USAGE = "/courier tree opens the session tree; /courier stop [session] stops a session and those under it"

export function addTreePanel(ctx: Context) {
  const { courier, location } = courierOf(ctx)
  const animations = animationsOn(ctx.options)
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
        <TreePanel ctx={ctx} input={input} view={viewOf(input.sessionID)} courier={courier} location={location} changed={changed} animations={animations} />
      </Show>
    ),
  })
  const show = (from: Following, at: string, root: string, tree: Tree | undefined) => {
    following = { ...from, root, at, to: undefined, tree, refocus: !from.focused }
    ctx.ui.panel.open(PANEL, { presentation: from.presentation })
  }
  const treeOf = (sessionID: string) => courier.tree({ sessionID }, { location: location(sessionID) }).catch(() => undefined)
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
        if (!shown && sessionID && following.at === sessionID) following = undefined
        else if (!sessionID) hide(following)
        else follow(following, sessionID)
      })
    })
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
    const spawned = rows.filter((row) => !row.subagent)
    if (!target && "error" in read) return ctx.ui.toast.show({ title: "courier stop", message: reason(read.error), variant: "error" })
    if (!target && !spawned.length)
      return ctx.ui.toast.show({ title: "courier stop", message: "No session started with courier_spawn under this one.", variant: "warning" })
    const sessionID =
      target ||
      (await ctx.ui.dialog.select({
        title: "Stop which session?",
        options: spawned.map((row) => ({ title: row.title, value: row.sessionID, description: `${row.sessionID} · ${statusLine(row)}` })),
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

const NOTIFIED_MAX = 500

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
