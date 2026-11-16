# Plugin API traps

What the OpenCode V2 plugin API and host do that the plugin works around or relies on, at
`@opencode/plugin@2.3.0` and OpenCode 2.3.0. Only two kinds are listed: traps no unit or e2e test
catches, and facts a pin bump must re-check. A trap a test fails on lives in that test. OpenCode's
source is on the `v2` branch of https://github.com/anomalyco/opencode, each release tagged
(`v2.3.0`); a host path is given where a pin bump must find the code again. A "since" stays only
where the plugin branches on an older host. How the modules fit together:
[architecture.md](architecture.md).

Each trap: **its name**, what the host does and what courier does about it, then `Where:` when
code handles it.

## Tools

- **The host decodes tool input** with its own `effect`, so a plugin schema's checks and
  transformations are not run. Tool inputs use plain schemas and validate values themselves. Where:
  `src/*/tools.ts`.
- **Undeclared keys are deleted** before a tool runs (`tool-input-repair`), so a renamed optional key
  stays declared under its old name while it is accepted. Where: `src/*/tools.ts`.
- **Reading `context.signal` opts into a cooperative stop**: the tool's return becomes its result
  on the person's stop. Courier's tools read only `sessionID`, `id` and `messageID` and never spread
  the context, so a stop interrupts them. Where: `src/*/tools.ts`.

## Events

- **Events reach every location's instance**, with the same id, but only while it is subscribed
  (`permission.*`, `form.*`, `session.execution.*`). The hub keeps a standby subscription for
  hand-over and relays pending requests on every (re)subscribe. Where: `src/platform/hub.ts`,
  `relayPending` in `src/person/events.ts`.
- **`subscribe({ types })`** (since `@opencode/plugin@2.2.0`) filters the stream, but courier still
  drops other types itself. `server.connected` never reaches a plugin and the adapter does not pass
  `onActivity`, so the `followed` hooks run at the first event or `CONNECTED_MS`. Where:
  `src/platform/events.ts`.
- **An execution is one busy period**: `session.execution.started`, then one `.succeeded`,
  `.failed` or `.interrupted` (`reason` `user` or `shutdown`) however many prompts were steered in.
  A steer is `inbox.enqueued` (`delivery: "steer"`), `inbox.delivered` at the next step, one
  `.succeeded`; an interrupt with `resume` while a steer waits gives `.interrupted`, `.started`, then
  the steer's `delivered`. The schema's `inactivity` and `superseded` reasons are never published. A
  pin bump re-checks these shapes. Where: `src/tree/events.ts`.
- **`retryAfterMs` can overflow a `Date`**: it counts from the event's `created`, and a provider
  header is clamped to 2^53 ms. Courier ignores a wait over 30 days. Where: `src/tree/domain.ts`.
- **Closing a stream can hang** while a location closes, so courier does not await `return()`.
  Where: `src/platform/events.ts`.
- **`session.status` and `session.idle` are never published** in core; courier does not use them.

## The inbox and wakes

- **Only `enqueued` says what an item is.** `session.inbox.enqueued` carries the type (`user`,
  `synthetic`, `compaction`, `move`) and a synthetic item's `payload.metadata`; `delivered` carries
  only `inboxID`, and the `synthetic` call's returned id may arrive after it. The runner's own
  compactions and its output-limit continuation skip the inbox. Courier keeps each item's kind until
  delivery, and `notePrompt` tells its own messages apart by metadata. Where: `src/tree/events.ts`.
- **A `user` item does not say where it came from**: the API, `opencode run`, `/init`, `/review`, a
  prompt with a skill attached and a `subagent` follow-up all arrive with `metadata: null`. The
  fan-up of typed text goes by item kind. Where: `src/tree/relay.ts`.
- **What the TUI sends** (`packages/tui/src/component/prompt/index.tsx`): typed text through
  `data.session.prompt`, a slash command through `session.command`; `!` calls `session.shell`, which
  admits no `user` item. A pin bump re-checks each. Where: `src/tree/relay.ts`.
- **`/goal`'s kickoff** (`packages/core/src/plugin/goal.ts`, `source: "goal"`) is `synthetic`, or a
  `user` prompt when it has attachments, which the fan-up passes up. A pin bump re-checks which.
  Where: `src/tree/relay.ts`.
