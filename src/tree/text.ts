import { obj, str } from "../platform/json.js"
import { clipText, defuse, defuseBlock, END_TURN, ROOT_SPLIT_LINE, SKILL_ID, SPLIT_LINE, STATUSES } from "../kernel/protocol.js"
import { retryDelay, type ModelRef } from "./domain.js"
import type { Artifacts, CleanupResult, ExecutionError, HeldReport, LeftMember, Limits, Sent, Standing } from "./ports.js"

const STATUS_LIST = `${STATUSES.slice(0, -1).join(", ")} or ${STATUSES.at(-1)}`

export const childBranch = (sessionID: string) => `courier/${sessionID}`

export const BRIEF_FIRST_LINE = "You were started by session "

export function childBrief(parentID: string, task: string, depth: number, limits: Limits, branch?: string) {
  return [
    `${BRIEF_FIRST_LINE}${parentID} through opencode-courier.`,
    "",
    `When you finish, send exactly one report: call courier_send with sessionID "${parentID}", a short account of what you did and ` +
      "status done, partial (say what is left and why) or failed (say what went wrong). Add artifacts where there are any: " +
      "branch, commits, files, checks (each command you ran and its result). If the report holds something the other parts of " +
      "the job need (a value, a path or a command they wait for, an assumption of the split that is wrong), put that in finding " +
      "as well, in a sentence or two: a finding reaches the parent at once, also when the report itself is held for later.",
    "If you need a decision from the session that started you, which you cannot make yourself, send status blocked with a " +
      "concrete ask, then end your turn and wait for its answer; never end quietly.",
    "A report with a status wakes the parent and is the only way it hears from you, so do not end without sending one. " +
      "A message without a status is progress, not your report: if you end your turn without a report, the parent is told so.",
    "If you have to wait for something outside the tree that wakes this session later (a tool that watches a pull request, " +
      "a thread or a run), tell the parent so with courier_send without a status and schedule yourself a check-in with " +
      "courier_later, which shows you as waiting, then end your turn. Once woken, cancel the check-in with courier_cancel " +
      "and send your report.",
    "If you find something the other parts of the job need (an assumption of the split that is wrong, a shared file or API " +
      "that behaves otherwise), send it to the parent at once with courier_send without a status, then carry on: it passes " +
      "it on to the sessions it affects. Do the same with one a session you started sends you, when it reaches past your own " +
      "part. Progress alone is not worth a message.",
    "Courier passes what the person writes in your session, outside a <courier> envelope, to the sessions above you, in an " +
      'envelope marked route="prompt". Do not send it up yourself: act on it, and say in your report what you did because of it.',
    "If you need the person to decide something, use your question tool; it reaches them through the top session of the tree.",
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
    "- Do it yourself when it is small, sequential or tightly coupled. Never start exactly one session for the whole task. One session for one stage is a part, not the whole: " +
      "a core you stage before the rest, when 2 or more parts follow it; a review of the parts once you have merged them; the fixing of what a review found once you have verified it. " +
      "One session alone, with nothing of the task done before it by you or by 2 or more parts, and fewer than 2 parts after it, is the whole task.",
    `- Say which in one line of your reply: ${SPLIT_LINE}.`,
    "- If you split, you orchestrate: start the parts, then end your turn while they work. Do not poll with " +
      "courier_children, courier_tree or sleep: each report wakes you. A group name is for parts whose reports are of no " +
      "use to you one at a time: it holds them for one wake. Check and integrate each part yourself when it reports " +
      `(never hand that checking to another session), and once every part has reported, send ${parentID} one combined report.`,
  ]
}

export const ROLE_PREFIX = "opencode-courier role:"

export const ROLE_KEY = "role"

