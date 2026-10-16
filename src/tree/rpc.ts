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
  /** Running, and waiting on no request or form. */
  running: Count,
  /** Waiting on a permission request, a question or a form it shows, which go to the person. */
  waiting: Count,
  /** Not running: done, or waiting for a message. */
  idle: Count,
  /** Left a courier message waiting while idle, and did not take it once woken again; the session itself counts too. Absent at 0. */
  stalled: Schema.optionalKey(Count),
  groups: Schema.Array(Group),
})

export type Summary = typeof Summary.Type

/** A request a session waits on until the person answers it: a permission request, its first question, or a form it shows. */
const Wait = Schema.Union([
  Schema.Struct({ type: Schema.Literal("permission"), action: Schema.String, resources: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("question"), question: Schema.String }),
  Schema.Struct({ type: Schema.Literal("form"), title: Schema.String }),
])

/** One session of the tree panel: what courier_tree shows of it, and what it is doing, in epoch milliseconds. */
const Row = Schema.Struct({
  sessionID: Schema.String,
  parentID: Schema.String,
  title: Schema.String,
  /** A child of the panel's session is at depth 1. */
  depth: Count,
  /**
   * `waiting` on a request to the person or a form it shows them; `stalled` when a courier message waits in its inbox and
   * waking it again did not start a turn; `gone` when OpenCode no longer knows it.
   */
  state: Schema.Literals(["running", "waiting", "idle", "stalled", "gone"]),
  /** Since when its oldest message that did not wake it has waited, when it is stalled. */
  stalled: Schema.optionalKey(Schema.Number),
  /** How its last turn ended. */
  outcome: Schema.optionalKey(Schema.Literals(["succeeded", "failed", "interrupted"])),
  /** Set when courier_stop stopped it since its last prompt. */
  stopped: Schema.optionalKey(Schema.Boolean),
  /** Its report since its last prompt: still owed, arrived (held with its group or delivered), or its turn ended without one. */
  report: Schema.optionalKey(
    Schema.Struct({ state: Schema.Literals(["owed", "reported", "ended"]), status: Schema.optionalKey(Schema.String), progressed: Schema.Boolean }),
  ),
  /** Its join group, and its standing there: `held`, `out`, how it left, or `released`. */
  group: Schema.optionalKey(Schema.Struct({ name: Schema.String, standing: Schema.String })),
  isolated: Schema.Boolean,
  created: Schema.Number,
  /** When its last turn ended, if it is not running. */
  idle: Schema.optionalKey(Schema.Number),
  /** What it has cost so far, in US dollars. */
  cost: Schema.optionalKey(Schema.Number),
  /** How full its context is, as a fraction of the model's window; left out when the model or its limit cannot be read. */
  context: Schema.optionalKey(Schema.Number),
  /** Its last tool call, and when it was made. */
  tool: Schema.optionalKey(Schema.Struct({ name: Schema.String, at: Schema.Number })),
  waits: Schema.Array(Wait),
})

/** The sessions under a session, as courier_tree lists them, in the order a tree is drawn. */
const Tree = Schema.Struct({
  rows: Schema.Array(Row),
  /** How many older sessions the listing left out, when it had more than `maxTotal`: the live ones come first, then the newest. */
  truncated: Schema.optionalKey(Count),
  /** Since when a courier message has waited in the panel's own session, when that session is stalled. */
  stalled: Schema.optionalKey(Schema.Number),
})

export type Row = typeof Row.Type
export type Tree = typeof Tree.Type
export type Wait = typeof Wait.Type

/** What a stop did to each session, deepest first, as courier_stop reports it. */
const Stopped = Schema.Struct({
  stopped: Schema.Array(Schema.Struct({ sessionID: Schema.String, title: Schema.String, outcome: Schema.String })),
  /** How many scheduled messages were cancelled. */
  cancelled: Count,
})

export type Stopped = typeof Stopped.Type

/** What courier_cleanup did: forgot it, removed its worktree, found that already gone, or kept the worktree, saying why. */
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
    /** Stops `sessionID` and everything under it, as courier_stop called from `by`, which must be above it. */
    stop: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String, by: Schema.String })),
      output: Schema.toStandardSchemaV1(Stopped),
      errors: { refused: Schema.toStandardSchemaV1(Schema.Struct({})) },
    },
    /** Forgets `sessionID` as courier_cleanup called from its parent, without `force`; `by` must be above it. */
    cleanup: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String, by: Schema.String })),
      output: Schema.toStandardSchemaV1(Forgotten),
      errors: { refused: Schema.toStandardSchemaV1(Schema.Struct({})) },
    },
  },
  events: {},
})

export type TreeRpc = typeof treeRpc