- **`session.inbox.cancelled`** (`packages/core/src/session/inbox.ts`) comes for an item withdrawn
  before delivery; courier drops a typed-in item's stored text on it. A pin bump re-checks it.
  Where: `src/tree/relay.ts`.
- **A healthy wake** is `enqueued → started → delivered → … → succeeded`; only a new synthetic,
  prompt, compaction, skill or resume rings the run coordinator again. Where: `src/tree/wake.ts`.
- **A lost wake is silent**: `enqueued` with no `started`, when a revert is staged or an interrupt
  falls between the doorbell and the stop. Neither reproduces on demand, so `watchWake` keys on the
  signature. Where: `src/tree/wake.ts`.
- **A waiting item is invisible**: it is not in the transcript until delivered, and the plugin API
  cannot list the inbox. `session.synthetic` with the id of a waiting or delivered item returns it
  and wakes the session again, so a re-sent wake adds no message. Where: `src/tree/wake.ts`.
- **`resume: false` is the only way to send without starting a turn**, and `enqueued` does not carry
  it, so courier marks such messages in their metadata and `watchWake` skips them. Where:
  `src/tree/wake.ts`.

## Is a session running

- **`time.updated` is no sign of activity**: renames, metadata, permissions, agent and model
  switches, moves, archive, reverts, `enqueued` and step boundaries stamp it; a turn's tool and text
  events and its end do not. Where: `src/tree/running.ts`.
- **`time.idle` and `time.busy`.** `idle` is the last turn's end, never from a shutdown; `busy`
  (since 2.2.2) the latest execution's start. `busy` after `idle` is running, or at rest after a
  shutdown or a plain decline; only the transcript tells which. Where: `src/tree/running.ts`.
- **The transcript** starts at the last compaction. A turn ends on an `idle` message, or on an
  `aborted` assistant message (`STEP_INTERRUPTED`) for a plain decline, a dismissed question or a
  shutdown mid-step; `agent-switched`, `model-switched`, `location-switched` and `shell` are no
  turn. Where: `endsIdle` in `src/tree/domain.ts`.
- **A delivered item stamps nothing until its first step**, so a session about to run can read at
  rest. Where: `src/tree/running.ts`.

## The idle hook

