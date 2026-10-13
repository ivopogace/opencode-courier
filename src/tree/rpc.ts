/**
 * The tree's RPC, the contract its TUI part and its server half share. Standard Schema values, so the promise
 * API's `rpc.register` and the TUI's `client.rpc` both type it; imports only `@opencode/plugin/rpc` and `effect`.
 */
import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** A join group the session opened, with how many of its members have reported and how many have not left. */
const Group = Schema.Struct({ name: Schema.String, reported: Count, members: Count })

/** The sessions started under a session, as the prompt footer's status entry shows them. */
const Summary = Schema.Struct({
  /** Running, and waiting on no request. */
  running: Count,
  /** Waiting on a permission request or a question, which go to the person. */
  waiting: Count,
  /** Not running: done, or waiting for a message. */
  idle: Count,
  groups: Schema.Array(Group),
  /** Set when the subtree had more sessions than `maxTotal`, which were not counted. */
  truncated: Schema.optionalKey(Count),
})

export type Summary = typeof Summary.Type

export const treeRpc = Rpc.define({
  id: "courier",
  methods: {
    summary: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String })),
      output: Schema.toStandardSchemaV1(Summary),
    },
  },
  events: {},
})

export type TreeRpc = typeof treeRpc
