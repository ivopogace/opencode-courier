import { childrenOf, type Entry } from "../tree/index.js"
import { pinnedFirst } from "./domain.js"
import type { MemoryPorts } from "./ports.js"
import { memoryStore } from "./store.js"
import { LESSONS_KEY, lessonsEntry } from "./text.js"

/**
 * The `lessons` entry of this project, as `courier_spawn` writes it to a spawned session before its prompt and to a root at
 * its first spawn: none with the memory option off, or while no record of the project holds a lesson.
 */
export async function lessonsOf(ports: MemoryPorts): Promise<ReadonlyArray<Entry>> {
  if (!ports.memory) return []
  const value = lessonsEntry(pinnedFirst(await memoryStore(ports.storage).ofProject(ports.projectID)))
  return value === undefined ? [] : [{ key: LESSONS_KEY, value }]
}

/**
 * Puts the project's lessons entry again, once a lesson was written, on the writer's tree's top, the top's current children
 * when they are below `maxDepth`, and the writer itself, each only where it differs from the entry stored (a put of the value
 * stored would change nothing, but costs a call). Best effort: a failure is logged. Returns the sessions put.
 */
export async function relesson(ports: MemoryPorts, writerID: string, top: string) {
  const entries = ports.session.instructions?.entry
  if (!entries) return []
  const put: string[] = []
  try {
    const [entry] = await lessonsOf(ports)
    if (!entry) return put
    const children = ports.maxDepth > 1 ? await childrenOf(ports.storage, top) : []
    for (const sessionID of new Set([top, ...children.map((child) => child.sessionID), writerID])) {
      try {
        const stored = (await entries.list({ sessionID })).find((one) => one.key === entry.key)
        if (stored?.value === entry.value) continue
        await entries.put({ sessionID, key: entry.key, value: entry.value })
        put.push(sessionID)
      } catch (error) {
        ports.log(`courier_note: the lessons entry of ${sessionID} could not be written: ${String(error)}`)
      }
    }
  } catch (error) {
    ports.log(`courier_note: the lessons entry could not be read again: ${String(error)}`)
  }
  return put
}
