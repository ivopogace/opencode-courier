/** The tree's model-facing texts: the child brief, the role part, refusals, reports, notices and tool results. */
import { obj, str } from "../platform/json.js"
import { clipText, defuse, END_TURN, SKILL_ID, SPLIT_LINE, STATUSES } from "../kernel/protocol.js"
import type { Artifacts, CleanupResult, ExecutionError, HeldReport, LeftMember, Limits, Sent } from "./ports.js"

// The envelope and the child brief.

/** How a text names the statuses a report may carry. */
const STATUS_LIST = `${STATUSES.slice(0, -1).join(", ")} or ${STATUSES.at(-1)}`

/** The branch an isolated child commits its work on, and names in the `branch` of its report. */
export const childBranch = (sessionID: string) => `courier/${sessionID}`

/** What a spawned session at `depth` is told; `depth` 1 is a child of a session nobody spawned. `branch` is for an isolated one. */
export function childBrief(parentID: string, task: string, depth: number, limits: Limits, branch?: string) {
  return [
    `You were started by session ${parentID} through opencode-courier.`,
    "",
    `When you finish, send exactly one report: call courier_send with sessionID "${parentID}", a short account of what you did and ` +
      "status done, partial (say what is left and why) or failed (say what went wrong). Add artifacts where there are any: " +
      "branch, commits, files, checks (each command you ran and its result).",
    "If you need a decision from the session that started you, which you cannot make yourself, send status blocked with a " +
      "concrete ask, then end your turn and wait for its answer; never end quietly.",
    "A report with a status wakes the parent and is the only way it hears from you, so do not end without sending one. " +
      "A message without a status is progress, not your report: if you end your turn without a report, the parent is told so.",
    "If you need the person to decide something, use your question tool; it reaches them through the session that started you.",
    "",
    ...(branch ? [...isolationRule(branch, depth < limits.maxDepth), ""] : []),
    ...splitRule(parentID, depth, limits),
    "",
    "Task:",
    task,
  ].join("\n")
}

function isolationRule(branch: string, mayPass: boolean) {
  return [
    "You work in a git worktree of your own, on a detached HEAD. Commit your work on the branch " +
      `${branch}: create it first (git switch -c ${branch}), and name it in the branch of your report's artifacts, so the ` +
      "session that started you can merge it. Uncommitted work is not in your report.",
    ...(mayPass
      ? [
          `If you split your task and start a session with isolate: true, commit first: its worktree starts from your current HEAD, ` +
            "not from your uncommitted changes. Merge each branch it reports into yours before you report.",
        ]
      : []),
  ]
}

function splitRule(parentID: string, depth: number, limits: Limits) {
  if (depth >= limits.maxDepth)
    return [`You are at depth ${depth}, the deepest the session tree goes, so you cannot start sessions: do the task yourself.`]
  return [
    `You are at depth ${depth} of a session tree that goes at most ${limits.maxDepth} deep. Split your task or do it yourself:`,
    "- Split it when it has 2 or more independent parts, each substantial and touching separate files or areas: start one " +
      `session per part with courier_spawn, at most ${limits.maxChildren} of yours running at once and ${limits.maxTotal} in the whole tree.`,
    "- Do it yourself when it is small, sequential or tightly coupled. Never start exactly one session for the whole task.",
    `- Say which in one line of your reply: ${SPLIT_LINE}.`,
    "- If you split, you orchestrate: end your turn while they work, check and integrate each part yourself when it " +
      `reports (never hand that checking to another session), then send ${parentID} one combined report.`,
  ]
}

/** How every part the context hook adds begins, so a second copy of the plugin does not add its own. */
export const ROLE_PREFIX = "opencode-courier role:"

/**
 * The system part naming a session's place in its tree: `depth` 0 for a session nobody spawned that
 * has started one, `null` for one that has started none, which is pointed to the skill. The same on every request.
 */
export function rolePart(depth: number | null, limits: Limits) {
  const { maxDepth, maxChildren, maxTotal } = limits
  const budget = `At most ${maxChildren} of the sessions you start run at once, and ${maxTotal} in the whole tree.`
  if (depth === null)
    return (
      `${ROLE_PREFIX} root, no sessions started yet. Before a task that touches several files or areas, load the ` +
      `${SKILL_ID} skill and decide whether to split it across sessions (doing it yourself is fine), and say ` +
      `which in one line of your reply: ${SPLIT_LINE}`
    )
  if (depth === 0)
    return (
      `${ROLE_PREFIX} root orchestrator. You started sessions with courier_spawn, and they may start their own, ` +
      `down to ${maxDepth} levels below you. ${budget} Check and integrate what each one reports yourself.`
    )
  if (depth < maxDepth)
    return (
      `${ROLE_PREFIX} sub-orchestrator, at depth ${depth} of at most ${maxDepth}. Split your task with courier_spawn or ` +
      `do it yourself, as your brief says; sessions can be started ${count(maxDepth - depth, "level")} below you. ${budget}`
    )
  return (
    `${ROLE_PREFIX} leaf, at depth ${depth}, the deepest the session tree goes. You cannot start sessions: do your ` +
    "task yourself and report with courier_send to the session that started you."
  )
}

