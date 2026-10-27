import { isNotFound } from "../platform/json.js"
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
 * below `maxDepth` and the writer, each only where it differs from the entry stored; a failure is logged. Returns the sessions put.
 */
export async function relesson(ports: MemoryPorts, writerID: string, top: string) {
  const entries = ports.session.instructions?.entry
  if (!entries) return []
  let sessions: string[] = []
  let entry: Entry | undefined
  try {
    ;[entry] = await lessonsOf(ports)
    if (!entry) return []
    const children = ports.maxDepth > 1 ? await childrenOf(ports.storage, top) : []
    sessions = [...new Set([top, ...children.map((child) => child.sessionID), writerID])]
  } catch (error) {
    ports.log(`courier_note: the lessons entry could not be read again: ${String(error)}`)
    return []
  }
  const value = entry
  const renew = async (sessionID: string) => {
    try {
      const stored = (await entries.list({ sessionID })).find((one) => one.key === value.key)
      if (stored?.value === value.value) return false
      await entries.put({ sessionID, key: value.key, value: value.value })
      return true
    } catch (error) {
      // A child on the roster that OpenCode no longer knows is a normal path, not one to log.
      if (!isNotFound(error)) ports.log(`courier_note: the lessons entry of ${sessionID} could not be written: ${String(error)}`)
      return false
    }
  }
  const put = await Promise.all(sessions.map(renew))
  return sessions.filter((_, index) => put[index])
}
