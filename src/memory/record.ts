import { finite, isNotFound, millis } from "../platform/json.js"
import { busy, contextOf, reportState, stalledAmong, subtree, type Below, type ModelWindow } from "../tree/index.js"
import { mergeParts, NOT_STATED, partStatus, splitLineOf, type PartRecord, type TreeRecord } from "./domain.js"
import type { MemoryState, RefreshPorts } from "./ports.js"
import { memoryStore } from "./store.js"

type Info = Awaited<ReturnType<RefreshPorts["session"]["get"]>>
type Messages = Awaited<ReturnType<RefreshPorts["session"]["context"]>>

/** The text of a session's replies, in order, for its split line. */
const repliesOf = (messages: Messages) =>
  messages
    .flatMap((message) => (message.type === "assistant" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : []))
    .join("\n")

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

/**
 * One session of the tree as its record keeps it, without its use when its messages were not read (only when its turn
 * `ended` or it is `known` to no record yet), and whether it runs now.
 */
async function part(ports: RefreshPorts, windows: ReadonlyArray<ModelWindow>, { entry, depth }: Below, stalled: boolean, at: number, known: boolean, ended: boolean) {
  const { sessionID } = entry
  const [info, use, report] = await Promise.all([
    ports.session.get({ sessionID }).catch((): Info | undefined => undefined),
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
    duration: Math.max(0, end - created),
    ...(cost !== undefined ? { cost } : {}),
  }
  return { record, use, running }
}

/**
 * Writes the record of the tree under `top` as it stands at `at`, after the turn of `ended`; a part the roster has forgotten
 * keeps its last recorded state. Nothing for a top unknown to OpenCode or in a location with memory off; returns the record.
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
  // The split line is in the top's own replies, so only its own turn end can change one stated already.
  const replies = ended === top || (previous?.split ?? NOT_STATED) === NOT_STATED ? ports.session.context({ sessionID: top }).then(repliesOf, () => "") : ""
  const stalled = await stalledAmong(ports, nodes.map((node) => node.entry.sessionID))
  const windows = [...state.windows.values()]
  const known = new Set(previous?.parts.map((one) => one.sessionID))
  const read = await Promise.all(
    nodes.map((node) => part(ports, windows, node, stalled.has(node.entry.sessionID), at, known.has(node.entry.sessionID), node.entry.sessionID === ended)),
  )
  const split = splitLineOf(await replies)
  // Read again just before the write: a courier_recall or courier_note call, or another turn end's refresh, wrote meanwhile.
  const latest = (await store.get(info.projectID, top).catch(() => previous)) ?? previous
  const last = new Map(latest?.parts.map((one) => [one.sessionID, one]))
  const parts = mergeParts(latest?.parts ?? [], read.map(({ record, use }) => ({ ...record, ...(use ?? keptUse(last.get(record.sessionID))) })))
  const recalled = latest?.recalled ?? previous?.recalled
  const lesson = latest?.lesson ?? previous?.lesson
  const record: TreeRecord = {
    startedAt: finite(millis(info.time.created)) ?? previous?.startedAt ?? at,
    movedAt: at,
    title: info.title ?? previous?.title ?? "",
    split: split ?? latest?.split ?? NOT_STATED,
    finished: !busy(info.time) && !read.some(({ running }) => running) && parts.every((one) => one.status !== "out" && one.status !== "stalled"),
    ...(recalled ? { recalled } : {}),
    ...(lesson ? { lesson } : {}),
    parts,
  }
  await store.put(info.projectID, top, record)
  return record
}
