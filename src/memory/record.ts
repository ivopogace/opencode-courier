import { finite, isNotFound, millis } from "../platform/json.js"
import { busy, contextOf, reportState, stalledAmong, subtree, type Below, type ModelWindow } from "../tree/index.js"
import { isSettled, isStated, mergeParts, NOT_STATED, partStatus, replacingMention, revise, splitLinesOf, splitOf, unreadPart, type PartRecord, type Stated, type TreeRecord } from "./domain.js"
import type { MemoryState, RefreshPorts } from "./ports.js"
import { memoryStore } from "./store.js"

type Info = Awaited<ReturnType<RefreshPorts["session"]["get"]>>
type Messages = Awaited<ReturnType<RefreshPorts["session"]["context"]>>

/** A session's replies, in order, each with when it was created, for its split lines; only the `finished` ones when asked. */
const repliesOf = (messages: Messages, finished: boolean) =>
  messages.flatMap((message) =>
    message.type === "assistant" && (!finished || message.time?.completed !== undefined)
      ? [{ text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"), at: finite(millis(message.time?.created)) }]
      : [],
  )

/** The lines in the replies that begin with `split:`, each with its reply's time. */
const statedIn = (replies: ReturnType<typeof repliesOf>): Stated[] =>
  replies.flatMap(({ text, at }) => splitLinesOf(text).map((line) => (at === undefined ? { text: line } : { text: line, at })))

/** How many courier_spawn calls of a session failed, refused by a limit mostly. */
const refusedIn = (messages: Messages) =>
  messages.reduce(
    (n, message) => (message.type === "assistant" ? n + message.content.filter((part) => part.type === "tool" && part.name === "courier_spawn" && part.state.status === "error").length : n),
    0,
  )

type Use = Pick<PartRecord, "context" | "refused">

/** A part's context use and refused spawns, as its messages show them. */
function useOf(messages: Messages, windows: ReadonlyArray<ModelWindow>): Use {
  const context = contextOf(messages, windows)
  const refused = refusedIn(messages)
  return { ...(context !== undefined ? { context: Math.round(context * 100) / 100 } : {}), ...(refused ? { refused } : {}) }
}

/** A part's use as last recorded. */
const keptUse = (last: PartRecord | undefined): Use => ({
  ...(last?.context !== undefined ? { context: last.context } : {}),
  ...(last?.refused ? { refused: last.refused } : {}),
})

/** A session's info, or `gone` when OpenCode no longer knows it; neither when it could not be read for another reason. */
const infoOf = (ports: RefreshPorts, sessionID: string): Promise<{ info?: Info; gone: boolean }> =>
  ports.session.get({ sessionID }).then(
    (info) => ({ info, gone: false }),
    (error: unknown) => ({ gone: isNotFound(error) }),
  )

/**
 * One session of the tree as its record keeps it, without its use when its messages were not read (only when its turn
 * `ended` or it is `known` to no record yet), without a duration when its info was not, and whether it runs now.
 */
async function part(ports: RefreshPorts, windows: ReadonlyArray<ModelWindow>, { entry, depth }: Below, stalled: boolean, at: number, known: boolean, ended: boolean) {
  const { sessionID } = entry
  const [{ info, gone }, use, report] = await Promise.all([
    infoOf(ports, sessionID),
    ended || !known ? ports.session.context({ sessionID }).then((messages) => useOf(messages, windows), () => undefined) : undefined,
    reportState(ports.storage, sessionID).catch(() => undefined),
  ])
  const running = info !== undefined && busy(info.time)
  const created = finite(millis(info?.time.created)) ?? entry.createdAt
  const end = info && !running && info.time.idle !== undefined ? millis(info.time.idle) : at
  const cost = finite(info?.cost)
  const record: PartRecord = {
    sessionID,
    title: info?.title ?? entry.title,
    depth,
    isolated: entry.isolated,
    ...(entry.group ? { group: entry.group } : {}),
    status: partStatus({ stopped: report?.stopped ?? false, stalled, report }),
    ...(info ? { duration: Math.max(0, end - created) } : {}),
    ...(cost !== undefined ? { cost } : {}),
  }
  return { record, use, running, unread: info === undefined, gone }
}

/** Of the parts last recorded, those the roster has forgotten before they settled whose session OpenCode no longer knows. */
async function goneSince(ports: RefreshPorts, parts: ReadonlyArray<PartRecord>, onRoster: ReadonlySet<string>) {
  const unsettled = parts.filter((one) => !onRoster.has(one.sessionID) && !isSettled(one.status))
  const looked = await Promise.all(unsettled.map(async ({ sessionID }) => ({ sessionID, ...(await infoOf(ports, sessionID)) })))
  return new Set(looked.flatMap((one) => (one.gone ? [one.sessionID] : [])))
}

/**
 * Writes the record of the tree under `top` as it stands at `at`, after the turn of `ended`; a part the roster has forgotten
 * keeps its last recorded state, unless found gone before it settled. Nothing for a top unknown to OpenCode or with memory off.
 */
export async function refresh(ports: RefreshPorts, state: Pick<MemoryState, "windows" | "off">, top: string, at: number, ended?: string): Promise<TreeRecord | undefined> {
  let info: Info
  try {
    info = await ports.session.get({ sessionID: top })
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  if (state.off.has(info.location.directory)) return undefined
  const store = memoryStore(ports.storage)
  const [previous, { nodes }] = await Promise.all([store.get(info.projectID, top), subtree(ports.storage, top)])
  // The split lines are in the top's own replies, so only its own turn end can revise one stated already; another's reads
  // them while none is stated, and only the replies finished, never a line the top is still writing.
  const own = ended === top
  const replies =
    own || !isStated(previous?.split ?? NOT_STATED)
      ? ports.session.context({ sessionID: top }).then((messages) => repliesOf(messages, !own), () => [])
      : []
  const stalled = await stalledAmong(ports, nodes.map((node) => node.entry.sessionID))
  const windows = [...state.windows.values()]
  const known = new Set(previous?.parts.map((one) => one.sessionID))
  const [read, lost] = await Promise.all([
    Promise.all(nodes.map((node) => part(ports, windows, node, stalled.has(node.entry.sessionID), at, known.has(node.entry.sessionID), node.entry.sessionID === ended))),
    goneSince(ports, previous?.parts ?? [], new Set(nodes.map((node) => node.entry.sessionID))),
  ])
  const said = await replies
  // Read again just before the write: a courier_recall or courier_note call, or another turn end's refresh, wrote meanwhile.
  const latest = (await store.get(info.projectID, top).catch(() => previous)) ?? previous
  const last = new Map(latest?.parts.map((one) => [one.sessionID, one]))
  const current = read.map(({ record, use, unread, gone }) => {
    const before = last.get(record.sessionID)
    return { ...(unread ? unreadPart(record, before, gone) : record), ...(use ?? keptUse(before)) }
  })
  const forgotten = (latest?.parts ?? []).filter((one) => lost.has(one.sessionID)).map((one) => unreadPart(one, one, true))
  const parts = mergeParts(latest?.parts ?? [], [...current, ...forgotten])
  const recalled = latest?.recalled ?? previous?.recalled
  const lesson = latest?.lesson ?? previous?.lesson
  // The first stated line stays even when compaction has dropped its reply; a later one is a revision.
  const first = latest?.split ?? NOT_STATED
  const found = splitOf(first, said.map((reply) => reply.text).join("\n"))
  const stated = statedIn(said)
  const replaced = found !== first
  const { split, revisions: recorded } = replaced ? replacingMention(found, latest?.revisions) : { split: first, revisions: latest?.revisions }
  // The line that replaced a mention is the first stated, so beside revisions already recorded it is not one of them too.
  const since = replaced && recorded ? stated.slice(1) : stated
  const revisions = split === NOT_STATED ? undefined : revise({ split, revisions: recorded }, since, at, parts.length)
  const record: TreeRecord = {
    startedAt: finite(millis(info.time.created)) ?? previous?.startedAt ?? at,
    movedAt: at,
    title: info.title ?? previous?.title ?? "",
    split,
    ...(revisions ? { revisions } : {}),
    finished: !busy(info.time) && !read.some(({ running }) => running) && parts.every((one) => isSettled(one.status)),
    ...(recalled ? { recalled } : {}),
    ...(lesson ? { lesson } : {}),
    parts,
  }
  await store.put(info.projectID, top, record)
  return record
}
