import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const PART_STATUSES = ["done", "partial", "blocked", "failed", "interrupted", "stopped", "gone", "stalled", "out"] as const

const Part = Schema.Struct({
  sessionID: Schema.String,
  title: Schema.String,
  depth: Count,
  isolated: Schema.Boolean,
  subagent: Schema.optionalKey(Schema.Boolean),
  group: Schema.optionalKey(Schema.String),
  status: Schema.Literals(PART_STATUSES),
  duration: Schema.optionalKey(Schema.Number),
  cost: Schema.optionalKey(Schema.Number),
  context: Schema.optionalKey(Schema.Number),
  refused: Schema.optionalKey(Count),
})

const Lesson = Schema.Struct({ text: Schema.String, at: Schema.Number, depth: Schema.optionalKey(Count) })

const Record = Schema.Struct({
  sessionID: Schema.String,
  startedAt: Schema.Number,
  movedAt: Schema.Number,
  title: Schema.String,
  split: Schema.String,
  finished: Schema.Boolean,
  recalled: Schema.optionalKey(Schema.Struct({ at: Schema.optionalKey(Schema.Number), calls: Count })),
  lesson: Schema.optionalKey(Lesson),
  reads: Schema.optionalKey(Schema.Struct({ shown: Count, read: Count, at: Schema.Number })),
  pinned: Schema.optionalKey(Schema.Struct({ at: Schema.Number })),
  parts: Schema.Array(Part),
})

const Records = Schema.Struct({
  memory: Schema.Boolean,
  projectID: Schema.String,
  records: Schema.Array(Record),
})

const Forgotten = Schema.Struct({ outcome: Schema.Literals(["record", "lesson", "none"]) })

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
    forget: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String, lesson: Schema.optionalKey(Schema.Boolean) })),
      output: Schema.toStandardSchemaV1(Forgotten),
    },
    pin: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String, pinned: Schema.Boolean })),
      output: Schema.toStandardSchemaV1(Pinned),
    },
  },
  events: {},
})

export type MemoryRpc = typeof memoryRpc
