/**
 * The memory's RPC, the contract its TUI part, the memory view, and its server half share. Standard Schema values, as
 * the tree's and the person's; imports only `@opencode/plugin/rpc` and `effect`.
 */
import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** A part's statuses, as `memory/domain.ts`'s `PART_STATUSES` has them; a unit test keeps the two equal. */
export const PART_STATUSES = ["done", "partial", "blocked", "failed", "interrupted", "stopped", "gone", "stalled", "out"] as const

/** One session started in a tree, as its record keeps it: durations in milliseconds, context use a share of the model's window. */
const Part = Schema.Struct({
  sessionID: Schema.String,
  title: Schema.String,
  /** 1 for a session the top started. */
  depth: Count,
  isolated: Schema.Boolean,
  group: Schema.optionalKey(Schema.String),
  status: Schema.Literals(PART_STATUSES),
  duration: Schema.optionalKey(Schema.Number),
  cost: Schema.optionalKey(Schema.Number),
  context: Schema.optionalKey(Schema.Number),
  refused: Schema.optionalKey(Count),
})

/** The one line the tree's orchestrator wrote with courier_note: when, and from which depth when not the top's own. */
const Lesson = Schema.Struct({ text: Schema.String, at: Schema.Number, depth: Schema.optionalKey(Count) })

/** A tree's record as `courier_recall` reads it, with the top session it is kept under; times in epoch milliseconds. */
const Record = Schema.Struct({
  sessionID: Schema.String,
  startedAt: Schema.Number,
  movedAt: Schema.Number,
  title: Schema.String,
  split: Schema.String,
  finished: Schema.Boolean,
  recalled: Schema.optionalKey(Schema.Struct({ at: Schema.optionalKey(Schema.Number), calls: Count })),
  lesson: Schema.optionalKey(Lesson),
  /** How often other trees' courier_recall calls listed the record and gave it in full, and when one last did. */
  reads: Schema.optionalKey(Schema.Struct({ shown: Count, read: Count, at: Schema.Number })),
  /** The person's pin, when; a pinned record is listed first and never swept. */
  pinned: Schema.optionalKey(Schema.Struct({ at: Schema.Number })),
  parts: Schema.Array(Part),
})

/** The records of the project of the location asked, pinned first and then newest first; none, and `memory` false, when the option is off there. */
const Records = Schema.Struct({
  memory: Schema.Boolean,
  projectID: Schema.String,
  records: Schema.Array(Record),
})

/** What a forget did: removed the record, dropped only its lesson, or found nothing to forget. */
const Forgotten = Schema.Struct({ outcome: Schema.Literals(["record", "lesson", "none"]) })

/** What a pin did: pinned the record, unpinned it, or found no record to pin. */
const Pinned = Schema.Struct({ outcome: Schema.Literals(["pinned", "unpinned", "none"]) })

export type MemoryRecord = typeof Record.Type
export type MemoryPart = typeof Part.Type
export type MemoryLesson = typeof Lesson.Type
export type MemoryReads = NonNullable<MemoryRecord["reads"]>
export type Records = typeof Records.Type
export type Forgotten = typeof Forgotten.Type
export type Pinned = typeof Pinned.Type

export const memoryRpc = Rpc.define({
  id: "courier-memory",
  methods: {
    records: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Records),
    },
    /** Forgets the record of the tree under `sessionID` in the project asked, or with `lesson` only its lesson, keeping the facts. */
    forget: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String, lesson: Schema.optionalKey(Schema.Boolean) })),
      output: Schema.toStandardSchemaV1(Forgotten),
    },
    /** Pins the record of the tree under `sessionID` in the project asked, or with `pinned` false unpins it. */
    pin: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String, pinned: Schema.Boolean })),
      output: Schema.toStandardSchemaV1(Pinned),
    },
  },
  events: {},
})

export type MemoryRpc = typeof memoryRpc
