# Plugin API traps

What the OpenCode V2 plugin API and host do that the plugin works around or relies on, at
`@opencode/plugin@2.2.6` and OpenCode 2.2.6. A pin bump re-checks each trap and moves that version.
OpenCode's source is on the `v2` branch of https://github.com/anomalyco/opencode, each release
tagged (`v2.2.6`); paths below are in it. A "since" stays only where the plugin still runs on an
older host and branches on it. How the plugin itself answers a trap is in
[architecture.md](architecture.md).

## Tools

- A plugin tool is reachable only through code mode's `execute` tool unless registered with
  `options: { codemode: false }`.
- A tool whose result `metadata` holds an `undefined` value never completes: the call stays
  `running`, with no error.
- OpenCode errors such as `Session.NotFoundError` can have an empty message, so tools rethrow
  through `describeFailure`, with the tag (`_tag`) and the session id. A throw becomes a
  `Tool.Error` the model sees, and the turn goes on.
- OpenCode decodes tool input with its own `effect`, so checks and transformations in the plugin's
  schemas are not to be relied on. Tool inputs use plain schemas and
  validate values themselves; a unit test keeps it so.
- `Schema.Number` advertises `"Infinity"`, `"-Infinity"` and `"NaN"`, and some models send numbers
  as strings, so `courier_later` takes `delayMinutes` as either. The host renders that union with
  its own `effect`, as one flat `anyOf` (the number, the sentinel enum, the string); the snapshot
  pins it.
- Tool schemas are converted once and shared across steps, so a `context` hook may delete tools from
  the map but must never edit a tool's schema in place. The runner waits for plugin reloads before
  each step.
- OpenCode renders every Effect tool schema closed (`onExcessProperty: "error"` in
  `packages/core/src/tool/runtime.ts`). `test/notices.test.ts` renders them the same way.
- An undeclared key never reaches a tool: `tool-input-repair` (`packages/core/src/plugin/`) deletes
  it. So a renamed optional key stays declared under its old name while it is accepted.

## Events

- `permission.*`, `form.*` and `session.execution.*` reach every location's instance through
  `event.subscribe()`, with the same event id, whatever the event's location (seen with
  `e2e/probe-plugin`). An instance gets only events published while it is subscribed: the hub keeps a
  standby subscription for hand-over, and relays pending requests on every (re)subscribe.
- `event.subscribe({ types })` (since `@opencode/plugin@2.2.0`) yields only those types, so the
  courier's instances never see a turn's streamed `session.text.*`, `session.reasoning.*` and
  `session.tool.*` events. `types` cannot name `server.connected`: a plugin never receives it.
  The courier still drops an event outside its types itself, for a host that ignores the filter.
  The plugin adapter forwards only `types` and `signal`, never `onActivity`, so a plugin cannot tell
  when its stream connects: the `followed` hooks run at the first event or `CONNECTED_MS` after
  subscribing.
