import { lineage } from "../tree/index.js"
import { type Lesson, LESSON_MAX, oneLine } from "./domain.js"
import { relesson } from "./lessons.js"
import type { MemoryPorts } from "./ports.js"
import { memoryStore } from "./store.js"

export interface NoteInput {
  readonly text: string
}

export type Refusal =
  | { readonly kind: "off" }
  | { readonly kind: "below"; readonly depth: number; readonly top: string }
  | { readonly kind: "empty" }
  | { readonly kind: "long"; readonly length: number }
  | { readonly kind: "unrecorded"; readonly top: string }

export type Noted = { readonly kind: "noted"; readonly projectID: string; readonly top: string; readonly lesson: Lesson; readonly replaced?: Lesson } | Refusal

export async function note(ports: MemoryPorts, callerID: string, input: NoteInput): Promise<Noted> {
  if (!ports.memory) return { kind: "off" }
  const chain = await lineage(ports.storage, callerID)
  const top = chain.at(-1)?.parentID ?? callerID
  if (chain.length) return { kind: "below", depth: chain.length, top }
  const text = oneLine(typeof input.text === "string" ? input.text : "")
  if (!text) return { kind: "empty" }
  if (text.length > LESSON_MAX) return { kind: "long", length: text.length }
  const store = memoryStore(ports.storage)
  const { projectID } = ports
  const record = await store.get(projectID, top)
  if (!record) return { kind: "unrecorded", top }
  const lesson: Lesson = { text, at: ports.now() }
  await store.put(projectID, top, { ...record, lesson })
  await relesson(ports, top)
  return { kind: "noted", projectID, top, lesson, ...(record.lesson ? { replaced: record.lesson } : {}) }
}
