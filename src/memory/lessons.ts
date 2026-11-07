import { isNotFound } from "../platform/json.js"
import { childrenOf, type Entry } from "../tree/index.js"
import { pinnedFirst } from "./domain.js"
import type { MemoryPorts } from "./ports.js"
import { memoryStore } from "./store.js"
import { LESSONS_KEY, lessonsEntry } from "./text.js"

export async function lessonsOf(ports: MemoryPorts): Promise<ReadonlyArray<Entry>> {
  if (!ports.memory) return []
  const value = lessonsEntry(pinnedFirst(await memoryStore(ports.storage).ofProject(ports.projectID)))
  return value === undefined ? [] : [{ key: LESSONS_KEY, value }]
}

export async function relesson(ports: MemoryPorts, top: string) {
  const entries = ports.session.instructions?.entry
  if (!entries) return []
  let sessions: string[] = []
  let entry: Entry | undefined
  try {
    ;[entry] = await lessonsOf(ports)
    if (!entry) return []
    const children = ports.maxDepth > 1 ? await childrenOf(ports.storage, top) : []
    sessions = [top, ...children.map((child) => child.sessionID)]
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
      if (!isNotFound(error)) ports.log(`courier_note: the lessons entry of ${sessionID} could not be written: ${String(error)}`)
      return false
    }
  }
  const put = await Promise.all(sessions.map(renew))
  return sessions.filter((_, index) => put[index])
}
