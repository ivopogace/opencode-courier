import { claim } from "../platform/bounded.js"
import type { EventModule, EventPorts, EventType, HostEvent } from "../platform/events.js"
import { childrenOf, endsIdle, indexedLineage } from "../tree/index.js"
import type { MemoryState, RefreshPorts } from "./ports.js"
import { refresh } from "./record.js"

interface Execution {
  readonly id: string
  readonly created?: number
  readonly data: { readonly sessionID: string; readonly reason?: string }
}

const TURN_END_TYPES = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] as const satisfies readonly EventType[]
const TURN_ENDS = new Set<string>(TURN_END_TYPES)

export type MemoryEventPorts = RefreshPorts & EventPorts

export async function topOf(ports: Pick<RefreshPorts, "storage">, state: Pick<MemoryState, "tops">, sessionID: string) {
  const chain = await indexedLineage(ports.storage, sessionID)
  if (chain.length) return chain.at(-1)!.parentID
  if (state.tops.has(sessionID)) return sessionID
  return (await childrenOf(ports.storage, sessionID)).length ? sessionID : undefined
}

export async function noteTurnEnd(ports: RefreshPorts, state: MemoryState, event: Execution) {
  const top = await topOf(ports, state, event.data.sessionID)
  if (top === undefined) return undefined
  // a plain permission decline also reports "shutdown" (api-notes)
  if (event.data.reason === "shutdown" && !endsIdle(await ports.session.context({ sessionID: event.data.sessionID }).catch(() => []))) return undefined
  if (!claim(state.seen, event.id)) return undefined
  try {
    await refresh(ports, state, top, event.created ?? ports.now(), event.data.sessionID)
  } catch (error) {
    state.seen.delete(event.id)
    throw error
  }
  return top
}

export function memoryEvents(state: MemoryState): EventModule<MemoryEventPorts> {
  return {
    types: TURN_END_TYPES,
    after: (ports, event: HostEvent) =>
      TURN_ENDS.has(event.type)
        ? noteTurnEnd(ports, state, event as unknown as Execution).then(
            () => undefined,
            (error: unknown) => ports.log(`courier memory: could not record the tree of ${(event.data as Execution["data"] | undefined)?.sessionID}: ${String(error)}`),
          )
        : undefined,
  }
}