// courier_spawn's refusals, one per limit.

export const depthRefusal = (depth: number, maxDepth: number) =>
  `Not started: this session is at depth ${depth} of its session tree, and the tree goes at most ${maxDepth} deep ` +
  "(maxDepth), so it cannot start sessions. Do the task yourself, and report with courier_send."

/** How a refusal names sessions that count against a limit: those running, and those that have not reported yet. */
const live = (n: number) => (n === 1 ? "is running or has not reported yet" : "are running or have not reported yet")

export const childrenRefusal = (running: number, maxChildren: number) =>
  `Not started: ${count(running, "session")} you started ${live(running)}, the most allowed at once ` +
  `(maxChildren ${maxChildren}). Do this part yourself, or end your turn and start it once one of them has reported.`

export const totalRefusal = (running: number, maxTotal: number) =>
  `Not started: ${count(running, "session")} in this session tree ${live(running)}, the most allowed at once ` +
  `(maxTotal ${maxTotal}). Do this part yourself, or end your turn and try again once a report has arrived.`

/** The strings of a list given as artifacts, whatever else the model put in it. */
const strings = (value: unknown) => (Array.isArray(value) ? value.flatMap((item) => (typeof item === "string" ? [item.trim()] : [])) : []).filter(Boolean)

/** A list's line in the artifacts block, or none when it is empty. */
const listed = (name: string, items: readonly string[]) => (items.length ? [`- ${name}: ${items.join(", ")}`] : [])

/**
 * The body of a report: its text, then the artifacts in a fixed layout, the same for every report,
 * so a parent finds the branch, the commits, the files and the checks without reading prose.
 */
export function reportBody(message: string, artifacts: Artifacts | undefined) {
  const given = obj(artifacts)
  const checks = (Array.isArray(given.checks) ? given.checks : []).flatMap((check: unknown) => {
    const command = str(obj(check).command)?.trim()
    return command ? [`  - ${command}: ${str(obj(check).result)?.trim() || "(no result given)"}`] : []
  })
  const lines = [
    ...listed("branch", strings([given.branch])),
    ...listed("commits", strings(given.commits)),
    ...listed("files", strings(given.files)),
    ...(checks.length ? ["- checks:", ...checks] : []),
  ]
  return lines.length ? [message, "", "Artifacts:", ...lines].join("\n") : message
}

// Tool results.

export function spawnText(child: {
  readonly sessionID: string
  readonly directory: string
  readonly group?: string
  readonly rosterError?: string
  readonly groupError?: string
  readonly fromParent?: boolean
  readonly uncommitted?: boolean
}) {
  const warning =
    (child.fromParent ? " Its worktree starts from the commit your own worktree is on." : "") +
    (child.uncommitted
      ? " Your worktree has uncommitted changes, which it does not see: commit them and tell it, or send them to it, if it needs them."
      : "") +
    (child.rosterError ? ` It is not on your courier_children list: ${child.rosterError}` : "") +
    (child.groupError ? ` It is in no group, so its report comes on its own: ${child.groupError}` : "")
  const reports = child.group
    ? `Its report is held with group "${child.group}": once every session you started in that group has reported and your ` +
      "turn has ended, you get their reports in one message, which starts a new turn for you; a blocked report, a question " +
      "or a failed turn still reaches you at once."
    : "It will report back with courier_send, which starts a new turn for you."
  return (
    `Started session ${child.sessionID} in ${child.directory}. ${reports} Once you have started every session you need, ` +
    `end your turn: reply without calling more tools. That does not drop the task; you carry on with it when the reports arrive.${warning}`
  )
}

/** courier_send's result: for a message to the session that started the sender, whether it was its report. */
export function sendText(sessionID: string, sent: Pick<Sent, "status" | "report" | "held"> = {}) {
  const status = sent.status ? `, status ${sent.status}` : ""
  if (sent.held) {
    const { group, reported, members } = sent.held
    const counted = reported !== undefined && members !== undefined
    let when = `once ${sessionID}'s turn has ended, yours being the last.`
    if (!counted || reported < members) {
      const have = counted ? ` (${reported} of ${members} have)` : ""
      when = `once every member of the group has reported${have}. Nothing more is needed from you for it.`
    }
    return `Recorded as your report${status}. It is held with group "${group}" and goes to ${sessionID} in one message with the group's other reports, ${when} ${END_TURN}`
  }
  if (sent.report === true) return `Delivered to ${sessionID} as your report${status}. ${END_TURN}`
  if (sent.report === false)
    return `Delivered to ${sessionID}. Without a status it is progress, not your report: when you finish, send one with status ${STATUS_LIST}.`
  return `Delivered to ${sessionID}.`
}

