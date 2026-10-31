# Plugin API traps

What the OpenCode V2 plugin API and host do that the plugin works around or relies on, at
`@opencode/plugin@2.2.4` and OpenCode 2.2.4. A pin bump re-checks each trap. OpenCode's source is on
the `v2` branch of https://github.com/anomalyco/opencode, each release tagged (`v2.2.4`); paths
below are in it.

## Tools

- A plugin tool is reachable only through code mode's `execute` tool unless registered with
  `options: { codemode: false }`.
- A tool whose result `metadata` holds an `undefined` value never completes: the call stays
  `running`, with no error.
- OpenCode errors such as `Session.NotFoundError` can have an empty message, so tools rethrow
  through `describeFailure`, with the tag (`_tag`) and the session id. A throw becomes a
  `Tool.Error` the model sees, and the turn goes on.
- OpenCode decodes tool input with its own `effect`. Before 2.0.25, schema checks and
  transformations of the plugin's copy broke (`Schema.Finite` refused `2`). Tool inputs use plain
  schemas and validate values themselves; a unit test keeps it so.
- `Schema.Number` advertises `"Infinity"`, `"-Infinity"` and `"NaN"`, and some models send numbers
  as strings, so `courier_later` takes `delayMinutes` as either. `effect` 4.0.6 renders that union
  as one flat `anyOf` (the number, the sentinel enum, the string) where 4.0.1 nested the number's
  own `anyOf` inside it; same meaning, and the host renders with its own `effect`, so a host from
  2.2.2 on shows the flat shape whatever the plugin's pin. The snapshot pins the flat one.
- `effect` 4.0.6 bounds `Schema.Int`'s JSON Schema by the safe-integer range; the runtime's
  `flattenAllOf` drops those `minimum` and `maximum` so the schema sent to the model, and the
  prompt cache, stay as before. The plugin's inputs use `Schema.Number` and check the value
  themselves either way.
- Tool schemas are converted once and shared across steps, so a `context` hook may delete tools from
  the map but must never edit a tool's schema in place. The runner waits for plugin reloads before
  each step.
- OpenCode renders every tool's schema closed (`onExcessProperty: "error"` in
  `packages/core/src/tool/runtime.ts`). `test/notices.test.ts` renders them the same way.
- An undeclared key never reaches a tool: `tool-input-repair` (`packages/core/src/plugin/`) deletes
  it. So a renamed optional key stays declared under its old name while it is accepted.
- A plugin cannot add an HTTP route: `rpc.register` sits behind authenticated `/api/rpc` with a JSON
  envelope, which GitHub's headers and signed raw body would not get through. The webhook receiver is
  its own listener, shared by the instances. It waits for the previous listener to close before it
  binds, and the next instance to load retries a failed bind.
- Options come from a `{ "package", "options" }` entry in `plugins`. A local plugin must be a
  directory; a path to a file is ignored with a warning.

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
  when its stream connects: the `followed` hooks run at the first event or `CONNECTED_MS` after subscribing.
- `session.execution.started`, `.succeeded`, `.failed` and `.interrupted` frame a busy period, one
  terminal event however many prompts were steered in. `.interrupted` has `reason` `user`,
  `shutdown` (resumed on the next start; also what a plain permission decline reports) or
  `inactivity` (the location was evicted, see below). The schema's `superseded` is published by
  nothing. A steered message interrupts nothing:
  `inbox.enqueued` (`delivery: "steer"`), then `inbox.delivered` at the next step, then one
  `.succeeded`. An interrupt with `resume` while a steer waits publishes `.interrupted` (`user`), then
  `.started` and the steer's `inbox.delivered`.
- `session.inbox.delivered` (`data.inboxID` only) is published as each prompt, synthetic message,
  requested compaction or move reaches the session. The runner's own compactions skip the inbox, as
  does its continuation after the output token limit, so a continued turn owes no report again
  (after two continuations the turn fails as `output-limit`). The delivered message is stamped with
  the event's `created`. Only `session.inbox.enqueued` carries the item's type (`user`, `synthetic`, `compaction`, `move`),
  so the plugin remembers it until delivery.