export function rolePart(depth: number | null, limits: Limits) {
  const { maxDepth, maxChildren, maxTotal } = limits
  const budget = `At most ${maxChildren} of the sessions you start run at once, and ${maxTotal} in the whole tree.`
  if (depth === null)
    return (
      `${ROLE_PREFIX} root, no sessions started yet. Before a task with 2 or more independent, substantial parts touching separate files or areas, load the ` +
      `${SKILL_ID} skill, call courier_recall once for how earlier trees in this project were split and how they went, ` +
      `and decide whether to split it across sessions (doing it yourself is fine; so is handing a heavy task, with long ` +
      `reading, many edits or long runs, whole to one session to keep your context, but never a small one), and say ` +
      `which in one line of your reply: ${ROOT_SPLIT_LINE}.`
    )
  if (depth === 0)
    return (
      `${ROLE_PREFIX} root orchestrator. You started sessions with courier_spawn, and they may start their own, ` +
      `down to ${maxDepth} levels below you. ${budget} Check and integrate what each one reports yourself. ` +
      `Load the ${SKILL_ID} skill if it is not in your context.`
    )
  if (depth < maxDepth)
    return (
      `${ROLE_PREFIX} sub-orchestrator, at depth ${depth} of at most ${maxDepth}. Before you decide whether to split, load the ${SKILL_ID} ` +
      `skill. Split your task with courier_spawn or do it yourself, as your brief says; sessions can be started ${count(maxDepth - depth, "level")} below you. ${budget}`
    )
  return (
    `${ROLE_PREFIX} leaf, at depth ${depth}, the deepest the session tree goes. You cannot start sessions: do your ` +
    "task yourself and report with courier_send to the session that started you."
  )
}

export const STANDING_KEY = "standing"

export const STANDING_PREFIX = "opencode-courier standing:"

export const STANDING_MAX = 10

const TITLE_MAX = 40

export type ChildState =
  | { readonly kind: "started" | "working" | "ended" | "failed" | "interrupted" | "stopped"; readonly progressed?: boolean }
  | { readonly kind: "reported"; readonly status: string; readonly progressed?: boolean }

export interface StandingRow {
  readonly sessionID: string
  readonly title: string
  readonly state: ChildState
  readonly group?: { readonly name: string; readonly standing: Standing | "unknown" }
}

function stateWords(state: ChildState) {
  const progressed = state.progressed ? ", sent progress" : ""
  switch (state.kind) {
    case "started":
      return "started"
    case "working":
      return `working${progressed}`
    case "ended":
      return `ended its turn without a report${progressed}`
    case "failed":
      return "its turn failed"
    case "interrupted":
      return "its turn was interrupted"
    case "stopped":
      return "stopped"
    case "reported":
      return `reported ${state.status}`
  }
}

function groupWords(name: string, standing: Standing | "unknown") {
  const group = `group "${name}"`
  switch (standing) {
    case "held":
      return `its report is held with ${group}`
    case "out":
      return `${group} waits for it`
    case "released":
      return `${group} was delivered`
    case "unknown":
      return `in ${group}`
    default:
      return `out of ${group} (${LEFT_HOW[standing]})`
  }
}

export function standingEntry(rows: ReadonlyArray<StandingRow>) {
  const shown = rows.slice(-STANDING_MAX)
  const older = rows.length - shown.length
  return [
    `${STANDING_PREFIX} the sessions you started with courier_spawn, each with its state, kept current as it changes, so you need ` +
      "not look with courier_children or courier_tree; a report, a group's reports or a notice still reach you as a message.",
    ...shown.map((row) => {
      const title = defuseBlock(row.title.replace(/\s+/g, " ").trim())
      const group = row.group ? `; ${groupWords(row.group.name, row.group.standing)}` : ""
      return `- ${row.sessionID} "${clipText(title, TITLE_MAX)}": ${stateWords(row.state)}${group}`
    }),
    ...(older ? [`${count(older, "older session")} not listed; courier_children lists them.`] : []),
  ].join("\n")
}

export const depthRefusal = (depth: number, maxDepth: number) =>
  `Not started: this session is at depth ${depth} of its session tree, and the tree goes at most ${maxDepth} deep ` +
  "(maxDepth), so it cannot start sessions. Do the task yourself, and report with courier_send."

const live = (n: number) => (n === 1 ? "is running, blocked or still owes a report" : "are running, blocked or still owe a report")

const stillCounts = (whoDrops: string) =>
  `A session also counts while one it started is live, and one that is blocked, or whose turn ended without a report unless it failed or was interrupted, counts until it reports or ${whoDrops} it with courier_cleanup.`

export const childrenRefusal = (running: number, maxChildren: number) =>
  `Not started: ${count(running, "session")} you started ${live(running)}, the most allowed at once ` +
  `(maxChildren ${maxChildren}). Do this part yourself, or answer any of them that is blocked, end your turn and start it once one of them has reported, not in a loop. ` +
  stillCounts("you drop")

export const totalRefusal = (running: number, maxTotal: number, yours: number) =>
  `Not started: ${count(running, "session")} in this session tree ${live(running)}, the most allowed at once (maxTotal ${maxTotal}). ` +
  (yours === 0
    ? "Do this part yourself: none of the sessions you started counts, so only reports already held for a group can still wake you."
    : "Do this part yourself, or answer any session you started that is blocked, end your turn and try again once one of them has reported, not in a loop. " +
      stillCounts("its parent drops"))

