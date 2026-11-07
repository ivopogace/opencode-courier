import { Schema } from "effect"
import { describeFailure } from "../kernel/protocol.js"
import { rethrow, type ToolEditor } from "../kernel/tool.js"
import { LESSON_MAX } from "./domain.js"
import { note } from "./note.js"
import type { MemoryPorts, MemoryState } from "./ports.js"
import { recall } from "./recall.js"
import { NOTE_EMPTY, NOTE_OFF, NOTE_TOOL, noteBelowRefusal, noteLongRefusal, noteText, noteUnrecordedRefusal, RECALL_OFF, RECALL_TOOL, recallListText, recallMissingText, recallRecordText } from "./text.js"

export const RecallInput = Schema.Struct({
  sessionID: Schema.optional(
    Schema.String.annotate({ description: "The top session of a listed record, for that record in full; without it, one line per record of this project." }),
  ),
})

export const NoteInput = Schema.Struct({
  text: Schema.String.annotate({
    description:
      `The lesson, one line of at most ${LESSON_MAX} characters (longer is refused, not clipped): what the next orchestrator in this ` +
      "project should know about running a tree like this one, how it was split, verified or briefed, or what the person decided, " +
      "with the job it comes from and the reason.",
  }),
})

export interface MemoryToolPorts {
  readonly memory: MemoryPorts
  readonly state: Pick<MemoryState, "tops">
}

export function addMemoryTools(tools: ToolEditor, ports: MemoryToolPorts) {
  tools.add({
    name: RECALL_TOOL,
    options: { codemode: false },
    description:
      "Look once at what earlier session trees in this project did, at the root, before you decide whether and how to split " +
      "a task; a session another session started reads none, since the root weighed the records before it split. The listing: " +
      "one line per tree, those the person pinned first and then newest first, with how its top split the task, how each part went (its status, how long it ran, " +
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
          return { content: recallListText(result.records, result.top, ports.memory.now()), metadata: { projectID: result.projectID, top: result.top, records: result.records } }
        case "record":
          return { content: recallRecordText(result.record), metadata: { projectID: result.projectID, record: result.record } }
        case "missing":
          return { content: recallMissingText(result.sessionID), metadata: { projectID: result.projectID, sessionID: result.sessionID, found: false } }
      }
    },
  })
  tools.add({
    name: NOTE_TOOL,
    options: { codemode: false },
    description:
      "Write the one lesson of your session tree for the next orchestrator in this project, once you have verified and " +
      "integrated the work: what it should know about running a tree like this one that the record's facts do not say. How " +
      "it was split (which parts collided, what was too small to hand off), how it was verified (what a part got wrong and " +
      "what caught it), how the parts were briefed, or what the person decided. Name the job it comes from and the reason, " +
      "so that a lesson for one kind of job can be told from one that holds everywhere. One line, at most " +
      `${LESSON_MAX} characters; a longer one is refused, not clipped, so write it again shorter. Kept on your own tree's ` +
      "record and listed by courier_recall after its facts, dated; a second call replaces the first. From the top session " +
      "only: a session below it puts what it learned in its report. No code, no secrets, and not a rule that holds every time: that belongs " +
      "in AGENTS.md or the skill, for the person to put there, so tell them instead.",
    input: NoteInput,
    execute: async (input, context) => {
      const result = await note(ports.memory, context.sessionID, input).catch(rethrow(NOTE_TOOL))
      const refuse = (text: string) => describeFailure(NOTE_TOOL, new Error(text))
      switch (result.kind) {
        case "noted": {
          const { projectID, top, lesson, replaced } = result
          return { content: noteText(top, lesson, replaced), metadata: { projectID, top, lesson, ...(replaced ? { replaced } : {}) } }
        }
        case "off":
          throw refuse(NOTE_OFF)
        case "below":
          throw refuse(noteBelowRefusal(result.depth, result.top))
        case "empty":
          throw refuse(NOTE_EMPTY)
        case "long":
          throw refuse(noteLongRefusal(result.length))
        case "unrecorded":
          throw refuse(noteUnrecordedRefusal(result.top))
      }
    },
  })
}