- A synthetic message steered to an idle session: `session.synthetic` admits it
  (`inbox.enqueued`, a pending inbox row), then rings the run coordinator
  (`packages/core/src/session/run-coordinator.ts`), which publishes `execution.started` and drains:
  `inbox.delivered`, the turn, one terminal event. A healthy wake is
  `enqueued → started → delivered → … → succeeded`. Only a new synthetic, prompt or resume rings
  again.
- **A lost wake is silent:** `enqueued` with no `started`. The host's paths to it: `synthetic`
  skips the wake while a revert is staged, and an interrupt between the doorbell and the stop clears
  the wake with no error or log. Neither reproduces on demand, so the missed-wake watch keys on that
  signature. `delivered` without `started` means this instance missed an event. Since 2.2.2 the
  session records every `started` itself (`time.busy`, below): after `enqueued`, a `session.get`
  showing `busy` at or after the wake's `at` means an execution started, event seen or not. The
  missed-wake check (`wakeAgain`, `src/tree/wake.ts`) reads it before re-sending: a `busy` at or
  after the message was last left waiting (enqueued, seen waiting as a turn ended, or sent again)
  and later than `idle` marks the message as a running turn's to take; an earlier one, or one
  `idle` has passed (that execution ended, its event missed), re-sends, with no transcript read.
  Without `busy` it reads the times and the transcript as before.
