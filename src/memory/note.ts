import { lineage } from "../tree/index.js"
import { type Lesson, lessonText } from "./domain.js"
import type { MemoryPorts } from "./ports.js"
import { memoryStore } from "./store.js"

export interface NoteInput {
  readonly text: string
}

/** Why courier_note wrote nothing: the option is off, the caller is a leaf, its text is empty, or its tree has no record to write on. */
export type Refusal =
  | { readonly kind: "off" }
  | { readonly kind: "leaf"; readonly depth: number; readonly maxDepth: number }
  | { readonly kind: "empty" }
  | { readonly kind: "unrecorded"; readonly top: string }

/** What courier_note gives: the lesson written on the caller's tree's record, with the one it replaced, or why it was not. */
export type Noted = { readonly kind: "noted"; readonly projectID: string; readonly top: string; readonly lesson: Lesson; readonly clipped?: number; readonly replaced?: Lesson } | Refusal

/**
 * courier_note: writes `text`, as one line, as the lesson on the record of the caller's own tree in this project,
 * replacing the one there; the top of the tree is the top of the caller's lineage, or itself.
 */
export async function note(ports: MemoryPorts, callerID: string, input: NoteInput): Promise<Noted> {
  if (!ports.memory) return { kind: "off" }
  const chain = await lineage(ports.storage, callerID)
  const depth = chain.length
  if (depth >= ports.maxDepth) return { kind: "leaf", depth, maxDepth: ports.maxDepth }
  const { text, clipped } = lessonText(typeof input.text === "string" ? input.text : "")
  if (!text) return { kind: "empty" }
  const top = chain.at(-1)?.parentID ?? callerID
  const store = memoryStore(ports.storage)
  const { projectID } = ports
  const record = await store.get(projectID, top)
  if (!record) return { kind: "unrecorded", top }
  const lesson: Lesson = { text, at: ports.now(), ...(depth ? { depth } : {}) }
  await store.put(projectID, top, { ...record, lesson })
  return { kind: "noted", projectID, top, lesson, ...(clipped ? { clipped } : {}), ...(record.lesson ? { replaced: record.lesson } : {}) }
}