- `session.execution.started`, `.succeeded`, `.failed` and `.interrupted` frame a busy period, one
  terminal event however many prompts were steered in. `.interrupted` has `reason` `user` or
  `shutdown` (resumed on the next start; a plain decline reports it too, see
  [Permission requests](#permission-requests)). The schema's `inactivity` and `superseded` are
  published by nothing. A steered message interrupts nothing: `inbox.enqueued`
  (`delivery: "steer"`), then `inbox.delivered` at the next step, then one `.succeeded`. An
  interrupt with `resume` while a steer waits publishes `.interrupted` (`user`), then `.started` and
  the steer's `inbox.delivered`.
- Every event carries `created`, its publish time in epoch milliseconds.
- A failed execution's `retryAfterMs`, set by rate and quota limits, counts from the event's
  `created`. OpenCode clamps a provider's retry header to 2^53 ms, past what a `Date` holds, so the
  plugin ignores a wait over 30 days.
- A provider's 402 fails the turn at once; a 429 OpenCode retries for minutes. The live suite's
  out-of-quota child answers 402 (`e2e/mock-model.mjs`).
- Closing a subscription's stream (`return()` on its iterator) waits on OpenCode, which may not
  answer while a location closes, so the courier closes it without awaiting.
- `session.status` and `session.idle` are published by nothing in core.

## The inbox and wakes

- `session.inbox.delivered` (`data.inboxID` only) is published as each prompt, synthetic message,
  requested compaction or move reaches the session. The runner's own compactions skip the inbox, as
  does its continuation after the output token limit, so a continued turn owes no report again
  (after two continuations the turn fails as `output-limit`). The delivered message is stamped with
  the event's `created`. Only `session.inbox.enqueued` carries the item's type (`user`,
  `synthetic`, `compaction`, `move`), so the plugin remembers it until delivery. It also carries a
  synthetic item's `payload.metadata`, which is how `notePrompt` tells a join group's release (the
  `group` key) from other courier messages; the `synthetic` call's returned id may arrive after
  the `delivered` event, so it is not used.
- A synthetic message steered to an idle session: `session.synthetic` admits it
  (`inbox.enqueued`, a pending inbox row), then rings the run coordinator
  (`packages/core/src/session/run-coordinator.ts`), which publishes `execution.started` and drains:
  `inbox.delivered`, the turn, one terminal event. A healthy wake is
  `enqueued → started → delivered → … → succeeded`. Only a new synthetic, prompt, compaction, skill
  or resume rings again.
- **A lost wake is silent:** `enqueued` with no `started`. The host's paths to it: `synthetic`
  skips the wake while a revert is staged, and an interrupt between the doorbell and the stop clears
  the wake with no error or log. Neither reproduces on demand, so the missed-wake watch keys on that
  signature. `delivered` without `started` means this instance missed an event; `time.busy`
  ([below](#is-a-session-running)) records a start whose event was missed.
- A waiting inbox item bumps `time.updated` (to the item's `time.created`, `idle` unchanged) and is
  not in the transcript until delivered, so the session reads at rest. The plugin API cannot list
  the inbox (`GET /api/session/:id/inbox` can). `session.synthetic` with the `id` of an item already
  waiting or delivered returns that item and still wakes the session, so a re-sent wake adds no
  message. The `inbox.enqueued` event is handled apart from the `synthetic` call that caused it.
- **`resume: false` is the only way to send without starting a turn.** `queue` still wakes an idle
  session. The item waits for the next turn. `inbox.enqueued` does not carry `resume`, so the plugin
  marks such messages in their metadata (`resume: false` beside `source: "courier"`) and `watchWake`
  skips them. A permission request's settled notice is sent this way.

## Is a session running

- **`time.updated` is no sign of activity.** The projector (`packages/core/src/session/projector.ts`)
  stamps it for renames, metadata, permissions, agent and model switches, moves, archive and
  unarchive (which also set `time.archived`), reverts, `inbox.enqueued`, and as a step starts or
  ends; never on a turn's tool or text events. A turn's end sets `time_idle`, not `time_updated`. So
  `updated > idle` holds both for an idle session renamed since and for one between two steps.
- **`time.idle` is when the last turn ended**, stamped from `execution.succeeded`, `failed` and
  `interrupted`, but not from a shutdown (`projectIdle` in the projector). It is never cleared and
  always moves forward, and it is in place by the time the plugin sees the turn's end. A join
  group's release compares it with when its last member joined.
- **`time.busy`** (since 2.2.2) is the start of the latest execution, stamped by the projector on
  `session.execution.started` with `time.updated` left untouched; absent until a session's first
  execution. `busy` not later than `idle` is at rest since `idle`, whatever `updated` says. `busy`
  later than `idle` (or `idle` undefined with `busy` set) is a session running or one at rest after
  a `shutdown` interruption, a plain decline included, which stamps no `idle`; the resumed execution
  stamps `busy` again. Only the transcript tells the two apart.
- **The transcript.** `session.context()` returns stored messages, not what the `context` hook sees.
  It starts at the last compaction. A turn's end is an `idle` message with
  `outcome: "succeeded" | "failed" | "interrupted"`, and a transcript ending on it is at rest, past
  the `agent-switched`, `model-switched` and `location-switched` messages and a person's `shell`
  message, which are no turn. A turn ended by a plain decline or dismissed question ends on an
  assistant message with `error.type` `aborted` (`STEP_INTERRUPTED`, `runner/step.ts`) and sets no
  `time.idle`; it reads at rest, and ended when that message completed. A shutdown during a step
  leaves the same mark, and the next boot resumes the turn. Any other message after `idle` reads
  running (`skill`, `compaction` and a `system` notice start a turn).
- A delivered item stamps nothing until its first step, so a read just after a stamp can show rest
  for a session about to run.

## The idle hook

`experimental.idle` (`SessionIdle { sessionID, background }`, since 2.2.4) runs in `SessionRunner`
(`packages/core/src/session/runner/llm.ts`) when a session that ran the model has no pending input
and would go idle. Its name and shape may still change: a pin bump re-checks both, and the reminder
(`tree/nudge.ts`) reads only `sessionID` and each `background` item's `sessionID`.

- Input it admits keeps the execution going: after the hook, the runner checks the inbox for input
  and loops. So the reminder is sent with `resume: false`, which only skips `execution.wake`, and
  the plugin's missed-wake watch skips it too. A hook that always admits input loops forever: the
  `nudged` note bounds it to one per prompt.
- It does not run after an interruption (a plain decline, a dismissed question), a failure or
  control-only work such as a manual compaction.
- A hook that throws fails the execution, so `onIdle` logs every failure.
- The admitted input still publishes `session.inbox.enqueued` and `delivered`, so `notePrompt`
  matches its inbox id to the `nudged` note rather than taking it for a new prompt.
- `PluginHooks` (`packages/core/src/plugin/hooks.ts`) keys callbacks by name without checking it, so
  a host without the hook takes the registration and never runs it, and the parent is told of a
  silent end as before. `src/index.ts` still registers it after the rest and logs a refusal.
- `trigger` runs every callback for the name in turn, in registration order: each loaded instance's
  (the hub's claim and the `nudged` note keep it to one reminder), after `pre` built-ins such as
  `/goal`'s, which run before package plugins (`plugin/supervisor.ts`, `plugin/internal.ts`). On a
  child with an active goal, its continuation may already be pending when the reminder is admitted:
  the plugin API cannot read a session's inbox, and the goal's state is in its own plugin's storage.
  Both go in the next step; the reminder says to carry on if work is left, and that prompt's one
  reminder is spent.

## Permission requests

- Pending requests are kept per location, and an instance's `permission` domain answers only its
  own. So a request of an isolated child is answered through the instance in the child's worktree;
  the plugin keeps every instance's domain.
- `permission.reply` takes `decision`; the `permission.replied` event carries `reply`, as does
  `courier_answer`.
- A rejection without a message ends the asking turn ("The user declined this tool call"). With a
  message only the call fails, and the model is not told the message. So every rejection carries
  one.
- **A plain decline** sets no `time.idle` and no `idle` message. The execution ends as `interrupted`
  with `reason: "shutdown"` (`terminal` in `session/execution.ts`) on an `aborted` assistant
  message, keeping its claim, so the next boot resumes the turn ("The server restarted while you
  were working", `execution/restart.ts`), and the resumed execution stamps `time.busy` again. The
  plugin tells it from a real shutdown by the transcript ending on the aborted message (`endsIdle`,
  `wakeEnded`). A message steered in during the turn is then delivered at once in a turn of its own.
  The group seal reads `time.idle`, which a decline does not stamp, so it also takes a transcript
  ending on the aborted step, completed at or after the last join (`sealed`, `src/tree/group.ts`),
  and the turn-end hook nudges the release on such a shutdown.
- `permission.assert({ sessionID, action, resources, save?, metadata?, source?, agent? })`
  (`packages/core/src/permission.ts`) checks the session's rules and, on ask, creates a request in
  that session and waits. It resolves with nothing: the request's id and whether the person chose
  `once` or `always` come only from the events. With `save`, `always` saves a project-wide rule and
  answers every other pending request it covers, so `courier_answer` asserts without `save`.
  It rejects with a `Tool.Error` wrapping `Permission.BlockedError` (deny rule),
  `Permission.CorrectedError` (rejection with feedback) or `Session.NotFoundError`, with the cause as
  its `error`. The host builds the `Tool.Error`'s `message` from the cause
  (`packages/core/src/plugin/host.ts`): the deny rule's message, the rejection's `feedback`, or
  "Session not found: <id>". So `refusalOf` (`src/person/permission.ts`) reads the feedback from the
  wrapping error's `message`, and the person's reason reaches `courier_answer`'s result;
  `e2e/run.sh`'s `run_answer` pins it. A plain rejection rejects with `Permission.DeclinedError`
  itself, which ends the step only if the tool rethrows it untouched, not through `describeFailure`.
- `opencode run --auto` replies `once` to every request in its session, asserted ones included
  (`packages/cli/src/run/noninteractive.ts`). The scenario that holds the prompt drives the parent
  through the API.
- The TUI's prompt (`packages/tui/src/routes/session/permission.tsx`) renders per action
  (`permissionPresentation`, `packages/tui/src/util/permission.ts`); an action it does not know,
  such as a plugin's, shows only `Tool: <action>`, without its resources. A `source` of type `tool`
  adds that tool call's input and metadata. Request `metadata` is read only for `url`, `query`,
  `provider`, `files`, `diff`, `parentDir` and `filepath`, and `assert` cannot set the request's
  `message`. `permission.list` gives `metadata` and `source` back, so the asks inbox reads which
  child the top's prompt is for.

## The question tool and forms

- `tool.transform` with the editor's `update` replaces any tool's `execute`, OpenCode's included.
  `question` comes from an OpenCode plugin that loads before external ones. A later plugin that
  replaces it too drops the relay.
- The relay must withdraw a child's question once the parent's answer is in, and only interrupting
  the call does that: the plugin API cannot answer or withdraw a form. So the default export is an
  Effect plugin (`{ id, effect }`) that runs the promise plugin through `fromPromise`
  (`@opencode/plugin/promise/adapter`) and wraps `question` with the Effect API, whose `execute` can
  be interrupted.
- The adapter hands the promise plugin the same `location` object, and the relay finds its ports in
  the hub by it. An adapter that copied it would break the relay.
- `form.created` (never stored) carries `metadata.tool.id`, and comes only after the call's
  permission check passed. A dismissal kills the tool with `QuestionTool.CancelledError`, ending the
  turn. Forms live in memory: a restart drops them, and the call stays `running` until the next
  turn marks it aborted.
- A plugin sees `form.created` (`id`, `sessionID`, `title`, `metadata`, `fields` with `key`, `type`,
  `title`, `description`, `options`), `form.replied` (`answer`) and `form.cancelled`. Forms come from
  the question tool (`kind: "question"`), web search and MCP elicitation (`kind: "mcp-elicitation"`,
  session id `global`). `GET /api/form` lists them; `DELETE /api/session/:id/form/:form` dismisses
  one. `session.form.list` on a session whose location is idle answers an empty list without booting
  it.
- A field shows when all its `when` conditions hold. A condition on a field not answered is false;
  on a multiselect, `eq` means the answer includes the value. A hidden field is not asked: OpenCode's
  form view submits its default, when it has one, and conditions read it.

## Locations

- OpenCode evicts a location after 60 minutes without a stored session event
  (`experimental.location_idle_timeout`, `false` turns it off), but never while a session in it is
  executing, a background job it owns runs, or a terminal or client MCP socket retains it
  (`packages/core/src/location-activity.ts`). Eviction interrupts no session. A tool call has no
  timeout.
- A graceful shutdown closes locations one by one. A closing location first withdraws its forms, so
  a question call dies with `QuestionTool.CancelledError` as if dismissed; about 40 ms later
  `location.shutdown` arrives, then the plugin unloads. The question relay holds a dismissal 2
  seconds to tell the two apart.
- `GET /api/plugin?directory=<worktree>` does not boot that location; a session there does. A
  session whose location's directory is gone answers 404 `LocationNotFoundError` on some routes
  (not the instruction-entry, interrupt, rename, archive, `synthetic` and `compact` ones, which do
  not boot the location; the plugin API's `session.synthetic` is the global session service's,
  `packages/core/src/plugin/host.ts`), which a test for a deleted session by an error tag with
  `NotFound` would match too. The health route is `/api/info`.
- Directories that differ by a trailing slash or `..` are one location, and `session.create` stores
  the canonical directory, so compare directories after resolving them.

## Installing and loading a plugin

- Options come from a `{ "package", "options" }` entry in `plugins`. A local plugin must be a
  directory; a path to a file is ignored with a warning.
- **Nothing checks the version.** `opencode plugin add` installs into an empty directory under
  `~/.cache/opencode/npm/`, with the peers at the versions the package names. Neither it nor the
  loader reads `peerDependencies` or `engines`. What that means for users is in
  [reference.md](../reference.md#the-opencode-version).
- **The host's copies run.** `ensurePluginRuntime` (`packages/plugin/src/runtime.ts`)
  resolves every import of `effect` and `@opencode/plugin*` to OpenCode's own copy. The installed
  peers serve the build, the tests and older hosts. Either way the relay's Effects and the host's
  must compose, so the plugin's `effect` is the host's version.
- **The peers stay exact.** A range would install, on an older host, the newest match, which nothing
  tested. The exact `effect` peer can fail `npm install` with ERESOLVE in a project with another
  `effect`; `opencode plugin add` never meets that.
- **Update checks skip exact versions.** `plugin check`, `plugin update` and the TUI's check parse
  the entry with `npm-package-arg` and skip type `version` without asking the registry
  ([reference.md](../reference.md#updating-the-plugin)).

## Managed policy

- The loader refuses a plugin the organisation's managed policy denies: `plugin.use` on the plugin's
  target (since 2.2.3; `packages/core/src/plugin/module.ts`), before `integration.use` on
  `plugin:<name>`. The policy schema (`packages/schema/src/config/policy.ts`) decodes a legacy
  `integration.use` whose resource starts `plugin:`, `skill:` or `mcp:` into the new action, so old
  policies still apply.
- A `skill.use` deny removes the skill from the registry (`packages/core/src/config/plugin/policy.ts`,
  a `post` plugin, so after the courier's `editor.add`). A denied `courier-orchestrate` is then
  neither listed nor loadable (`skill` fails "unable to load", `/skills` with `SkillNotFoundError`);
  the tools and the role part work without it, as with a `skill` rule's deny
  (`COURIER_SKILL=deny`).

## Feature flags

Some features are flags (`packages/schema/src/config/flag.ts`: `schedules`, `todo`,
`background_compaction`, `media_blob`, `artifacts`): off in a release build, on in local and dev
builds, turned on by `experimental.<key>: true`, `experimental.all_flags: true` or
`OPENCODE_FLAGS=all` (`-key` turns one off).

## Native `parentID`

What a native child (`courier_spawn`'s `native`, else the `nativeChildren` option) rests on:

- **`Session.create` takes a `location` or a `parentID`**, never both. With a parent the child takes
  its location, so an isolated child cannot have one.
- **Inheritance:** with a `parentID` and no `permissions`, a child gets its parent's session ruleset
  (`packages/core/src/session.ts`); a ruleset passed is kept, and the plugin passes its own
  (`CHILD_RULES`, [OpenCode's schedules](#opencodes-schedules)). `metadata` is
  inherited too; the plugin passes its own.
- **Providers** (`session/affinity.ts`, `session/model-request.ts`): `parentID ?? fork?.sessionID ??
  id` goes out as `x-session-affinity`, `X-Session-Id`, `x-opencode-session` and `promptCacheKey`,
  plus `x-opencode-parent-session-id` and `x-parent-session-id`. GitHub Copilot sends
  `X-Interaction-Type: conversation-subagent` and `x-initiator: agent`.
- **The TUI:** a root's view (`routes/session/index.tsx`) lists the asks of the root and every
  descendant; a child's view lists none. `autoaccept` replies `once` for the family. Session lists
  show `parentID: null` only. A root's `cost` sums its family.
- **`opencode run`** treats the native family as its own: `once` with `--auto`, reject without, and
  it cancels their questions and forms. The live suite drives native scenarios through
  `POST /api/session/:id/prompt`.
- **Deletion:** `Session.remove` interrupts and removes each native child recursively, with a
  `session.deleted` each.
- **No generated title** and no warming for a session with a `parentID`; the courier sets the
  title.

## OpenCode's subagent tool

What reading OpenCode's subagents into a tree rests on (`packages/core/src/tool/plugin/subagent.ts`,
`session/subagent-job.ts`, `session/subagent-completion.ts`):

- **The tool is `subagent`**, not `task`. It creates the child with `parentID` and the
  `description` as title, and prompts it with `You are a subagent spawned by another session.`
  first. `experimental.subagent_depth` (default 1) counts `parentID` links up to the root, so a
  native courier child cannot start one by default; a standalone one can.
- **`session.list({ parentID })`** lists a session's children from any location, 50 by default
  (`session.ts`), most recently updated first (`session/store.ts`). The plugin's `ctx.session.list`
  is the same call.
- **A foreground call** blocks on the child's job and interrupts it when the parent's call is
  interrupted. **A background one** (`background: true`, or a foreground one moved there) is tied to
  nothing: when the child's execution ends, interrupted included, its job ends and a forked observer
  sends the parent a synthetic `<subagent sessionID=… state=…>` with `metadata.childID`, without
  `resume: false`, which wakes an idle parent, or one still stopping. `courier_stop` waits for it
  (`SETTLE_MS`) and interrupts the parent again.
- **A completed background call's content** names the child's id (`working in the background
  (sessionID: …)`); a foreground call's stays `running` until the child ends.

## Models and variants

- `session.create` takes `model: { providerID, id, variant? }` (`Model.Ref`). A
  session that names a model runs on it at its own `variant`; the agent's `model.variant` counts only
  for a session with no model (`session/runner/model.ts`), so the plugin passes the agent's variant
  with its model.
- A model OpenCode does not have, or a variant the model has not, fails the session's first turn
  (`ModelUnavailableError` in `session/runner/model.ts`, `VariantUnavailableError` in
  `model-resolver.ts`), so `courier_spawn` checks a choice against `model.list()` first:
  `models.available()`, the enabled models, each with its `variants`. `"default"` is no variant
  (`withVariant`), and `session.get` fills `variant: "default"`.
- A configured model given neither `capabilities.reasoning` nor `variants` gets its package's default
  ones (`variant.ts`): `low`, `medium` and `high` for an OpenAI-compatible one, each the setting
  `reasoningEffort`, which reaches the provider as `reasoning_effort`. So the live suite's `mock/chat`
  and `mock/other` have them.
- A session `opencode run` without `--model`, or the API, creates has no `model`: the runner takes
  `model.default()`. The plugin reads that default itself (`ctx.model.default()`, the plugin's own
  location) and passes it to `session.create` as such a parent's model, so a `variant` alone has a
  model to apply to and the child is pinned to it; with the agent's lookup failed it passes none,
  since OpenCode then applies the agent's own model.
- `agent.get` takes `location`. `agent.list` and `provider.list` wait for plugin activation, and
  `agent.list` declares a 503 `ServiceUnavailableError` while it has not finished.

## Creating a worktree from a given commit

`worktree.create`, `.remove` and `.list` take `projectID` (`location.project.id`); `create` takes
optionally `from`, `branch`, `directory` and `name` (`packages/core/src/worktree.ts`):

- **`from` is a source directory, not a ref:** one the project knows, else
  `SourceDirectoryNotFoundError`.
- **`branch` is a starting ref, not a new branch:** it runs
  `git worktree add --detach -- <dir> <branch ?? HEAD>` (`packages/core/src/git.ts`), so a commit
  works and HEAD is always detached. Uncommitted changes are not carried over.
- A project's worktrees share one repository, so commits and branches are visible across them.

For a nested isolated child, `courier_spawn` passes the parent's worktree as `from` and its HEAD as
`branch`, recorded as the roster entry's `base`.

## Keyed session instructions

`ctx.session.instructions.entry.put({ sessionID, key, value })`, `.list({ sessionID })` and
`.remove({ sessionID, key })`, since `@opencode/plugin@2.2.0`; over HTTP
`GET /api/experimental/session/:id/instructions/entries` and `PUT` or `DELETE …/entries/:key`
(`packages/protocol/src/groups/session.ts`; the plugin API's path has no `experimental`). The SDK's
`client.session.instructions` is a deprecated alias of `client.experimental.session.instructions`,
and the plugin context's path may move with it, so a pin bump checks it. Read in
`packages/core/src/session/instruction-entry.ts`, `packages/core/src/instructions/index.ts`, and in
`session/`, `instruction-state.ts`, `context.ts`, `model-request.ts` and `runner/llm.ts`. Which
entries the courier writes: [architecture.md](architecture.md#instruction-entries).

- **Rendering.** An entry is one block, `<context key="<key>">`, the value, `</context>`: a string
  as it is, any other JSON pretty-printed. The key matches `^[a-z0-9][a-z0-9._-]*$` (stored as
  `api/<key>`), and the value's JSON is at most 256 KiB (`InstructionEntryValueTooLargeError`, 413).
  A `put` of the value already stored changes nothing and announces nothing.
- **Where it lands.** The entries are the last of OpenCode's instruction sources, after the code
  mode catalog, MCP instructions, references, the skill listing, AGENTS.md and the built-ins, all
  rendered into one *baseline*: the second system part, after the agent's system prompt and before
  anything a `context` hook pushes. The hook's `event.system` is that pair, so a part the courier
  adds comes after the block. The part also carries each source's text in
  `metadata.experimental.instructions` as `{ key, text }` (`baseTranscript`, `model-request.ts`), an
  entry under its stored key (`api/role`), not updated when a hook edits `text`; it is experimental,
  so `context.ts` reads the `role` entry through `entry.list`.
- **The baseline is fixed at the session's first step** (`InstructionState.prepare`, run at every
  step boundary) and moved only by a compaction (`advanceEpoch` on `session.compaction.ended`) or
  a revert that removes an instruction update or the epoch start (`rewind`). So an entry put between
  `session.create` and the first prompt is in the system prompt from the first request, and the
  first `put` after spawn moves no cached prefix. An entry put after the first step is announced at
  the next step boundary as a `session.instructions.updated` event whose `text` is the block (for a
  new key), "The context under "<key>" changed and supersedes the previous value:" with the block (a
  changed one) or "The context under "<key>" no longer applies. Disregard it." (a removal);
  `message-updater.ts` stores it as a `system` message (`description`
  `Instructions updated: api/<key>`, the keys as stored, every key changed since the last step in
  one message, sorted: `api/lessons, api/role, api/standing` at a root's first spawn, as
  `e2e/run.sh` checks; in a turn a courier message starts, the message comes before that message),
  which goes to the model at its place in the transcript, after the tool result that put the entry,
  as a **user** message: `<system-update>`, the text with `&`, `<` and `>` escaped,
  `</system-update>` (`wrapSystemUpdate`, `packages/ai/src/protocols/shared.ts`; AI SDK routes do
  not all allow the system role after history). So the block arrives as `&lt;context
  key="role"&gt;`, and a mock keyed on "the last message is a tool result" must skip the update
  (`e2e/mock-model.mjs` does, and logs the role it arrives as, `updateRole`). The baseline stays,
  so the prefix before the update holds. The plugin API's event carries that `text` and the keys'
  hashes (`delta`), never the value; the first sync after the first step has no text.
- **A compaction keeps it.** After a compaction the entry's current value is in the baseline, and
  the transcript replays from the compaction message, so the update message is no longer sent. A
  compaction's own model request carries the baseline too, so its model sees the block; it also
  carries the session's whole tool list and runs the `compaction` hook, not `context`, so a leaf's
  compaction model sees `courier_spawn` (its prompt says to call no tool). The summary must hold a
  line equal to one of the template's headings (`## Objective`, …): a reply without one is nudged
  once ("did not fill in the required summary template"), then the compaction fails
  (`session.compaction.failed`, no `ended`).
- **What inherits it.** `session.fork` copies the parent's entries and baseline; a native child
  (`parentID`) and `session.create` do not. `courier_cleanup` and a forgotten child leave entries
  alone: they belong to the session and go with it.
- **Reading it.** `put`, `list` and `remove` need the session to exist (`Session.NotFoundError`) but
  boot no location. The `context` hook reads nothing of the value: the text itself only shows in
  the model's request (`e2e/mock-model.mjs` logs `roleEntry` and `rolePart`).

## Skills

- **Registering:** `ctx.skill.transform((editor) => editor.add(info))` with `id`, `name`,
  `description`, `autoinvoke`, `path` and `content`. `path`'s directory is named to the model, so a
  skill without files gives its own path. The courier's is `skill://courier-orchestrate/SKILL.md`, as
  the built-ins' is `skill://opencode/SKILL.md`: a `skill://<id>/…` path names `skill://<id>` as the
  directory, and the `read` tool serves `skill://<id>/SKILL.md` from the registry, after the `skill`
  and `read` permissions, so a model that reads the directory it was told about gets the content.
  `Skill.Info.path` is a branded string with no shape check. The host's editor takes extra in-memory
  files beside such a skill; the plugin API's `SkillEditor.add` passes none. The same id from several
  locations is one entry.
- **Listing:** every skill with a `description`, `autoinvoke` not `false` and not denied by a `skill`
  rule is listed in every system prompt (`core/skill-guidance`, `<available_skills>`, sorted by id).
  A change reaches a running session as a delta. `GET /api/skill?directory=…` lists them.
- **Loading:** `skill({ id })` asks the `skill` permission (with `save: [id]`). Its result is
  `<skill_content name="…">` with the content and the base directory; files are listed only when the
  path's basename is `SKILL.md`.
- **A person's own skills:** OpenCode reads `<name>/SKILL.md` under `skill/` and `skills/` of each
  config directory (`~/.config/opencode`, a project's `.opencode`), and a project's `.claude/skills/`
  and `.agents/skills/`. They load after the server answers, so a list read at once can lack them.
- **Activating:** the TUI's `/skills` attaches `skills: [{ id }]` to the prompt, and the text goes
  first in that message. A compaction keeps it (`messageToText`, `session/recent-text.ts`).
- **Managed policy:** see [Managed policy](#managed-policy).

## OpenCode's schedules

The `opencode_schedule_*` tools (`packages/core/src/tool/plugin/schedule.ts`; the `schedules`
[feature flag](#feature-flags), one server per database through the `schedule:leader` row of the
`kv` table) let a session prompt itself later. The plugin API has no schedule domain and schedules
publish no events, so no `Waits` supplier can see one, and a child that schedules a wake and ends
its turn would read as ended without a report.

- So every spawned session is created with `CHILD_RULES` (`tree/spawn.ts`): `opencode_schedule_*`
  denied on `*`. A root keeps the tools.
- They are Code Mode tools (namespace `opencode`), in `execute`'s catalog rather than tools of their
  own while `execute` is not wholly denied, so the `context` hook cannot drop them. `Tool.snapshot`
  (`packages/core/src/tool.ts`) drops a tool whose action, its id (`opencode_` and the name), a rule
  wholly denies, from the direct tools and the catalog alike; the session's rules come after the
  agent's (`session/context.ts`).
- A plugin cannot reach schedules: no schedule domain, not under `ctx.experimental` either, and the
  plugin is not given the server's address or password for its HTTP routes. A firing is a plain
  steered prompt (`admitWake`, `packages/core/src/schedule.ts`: `delivery: "steer"`,
  `metadata: { schedule }`) without the sender's envelope. Why `courier_later` keeps its own
  scheduler: [architecture.md](architecture.md#courier_laters-scheduler).

## `/goal`'s idle reviewer

`/goal` (`packages/core/src/plugin/goal.ts`, a built-in plugin) judges on `experimental.idle`, and
courier children are invisible to it ([reference](../reference.md#goal-and-courier-children)).

- The runner (`session/runner/llm.ts`) fills `background` from `SessionBackground.outstanding`
  (`session/background.ts`): the host's running jobs under the session, which are task-tool
  subagents, image jobs and shells. A native courier child has a `parentID` but is not a job.
  `GET /api/experimental/job` lists the same jobs over HTTP only; a plugin cannot add one.
- `goal.ts` returns early only for a `subagent` or `image` entry of the session itself, and offers
  `wait` only while one of its own shells runs. Otherwise `continue` admits a synthetic continuation
  in the same execution; `MAX_STALLS` (3) rounds in a row with the same reason or no tool call
  pause the goal.
- An `experimental.idle` hook of the courier's could not change that: `/goal`'s runs first
  ([The idle hook](#the-idle-hook)), so the verdict and its continuation are in before the courier's
  hook runs, and a later hook can add input but not take any back. A fix needs OpenCode to let a
  plugin declare background work, which
  [an upstream request](https://github.com/anomalyco/opencode/issues/60860) asks for.

## Web search's form

`websearch` first asks the `websearch` permission. With no provider chosen it shows "Web Search"
(`metadata: { kind: "websearch.provider" }`, one field `choice`: `allow`, `choose`, `disable`), and on
`choose` a second form with a field `provider`. After a minute, or a dismissal, the call fails with
"Web search cancelled", ending the call, not the turn. The choice is global (`websearch:provider` in
OpenCode's KV), and `disable` drops the tool everywhere. Two children are asked one after the other.
A plugin adds a provider with `ctx.websearch.transform((editor) => editor.add({ id, name, execute }))`,
as `e2e/search-plugin` does.

## Two servers on one data directory

OpenCode keeps everything in one SQLite database (`$XDG_DATA_HOME/opencode/opencode.db`), which any
number of servers can open. Plugin storage is a slice of its `kv` table
(`plugin:<hex plugin id>:<key>`), shared; process memory (claims, the event bus, pending requests)
is not. What the plugin does about it: [architecture.md](architecture.md#two-servers).

- Without a lock, both schedulers deliver a due message (seen for none to all of ten).
- A child's turn runs in the server that queued its prompt, and only that server sees its
  `permission.asked` or `execution.failed`.
- `courier_answer` reaches a request only from the server where the child waits.

`e2e/two-servers.sh` (not in CI; see its header) checks these and exits 1 when one differs. It
does not cover the question relay.

## TUI and RPC packaging

- **Found by export.** `Host.resolve` (`packages/plugin/src/host.ts`) resolves `<name>/server` (else
  the package), `<name>/tui` and `<name>/rpc`. A local directory whose `package.json` has a
  `name` and `exports` resolves like a package; without them, `index.js`, `tui.js` and `rpc.js` sit
  at its root. A local plugin given as a file path gets `server` only.
- **The server runs only `server`**, recording `features: { server, tui, rpc }` (in
  `GET /api/plugin`). `opencode plugin add` adds a package with `server` to the global config.
- **The TUI loads `tui`** with a plain `import()` for each plugin with `features.tui`
  (`packages/tui/src/plugin/context.tsx`). It default-exports `{ id, setup }`.
- **The host provides the TUI's imports:** `effect`, `@opencode/plugin/*`, `@opentui/core`,
  `@opentui/core/testing`, `@opentui/solid`, its `components`, `jsx-runtime` and `jsx-dev-runtime`,
  `solid-js` and `solid-js/store`, without resolving them on disk. Anything else (`solid-js/web`,
  `@opencode/theme`) must not be imported at runtime. OpenCode patches its `solid-js`; unit tests
  run the unpatched one.
- **No peers for them.** An exact optional peer `@opentui/core` broke `opencode plugin add` with
  ERESOLVE. They are devDependencies at the versions of OpenCode's root catalog at the pinned tag,
  and `@opencode/theme` at the pin; `@opencode/plugin`'s own optional `@opentui/*` peers are ranges.
- **JSX must be compiled before publishing.** The host transforms `.tsx` only outside
  `node_modules`, so `script/build-tui.ts` bundles with `createSolidTransformPlugin()` and
  `packages: "external"`. `@arethetypeswrong/cli` flags an export without types, hence
  `tsconfig.tui.json` for `dist/tui.d.ts`.
- **RPC.** A plugin cannot add an HTTP route: `rpc.register` sits behind authenticated `/api/rpc`
  with a JSON envelope. `Rpc.define` (`@opencode/plugin/rpc`) takes `{ id, methods, events }`;
  `rpc.*` names are reserved. Registration and `client.rpc` take Standard Schema, so one definition
  serves both halves. One service per location; the last registration of an id answers. Errors:
  `rpc.invalid_input`, `rpc.method_not_found`, declared errors, `rpc.internal`, `rpc.unavailable`,
  `rpc.invalid_output`. Over HTTP: `POST /api/rpc/:rpcID/:method?directory=…` with
  `{ "input": … }`.

## The TUI plugin API

- **Options:** `ctx.options` is the TUI's own `cli.json` entry. A plugin loaded from the server's
  list enters bare, so `opencode.json` options never reach it. The TUI's `animations` setting is not
  on the plugin API, hence the plugin's own option.
- **The context:** `ctx.client` is the TUI's client. `ctx.location` may be `undefined`; fall back to
  `ctx.data.location.default()`. The footer slot shows on the home screen too, with no `sessionID`.
  `data.session.permission` has no `reply`, so the inbox uses `client.permission.reply`. Forms go
  through `client.session.form.list` and `client.session.form.reply`: `data.session.form.reply`
  resolves only once the form is gone. The client throws an RPC error as a plain
  `{ type, message }`. OpenCode sounds `permission` and `question` for every request and form
  itself.
- **A slot that renders bare text, or a dialog that throws while rendering,** is contained: a crash
  toast, the dialog closed. A slot still renders only elements.
- **A dialog replaces the one open** (`createDialogApi`, `packages/tui/src/plugin/api.tsx`): the open
  `select` resolves `undefined`, as on `esc`. `select` takes no starting query, so a changed list
  means a new `select` with an empty search. `current` matches by deep equality
  (`ui/dialog-select.tsx`).
- **A select's rows** are one line: title (cut at 61), description, and a right-aligned footer that
  squeezes them. `large` is 88 columns, `xlarge` 116. Rows also take an undeclared `details: string[]`
  of muted lines, which the memory view uses for lessons; a later host may drop it. A `disabled`
  option is left out.
- **The panel belongs to one session.** `ui.panel.open` targets the route's session, and the app
  closes it when the route leaves that session (`app.tsx`). A new panel takes the keyboard. So the
  tree panel reopens itself after a route change, and hands the keyboard back with
  `keymap.dispatch("pane.focus.left")` when it did not have it.
- **A panel splits from 108 columns, less the vertical tabs** (`canSplit`, `context/panel.tsx`). The
  plugin cannot read the tabs' width, so it notes the split only at a `renderer.width` of 108 or
  more.
- **Keys OpenCode takes after `<leader>`:** `a b c e g i l m n q r s t u w x y`, the digits, `return`
  and the arrows (`packages/tui/src/config/keybind.ts`; the legacy names in
  `config/v1/keybind.ts`). The inbox takes `<leader>k`.
- **A span's colour is not cleared by `undefined`:** `@opentui/solid` keeps the old `bg` and `fg`,
  and `attributes` only gain bits. Digby's spans are reused through `<Index>`, so every cell gets a
  `bg`, transparent where it has none. A `<box>`'s `backgroundColor` does clear.
- **Testing:** unit tests use OpenTUI's `testRender`, with `bunfig.toml` preloading
  `@opentui/solid/preload`. The live check reads `tmux capture-pane -p`; CI installs `tmux`. The TUI
  logs to `$XDG_DATA_HOME/opencode/log/opencode.log`.