- A waiting inbox item bumps `time.updated` (to the item's `time.created`, `idle` unchanged) and is
  not in the transcript until delivered, so the session reads at rest. The wake store holds courier
  messages waiting, which the limits and the memory's `finished` count (`waitsInInbox`).
  `courier_send` writes that row itself once `synthetic` returns (`noteSent`), since the enqueued
  event is handled apart from the call. The plugin API cannot list the inbox
  (`GET /api/session/:id/inbox` can). `session.synthetic` with the `id` of an item already waiting or
  delivered returns that item and still wakes the session, so a re-sent wake adds no message.
  `session.status` and `session.idle` are published by nothing in core.
- **`time.updated` is no sign of activity.** The projector (`packages/core/src/session/projector.ts`)
  stamps it for renames, metadata, permissions, agent and model switches, moves, archive and
  unarchive (which also set `time.archived`), reverts, `inbox.enqueued`, and as a step starts or
  ends; never on a turn's tool or text events. A turn's end sets `time_idle`, not `time_updated`. So
  `updated > idle` holds both for an idle session renamed since and for one between two steps.
  Since 2.2.2 `time.busy` is one: the start of the latest execution, stamped by the projector on
  `session.execution.started` with `time.updated` left untouched; optional, absent until a
  session's first execution on 2.2.2. `busy` not later than `idle` is at rest since `idle`, whatever
  `updated` says. `busy` later than `idle` (or `idle` undefined with `busy` set) is a session running
  or one at rest after an interruption with reason `shutdown`, which stamps no `idle` and is what a
  plain permission decline reports (below), so `busy > idle` holds at rest after a decline; the
  resumed execution stamps `busy` again. Only the transcript tells the two apart, so there it still
  decides. The plugin reads `busy` first (`busy`, `src/tree/domain.ts`; `runs`, `src/tree/running.ts`):
  `busy` not later than `idle` is rest at `idle`, with no transcript read and none of the caching
  below, whatever a rename, an archive, a switch or a waiting inbox item stamped on `updated`;
  `busy` later than `idle`, or set with no `idle`, goes by the transcript; `busy` absent goes by
  `updated > idle` and then the transcript, as before. A new `busy` is a new stamp for the cache.
  The transcript's reading:
  - a turn's end is an `idle` message, and one ending on it is at rest, past the `agent-switched`,
    `model-switched` and `location-switched` messages and a person's `shell` message, which are no
    turn;
  - a turn ended by a plain decline or dismissed question ends on an assistant message with
    `error.type` `aborted` (`STEP_INTERRUPTED`, `runner/step.ts`) and sets no `time.idle`; it reads at
    rest, and ended when that message completed. A shutdown during a step leaves the same mark, and
    the next boot resumes the turn;
  - any other message after `idle` reads running (`skill`, `compaction` and a `system` notice start a
    turn).
  Each instance caches the answer per session (500 at most per port) until the next stamp. A rest
  read within 10 seconds of its stamp is read again, since a delivered item stamps nothing until its
  first step; an answer is kept 30 seconds at most. An unreadable or empty transcript reads running.
- **`resume: false` is the only way to send without starting a turn.** `queue` still wakes an idle
  session. The item waits for the next turn. `inbox.enqueued` does not carry `resume`, so the plugin
  marks such messages in their metadata (`resume: false` beside `source: "courier"`) and `watchWake`
  skips them. A permission request's settled notice is sent this way.
- Every event carries `created`, its publish time in epoch milliseconds.
- `session.context()` returns stored messages, not what the `context` hook sees. A turn's end is
  recorded as an `idle` message with `outcome: "succeeded" | "failed" | "interrupted"`.
- OpenCode evicts a location after 60 minutes without a stored session event
  (`experimental.location_idle_timeout`) when no session in it is executing. A location with a running
  session is held for up to 24 hours without a durable event; then its sessions are interrupted with
  `reason: "inactivity"` and it is evicted. A tool call has no timeout.
- A graceful shutdown closes locations one by one. A closing location first withdraws its forms, so
  a question call dies with `QuestionTool.CancelledError` as if dismissed; about 40 ms later
  `location.shutdown` arrives, then the plugin unloads. The question relay holds a dismissal 2
  seconds to tell the two apart.
- `GET /api/plugin?directory=<worktree>` does not boot that location; a session there does. A
  session whose location's directory is gone answers 404 `LocationNotFoundError` on some routes
  (not the instruction-entry, interrupt, rename and archive ones, which no longer boot the location),
  which the webhook's test for a deleted session (an error tag with `NotFound`) would match too. The
  health route is `/api/info`.
- Directories that differ by a trailing slash or `..` are one location, and `session.create` stores
  the canonical directory, so compare directories after resolving them.

## When a session's turn ended

`time.idle` is when the last turn ended, stamped from `execution.succeeded`, `failed` and
`interrupted`, but not from a shutdown (`projectIdle` in the projector). It is never cleared and
always moves forward. A join group's release compares it with when its last member joined. It is in
place by the time the plugin sees the turn's end.

## The idle hook

`experimental.idle` (`SessionIdle { sessionID, background }`, added in 2.2.4 by
anomalyco/opencode#59437) runs in `SessionRunner` (`packages/core/src/session/runner/llm.ts`) when a
session that ran the model has no pending input and would go idle. Its name and shape may still
change: a pin bump re-checks both, and the reminder (`tree/nudge.ts`) reads only `sessionID` and
each `background` item's `sessionID`.

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
- `trigger` runs every callback for the name in turn: each loaded instance's (the hub's claim and the
  `nudged` note keep it to one reminder) and `/goal`'s (`packages/core/src/plugin/goal.ts`), each
  admitting its own input.

## Permission requests

- Pending requests are kept per location, and an instance's `permission` domain answers only its
  own. So a request of an isolated child is answered through the instance in the child's worktree;
  the plugin keeps every instance's domain.
- `permission.reply` takes `decision`; the `permission.replied` event carries `reply`, as does
  `courier_answer`.
- A rejection without a message ends the asking turn ("The user declined this tool call"). With a
  message only the call fails, and the model is not told the message. So every rejection carries
  one.
- `permission.assert({ sessionID, action, resources, save?, metadata?, source?, agent? })`
  (`packages/core/src/permission.ts`) checks the session's rules and, on ask, creates a request in
  that session and waits. It resolves with nothing: the request's id and whether the person chose
  `once` or `always` come only from the events. With `save`, `always` saves a project-wide rule and
  answers every other pending request it covers, so `courier_answer` asserts without `save`.
  It rejects with a `Tool.Error` wrapping `Permission.BlockedError` (deny rule),
  `Permission.CorrectedError` (rejection with feedback) or `Session.NotFoundError`, with the cause as
  its `error`. The host builds the `Tool.Error`'s `message` from the cause (`packages/core/src/plugin/host.ts`):
  the deny rule's message, the rejection's `feedback`, or "Session not found: <id>". So `refusalOf`
  (`src/person/permission.ts`) reads the feedback from the wrapping error's `message`, and the
  person's reason reaches `courier_answer`'s result; `e2e/run.sh`'s `run_answer` pins it. That
  `CorrectedError.message` itself is the feedback since 2.2.2 (empty before) changes nothing here.
  A plain rejection rejects with `Permission.DeclinedError` itself, which ends the step only if the
  tool rethrows it untouched, not through `describeFailure`.
  `Permission.Unattended` (2.2.2) is a core-internal reference that settles an `ask` when nobody is
  present to answer; only the experimental schedule route provides it, and the plugin API does not
  expose it.
- That plain decline sets no `time.idle` and no `idle` message. The execution ends as
  `interrupted` with `reason: "shutdown"` (`terminal` in `session/execution.ts`), keeping its claim,
  so the next boot resumes the turn ("The server restarted while you were working",
  `execution/restart.ts`), and the resumed execution stamps `time.busy` again. The plugin tells it
  from a real shutdown by the transcript ending on the aborted message (`endsIdle`, `wakeEnded`). A
  message steered in during the turn is then delivered at once in a turn of its own. The group seal
  reads `time.idle`, so a decline does not seal.
  `wakeAgain` reads the session before re-sending, in case a resumed turn's `started` came before
  the subscription: since 2.2.2 by `time.busy` (Events, above), which records that start; without
  it, only a transcript actually read marks it running, so a failed read re-sends.
- `opencode run --auto` replies `once` to every request in its session, asserted ones included
  (`packages/cli/src/run/noninteractive.ts`). The scenario that holds the prompt drives the parent
  through the API.
- The TUI's prompt (`packages/tui/src/routes/session/permission.tsx`) shows action and resources; a
  `source` of type `tool` adds that tool's input. `metadata` is read only for `url`, `query`,
  `provider`, `files` and `diff`, and `assert` cannot set the request's `message`.
  `permission.list` gives `metadata` and `source` back, so the asks inbox reads which child the top's
  prompt is for.
- `worktree.create`, `.remove` and `.list` take `projectID` (`location.project.id`); `agent.get`
  takes `location`. `agent.list` and `provider.list` wait for plugin activation, and `agent.list`
  declares a 503 `ServiceUnavailableError` while it has not finished.

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

## Web search's form

`websearch` first asks the `websearch` permission. With no provider chosen it shows "Web Search"
(`metadata: { kind: "websearch.provider" }`, one field `choice`: `allow`, `choose`, `disable`), and on
`choose` a second form with a field `provider`. After a minute, or a dismissal, the call fails with
"Web search cancelled", ending the call, not the turn. The choice is global (`websearch:provider` in
OpenCode's KV), and `disable` drops the tool everywhere. Two children are asked one after the other.
A plugin adds a provider with `ctx.websearch.transform((editor) => editor.add({ id, name, execute }))`,
as `e2e/search-plugin` does.

## The peer dependency and the host's runtime

- **Nothing checks the version.** `opencode plugin add` installs into an empty directory under
  `~/.cache/opencode/npm/`, with the peers at the versions the package names. Neither it nor the
  loader reads `peerDependencies` or `engines`. On 2.0.0 to 2.0.3 the plugin fails to load (no
  `model` domain); from 2.0.4 it loads, and what breaks does so on use.
- **From 2.0.25 the host's copies run.** `ensurePluginRuntime` (`packages/plugin/src/runtime.ts`)
  resolves every import of `effect` and `@opencode/plugin*` to OpenCode's own copy. The installed
  peers serve the build, the tests and older hosts. Either way the relay's Effects and the host's
  must compose, so the plugin's `effect` is the host's version.
- **The peers stay exact.** A range would install, on an older host, the newest match, which nothing
  tested. The exact `effect` peer can fail `npm install` with ERESOLVE in a project with another
  `effect`; `opencode plugin add` never meets that.
- **Update checks skip exact versions.** `plugin check`, `plugin update` and the TUI's check parse
  the entry with `npm-package-arg` and skip type `version` without asking the registry. A failed
  check reads as "no update".
- The loader refuses a plugin the organisation's managed policy denies: since 2.2.3 `plugin.use` on
  the plugin's target (`packages/core/src/plugin/module.ts`), before `integration.use` on
  `plugin:<name>`. The policy schema (`packages/schema/src/config/policy.ts`) adds `plugin.use`,
  `skill.use`, `mcp.use` and `integration.connect`, and decodes a legacy `integration.use` whose
  resource starts `plugin:`, `skill:` or `mcp:` into the new action, so old policies still apply.

## Two servers on one data directory

OpenCode keeps everything in one SQLite database (`$XDG_DATA_HOME/opencode/opencode.db`), which any
number of servers can open. Plugin storage is a slice of its `kv` table
(`plugin:<hex plugin id>:<key>`), shared; process memory (claims, the event bus, pending requests)
is not.

- Without a lock, both schedulers deliver a due message (seen for none to all of ten). The owner key
  ([architecture](architecture.md#two-servers)) fixes that.
- A child's turn runs in the server that queued its prompt, and only that server sees its
  `permission.asked` or `execution.failed`.
- `courier_answer` reaches a request only from the server where the child waits.

`e2e/two-servers.sh` (not in CI, a few minutes, no API key; `KEEP=1` keeps the logs) schedules ten
messages due together, twice (ticks in step, then half a tick apart), has a child ask for permission
and answers from each server, and fails a child's turn. It
exits 1 on a double delivery or any other result than the above. It does not cover the webhook
receiver or the question relay.

## OpenCode's schedules

With `experimental.schedules` on (off by default; added in 2.2.3, run under `opencode serve` too
since 2.2.4, by one server per database through the `schedule:leader` row of the `kv` table), the
`opencode_schedule_*` tools (`packages/core/src/tool/plugin/schedule.ts`) let a session prompt itself
later. The plugin API has no schedule domain and schedules publish no events, so no `Waits` supplier
can see one, and a child that schedules a wake and ends its turn would read as ended without a report.

- So every spawned session is created with `CHILD_RULES` (`tree/spawn.ts`): `opencode_schedule_*`
  denied on `*`. A root keeps the tools.
- They are Code Mode tools (namespace `opencode`), in `execute`'s catalog rather than tools of their
  own, so the `context` hook cannot drop them. `Tool.snapshot` (`packages/core/src/tool.ts`) drops a
  tool whose action, its id (`opencode_` and the name), a rule wholly denies, from the direct tools
  and the catalog alike; the session's rules come after the agent's (`session/context.ts`).
- 2.2.4's `ctx.experimental.artifact` (artifact providers for `artifact_create` and the rest, behind
  `experimental.artifacts`) is not used: the plugin stores and serves no files.

## Creating a worktree from a given commit

`worktree.create` takes `projectID` and optionally `from`, `branch`, `directory` and `name`
(`packages/core/src/worktree.ts`):

- **`from` is a source directory, not a ref:** one the project knows, else
  `SourceDirectoryNotFoundError`.
- **`branch` is a starting ref, not a new branch:** it runs
  `git worktree add --detach -- <dir> <branch ?? HEAD>`, so a commit works and HEAD is always
  detached. Uncommitted changes are not carried over.
- A project's worktrees share one repository, so commits and branches are visible across them.

For a nested isolated child, `courier_spawn` passes the parent's worktree as `from` and its HEAD as
`branch`, recorded as the child's `base`.

## Skills

- **Registering:** `ctx.skill.transform((editor) => editor.add(info))` with `id`, `name`,
  `description`, `autoinvoke`, `path` and `content`. `path`'s directory is named to the model, so a
  skill without files gives its own path, as the built-ins do (`/builtin/opencode.md`). The same id
  from several locations is one entry.
- **Listing:** every skill with a `description`, `autoinvoke` not `false` and not denied by a `skill`
  rule is listed in every system prompt (`core/skill-guidance`, `<available_skills>`, sorted by id).
  A change reaches a running session as a delta. `GET /api/skill?directory=…` lists them.
- **Loading:** `skill({ id })` asks the `skill` permission (with `save: [id]`). Its result is
  `<skill_content name="…">` with the content and the base directory; files are listed only when the
  path's basename is `SKILL.md`.
- **Activating:** the TUI's `/skills` attaches `skills: [{ id }]` to the prompt, and the text goes
  first in that message. A compaction keeps it (`messageToText`, `session/recent-text.ts`).
- **Managed policy:** a `skill.use` deny (before 2.2.3 `integration.use` on `skill:<id>`, still
  accepted) removes the skill from the registry (`packages/core/src/config/plugin/policy.ts`, a
  `post` plugin, so after the courier's `editor.add`). A denied `courier-orchestrate` is then neither
  listed nor loadable (`skill` fails "unable to load", `/skills` with `SkillNotFoundError`); the
  tools and the role part work without it, as with a `skill` rule's deny (`COURIER_SKILL=deny`).

## Keyed session instructions

`ctx.session.instructions.entry.put({ sessionID, key, value })`, `.list({ sessionID })` and
`.remove({ sessionID, key })`, since `@opencode/plugin@2.2.0` (anomalyco/opencode#56550); over HTTP
`GET /api/experimental/session/:id/instructions/entries` and `PUT` or `DELETE …/entries/:key`
(`packages/protocol/src/groups/session.ts`; the plugin API's path has no `experimental`). Since 2.2.1
its type is the client's `ExperimentalSessionApi` (anomalyco/opencode#59072), and the SDK's
`client.session.instructions` is a deprecated alias of `client.experimental.session.instructions`,
removed in the next minor; the plugin context's path may move with it, so a pin bump checks. The
courier writes three entries: a spawned session's role part to `role` and the project's lessons to `lessons`
(`spawn.ts`, before the prompt; `memory/lessons.ts` supplies the text and `courier_note` renews it),
and a parent's children to `standing` (`tree/standing.ts`, from the tools and events that move a
child, put only when the text changed, removed with the last child). Each value stays well under
3 KiB. Read in
`packages/core/src/session/instruction-entry.ts`, `instructions/index.ts`, `instruction-state.ts`,
`context.ts`, `model-request.ts` and `runner/llm.ts` at `v2.2.4`:

- **Rendering.** An entry is one block, `<context key="<key>">`, the value, `</context>`: a string
  as it is, any other JSON pretty-printed. The key matches `^[a-z0-9][a-z0-9._-]*$` (stored as
  `api/<key>`), and the value's JSON is at most 256 KiB (`InstructionEntryValueTooLargeError`, 413).
  A `put` of the value already stored changes nothing and announces nothing; the courier still
  `list`s and compares before a put that may be the same (`standing`, `lessons`), so an unchanged
  value costs one read and no write.
- **Where it lands.** The entries are the last of OpenCode's instruction sources, after the code
  mode catalog, MCP instructions, references, the skill listing, AGENTS.md and the built-ins, all
  rendered into one *baseline*: the second system part, after the agent's system prompt and before
  anything a `context` hook pushes. The hook's `event.system` is that pair, so a part the courier
  adds comes after the block. Since 2.2.3 that part also carries each source's text in
  `metadata.experimental.instructions`, `{ key, text }` (`baseTranscript`, `model-request.ts`), an
  entry under its stored key (`api/role`, not `role`), not updated when a hook edits `text`; marked
  experimental, so `context.ts` still reads the `role` entry through `entry.list`.
- **The baseline is fixed at the session's first step** (`InstructionState.prepare`, run at every
  step boundary) and moved only by a compaction (`advanceEpoch` on `session.compaction.ended`) or
  a revert past the epoch (`rewind`). So an entry put between `session.create` and the first prompt
  is in the system prompt from the first request, and the first `put` after spawn moves no cached
  prefix. An entry put after the first step is announced at the next step boundary as a
  `session.instructions.updated` event whose `text` is the block (for a new key), "The context under
  "<key>" changed and supersedes the previous value:" with the block (a changed one) or "The context
  under "<key>" no longer applies. Disregard it." (a removal); `message-updater.ts` stores it as a
  `system` message (`description` `Instructions updated: api/<key>`, the keys as stored, every key
  changed since the last step in one message, sorted: `api/lessons, api/role, api/standing` at a
  root's first spawn; in a turn a courier message starts, the message comes before that message),
  which goes to the model at its place in the transcript, after the tool result that put
  the entry, as a **user** message: `<system-update>`, the text with `&`, `<` and `>` escaped,
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
  (`session.compaction.failed`, no `ended`), as `e2e/mock-model.mjs` found before it answered with
  a heading.
- **What inherits it.** `session.fork` copies the parent's entries and baseline; a native child
  (`parentID`) and `session.create` do not. `courier_cleanup` and a forgotten child leave entries
  alone: they belong to the session and go with it.
- **Reading it.** `put`, `list` and `remove` need the session to exist (`Session.NotFoundError`) but
  boot no location (anomalyco/opencode#58997). The `context` hook reads nothing of the value: the
  courier lists a session's entries once per instance and session, and the text itself only shows
  in the model's request (`e2e/mock-model.mjs` logs `roleEntry` and `rolePart`).

## Models and variants

- `session.create` takes `model: { providerID, id, variant? }` (`Model.Ref`) from 2.0.4 on. A session that
  names a model runs on it at its own `variant`; the agent's `model.variant` counts only for a session
  with no model (`session/runner/model.ts`), so the plugin passes the agent's variant with its model.
- A model OpenCode does not have, or a variant the model has not, fails the session's first turn
  (`ModelUnavailableError`, `VariantUnavailableError` in `model-resolver.ts`), so `courier_spawn`
  checks a choice against `model.list()` first: `models.available()`, the enabled models, each with its
  `variants`. `"default"` is no variant (`withVariant`), and `session.get` fills `variant: "default"`.
- A configured model given neither `capabilities.reasoning` nor `variants` gets its package's default
  ones (`variant.ts`): `low`, `medium` and `high` for an OpenAI-compatible one, each the setting
  `reasoningEffort`, which reaches the provider as `reasoning_effort`. So the live suite's `mock/chat`
  and `mock/other` have them.
- A session `opencode run` without `--model`, or the API, creates has no `model`: the runner takes
  `model.default()`. The plugin reads that default itself (`ctx.model.default()`, the plugin's own
  location) and passes it to `session.create` as such a parent's model, so a `variant` alone has a
  model to apply to and the child is pinned to it; with the agent's lookup failed it passes none,
  since OpenCode then applies the agent's own model.

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
- **The paired app's dock** (`session-request-tree.ts`) walks `parentID` down from the open session.
  Read in the source only.

## TUI and RPC entrypoints

- **Found by export.** `Host.resolve` (`packages/plugin/src/host.ts`) resolves `<name>/server` (else
  the package), `<name>/tui` and `<name>/rpc`. In a local directory, `tui.js` and `rpc.js` sit next
  to `index.js`. A local plugin given as a file path gets `server` only.
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
  ERESOLVE. They are devDependencies at the versions of OpenCode's catalog (`@opentui/*` `0.8.0`,
  `solid-js` `1.9.17` at `v2.2.4`, unchanged from `v2.2.3`), and `@opencode/theme` at the pin.
  `@opencode/plugin`'s own optional `@opentui/core` and `@opentui/solid` peers are ranges since 2.2.3
  (`>=0.8.0`); the plugin's stay devDependencies.
- **JSX must be compiled before publishing.** The host transforms `.tsx` only outside
  `node_modules`, so `script/build-tui.ts` bundles with `createSolidTransformPlugin()` and
  `packages: "external"`. `@arethetypeswrong/cli` flags an export without types, hence
  `tsconfig.tui.json` for `dist/tui.d.ts`.
- **RPC.** `Rpc.define` (`@opencode/plugin/rpc`) takes `{ id, methods, events }`; `rpc.*` names are
  reserved. Registration and `client.rpc` take Standard Schema, so one definition serves both
  halves. One service per location; the last registration of an id answers. Errors:
  `rpc.invalid_input`, declared errors, `rpc.internal`, `rpc.unavailable`, `rpc.invalid_output`.
  Over HTTP: `POST /api/rpc/:rpcID/:method?directory=…` with `{ "input": … }`.
- **Options:** `ctx.options` is the TUI's own `cli.json` entry. A plugin loaded from the server's
  list enters bare, so `opencode.json` options never reach it. The TUI's `animations` setting is not
  on the plugin API, hence the plugin's own option.
- **The context:** `ctx.client` is the TUI's client. `ctx.location` may be `undefined`; fall back to
  `ctx.data.location.default()`. The footer slot shows on the home screen too, with no `sessionID`.
  `data.session.permission` has no `reply`, so the inbox uses `client.permission.reply`. Forms go
  through `data.session.form.reply` and `client.session.form.list`. OpenCode sounds `permission` and
  `question` for every request and form itself.
- **A slot that renders bare text** shows a crash toast, no longer taking the TUI down; a slot still
  renders only elements.
- **A dialog replaces the one open** (`createDialogApi`, `packages/tui/src/plugin/api.tsx`): the open
  `select` resolves `undefined`, as on `esc`. `select` takes no starting query, so a changed list
  means a new `select` with an empty search. `current` matches by deep equality
  (`ui/dialog-select.tsx`).
- **A select's rows** are one line: title (cut at 61), description, and a right-aligned footer that
  squeezes them. `large` is 88 columns, `xlarge` 116. Rows also take an undeclared `details: string[]`
  of muted lines, which the memory view uses for lessons; a later host may drop it (2.2.4 still
  reads it, and colours the detail line from the `dialog.footer` surface 2.2.2 added). A `disabled`
  option is left out.
- **Theme:** 2.2.2 retires `text.faint` from the new designs (its dialogs use `text.muted` where
  they used `faint`) and adds the `dialog.footer` surface (`useTheme().surface("dialog.footer")`,
  layered on `dialog`; a theme's `@dialog` may carry `@footer`). No TUI part of the plugin uses
  `text.faint` or a surface.
- **The panel belongs to one session.** `ui.panel.open` targets the route's session, and the app
  closes it on any route change (`app.tsx`). A new panel takes the keyboard. So the tree panel
  reopens itself after a route change, and hands the keyboard back with
  `keymap.dispatch("pane.focus.left")` when it did not have it.
- **A panel splits from 108 columns, less the vertical tabs** (`canSplit`, `context/panel.tsx`;
  `> 80` up to 2.0.29). The plugin cannot read the tabs' width, so it notes the split only at a
  `renderer.width` of 108 or more.
- **Keys OpenCode takes after `<leader>`:** `a b c e g i l m n q r s t u w x y`, the digits and the
  arrows (`config/v1/keybind.ts`). The inbox takes `<leader>k`.
- **A span's colour is not cleared by `undefined`:** `@opentui/solid` keeps the old `bg` and `fg`,
  and `attributes` only gain bits. Digby's spans are reused through `<Index>`, so every cell gets a
  `bg`, transparent where it has none. A `<box>`'s `backgroundColor` does clear.
- **Testing:** unit tests use OpenTUI's `testRender`, with `bunfig.toml` preloading
  `@opentui/solid/preload`. The live check reads `tmux capture-pane -p`; CI installs `tmux`. The TUI
  logs to `$XDG_DATA_HOME/opencode/log/opencode.log`.