const LISTED_MAX = 12

const some = (items: ReadonlyArray<string>) => (items.length > LISTED_MAX ? `${items.slice(0, LISTED_MAX).join(", ")} and ${items.length - LISTED_MAX} more` : items.join(", "))

export const modelFormatRefusal = (given: string) =>
  `Not started: model must be provider/model, as OpenCode names them (opencode/gpt-5-nano, anthropic/claude-sonnet-4-5), not ${JSON.stringify(given)}. ` +
  "Leave it unset to run the session on your own model."

export function unknownModelRefusal(model: ModelRef, known: ReadonlyArray<Pick<ModelRef, "providerID" | "id">>, named: boolean) {
  const name = `${model.providerID}/${model.id}`
  const ids = known.filter((item) => item.providerID === model.providerID).map((item) => item.id)
  const providers = [...new Set(known.map((item) => item.providerID))]
  let hint = "No model is listed here at all."
  if (ids.length) hint = `The models of ${model.providerID} here are ${some(ids)}.`
  else if (providers.length) hint = `The providers here are ${some(providers)}.`
  return named
    ? `Not started: OpenCode lists no model ${name} here. ${hint} Leave model unset to run the session on your own model.`
    : `Not started: the variant cannot be checked, since OpenCode lists no model ${name} here, the one the session would run on. ${hint}`
}

export function unknownVariantRefusal(model: ModelRef, variants: ReadonlyArray<string>) {
  const listed = variants.length ? `${variants.join(", ")} and default` : "default alone"
  return (
    `Not started: the model ${model.providerID}/${model.id} has no variant ${JSON.stringify(model.variant)}. ` +
    `Its variants are ${listed}; leave variant unset for the model's default.`
  )
}

export function variantWithoutModelRefusal(variant: string, agent?: string) {
  const why = agent ? `the agent ${agent} could not be looked up` : "neither your own model nor OpenCode's default could be read"
  return `Not started: variant ${JSON.stringify(variant)} needs a model to apply to, and ${why}. Name a model as provider/model, or leave variant unset.`
}

const strings = (value: unknown) => (Array.isArray(value) ? value.flatMap((item) => (typeof item === "string" ? [item.trim()] : [])) : []).filter(Boolean)

const listed = (name: string, items: readonly string[]) => (items.length ? [`- ${name}: ${items.join(", ")}`] : [])

const FINDING_LABEL ="Finding for the other parts:"

export function reportBody(message: string, artifacts: Artifacts | undefined, finding?: string) {
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
  return [message, ...(finding ? ["", FINDING_LABEL, finding] : []), ...(lines.length ? ["", "Artifacts:", ...lines] : [])].join("\n")
}

export const findingAhead = (group: string, status: string, finding: string) =>
  [
    `A finding from this session's report (status ${status}), delivered ahead of it: the report is held with group "${group}" and reaches you ` +
      "with the group's other reports. If other sessions you started need the finding, send it to them now with courier_send, only to those it affects.",
    "",
    finding,
  ].join("\n")

export const nativeIsolateRefusal = () =>
  "Not started: native: true and isolate: true cannot go together. OpenCode runs a session in a worktree of its own or as a " +
  "subagent of its parent, never both. Start it with isolate: true alone for a worktree of its own, or with native: true alone for a subagent in your directory."

export function spawnText(child: {
  readonly sessionID: string
  readonly directory: string
  readonly group?: string
  readonly rosterError?: string
  readonly groupError?: string
  readonly fromParent?: boolean
  readonly uncommitted?: boolean
  readonly model?: string
  readonly belowTop?: boolean
}) {
  const warning =
    (child.fromParent ? " Its worktree starts from the commit your own worktree is on." : "") +
    (child.uncommitted
      ? " Your working tree has uncommitted changes, which it does not see: commit them and tell it, or send them to it, if it needs them."
      : "") +
    (child.rosterError ? ` It is not on your courier_children list: ${child.rosterError}` : "") +
    (child.groupError ? ` It is in no group, so its report comes on its own: ${child.groupError}` : "")
  const asks = child.belowTop
    ? " Its permission requests and questions go to the top session of the tree, not to you, so a child slow to report may be waiting on the person."
    : ""
  const topAsks = child.belowTop ? "" : ", and so does a question or a permission request"
  const reports = child.group
    ? `Its report is held with group "${child.group}": once every session you started in that group has reported and your ` +
      `turn has ended, you get their reports in one message, which starts a new turn for you; a blocked report, a report's finding, a failed turn ` +
      `or an end without a report still reaches you at once${topAsks}.${asks}`
    : `It will report back with courier_send, which starts a new turn for you.${asks}`
  const on = child.model ? `, on ${child.model}` : ""
  return (
    `Started session ${child.sessionID} in ${child.directory}${on}. ${reports} Once you have started every session you need, ` +
    `end your turn: reply without calling more tools. That does not drop the task; you carry on with it when the reports arrive.${warning}`
  )
}

