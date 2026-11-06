import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const Session = Schema.Struct({
  sessionID: Schema.String,
  title: Schema.String,
  parentID: Schema.String,
  depth: Count,
  group: Schema.optionalKey(Schema.String),
})

const Permission = Schema.Struct({
  sessionID: Schema.String,
  requestID: Schema.String,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  save: Schema.optionalKey(Schema.Array(Schema.String)),
  passesOn: Schema.optionalKey(Schema.Struct({ sessionID: Schema.String, requestID: Schema.String })),
})

const Prompt = Schema.Struct({
  question: Schema.String,
  header: Schema.String,
  options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
  multiple: Schema.optionalKey(Schema.Boolean),
})

const Question = Schema.Struct({
  sessionID: Schema.String,
  requestID: Schema.String,
  questions: Schema.Array(Prompt),
  stopped: Schema.optionalKey(Schema.Boolean),
})

const Asks = Schema.Struct({
  top: Schema.String,
  sessions: Schema.Array(Session),
  permissions: Schema.Array(Permission),
  questions: Schema.Array(Question),
})

export type Asks = typeof Asks.Type
export type AskedQuestion = typeof Question.Type
export type AskedPermission = typeof Permission.Type
export type TreeSession = typeof Session.Type

const Answered = Schema.Struct({
  answered: Schema.Boolean,
  by: Schema.optionalKey(Schema.Literals(["result", "message"])),
  problem: Schema.optionalKey(Schema.String),
})

export type Answered = typeof Answered.Type

export const personRpc = Rpc.define({
  id: "courier-person",
  methods: {
    asks: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String })),
      output: Schema.toStandardSchemaV1(Asks),
    },
    answer: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({ sessionID: Schema.String, requestID: Schema.String, answers: Schema.Array(Schema.Array(Schema.String)) }),
      ),
      output: Schema.toStandardSchemaV1(Answered),
    },
  },
  events: {},
})

export type PersonRpc = typeof personRpc
