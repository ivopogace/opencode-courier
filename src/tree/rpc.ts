import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const Summary = Schema.Struct({
  running: Count,
  waiting: Count,
  idle: Count,
  stalled: Schema.optionalKey(Count),
  groups: Schema.Array(Schema.Unknown),
})

export type Summary = typeof Summary.Type

const Wait = Schema.Union([
  Schema.Struct({ type: Schema.Literal("permission"), action: Schema.String, resources: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("question"), question: Schema.String }),
  Schema.Struct({ type: Schema.Literal("form"), title: Schema.String }),
])

const Row = Schema.Struct({
  sessionID: Schema.String,
  parentID: Schema.String,
  title: Schema.String,
  depth: Count,
  state: Schema.Literals(["running", "waiting", "idle", "stalled", "gone"]),
  stalled: Schema.optionalKey(Schema.Number),
  outcome: Schema.optionalKey(Schema.Literals(["succeeded", "failed", "interrupted"])),
  resumes: Schema.optionalKey(Schema.Number),
  stopped: Schema.optionalKey(Schema.Boolean),
  report: Schema.optionalKey(
    Schema.Struct({ state: Schema.Literals(["owed", "reported", "ended"]), status: Schema.optionalKey(Schema.String), progressed: Schema.Boolean }),
  ),
  isolated: Schema.Boolean,
  native: Schema.optionalKey(Schema.Boolean),
  subagent: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(Schema.String),
  created: Schema.Number,
  idle: Schema.optionalKey(Schema.Number),
  cost: Schema.optionalKey(Schema.Number),
  context: Schema.optionalKey(Schema.Number),
  tool: Schema.optionalKey(Schema.Struct({ name: Schema.String, at: Schema.Number })),
  waits: Schema.Array(Wait),
})

const Tree = Schema.Struct({
  rows: Schema.Array(Row),
  top: Schema.optionalKey(Row),
  truncated: Schema.optionalKey(Count),
  stalled: Schema.optionalKey(Schema.Number),
})

export type Row = typeof Row.Type
export type Tree = typeof Tree.Type
export type Wait = typeof Wait.Type

const Stopped = Schema.Struct({
  stopped: Schema.Array(Schema.Struct({ sessionID: Schema.String, title: Schema.String, outcome: Schema.String })),
  cancelled: Count,
})

export type Stopped = typeof Stopped.Type

const Forgotten = Schema.Union([
  Schema.Struct({ outcome: Schema.Literals(["forgotten", "removed", "gone"]) }),
  Schema.Struct({ outcome: Schema.Literal("kept"), reason: Schema.String }),
])

export type Forgotten = typeof Forgotten.Type

export const treeRpc = Rpc.define({
  id: "courier",
  methods: {
    summary: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String })),
      output: Schema.toStandardSchemaV1(Summary),
    },
    tree: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String })),
      output: Schema.toStandardSchemaV1(Tree),
    },
    stop: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String, by: Schema.String })),
      output: Schema.toStandardSchemaV1(Stopped),
      errors: { refused: Schema.toStandardSchemaV1(Schema.Struct({})) },
    },
    cleanup: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String, by: Schema.String })),
      output: Schema.toStandardSchemaV1(Forgotten),
      errors: { refused: Schema.toStandardSchemaV1(Schema.Struct({})) },
    },
  },
  events: {},
})

export type TreeRpc = typeof treeRpc
