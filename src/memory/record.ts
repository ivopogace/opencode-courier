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

/** One session of the tree as its record keeps it, and whether it runs now. */
async function part(ports: RefreshPorts, windows: ReadonlyArray<ModelWindow>, { entry, depth }: Below, stalled: boolean, at: number) {
  const { sessionID } = entry
  const [info, messages, report] = await Promise.all([
    ports.session.get({ sessionID }).catch((): Info | undefined => undefined),
    ports.session.context({ sessionID }).catch((): Messages => []),
    reportState(ports.storage, sessionID).catch(() => undefined),
  ])
  const running = info !== undefined && busy(info.time)
  const created = finite(millis(info?.time.created)) ?? entry.createdAt
  const end = info && !running && info.time.idle !== undefined ? millis(info.time.idle) : at
  const cost = finite(info?.cost)
  const context = contextOf(messages, windows)
  const refused = refusedIn(messages)
  const record: PartRecord = {
    sessionID,
    title: info?.title ?? entry.title,
    depth,
    isolated: entry.isolated,
    ...(entry.group ? { group: entry.group } : {}),
    status: partStatus({ stopped: report?.stopped ?? false, stalled, report }),
    duration: Math.max(0, end - created),
    ...(cost !== undefined ? { cost } : {}),
    ...(context !== undefined ? { context: Math.round(context * 100) / 100 } : {}),
    ...(refused ? { refused } : {}),
  }
  return { record, running }
}

/**
 * Writes the record of the tree under `top` as it stands at `at`; a part the roster has forgotten keeps its last recorded
 * state. Nothing for a top OpenCode no longer knows, or whose location has memory off. Returns the record written.
 */
export async function refresh(ports: RefreshPorts, state: Pick<MemoryState, "windows" | "off">, top: string, at: number): Promise<TreeRecord | undefined> {
  let info: Info
  try {
    info = await ports.session.get({ sessionID: top })
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  if (state.off.has(info.location.directory)) return undefined
  const store = memoryStore(ports.storage)
  const [previous, { nodes }, replies] = await Promise.all([
    store.get(info.projectID, top),
    subtree(ports.storage, top),
    ports.session.context({ sessionID: top }).then(repliesOf, () => ""),
  ])
  const stalled = await stalledAmong(ports, nodes.map((node) => node.entry.sessionID))
  const windows = [...state.windows.values()]
  const read = await Promise.all(nodes.map((node) => part(ports, windows, node, stalled.has(node.entry.sessionID), at)))
  const parts = mergeParts(previous?.parts ?? [], read.map(({ record }) => record))
  // Read again just before the write: a courier_recall or courier_note call during the reads above has written meanwhile.
  const latest = await store.get(info.projectID, top).catch(() => previous)
  const recalled = latest?.recalled ?? previous?.recalled
  const lesson = latest?.lesson ?? previous?.lesson
  const record: TreeRecord = {
    startedAt: finite(millis(info.time.created)) ?? previous?.startedAt ?? at,
    movedAt: at,
    title: info.title ?? previous?.title ?? "",
    split: splitLineOf(replies) ?? previous?.split ?? NOT_STATED,
    finished: !busy(info.time) && !read.some(({ running }) => running) && parts.every((one) => one.status !== "out" && one.status !== "stalled"),
    ...(recalled ? { recalled } : {}),
    ...(lesson ? { lesson } : {}),
    parts,
  }
  await store.put(info.projectID, top, record)
  return record
}