/** courier_status's result: the session's state, as JSON. */
export const statusText = (status: unknown) => JSON.stringify(status, null, 2)

export const childrenText = (listed: ReadonlyArray<unknown>) =>
  listed.length ? JSON.stringify(listed, null, 2) : "No sessions started with courier_spawn."

export function cleanupText(result: CleanupResult) {
  if (result.outcome === "kept")
    return `Kept the worktree ${result.directory} of ${result.sessionID}: it has ${result.reason}. Commit or branch what you want to keep, or call courier_cleanup again with force: true to discard it.`
  const done = {
    removed: `Removed the worktree ${result.directory} of ${result.sessionID}.`,
    gone: `The worktree ${result.directory} of ${result.sessionID} was already gone; dropped it from courier_children.`,
    forgotten: `${result.sessionID} ran in ${result.directory}, with no worktree of its own to remove; dropped it from courier_children.`,
  }[result.outcome]
  if (!result.group) return done
  return `${done} Dropped it from group "${result.group}" without a report: the group's other reports reach you once they are in and your turn has ended, the message naming it, and a report it sends after all comes on its own.`
}

/** courier_tree's result: the sessions under a session, drawn depth first, as JSON. */
export function treeText(tree: { readonly sessions: ReadonlyArray<unknown>; readonly truncated?: number }) {
  if (!tree.sessions.length) return "No sessions started with courier_spawn."
  if (tree.truncated === undefined) return JSON.stringify(tree, null, 2)
  const older = tree.truncated === 1 ? "1 older session is" : `${tree.truncated} older sessions are`
  const note = `\n${older} not listed: at most maxTotal are, the live ones first, then the newest; courier_tree on a listed session lists what is under it.`
  return JSON.stringify(tree, null, 2) + note
}

/** What courier_stop did to each session, and to the messages and worktrees. */
export function stopText(result: {
  readonly sessionID: string
  readonly stopped: ReadonlyArray<{ readonly sessionID: string; readonly outcome: string; readonly error?: string }>
  readonly cancelled: ReadonlyArray<string>
  readonly cleanup?: ReadonlyArray<CleanupResult | { readonly sessionID: string; readonly outcome: "failed"; readonly error: string }>
  readonly told?: string
}) {
  const interrupted = result.stopped.filter((one) => one.outcome === "interrupted").length
  const failed = result.stopped.filter((one) => one.outcome === "failed")
  return [
    `Stopped ${result.sessionID} and ${count(result.stopped.length - 1, "session")} under it, deepest first: ${interrupted} had a turn running and was interrupted, ` +
      `${result.stopped.filter((one) => one.outcome === "idle" || one.outcome === "gone").length} did not run.`,
    ...result.stopped.map((one) => `- ${one.sessionID}: ${one.outcome}${one.error ? " (" + one.error + ")" : ""}`),
    ...(failed.length ? ["Those that failed may still run: try courier_stop again."] : []),
    result.cancelled.length
      ? `Cancelled ${count(result.cancelled.length, "scheduled message")}: ${result.cancelled.join(", ")}.`
      : "No scheduled messages were pending for them.",
    ...(result.told ? [`Told ${result.told}, which started ${result.sessionID}, that it was stopped.`] : []),
    ...(result.cleanup ? worktreeLines(result.cleanup) : []),
  ].join("\n")
}

const FORCE_HINT = " Commit or branch what you want to keep, or call courier_cleanup again with force: true to discard it."

/** courier_stop's lines on the worktrees it was asked to remove. */
function worktreeLines(cleanup: ReadonlyArray<CleanupResult | { readonly sessionID: string; readonly outcome: "failed"; readonly error: string }>) {
  if (!cleanup.length) return ["None of them ran in a worktree of its own."]
  return cleanup.map((one) =>
    one.outcome === "failed"
      ? `Worktree of ${one.sessionID}: not removed (${one.error}).`
      : cleanupText(one).replace(FORCE_HINT, " Kept; courier_cleanup with force: true discards it."),
  )
}