export function sendText(sessionID: string, sent: Pick<Sent, "status" | "report" | "held" | "dropped" | "finding"> = {}) {
  if (sent.dropped)
    return (
      `Delivered to ${sessionID}, without the status ${sent.dropped}: a status belongs on a report to the session that ` +
      "started you, and means nothing on a message to a session you started."
    )
  const status = sent.status ? `, status ${sent.status}` : ""
  if (sent.held) {
    const { group, reported, members } = sent.held
    const counted = reported !== undefined && members !== undefined
    let when = `once ${sessionID}'s turn has ended, yours being the last.`
    if (!counted || reported < members) {
      const have = counted ? ` (${reported} of ${members} have)` : ""
      when = `once every member of the group has reported${have}. Nothing more is needed from you for it.`
    }
    const finding = {
      ahead: ` Its finding went to ${sessionID} now, ahead of the report.`,
      unsent: ` Its finding could not be delivered ahead of it: send the finding to ${sessionID} now with courier_send without a status.`,
      none: "",
    }[sent.finding ?? "none"]
    return `Recorded as your report${status}. It is held with group "${group}" and goes to ${sessionID} in one message with the group's other reports, ${when}${finding} ${END_TURN}`
  }
  if (sent.report === true) return `Delivered to ${sessionID} as your report${status}. ${END_TURN}`
  if (sent.report === false)
    return `Delivered to ${sessionID}. Without a status it is progress, not your report: when you finish, send one with status ${STATUS_LIST}.`
  return `Delivered to ${sessionID}.`
}

export const childrenText = (listed: ReadonlyArray<unknown>) =>
  listed.length ? JSON.stringify(listed, null, 2) : "No sessions started with courier_spawn."

const keptLine = (result: Extract<CleanupResult, { readonly outcome: "kept" }>) =>
  `Kept the worktree ${result.directory} of ${result.sessionID}: it has ${result.reason}.`

export function cleanupText(result: CleanupResult) {
  if (result.outcome === "kept")
    return `${keptLine(result)} ${result.sessionID} is not dropped yet: commit what you want to keep to a branch, then call courier_cleanup again, or call it now with force: true to discard it. Either call drops ${result.sessionID}.`
  const done = {
    removed: `Removed the worktree ${result.directory} of ${result.sessionID}.`,
    gone: `The worktree ${result.directory} of ${result.sessionID} was already gone; dropped it from courier_children.`,
    forgotten: `${result.sessionID} ran in ${result.directory}, with no worktree of its own to remove; dropped it from courier_children.`,
  }[result.outcome]
  if (!result.group) return done
  return `${done} Dropped it from group "${result.group}" without a report: the group's other reports reach you once they are in and your turn has ended, the message naming it, and a report it sends after all comes on its own.`
}

export function treeText(tree: { readonly sessions: ReadonlyArray<unknown>; readonly truncated?: number }) {
  if (!tree.sessions.length) return "No sessions started with courier_spawn."
  if (tree.truncated === undefined) return JSON.stringify(tree, null, 2)
  const older = tree.truncated === 1 ? "1 older session is" : `${tree.truncated} older sessions are`
  const note = `\n${older} not listed: at most maxTotal are, the live ones first, then the newest; courier_tree on a listed session lists what is under it.`
  return JSON.stringify(tree, null, 2) + note
}

const IDLE_STOPPED =
  "Stopping an idle session does not settle it: one that owed a report still owes it, stays in its join group and " +
  "counts toward maxChildren and maxTotal until the session that started it drops it with courier_cleanup."

