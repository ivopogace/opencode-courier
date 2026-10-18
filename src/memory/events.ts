import { claim } from "../platform/bounded.js"
import type { EventModule, EventPorts, HostEvent } from "../platform/events.js"
import { childrenOf, indexedLineage } from "../tree/index.js"
import type { MemoryState, RefreshPorts } from "./ports.js"
import { refresh } from "./record.js"

/** OpenCode's `session.execution.*` events, as the memory reads them. */
interface Execution {
  readonly id: string
  readonly created?: number
  readonly data: { readonly sessionID: string; readonly reason?: string }
}

const TURN_ENDS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

/** The ports the event module runs on: the watcher's, which every hub-v2 member joins with. */
export type MemoryEventPorts = RefreshPorts & EventPorts

/**
 * The top of the tree a session is in: by the reverse index for a spawned one, else the session itself when it called
 * courier_recall or has started sessions; undefined for a session in no tree.
 */
export async function topOf(ports: Pick<RefreshPorts, "storage">, state: Pick<MemoryState, "tops">, sessionID: string) {
  const chain = await indexedLineage(ports.storage, sessionID)
  if (chain.length) return chain.at(-1)!.parentID
  if (state.tops.has(sessionID)) return sessionID
  return (await childrenOf(ports.storage, sessionID)).length ? sessionID : undefined
}

/** A turn ended in a tree: its record is written again, once however many subscriptions see the event. Returns the top refreshed. */
export async function noteTurnEnd(ports: RefreshPorts, state: MemoryState, event: Execution) {
  // A shutdown's interruption is resumed on the next start: nothing ended.
  if (event.data.reason === "shutdown") return undefined
  const top = await topOf(ports, state, event.data.sessionID)
  // Claimed after the lookup, so other sessions' turns do not crowd `seen`; released on a failure, as a write is
  // the same twice, so the hub's other subscription may still make it.
  if (top === undefined || !claim(state.seen, event.id)) return undefined
  try {
    await refresh(ports, state, top, event.created ?? ports.now(), event.data.sessionID)
  } catch (error) {
    state.seen.delete(event.id)
    throw error
  }
  return top
}

/**
 * Keeps each tree's record current: after the tree's and the person's notices of a turn's end have gone out, and the
 * report state it settled is written, the record of the tree it belongs to is rebuilt. A failure is logged, never thrown.
 */
export function memoryEvents(state: MemoryState): EventModule<MemoryEventPorts> {
  return {
    after: (ports, event: HostEvent) =>
      TURN_ENDS.has(event.type)
        ? noteTurnEnd(ports, state, event as unknown as Execution).then(
            () => undefined,
            (error: unknown) => ports.log(`courier memory: could not record the tree of ${(event.data as Execution["data"] | undefined)?.sessionID}: ${String(error)}`),
          )
        : undefined,
  }
}
