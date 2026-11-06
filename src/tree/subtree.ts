import type { Plugin } from "@opencode/plugin"
import { cut, isLive } from "./domain.js"
import type { CourierPorts, Lister, Pending, RosterEntry, RosterStorage, ShownForm } from "./ports.js"
import { lastStatus, reportOf } from "./report.js"
import { isExpired, type Exists } from "./roster.js"
import { turnOf } from "./running.js"
import { described } from "./status.js"
import { childStore } from "./store.js"

export interface Below {
  readonly entry: RosterEntry
  readonly depth: number
  readonly subagent?: true
}

export interface Retention {
  readonly now: number
  readonly exists?: Exists
}

async function listedUnder(sessions: Lister | undefined, parentID: string): Promise<RosterEntry[]> {
  if (!sessions?.list) return []
  const listed = await sessions.list({ parentID }).then(
    (page) => page.data,
    () => [],
  )
  return listed.map((info) => ({
    sessionID: info.id,
    parentID,
    title: info.title ?? "",
    directory: info.location.directory,
    isolated: false,
    createdAt: info.time.created,
  }))
}

export async function subtree(storage: RosterStorage, rootID: string, retention?: Retention, sessions?: Lister): Promise<{ nodes: Below[] }> {
  const children = childStore(storage)
  const byParent = new Map<string, Below[]>()
  const seen = new Set([rootID])
  const kept = (entry: RosterEntry) => !seen.has(entry.sessionID) && !(retention && isExpired(entry, retention.now, retention.exists))
  const expand = async (level: string[], depth: number): Promise<void> => {
    if (!level.length) return
    const found = await Promise.all(level.map((parentID) => Promise.all([children.children(parentID), listedUnder(sessions, parentID)])))
    const next: string[] = []
    for (const [index, [entries, listed]] of found.entries()) {
      const spawned = entries.filter(kept).map((entry): Below => ({ entry, depth }))
      for (const node of spawned) seen.add(node.entry.sessionID)
      // session.list also lists native courier children
      const onRoster = new Set(entries.map((entry) => entry.sessionID))
      const subagents = listed.filter((entry) => !onRoster.has(entry.sessionID) && kept(entry)).map((entry): Below => ({ entry, depth, subagent: true }))
      for (const node of subagents) seen.add(node.entry.sessionID)
      const all = [...spawned, ...subagents].sort((a, b) => a.entry.createdAt - b.entry.createdAt)
      if (all.length) byParent.set(level[index]!, all)
      next.push(...all.map((node) => node.entry.sessionID))
    }
    return expand(next, depth + 1)
  }
  await expand([rootID], 1)
  return { nodes: drawn(byParent, rootID) }
}

function drawn(byParent: ReadonlyMap<string, Below[]>, parentID: string): Below[] {
  return (byParent.get(parentID) ?? []).flatMap((node) => [node, ...drawn(byParent, node.entry.sessionID)])
}

type Info = Awaited<ReturnType<Plugin.Context["session"]["get"]>>

export interface Looked extends Below {
  readonly info: Info | undefined
  readonly running: boolean
  readonly endedAt?: number
  readonly pending: ReadonlyArray<Pending>
  readonly forms: ReadonlyArray<ShownForm>
}

export interface Listed extends Looked {
  readonly report: Awaited<ReturnType<typeof reportOf>>
  readonly live: boolean
}

export type ReadPorts = Pick<CourierPorts, "storage" | "session" | "pending" | "forms" | "now" | "limits">

export async function lookUp(ports: ReadPorts, rootID: string, subagents = false): Promise<Looked[]> {
  const { nodes } = await subtree(ports.storage, rootID, { now: ports.now() }, subagents ? ports.session : undefined)
  return Promise.all(nodes.map((node) => look(ports, node)))
}

export async function look(ports: ReadPorts, node: Below, known?: Info): Promise<Looked> {
  const [info, pending, forms] = await Promise.all([
    known ?? ports.session.get({ sessionID: node.entry.sessionID }).catch(() => undefined),
    ports.pending(node.entry.sessionID).catch((): ReadonlyArray<Pending> => []),
    ports.forms(node.entry.sessionID).catch((): ReadonlyArray<ShownForm> => []),
  ])
  const turn = info === undefined ? undefined : await turnOf(ports.session, node.entry.sessionID, info.time)
  const running = turn?.running ?? false
  // a form outlives its turn only if its withdrawal event was missed
  return { ...node, info, running, ...(turn?.endedAt !== undefined ? { endedAt: turn.endedAt } : {}), pending, forms: running ? forms : [] }
}

export async function readTop(ports: ReadPorts, rootID: string): Promise<Listed | undefined> {
  const info = await ports.session.get({ sessionID: rootID }).catch(() => undefined)
  if (!info) return undefined
  const children = childStore(ports.storage)
  const spawned = await children.indexedEntry(rootID).catch(() => undefined)
  const entry: RosterEntry = spawned ?? {
    sessionID: rootID,
    parentID: info.parentID ?? "",
    title: info.title ?? "",
    directory: info.location.directory,
    isolated: false,
    createdAt: info.time.created,
  }
  const looked = await look(ports, { entry, depth: 0 }, info)
  const report = await reportOf(children, rootID).catch(() => undefined)
  return { ...looked, report, live: isLive(looked.running, looked.pending.length + looked.forms.length, report) }
}

export async function readTree(ports: ReadPorts, rootID: string, max = ports.limits.maxTotal) {
  const children = childStore(ports.storage)
  const all = await Promise.all(
    (await lookUp(ports, rootID, true)).map(async (node): Promise<Listed> => {
      const report = node.subagent ? undefined : await reportOf(children, node.entry.sessionID).catch(() => undefined)
      return { ...node, report, live: isLive(node.info ? node.running : undefined, node.pending.length + node.forms.length, report) }
    }),
  )
  const listing = cut(
    all.map((node) => ({ sessionID: node.entry.sessionID, parentID: node.entry.parentID, createdAt: node.entry.createdAt, live: node.live, node })),
    max,
  )
  return { kept: listing.kept.map(({ node }) => node), leftOut: listing.leftOut }
}

export async function tree(ports: CourierPorts, rootID: string) {
  const { kept, leftOut } = await readTree(ports, rootID)
  const children = childStore(ports.storage)
  const listed = await Promise.all(
    kept.map(async ({ entry, depth, report, subagent }) => {
      const [info, last] = await Promise.all([described(ports, entry), report ? lastStatus(children, entry.sessionID).catch(() => undefined) : undefined])
      return {
        ...info,
        parentID: entry.parentID,
        depth,
        ...(subagent ? { subagent } : {}),
        ...(report
          ? { report: { owes: report.owes, progressed: report.progressed, ended: report.ended, ...(last ? { status: last } : {}) } }
          : {}),
      }
    }),
  )
  return { sessionID: rootID, sessions: listed, ...(leftOut ? { truncated: leftOut } : {}) }
}
