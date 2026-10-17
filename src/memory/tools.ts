import { Schema } from "effect"
import { rethrow, type ToolEditor } from "../kernel/tool.js"
import type { MemoryPorts, MemoryState } from "./ports.js"
import { recall } from "./recall.js"
import { RECALL_OFF, RECALL_TOOL, recallListText, recallMissingText, recallRecordText } from "./text.js"

export const RecallInput = Schema.Struct({
  sessionID: Schema.optional(
    Schema.String.annotate({ description: "The top session of a listed record, for that record in full; without it, one line per record of this project." }),
  ),
})

/** What the memory's tool runs on: one instance's ports and the process's shared state. */
export interface MemoryToolPorts {
  readonly memory: MemoryPorts
  readonly state: Pick<MemoryState, "tops">
}

/** Adds `courier_recall`, a direct tool rather than a code-mode one. */
export function addMemoryTools(tools: ToolEditor, ports: MemoryToolPorts) {
  tools.add({
    name: RECALL_TOOL,
    options: { codemode: false },
    description:
      "Look once at what earlier session trees in this project did, before you decide whether and how to split a task: " +
      "one line per tree, newest first, with how its top split the task, how each part went (its status, how long it ran, " +
      "what it cost, how full its context got) and whether a spawn was refused; with sessionID, one tree's record in full. " +
      "Records hold no report bodies or files. Call it once at the start, not in a loop, and not to check on sessions you " +
      "started: their reports wake you.",
    input: RecallInput,
    execute: async (input, context) => {
      const result = await recall(ports.memory, ports.state, context.sessionID, input).catch(rethrow(RECALL_TOOL))
      switch (result.kind) {
        case "off":
          return { content: RECALL_OFF, metadata: { memory: false } }
        case "list":
          return { content: recallListText(result.records, result.top), metadata: { projectID: result.projectID, top: result.top, records: result.records } }
        case "record":
          return { content: recallRecordText(result.record), metadata: { projectID: result.projectID, record: result.record } }
        case "missing":
          return { content: recallMissingText(result.sessionID), metadata: { projectID: result.projectID, sessionID: result.sessionID, found: false } }
      }
    },
  })
}