/** What the parent of a stopped session is told when the stop was ordered by a session above both. */
export const stoppedNotice = (title: string, by: string) =>
  [
    `This session, "${title}", which you started with courier_spawn, was stopped by ${by}, a session above you, together with the sessions under it.`,
    "It was not a failure and it will not report back. Carry on without it, or start a replacement if you still need what it was doing.",
  ].join("\n")

/** Why a worktree in this state must be kept, or undefined when removing it loses nothing. */
export function keepReason(state: { readonly changes: readonly string[]; readonly commits: readonly string[] }) {
  const reasons = [
    state.changes.length ? `${count(state.changes.length, "uncommitted change")} (${preview(state.changes)})` : "",
    state.commits.length
      ? `${count(state.commits.length, "commit")} on no branch, tag or remote (${preview(state.commits)})`
      : "",
  ].filter(Boolean)
  return reasons.length ? reasons.join(" and ") : undefined
}

function count(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

function preview(items: readonly string[]) {
  return items.length > 5 ? `${items.slice(0, 5).join(", ")}, ...` : items.join(", ")
}

// Turn failures.

export function failureNotice(title: string, error: ExecutionError, group?: string) {
  const status = error.status === undefined ? "" : `, status ${error.status}`
  return [
    `This session, "${title}", which you started with courier_spawn, failed: ${error.message} (${error.type}${status}).`,
    "Its turn ended without finishing, so it will not report back on its own.",
    "Message it with courier_send to have it try again, start a replacement, or carry on without it.",
    ...(group
      ? [
          `It is a member of group "${group}", which no longer waits for it: its other members' reports reach you once they have ` +
            "reported and your turn has ended, and if it reports after all before then, its report joins them.",
        ]
      : []),
  ].join("\n")
}

/** Longest last reply a notice that a session ended its turn without reporting quotes. */
const MAX_REPLY = 2000

/**
 * What the parent is told when a session it started ends its turn without a report to it;
 * `progressed` when it messaged the parent without a status since its last prompt.
 */
export function silentNotice(title: string, lastText: string | undefined, progressed = false, group?: string) {
  const reply = lastText?.trim()
  return [
    `This session, "${title}", which you started with courier_spawn, ended its turn without reporting back with courier_send, and does nothing more on its own.`,
    ...(progressed
      ? [`Its last message to you had no status, so it was progress, not its report: a report carries status ${STATUS_LIST}.`]
      : []),
    ...(reply ? ["Its last reply:", defuse(clipText(reply, MAX_REPLY))] : ["It ended without a reply."]),
    "",
    "Decide what it needs: message it with courier_send to have it carry on, or to report if its last reply is what you needed; or start a replacement.",
    "Until it reports, it counts toward your limits on the sessions you run at once.",
    ...(group
      ? [
          `It is a member of group "${group}", whose other reports are held until it reports: have it report, as above, so the group ` +
            "reaches you, or, if you no longer need its report, drop it with courier_cleanup, which releases the group without it.",
        ]
      : []),
  ].join("\n")
}

// Join groups.

/** How a release names each status among its reports: `2 done, 1 failed`. */
function statusCounts(reports: ReadonlyArray<Pick<HeldReport, "status">>) {
  return STATUSES.flatMap((status) => {
    const n = reports.filter((report) => report.status === status).length
    return n ? [`${n} ${status}`] : []
  }).join(", ")
}

const LEFT_HOW = {
  failed: "its turn failed",
  interrupted: "its turn was interrupted",
  deleted: "it was deleted",
  dropped: "you dropped it with courier_cleanup",
}

/**
 * What the parent gets when a group it named is released: every report, with its status, text and artifacts in
 * `reportBody`'s layout, and the members that left without one, in the order they joined.
 */
export function groupNotice(group: string, reports: ReadonlyArray<HeldReport & { readonly sessionID: string; readonly title: string }>, left: ReadonlyArray<LeftMember> = []) {
  const total = reports.length + left.length
  const listed = reports.flatMap((report, index) => [
    "",
    `[${index + 1}/${reports.length}] ${report.sessionID} "${report.title}": ${report.status}`,
    reportBody(report.message, report.artifacts),
  ])
  const named = left.map((member) => `${member.sessionID} "${member.title}" (${LEFT_HOW[member.by]})`).join(", ")
  const without = left.length ? ["", `Without a report: ${named}.`] : []
  const missing = left.length ? `, ${count(left.length, "member")} without a report, named at the end` : ""
  return [
    `Group "${group}" is complete: ${count(reports.length, "report")} of ${count(total, "member")} (${statusCounts(reports)})${missing}. Each report follows, with its status.`,
    ...listed,
    ...without,
    "",
    "Check and integrate each one yourself. The sessions that reported are idle; message one with courier_send if it has more to do.",
  ].join("\n")
}
