import type { Plugin } from "@opencode/plugin"
import { cut, isLive } from "./domain.js"
import type { CourierPorts, Lister, Pending, RosterEntry, RosterStorage, ShownForm } from "./ports.js"
import { lastStatus, reportOf } from "./report.js"
import { isExpired, type Exists } from "./roster.js"
import { turnOf } from "./running.js"
import { described } from "./status.js"
import { childStore } from "./store.js"

/**
 * A session below the one a subtree is read from, with how many levels below it is: a child is at depth 1. `subagent`
 * marks one OpenCode's subagent tool started, which has no roster entry: its `entry` is made of OpenCode's info of it.
 */
export interface Below {
  readonly entry: RosterEntry
  readonly depth: number
  readonly subagent?: true
}

/** What a read drops: the entries past retention at `now`, as `courier_children` drops them; `exists` tells a worktree still there. */
export interface Retention {
  readonly now: number
  readonly exists?: Exists
}

/** The sessions OpenCode lists under a parent, as roster entries made of its info; none when it cannot list them. */
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

/**
 * The sessions started from a session, directly or through others, every one of them, read one prefix scan per
 * parent, in the order a tree is drawn; with `retention`, without the expired entries and what is under them. With
 * `sessions`, also those OpenCode lists under each that have no roster entry, OpenCode's subagents, marked `subagent`.
 */
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
      // A native child is listed too: the roster's entry decides, kept or past retention.
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

/** The nodes in the order a tree is drawn: each followed by what it started. */
function drawn(byParent: ReadonlyMap<string, Below[]>, parentID: string): Below[] {
  return (byParent.get(parentID) ?? []).flatMap((node) => [node, ...drawn(byParent, node.entry.sessionID)])
}

type Info = Awaited<ReturnType<Plugin.Context["session"]["get"]>>

/** A session of a tree as a read looks it up: OpenCode's info of it, if it still knows it, whether it runs, and what it waits on. */
export interface Looked extends Below {
  readonly info: Info | undefined
  readonly running: boolean
  /** When its last turn ended, if it does not run and that is known. */
  readonly endedAt?: number
  readonly pending: ReadonlyArray<Pending>
  readonly forms: ReadonlyArray<ShownForm>
}

/** A session as a listing looks it up: `Looked` plus its report state, and whether it is live (`isLive`). */
export interface Listed extends Looked {
  readonly report: Awaited<ReturnType<typeof reportOf>>
  readonly live: boolean
}

export type ReadPorts = Pick<CourierPorts, "storage" | "session" | "pending" | "forms" | "now" | "limits">

/**
 * Every session under a session, without those past retention, each looked up, in the order a tree is drawn; with
 * `subagents`, OpenCode's subagents among them (`subtree`).
 */
export async function lookUp(ports: ReadPorts, rootID: string, subagents = false): Promise<Looked[]> {
  const { nodes } = await subtree(ports.storage, rootID, { now: ports.now() }, subagents ? ports.session : undefined)
  return Promise.all(nodes.map((node) => look(ports, node)))
}

/** One session looked up, as `lookUp` does each; `info` when the caller already has it. */
export async function look(ports: ReadPorts, node: Below, known?: Info): Promise<Looked> {
  const [info, pending, forms] = await Promise.all([
    known ?? ports.session.get({ sessionID: node.entry.sessionID }).catch(() => undefined),
    ports.pending(node.entry.sessionID).catch((): ReadonlyArray<Pending> => []),
    ports.forms(node.entry.sessionID).catch((): ReadonlyArray<ShownForm> => []),
  ])
  const turn = info === undefined ? undefined : await turnOf(ports.session, node.entry.sessionID, info.time)
  const running = turn?.running ?? false
  // A form outlives its session's turn only when its withdrawal was missed, as while no instance followed the events.
  return { ...node, info, running, ...(turn?.endedAt !== undefined ? { endedAt: turn.endedAt } : {}), pending, forms: running ? forms : [] }
}

/**
 * The session a subtree is read from, looked up and listed as its own sessions are, at depth 0: its roster entry when it
 * was spawned, else one made of OpenCode's info of it; none when OpenCode does not know it.
 */
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

/**
 * The listing of at most `max` of the sessions under a session, OpenCode's subagents among them: the live ones first,
 * then the newest, with what is above them, in the order a tree is drawn (`cut`); `leftOut` counts the rest.
 */
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

/**
 * The subtree under a session as courier_tree lists it (`readTree`): each session as courier_children shows it, plus
 * its depth, its parent and its report state, or `subagent` for OpenCode's; `truncated` counts the older sessions left out.
 */
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