export function stopText(result: {
  readonly sessionID: string
  readonly stopped: ReadonlyArray<{ readonly sessionID: string; readonly outcome: string; readonly error?: string; readonly subagent?: true }>
  readonly cancelled: ReadonlyArray<string>
  readonly cleanup?: ReadonlyArray<CleanupResult | { readonly sessionID: string; readonly outcome: "failed"; readonly error: string }>
  readonly told?: string
}) {
  const interrupted = result.stopped.filter((one) => one.outcome === "interrupted").length
  const failed = result.stopped.filter((one) => one.outcome === "failed")
  const idle = result.stopped.some((one) => one.outcome === "idle" && !one.subagent)
  return [
    `Stopped ${result.sessionID} and ${count(result.stopped.length - 1, "session")} under it, deepest first: ${interrupted} had a turn running and was interrupted, ` +
      `${result.stopped.filter((one) => one.outcome === "idle" || one.outcome === "gone").length} did not run.`,
    ...result.stopped.map((one) => `- ${one.sessionID}${one.subagent ? " (subagent)" : ""}: ${one.outcome}${one.error ? " (" + one.error + ")" : ""}`),
    ...(failed.length ? ["Those that failed may still run: try courier_stop again."] : []),
    ...(idle ? [IDLE_STOPPED] : []),
    result.cancelled.length
      ? `Cancelled ${count(result.cancelled.length, "scheduled message")}: ${result.cancelled.join(", ")}.`
      : "No scheduled messages were pending for them.",
    ...(result.told ? [`Told ${result.told}, which started ${result.sessionID}, that it was stopped.`] : []),
    ...(result.cleanup ? worktreeLines(result.cleanup) : []),
  ].join("\n")
}

function worktreeLines(cleanup: ReadonlyArray<CleanupResult | { readonly sessionID: string; readonly outcome: "failed"; readonly error: string }>) {
  if (!cleanup.length) return ["None of them ran in a worktree of its own."]
  return cleanup.map((one) => {
    if (one.outcome === "failed") return `Worktree of ${one.sessionID}: not removed (${one.error}).`
    if (one.outcome === "kept") return `${keptLine(one)} Kept; courier_cleanup with force: true discards it.`
    return cleanupText(one)
  })
}

export const stoppedNotice = (title: string, by: string) =>
  [
    `This session, "${title}", which you started with courier_spawn, was stopped by ${by}, a session above you, together with the sessions under it.`,
    "It was not a failure and it will not report back. Carry on without it, or start a replacement if you still need what it was doing.",
  ].join("\n")

const HOLDS_GROUP = "holds back its join group if it is in one"

export const idleStoppedNotice = (title: string, by: string) =>
  [
    `This session, "${title}", which you started with courier_spawn, was stopped by ${by}, a session above you, together with the sessions under it.`,
    `It was not running and still owed you a report, so it still counts toward maxChildren and maxTotal, and ${HOLDS_GROUP}. ` +
      "Drop it with courier_cleanup if you no longer need it, or message it with courier_send to have it carry on.",
  ].join("\n")

export const blockedStoppedNotice = (title: string, by: string) =>
  [
    `This session, "${title}", which you started with courier_spawn, was stopped by ${by}, a session above you, together with the sessions under it.`,
    "It was not running: it had sent you status blocked and was waiting on your answer. Do not send it that answer, since the work it asked about was stopped above you. " +
      `It still ${HOLDS_GROUP}. ` +
      "Drop it with courier_cleanup if you no longer need it, or message it with courier_send if you still need it to carry on.",
  ].join("\n")

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

function wait(ms: number) {
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return count(minutes, "minute")
  const rest = minutes % 60
  return [count(Math.floor(minutes / 60), "hour"), rest ? count(rest, "minute") : ""].filter(Boolean).join(" ")
}

