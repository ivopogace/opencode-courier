import { envelope, clipText } from "../kernel/protocol.js"
import { claim } from "../platform/bounded.js"
import { bySession, lineageBy } from "./domain.js"
import { live } from "./limits.js"
import type { ChildStore, WatchPorts } from "./ports.js"
import { reportOf } from "./report.js"
import { runs } from "./running.js"
import { childStore } from "./store.js"
import { BRIEF_FIRST_LINE, typedNotice } from "./text.js"
import { noteSent, waitsInInbox, type Enqueued, type InboxSettled } from "./wake.js"

const TYPED_MAX = 4000

function typedText(item: Enqueued["data"]["item"]) {
  if (item.type !== "user") return undefined
  const { text, metadata } = item.payload ?? {}
  if (typeof text !== "string" || !text.trim() || text.startsWith(BRIEF_FIRST_LINE)) return undefined
  return metadata?.source === "courier" || (metadata && "schedule" in metadata) ? undefined : text
}

export async function noteTyped(ports: Pick<WatchPorts, "storage" | "now">, event: Enqueued) {
  const { sessionID, inboxID, item } = event.data
  const text = typedText(item)
  if (text === undefined) return false
  const children = childStore(ports.storage)
  if ((await children.indexedParent(sessionID)) === undefined) return false
  await children.typed(sessionID, inboxID, event.created ?? ports.now(), clipText(text, TYPED_MAX))
  return true
}

export function forgetTyped(ports: Pick<WatchPorts, "storage">, event: InboxSettled) {
  return childStore(ports.storage).forgetTyped(event.data.sessionID, event.data.inboxID)
}

function withLoggedGet(ports: WatchPorts) {
  return {
    storage: ports.storage,
    session: {
      context: (input: Parameters<WatchPorts["session"]["context"]>[0]) => ports.session.context(input),
      get: (input: Parameters<WatchPorts["session"]["get"]>[0]) =>
        ports.session.get(input).catch((error: unknown) => {
          ports.log(`courier fan-up: could not read session ${input.sessionID}: ${String(error)}`)
          throw error
        }),
    },
  }
}

async function rootRuns(ports: WatchPorts, root: string) {
  const info = await ports.session.get({ sessionID: root }).catch((error: unknown) => {
    ports.log(`courier fan-up: could not read session ${root}: ${String(error)}`)
    return undefined
  })
  return info !== undefined && runs(ports.session, root, info.time, ports.now())
}

async function ownsWork(ports: WatchPorts, children: ChildStore, sessionID: string) {
  const [report, waiting] = await Promise.all([reportOf(children, sessionID), waitsInInbox(ports, sessionID, { stalled: false })])
  return report?.owes === true || report?.blocked === true || waiting
}

async function othersWork(ports: WatchPorts, children: ChildStore, sessionID: string, root: string) {
  const entries = await children.all()
  const parents = bySession(entries)
  const others = entries.filter((entry) => entry.sessionID !== sessionID && lineageBy(parents, entry.sessionID).at(-1)?.parentID === root)
  const logged = withLoggedGet(ports)
  return (await Promise.all(others.map((entry) => live(logged, entry.sessionID, "live")))).some((state) => state !== undefined)
}

async function atWork(ports: WatchPorts, children: ChildStore, sessionID: string, root: string) {
  try {
    const [others, own] = await Promise.all([othersWork(ports, children, sessionID, root), ownsWork(ports, children, sessionID)])
    return others || own || (await rootRuns(ports, root))
  } catch (error) {
    ports.log(`courier fan-up: could not read the tree of ${sessionID}, so it counts as at work: ${String(error)}`)
    return true
  }
}

async function ancestorsOf(children: ChildStore, sessionID: string) {
  const indexed = await children.indexedAncestors(sessionID)
  return indexed.length ? indexed : (await children.lineage(sessionID)).map((entry) => entry.parentID)
}

async function fanUp(ports: WatchPorts, ancestors: ReadonlyArray<string>, sessionID: string, title: string | undefined, typed: { readonly at: number; readonly text: string }) {
  const text = envelope("courier", typedNotice(sessionID, title, typed.at, ports.now(), typed.text), { route: "prompt", in: sessionID })
  const description = `Text typed into ${sessionID}`
  let passed = 0
  for (const ancestor of ancestors) {
    try {
      const sent = await ports.session.synthetic({
        sessionID: ancestor,
        text,
        description,
        metadata: { source: "courier", route: "prompt", in: sessionID },
        delivery: "steer",
      })
      passed += 1
      await noteSent(ports, { sessionID: ancestor, inboxID: sent.id, text, description }).catch((error: unknown) =>
        ports.log(`courier fan-up: could not note the wake of ${ancestor}: ${String(error)}`),
      )
    } catch (error) {
      ports.log(`courier fan-up: could not pass text typed into ${sessionID} to ${ancestor}: ${String(error)}`)
    }
  }
  ports.log(`courier fan-up: text typed into ${sessionID} passed to ${passed} sessions`)
}

export async function relayTyped(ports: WatchPorts, seen: Set<string>, event: InboxSettled) {
  const { sessionID, inboxID } = event.data
  const children = childStore(ports.storage)
  const typed = await children.typedOf(sessionID, inboxID)
  if (!typed) return false
  try {
    if (!claim(seen, `typed ${sessionID} ${inboxID}`)) return false
    const ancestors = await ancestorsOf(children, sessionID)
    const root = ancestors.at(-1)
    if (root === undefined) return false
    if (!(await atWork(ports, children, sessionID, root))) {
      ports.log(`courier fan-up: text typed into ${sessionID} reached nobody: the tree has finished`)
      return false
    }
    const entry = await children.indexedEntry(sessionID).catch(() => undefined)
    await fanUp(ports, ancestors, sessionID, entry?.title, typed)
    return true
  } finally {
    await children.forgetTyped(sessionID, inboxID)
  }
}
