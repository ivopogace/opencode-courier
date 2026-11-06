import { finite, isNotFound, millis } from "../platform/json.js"
import { contextOf, reportState, stalledAmong, subtree, turnIn, turnOf, waitsInInbox, type Below, type ModelWindow, type Turn } from "../tree/index.js"
import { isSettled, isStated, mergeParts, NOT_STATED, partStatus, subagentStatus, replacingMention, revise, splitLinesOf, splitOf, unreadPart, type PartRecord, type Stated, type TreeRecord } from "./domain.js"
import type { MemoryState, RefreshPorts } from "./ports.js"
import { memoryStore } from "./store.js"

type Info = Awaited<ReturnType<RefreshPorts["session"]["get"]>>
type Messages = Awaited<ReturnType<RefreshPorts["session"]["context"]>>

const repliesOf = (messages: Messages, finished: boolean) =>
  messages.flatMap((message) =>
    message.type === "assistant" && (!finished || message.time?.completed !== undefined)
      ? [{ text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"), at: finite(millis(message.time?.created)) }]
      : [],
  )

const statedIn = (replies: ReturnType<typeof repliesOf>): Stated[] =>
  replies.flatMap(({ text, at }) => splitLinesOf(text).map((line) => (at === undefined ? { text: line } : { text: line, at })))

const refusedIn = (messages: Messages) =>
  messages.reduce(
    (n, message) => (message.type === "assistant" ? n + message.content.filter((part) => part.type === "tool" && part.name === "courier_spawn" && part.state.status === "error").length : n),
    0,
  )

type Use = Pick<PartRecord, "context" | "refused">

function useOf(messages: Messages, windows: ReadonlyArray<ModelWindow>): Use {
  const context = contextOf(messages, windows)
  const refused = refusedIn(messages)
  return { ...(context !== undefined ? { context: Math.round(context * 100) / 100 } : {}), ...(refused ? { refused } : {}) }
}

const keptUse = (last: PartRecord | undefined): Use => ({
  ...(last?.context !== undefined ? { context: last.context } : {}),
  ...(last?.refused ? { refused: last.refused } : {}),
})

const infoOf = (ports: RefreshPorts, sessionID: string): Promise<{ info?: Info; gone: boolean }> =>
  ports.session.get({ sessionID }).then(
    (info) => ({ info, gone: false }),
    (error: unknown) => ({ gone: isNotFound(error) }),
  )

async function part(ports: RefreshPorts, windows: ReadonlyArray<ModelWindow>, { entry, depth, subagent }: Below, stalled: boolean, at: number, known: boolean, ended: boolean) {
  const { sessionID } = entry
  const readAt = Date.now()
  const messages = ended || !known ? ports.session.context({ sessionID }) : undefined
  const [{ info, gone, running, endedAt }, use, report, waiting] = await Promise.all([
    infoOf(ports, sessionID).then(async (one) => {
      if (!one.info) return { ...one, running: false } as typeof one & Turn
      const turn = messages ? turnIn(ports.session, sessionID, one.info.time, messages, readAt) : turnOf(ports.session, sessionID, one.info.time)
      return { ...one, ...(await turn) }
    }),
    messages?.then((read) => useOf(read, windows), () => undefined),
    subagent ? undefined : reportState(ports.storage, sessionID).catch(() => undefined),
    waitsInInbox(ports, sessionID).catch(() => true),
  ])
  const created = finite(millis(info?.time.created)) ?? entry.createdAt
  const end = info && !running && endedAt !== undefined ? endedAt : at
  const cost = finite(info?.cost)
  const record: PartRecord = {
    sessionID,
    title: info?.title ?? entry.title,
    depth,
    isolated: entry.isolated,
    ...(subagent ? { subagent } : {}),
    ...(entry.group ? { group: entry.group } : {}),
    status: subagent ? subagentStatus({ running, stalled, outcome: info?.outcome }) : partStatus({ stopped: report?.stopped ?? false, stalled, report }),
    ...(info ? { duration: Math.max(0, end - created) } : {}),
    ...(cost !== undefined ? { cost } : {}),
  }
  return { record, use, running: running || (waiting && !gone), unread: info === undefined, gone }
}

async function goneSince(ports: RefreshPorts, parts: ReadonlyArray<PartRecord>, onRoster: ReadonlySet<string>) {
  const unsettled = parts.filter((one) => !onRoster.has(one.sessionID) && !isSettled(one.status))
  const looked = await Promise.all(unsettled.map(async ({ sessionID }) => ({ sessionID, ...(await infoOf(ports, sessionID)) })))
  return new Set(looked.flatMap((one) => (one.gone ? [one.sessionID] : [])))
}

async function topTurnAfter(ports: RefreshPorts, top: string, info: Info, messages: Promise<Messages> | undefined, readAt: number): Promise<Turn> {
  const fresh = await ports.session.get({ sessionID: top }).catch(() => undefined)
  if (fresh && millis(fresh.time.updated) > readAt) return turnOf(ports.session, top, fresh.time)
  return messages ? turnIn(ports.session, top, info.time, messages, readAt) : turnOf(ports.session, top, info.time)
}

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
  const [previous, { nodes }] = await Promise.all([store.get(info.projectID, top), subtree(ports.storage, top, undefined, ports.session)])
  const own = ended === top
  const topReadAt = Date.now()
  const topMessages = own || !isStated(previous?.split ?? NOT_STATED) ? ports.session.context({ sessionID: top }) : undefined
  const replies = topMessages ? topMessages.then((messages) => repliesOf(messages, !own), () => []) : []
  const stalled = await stalledAmong(ports, nodes.map((node) => node.entry.sessionID))
  const windows = [...state.windows.values()]
  const known = new Set(previous?.parts.map((one) => one.sessionID))
  const [read, lost] = await Promise.all([
    Promise.all(nodes.map((node) => part(ports, windows, node, stalled.has(node.entry.sessionID), at, known.has(node.entry.sessionID), node.entry.sessionID === ended))),
    goneSince(ports, previous?.parts ?? [], new Set(nodes.map((node) => node.entry.sessionID))),
  ])
  const topTurn = topTurnAfter(ports, top, info, topMessages, topReadAt)
  const [said, topRunning, topOwed] = await Promise.all([replies, topTurn.then((turn) => turn.running), waitsInInbox(ports, top).catch(() => true)])
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
  // the transcript starts at the last compaction (api-notes)
  const first = latest?.split ?? NOT_STATED
  const found = splitOf(first, said.map((reply) => reply.text).join("\n"))
  const stated = statedIn(said)
  const replaced = found !== first
  const { split, revisions: recorded } = replaced ? replacingMention(found, latest?.revisions) : { split: first, revisions: latest?.revisions }
  const since = replaced && recorded ? stated.slice(1) : stated
  const revisions = split === NOT_STATED ? undefined : revise({ split, revisions: recorded }, since, at, parts.filter((one) => !one.subagent).length)
  const record: TreeRecord = {
    startedAt: finite(millis(info.time.created)) ?? previous?.startedAt ?? at,
    movedAt: at,
    title: info.title ?? previous?.title ?? "",
    split,
    ...(revisions ? { revisions } : {}),
    finished: !topRunning && !topOwed && !read.some(({ running }) => running) && parts.every((one) => isSettled(one.status)),
    ...(recalled ? { recalled } : {}),
    ...(lesson ? { lesson } : {}),
    parts,
  }
  await store.put(info.projectID, top, record)
  return record
}