function clock(at: number, from: number) {
  const iso = new Date(at).toISOString()
  return iso.slice(0, 10) === new Date(from).toISOString().slice(0, 10) ? `${iso.slice(11, 16)} UTC` : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

export function typedNotice(sessionID: string, title: string | undefined, at: number, now: number, text: string) {
  const named = title === undefined ? "" : ` ("${title}")`
  return [
    `At ${clock(at, now)} this text arrived in session ${sessionID}${named}, a session under yours, over the prompt route: courier did ` +
      "not send it and cannot tell who did, whether the person, a client, a session above it through OpenCode's subagent tool, or a shell " +
      `with the server's password. Courier passes it on as written. ${sessionID} has the text and acts on it. Where the text changes ` +
      `other parts of the job, send it to the sessions you started that those parts are under, and only to them: ${sessionID} already has ` +
      "the text, and every session between it and you and every session above you already has this envelope.",
    "",
    text,
  ].join("\n")
}

function waitLine(delay: number, at: number | undefined) {
  const until = at === undefined ? "" : `, until about ${clock(at + delay, at)}`
  return `The provider asked to wait about ${wait(delay)} before trying again${until}.`
}

function belowLine(below: ReadonlyArray<string>) {
  const titles = below.map((title) => `"${title}"`).join(", ")
  return (
    `It has ${count(below.length, "session")} of its own still running (${titles}), whose reports will wake it, and it still counts ` +
    "toward your limits: message it rather than replace it, or stop it with courier_stop first, which stops the sessions under it too."
  )
}

export function failureNotice(title: string, error: ExecutionError, group?: string, at?: number, below: ReadonlyArray<string> = []) {
  const status = error.status === undefined ? "" : `, status ${error.status}`
  const delay = retryDelay(error)
  const replace = below.length ? "" : " start a replacement,"
  return [
    `This session, "${title}", which you started with courier_spawn, failed: ${error.message} (${error.type}${status}).`,
    ...(delay === undefined ? [] : [waitLine(delay, at)]),
    below.length ? "Its turn ended without finishing." : "Its turn ended without finishing, so it will not report back on its own.",
    delay === undefined
      ? `Message it with courier_send to have it try again,${replace} or carry on without it.`
      : `Do not message it with courier_send before then, as the turn would fail again. Message it after,${replace} or carry on without it; ` +
        "courier_later can remind you when the wait is over.",
    ...(below.length ? [belowLine(below)] : []),
    ...(group
      ? [
          `It is a member of group "${group}", which no longer waits for it: its other members' reports reach you once they have ` +
            "reported and your turn has ended, and if it reports after all before then, its report joins them.",
        ]
      : []),
  ].join("\n")
}

export function reportReminder(parentID: string) {
  return [
    `You are about to end your turn without reporting to session ${parentID}, which started you.`,
    `If you are finished, send your report now: call courier_send with sessionID "${parentID}", a short account of what you did and ` +
      `status ${STATUS_LIST}. If work is left, carry on and report when you finish.`,
    "This reminder comes once: if you end your turn without a report, the session that started you is told.",
  ].join("\n")
}

const QUOTED_REPLY_MAX = 2000

export function silentNotice(title: string, lastText: string | undefined, progressed = false, group?: string) {
  const reply = lastText?.trim()
  return [
    `This session, "${title}", which you started with courier_spawn, ended its turn without reporting back with courier_send, and does nothing more on its own.`,
    ...(progressed
      ? [`Its last message to you had no status, so it was progress, not its report: a report carries status ${STATUS_LIST}.`]
      : []),
    ...(reply ? ["Its last reply:", defuse(clipText(reply, QUOTED_REPLY_MAX))] : ["It ended without a reply."]),
    "",
    reply
      ? "Decide what it needs: message it with courier_send to have it carry on, or to report if its last reply is what you needed; or start a replacement."
      : "Decide what it needs: message it with courier_send to have it carry on; or start a replacement.",
    "Until it reports, it counts toward your limits on the sessions you run at once, or until you drop it with courier_cleanup.",
    ...(group
      ? [
          `It is a member of group "${group}", whose other reports are held until it reports: have it report, as above, so the group ` +
            "reaches you, or, if you no longer need its report, drop it with courier_cleanup, which releases the group without it.",
        ]
      : []),
  ].join("\n")
}

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

export function heldSoFar(group: string, reports: ReadonlyArray<HeldReport & { readonly sessionID: string; readonly title: string }>) {
  if (!reports.length) return ""
  return [
    "",
    "",
    `Held with group "${group}" so far, ${count(reports.length, "report")}, shown now in case what this session needs is in ${reports.length === 1 ? "it" : "them"}. ` +
      `The group's message brings ${reports.length === 1 ? "it" : "them"} again once every member has reported.`,
    ...reports.flatMap((report) => ["", `- ${report.sessionID} "${report.title}": ${report.status}`, reportBody(report.message, report.artifacts, report.finding)]),
  ].join("\n")
}

export function groupNotice(group: string, reports: ReadonlyArray<HeldReport & { readonly sessionID: string; readonly title: string }>, left: ReadonlyArray<LeftMember> = []) {
  const total = reports.length + left.length
  const listed = reports.flatMap((report, index) => [
    "",
    `[${index + 1}/${reports.length}] ${report.sessionID} "${report.title}": ${report.status}`,
    reportBody(report.message, report.artifacts, report.finding),
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
