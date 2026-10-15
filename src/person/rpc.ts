/**
 * The person's RPC, the contract its TUI part, the asks inbox, and its server half share. Standard Schema values,
 * as the tree's; imports only `@opencode/plugin/rpc` and `effect`.
 */
import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** A session of the tree, as the inbox names where an ask comes from. */
const Session = Schema.Struct({
  sessionID: Schema.String,
  title: Schema.String,
  parentID: Schema.String,
  /** A child of the tree's top session is at depth 1. */
  depth: Count,
  group: Schema.optionalKey(Schema.String),
})

/** A permission request a session of the tree, the top among them, waits on. */
const Permission = Schema.Struct({
  sessionID: Schema.String,
  requestID: Schema.String,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  /** What "always" would allow from now on; absent when it is not offered. */
  save: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The request below that allowing this one passes on: the top's courier_answer prompt. */
  passesOn: Schema.optionalKey(Schema.Struct({ sessionID: Schema.String, requestID: Schema.String })),
})

/** One question of OpenCode's question tool. */
const Prompt = Schema.Struct({
  question: Schema.String,
  header: Schema.String,
  options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
  multiple: Schema.optionalKey(Schema.Boolean),
})

/** A question a session of the tree waits on; `stopped` when its call was cut off and the answer goes as a message. */
const Question = Schema.Struct({
  sessionID: Schema.String,
  requestID: Schema.String,
  questions: Schema.Array(Prompt),
  stopped: Schema.optionalKey(Schema.Boolean),
})

/** What the sessions of a courier tree wait on the person for, but forms, which the TUI lists itself. */
const Asks = Schema.Struct({
  /** The session at the top of the tree, which the sessions below were started from. */
  top: Schema.String,
  /** The sessions below the top, in the order a tree is drawn. */
  sessions: Schema.Array(Session),
  /** The top session's own requests first, then those of the sessions below. */
  permissions: Schema.Array(Permission),
  questions: Schema.Array(Question),
})

export type Asks = typeof Asks.Type
export type AskedQuestion = typeof Question.Type
export type AskedPermission = typeof Permission.Type
export type TreeSession = typeof Session.Type

/** What answering a question did; `problem` says why nothing was passed on, when it was refused. */
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