`experimental.idle` (since 2.2.4) runs in `packages/core/src/session/runner/llm.ts` when a session
that ran the model would go idle. A pin bump re-checks its name, its shape (courier reads only
`sessionID` and each `background` item's `sessionID`) and its order.

- **Admitted input keeps the execution going**, so a hook that always admits loops forever. The
  reminder goes with `resume: false`, and the `nudged` note bounds it to one per prompt. Where:
  `src/tree/nudge.ts`.
- **It does not run** after an interruption, a failure or control-only work; those ends are told
  without a reminder. A throw fails the execution, so `onIdle` logs every failure. Where:
  `src/tree/nudge.ts`.
- **Unknown hook names are accepted**: a host without the hook never runs it, and the parent is
  told of a silent end instead. Where: `src/index.ts`.
- **Order:** each loaded instance's callback runs, in registration order, after `pre` built-ins such
  as `/goal`'s; the hub's claim keeps it to one reminder. A goal's continuation may already be
  pending, and both go in the next step. Where: `src/tree/nudge.ts`.

## Permission requests

- **Requests are per location**: an instance answers only its own, so an isolated child's request
  goes through the instance in its worktree. Where: `src/person/permission.ts`.
- **A rejection without a message ends the asking turn**; with one, only the call fails. Every
  courier rejection carries one. Where: `src/person/permission.ts`.
- **A plain decline looks like a shutdown**: `interrupted` with `reason: "shutdown"`, no `time.idle`,
  and the next boot resumes the turn ("The server restarted while you were working"); a message
  steered in meanwhile is delivered at once in a turn of its own. Courier tells it apart by the transcript ending on the aborted
  message. Where: `endsIdle` in `src/tree/domain.ts`, `wakeEnded` in `src/tree/wake.ts`.
- **`permission.assert` resolves with nothing**: the request's id and `once` or `always` come only
  from the events, and with `save` an `always` saves a project-wide rule, so `courier_answer`
  asserts without it. A refusal is a `Tool.Error` whose `message` holds the person's feedback; a
  plain rejection throws `Permission.DeclinedError`, which ends the step only if rethrown untouched.
  Where: `refusalOf` in `src/person/permission.ts`.
- **`opencode run --auto` replies `once`** to every request in its session, asserted ones included,
  so the scenario that holds the top's prompt drives the parent through the API. Where:
  `e2e/run.sh`.
- **The TUI's prompt shows little of a plugin's action** (`Tool: <action>`), and `assert` cannot set
  a `message`. `permission.list` returns `metadata` and `source`, from which the asks inbox reads
  which child a top prompt is for. Where: `src/person/tui.tsx`.

## The question tool and forms

- **`tool.transform` replaces any tool**, OpenCode's `question` included; a later plugin that
  replaces it too drops the relay. Where: `src/person/question/relay.ts`.
- **Only an interrupt withdraws a question**: the plugin API cannot answer or withdraw a form. So the
  default export is an Effect plugin that runs the promise plugin through `fromPromise` and wraps
  `question` with the Effect API, whose `execute` can be interrupted. The relay finds its ports by
  the `location` object the adapter passes through unchanged. Where: `src/index.ts`,
  `src/person/question/relay.ts`.
- **Forms live in memory**: a restart drops them, and a dismissal kills the call with
  `QuestionTool.CancelledError`, ending the turn. Where: `src/person/question/pure.ts`.
- **A hidden field is not asked**: a condition on an unanswered field is false, and OpenCode's form
  view submits a hidden field's default. The asks inbox does the same. Where: `src/person/tui.tsx`.

## Locations

- **A shutdown looks like a dismissal**: a closing location withdraws its forms first, then sends
  `location.shutdown`. The relay holds a dismissal (`dismissalGraceMs`) to tell them apart. Where:
  `src/person/question/lifecycle.ts`.
- **A gone directory answers 404 `LocationNotFoundError`** on routes that boot its location, so a
  `NotFound` tag test for a deleted session matches it too. Where: `isNotFound` in
  `src/platform/json.ts`.
- **Directories are canonical**: ones that differ by a trailing slash or `..` are one location, and
  `session.create` stores the canonical one. Courier compares no directories today; a comparison
  must resolve both first.

## Installing and loading a plugin

- **Nothing checks the version**: neither `opencode plugin add` nor the loader reads
  `peerDependencies` or `engines`. Courier warns in the server log on another version. Where:
  `src/platform/version.ts`.
- **The host's copies run**: `ensurePluginRuntime` (`packages/plugin/src/runtime.ts`) resolves
  `effect` and `@opencode/plugin*` to OpenCode's own, so the relay's Effects compose only with the
  host's `effect` version. Where: `package.json`.
- **The peers stay exact**: a range would install an untested newest match on an older host. Where:
  `package.json`.

## Managed policy

- **A `skill.use` deny removes `courier-orchestrate`** after courier registers it; the tools and the
  role part work without it. Where: `src/skill.ts`.

## Console event watches

- **A watch is invisible to the plugin**: no API, event or `Waits` supplier, so a child that waits
  on one reads as ended without a report. The brief asks it to schedule a `courier_later` check-in,
  which `isScheduled` supplies to `Waits`; denying the tools made children look for another way and
  never report. Where: `childBrief` in `src/tree/text.ts`.

## Feature flags

- **Schedules and Console watches are flags**, off in a release build and turned on by
  `experimental.<key>: true`, `experimental.all_flags` or `OPENCODE_FLAGS=all`
  (`packages/schema/src/config/flag.ts`). A pin bump re-checks the list.

## Native `parentID`

What a native child (`courier_spawn` with `native: true`) rests on:

- **`Session.create` takes a `location` or a `parentID`**, never both, so an isolated child cannot
  be native. With a parent it inherits the parent's ruleset and `metadata` unless given its own, so
  courier passes `CHILD_RULES` and its metadata. Where: `src/tree/spawn.ts`.
- **OpenCode reports every turn end to the parent**: when a child's execution succeeds, fails or is
  interrupted by the person, the host admits
  `<subagent sessionID="…" state="completed|error|cancelled|running">` with its last text
  (`metadata.source: "subagent"`, `steer`, no `resume: false`) and wakes the parent. Nothing opts
  out. `notePrompt` keeps it from counting as a prompt, and
  the parent's `role` entry explains it (`HOST_REPORTS`) rather than the `context` hook editing it,
  since it is the only copy of the child's last text. Where: `src/tree/events.ts`,
  `src/tree/text.ts`.
- **`opencode run` owns the family**: it answers its asks and cancels its forms, and re-checks for
  exit only when a turn ends in the root or a job (`packages/cli/src/run/noninteractive.ts`). A
  native child still running then holds the run; a report may not end a later root turn first.
  Where: `api_prompt` in `e2e/run.sh`.
- **Deleting a session deletes its native children**, a `session.deleted` each. Where:
  `src/tree/events.ts`.
- **No generated title** for a session with a `parentID`; courier sets it. Where:
  `src/tree/spawn.ts`.

## OpenCode's subagent tool

- **`subagent`** (`packages/core/src/tool/plugin/subagent.ts`) creates a child with `parentID`, runs
  it in the background, and sends the [report above](#native-parentid) at each end, so
  `courier_stop` waits for it (`SETTLE_MS`). Given the id of the caller's child it prompts it as a
  plain `user` item, which the fan-up passes up; a pin bump re-checks it. Where: `src/tree/stop.ts`,
  `src/tree/relay.ts`.
- **`session.list({ parentID })`** lists children from any location, 50 by default. Where:
  `src/tree/subtree.ts`.

## Models and variants

- **A session's model wins over its agent's variant**, so courier passes the agent's variant with its
  model. Where: `src/tree/model.ts`.
- **A wrong model fails the first turn**, so `courier_spawn` checks against `model.list()`;
  `"default"` is no variant. Where: `src/tree/model.ts`.
- **A session may name no model** and run on `model.default()`; courier reads that default for such
  a parent, so the child is pinned to it. Where: `src/tree/model.ts`.
- **A request's model can differ from the session's** (`experimental.model.resolve`); courier reads
  and sets only the session's selection. Where: `src/tree/model.ts`.

## Creating a worktree from a given commit

- **`worktree.create`'s `from` is a source directory and `branch` a starting ref**: it runs
  `git worktree add --detach`, so a commit works and uncommitted changes stay behind. A nested
  isolated child gets its parent's worktree and HEAD. Where: `src/tree/spawn.ts`.

## Keyed session instructions

`ctx.session.instructions.entry.put`, `.list` and `.remove` (since `@opencode/plugin@2.2.0`). The
SDK's `client.session.instructions` is a deprecated alias, and the plugin context's path may move
with it: a pin bump checks `packages/core/src/session/instruction-entry.ts`. Which entries courier
writes: [architecture.md](architecture.md#instruction-entries).

- **An entry renders as one `<context key="…">` block**, the last instruction source in the
  *baseline*, the second system part; a part a `context` hook pushes comes after it. Where:
  `src/tree/context.ts`.
- **The baseline is fixed at the first step**, moved only by a compaction or a revert. So `role`,
  put before the first prompt, costs no cached prefix. A later `put` is announced at the next step
  by `session.instructions.updated`: the block for a new key, "The context under "<key>" changed and
  supersedes the previous value:" and the block for a changed one, "The context under "<key>" no
  longer applies. Disregard it." for a removal. It is stored as one `system` message for every key
  changed since the last step (`Instructions updated: api/role, api/standing`, sorted) and sent in
  place as a **user** `<system-update>` message, escaped, so the prefix before it holds and a mock
  keyed on "the last message is a tool result" must skip it. A pin bump re-checks these cache rules. Where: `src/tree/spawn.ts`, `src/tree/standing.ts`.
- **A compaction folds the current value into the baseline**, and its request runs the `compaction`
  hook, not `context`, so a leaf's compaction model sees every tool.
- **A fork copies the entries and seeds its baseline from their current values**; a native child
  and `session.create` copy nothing. The `fork` session hook (since 2.3.0) runs after the copy;
  `onFork` removes `role` and `standing`, announced as one update, and admits a `resume: false`
  notice. The stale block stays until a compaction, so `context.ts` adds no part. Where:
  `src/tree/fork.ts`, `src/index.ts`.
- **`put`, `list` and `remove` boot no location**, but need the session to exist. Where:
  `src/tree/context.ts`.

## Skills

- **A skill without files gives its own path**, `skill://courier-orchestrate/SKILL.md`, which `read`
  serves from the registry; the plugin API passes no extra files. Where: `src/skill.ts`.
- **A person's own skills load after the server answers**, so a list read at once can lack them.

## OpenCode's schedules

- **A schedule is invisible to the plugin**: no domain, no events, no HTTP address, so a child that
  schedules a wake and ends its turn would read as ended without a report. Every spawned session gets
  `CHILD_RULES`, `opencode_schedule_*` denied on `*`; as Code Mode tools in `execute`'s catalog only
  a rule drops them (`Tool.snapshot`, `packages/core/src/tool.ts`), not the `context` hook. Hence
  `courier_later`'s own scheduler ([architecture.md](architecture.md#courier_laters-scheduler)).
  Where: `src/tree/spawn.ts`.

## `/goal`'s idle reviewer

- **`/goal` cannot see courier children**: its `background` lists only host jobs, a plugin cannot
  add one, and its idle hook runs before courier's. A fix needs
  [an upstream request](https://github.com/anomalyco/opencode/issues/60860); users are told in
  [reference.md](../reference.md#goal-and-courier-children).

## Web search's form

- **With no provider chosen, web search shows a form** (`metadata.kind: "websearch.provider"`, a
  `choice` of `allow`, `choose` or `disable`, then a `provider` field on `choose`). After a minute or
  a dismissal only the call fails; the choice is global. Courier relays it to the top session. Where: `src/person/form.ts`.

## Two servers on one data directory

Plugin storage is a shared slice of the one SQLite database; process memory is not
([architecture.md](architecture.md#two-servers)). `e2e/two-servers.sh` (not in CI) checks these.

- **Both schedulers deliver** a due message without a lock, so one server owns the scheduler
  (`OWNER_KEY`). Where: `src/platform/hub.ts`.
- **A turn's events stay in its server**: only the server that queued the prompt sees its
  `permission.asked`, `execution.failed` and inbox events, and only it can answer the request.
  Where: `src/person/events.ts`, `src/tree/relay.ts`.

## TUI and RPC packaging

- **The host provides the TUI's imports** without resolving them on disk: `effect`,
  `@opencode/plugin/*`, `@opentui/core`, `@opentui/solid` with its `components` and JSX runtimes,
  `solid-js` (patched) and `solid-js/store`. Nothing else is imported at runtime. A pin bump
  re-checks the list. Where: `src/tui.tsx`, `src/*/tui.tsx`.
- **No peers for them**: an exact optional `@opentui/core` peer broke `opencode plugin add`, so they
  are devDependencies at the pinned tag's catalog versions. Where: `package.json`.
- **JSX must be compiled before publishing**: the host transforms `.tsx` only outside
  `node_modules`. Where: `script/build-tui.ts`.
- **`rpc.call` does not wait for plugins** and answers `rpc.unavailable` until they load, so the
  footer asks again each `UNAVAILABLE_MS`. Where: `whenLoaded` in `src/tree/tui.tsx`.

## The TUI plugin API

- **Options**: `ctx.options` is the TUI's own `cli.json` entry; `opencode.json` options never reach
  it. Where: `animationsOn` in `src/tree/tui.tsx`.
- **`data.session.permission` has no `reply`** and `data.session.form.reply` resolves only once the
  form is gone, so the inbox uses `client`. `ctx.location` may be `undefined`. Where:
  `src/person/tui.tsx`.
- **A dialog replaces the one open**, whose `select` resolves `undefined`. Where:
  `src/person/tui.tsx`.
- **The panel belongs to one session** and closes when the route leaves it, so the tree panel
  reopens itself and hands the keyboard back. Where: `src/tree/tui.tsx`.
- **Keys OpenCode takes after `<leader>`** (`packages/tui/src/config/keybind.ts`):
  `a b c e g i l m n q r s t u w x y`, the digits, `return` and the arrows. The inbox takes
  `<leader>k`; a pin bump re-checks the list. Where: `src/person/tui.tsx`.
- **`undefined` does not clear a span's colour** in `@opentui/solid`, so every Digby cell gets a
  `bg`. Where: `DIGBY_UNDER` in `src/tree/tui.tsx`.
