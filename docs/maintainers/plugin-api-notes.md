# Plugin API traps

What the OpenCode V2 plugin API and host do that the plugin works around, or relies on, at the
pinned version: `@opencode/plugin@2.0.32` and OpenCode 2.0.32. A pin bump re-checks each trap and
updates the ones it changes. OpenCode's source is on the `v2` branch of
https://github.com/anomalyco/opencode, each release tagged (`v2.0.32`); paths below are in it. The
[reference](../reference.md) says what the plugin does.

## Tools

- A plugin tool is reachable only through code mode's `execute` tool unless it is registered with
  `options: { codemode: false }`.
- A tool whose result `metadata` holds an `undefined` value never completes: the call stays
  `running` and no error is reported. Results drop `undefined` keys.
- OpenCode errors such as `Session.NotFoundError` can arrive with an empty message, so the tools
  rethrow them through `describeFailure`, with the tag (`_tag`, as on `WorktreeError`) and the
  session id. The promise adapter runs a tool's `execute` with `Effect.tryPromise`: a throw is a
  `Tool.Error` with its message, which the model gets as the tool's error, and the turn goes on.
- OpenCode decodes a tool's input with its own `effect`. On hosts before 2.0.25, which run the
  plugin on its own copy (below), schema checks and transformations of the plugin's copy did not
  survive that: `Schema.Finite` refused the number `2`, `Schema.FiniteFromString` failed with
  "Cannot convert a symbol to a number". Tool inputs use plain schemas and the tools validate the
  values themselves; a unit test keeps it that way.
- `Schema.Number` advertises the strings `"Infinity"`, `"-Infinity"` and `"NaN"` in its JSON
  Schema, and some models send numbers as strings regardless, so `courier_later` takes
  `delayMinutes` as either.
- Effect 4.0.1 renders a `Schema.Struct` as an open object (`additionalProperties: true`) unless a
  closed one is asked for per call. OpenCode asks for it for every tool
  (`Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })` in
  `packages/core/src/tool/runtime.ts`), so models are sent `additionalProperties: false`;
  `test/notices.test.ts` renders the schemas the same way.
- An undeclared key never reaches a tool: OpenCode's `tool-input-repair` plugin
  (`packages/core/src/plugin/tool-input-repair.ts`) deletes, on `execute.before`, each key a closed
  schema does not declare, and the decode ignores it too. OpenCode removes keys and never adds one,
  so a renamed optional key stays declared under its old name for as long as it is accepted.
- A plugin cannot add an HTTP route to OpenCode's server: `rpc.register` is reached through the
  authenticated `/api/rpc` endpoint with a JSON envelope, which neither GitHub's headers nor the raw
  body its signature covers would get through. The webhook receiver is its own listener in the
  OpenCode process, shared by the plugin's instances; it waits for the previous listener to close
  before it binds, as after a reload, and the next instance to load retries a failed bind.
- A plugin's options come from a `{ "package", "options" }` entry in `plugins`, which takes a local
  directory as `package` too. A configured local plugin must be a directory: OpenCode loads its
  `index.js` (or the entry its `package.json` names), and ignores a path to a file with a warning.

## Events

- `permission.asked`, `permission.replied`, `form.created`, `form.replied`, `form.cancelled` and
  `session.execution.*` reach every location's instance through `event.subscribe()`, once per
  instance, with the same event id ([isolated children](#isolated-childrens-events)). An instance
  receives only events published while it is subscribed: the hub keeps a standby subscription for
  the hand-over when an instance unloads, and relays pending permission requests on every
  (re)subscribe.
- `session.execution.started`, `.succeeded`, `.failed` and `.interrupted` frame a session's busy
  period: one terminal event however many prompts were steered into it. `.interrupted` carries a
  `reason`: `user`, `shutdown` (resumed on the next start) or `inactivity` (an idle location is
  evicted, which stops its sessions without resuming them); the schema's `superseded` is published
  by nothing. A message steered into a running turn interrupts nothing: `inbox.enqueued`
  (`delivery: "steer"`) as it is sent, `inbox.delivered` at the turn's next step, then the one
  `.succeeded`. An interrupt with `resume` while a steer waits publishes `.interrupted` (`user`),
  then `.started` and the steer's `inbox.delivered`, so the session owes a report again.
- `session.inbox.delivered` (`data.inboxID` only) is published as each prompt, synthetic message,
  requested compaction or move reaches the session; the runner's own compactions skip the inbox, as
  does the synthetic message it adds to continue a response cut off at the output token limit, so a
  continued turn owes no report again (after two such continuations the turn fails as
  `output-limit`). The message it makes is stamped with that event's `created`. Only
  `session.inbox.enqueued`, published as the item is admitted, carries its type (`data.item.type`:
  `user`, `synthetic`, `compaction` or `move`; a `session.prompt` is `user`), so the plugin remembers
  it until delivery.
- A synthetic message steered to an idle session starts its turn in a fixed order:
  `session.synthetic({ delivery: "steer" })` (`Session.synthetic`, `packages/core/src/session/session.ts`)
  admits the item (`session.inbox.enqueued`, and a pending row in the session inbox table), then
  rings the process-local run coordinator's doorbell (`execution.wake`,
  `packages/core/src/session/run-coordinator.ts`), whose fiber publishes `session.execution.started`
  with a write-ahead claim in the session store and drains: the runner promotes the pending steer
  (`session.inbox.delivered`, the row deleted) and runs the turn to its one terminal event. A healthy
  wake is `enqueued → started → delivered → … → succeeded`; a courier-delivered message is owed a
  turn when `enqueued` has no `started` behind it (unless it was sent with `resume: false`), and only
  a new synthetic, prompt or resume for that session rings the doorbell again.
- A lost wake is silent in the events: `enqueued` with no `started` (and no `delivered`, which only a
  drain publishes). The host's own paths to it: `synthetic` skips the wake while the session has a
  staged revert (`session.revert`), holding the input until the revert commits on the next prompt or
  compaction; and an interrupt landing between the doorbell and the execution's stop clears the
  pending wake, leaving the row pending with no error and no log (`reportLifecycle` swallows
  interrupt-only causes). `delivered` without `started` cannot be produced by the host's ordering,
  so that signature means this instance missed the `started` event or the events were reordered.
  Neither path reproduces on demand, so the missed-wake watch keys on the first signature.
- An item waiting in the inbox bumps the session's `time.updated` (`updated` equal to the item's
  `time.created`, `idle` unchanged), so `busy()` reads a session with an undelivered message as
  running. The plugin API cannot list the inbox (`GET /api/session/:id/inbox` can); a delivered item
  becomes the stored message with the same id. `session.synthetic` with the `id` of an item still
  waiting, or already delivered, returns that item (`reconcile` in `packages/core/src/session/inbox.ts`
  matches on session and type only, publishing nothing) and still wakes the session, so a wake sent
  again adds no second message. `session.status` and `session.idle` are in the schema but published
  by nothing in core.
- **`resume: false` is the only way to send a message that does not start a turn.** `Session.synthetic`
  admits the item and rings the run coordinator unless `resume === false`, whatever the `delivery`:
  `queue` still wakes an idle session. With `resume: false` the item waits in the inbox and is
  promoted by the session's next turn, whoever starts it; the live test also uses it to stage a
  missed wake. The `session.inbox.enqueued` event carries the item (`delivery`, `payload`) but not
  `resume`, so the missed-wake watch cannot tell such an item from a lost wake: the plugin marks the
  ones it sends so in their metadata (`resume: false`, next to `source: "courier"`) and `watchWake`
  skips them. The settled notice of a permission request is sent this way.
- Every event carries `created`, the epoch milliseconds OpenCode published it at, which the report
  state compares with the server's clock at `courier_send`.
- `session.context()` returns the session's stored messages (`SessionMessage.Info[]`), not the
  model-facing ones the `context` hook sees. A session's message list records an `idle` message
  when a turn ends, with `outcome: "succeeded" | "failed" | "interrupted"` (and an `error` on a failed
  one); the real-model checkers take it as the end of a turn.
- OpenCode stops every turn in a project location after 60 minutes without a stored session event
  there (`inactivity`), which withdraws any open question. A tool call has no timeout of its own.
- A graceful shutdown closes the locations one after another. A closing location first withdraws
  its open forms, so a question call dies with `QuestionTool.CancelledError` as if the person had
  dismissed it; some 40 ms later `location.shutdown` (`location.directory` names it) reaches every
  instance still loaded, and then the plugin unloads. The question relay holds a dismissal for 2
  seconds to see whether a shutdown or its instance's unload follows.
- `GET /api/plugin?directory=<worktree>` does not boot that worktree's location; a session run from
  the directory does. A session whose location's directory no longer exists answers 404 with
  `LocationNotFoundError`, on routes the courier does not call; the webhook's test for a session
  OpenCode no longer knows (an error tag with `NotFound`) would match it too. The server's health
  route is `/api/info` (version, pid, urls).

## Permission requests

- OpenCode keeps pending permission requests per location, and an instance's `permission` domain
  answers from its own location's, so a request of an isolated child is answered through the
  instance loaded in the child's worktree. The plugin keeps every loaded instance's domain and
  answers through the one that holds the request.
- `permission.reply` takes the answer as `decision`, as does
  `POST /api/session/:id/permission/:request/reply`; the `permission.replied` event carries it as
  `reply`, and so does `courier_answer`'s parameter.
- A request rejected without a message ends the asking session's turn ("The user declined this
  tool call"); with a message only the tool call fails, and its model is told the call could not
  be run, not the message. `courier_answer` and the asks inbox always send one with a rejection.
- `permission.assert({ sessionID, action, resources, save?, metadata?, source?, agent? })` evaluates
  the session's rules (the agent's and the session's, then the project's saved ones) for every
  resource and, when any says ask, creates a pending request in that session, publishes
  `permission.asked` and waits for the reply (`packages/core/src/permission.ts`). It resolves with
  nothing: the request's id and whether the person chose `once` or `always` come only from the
  session's `permission.asked` and `permission.replied` events, matched by action and resources,
  which another request of the session can share. With `save`, an `always` reply saves an allow rule
  for the whole project (`PermissionSaved`, read by every session in it) and OpenCode answers every
  other pending request of that location the rule now allows, with `always`, a shared child's
  included; so `courier_answer` asserts without `save` and passes `once`. Through the promise API it
  rejects with a `Tool.Error` (`_tag` `Tool.Error`, the reason in `message`) whose `error` is
  OpenCode's `Permission.BlockedError` (a deny rule) or `Permission.CorrectedError` (a rejection with
  feedback), or `Session.NotFoundError`; a plain rejection rejects with the `Permission.DeclinedError`
  itself (`_tag` `Permission.DeclinedError`), which the promise tool wrapper attaches to a
  `Tool.Error` and `SessionModelRequest.executeTool` recovers to end the step, so the tool must
  rethrow it untouched, not through `describeFailure`. The tool part then ends with `error.type`
  `aborted` ("The user declined this tool call") and the model is not called again, but neither the
  session's `time.idle` nor an `idle` message in the transcript marks that turn's end.
- `opencode run --auto` replies `once` to every request asked in its own session, the asserted ones
  included (`packages/cli/src/run/noninteractive.ts`), so the live suite's parent answers its own
  prompt; the scenario that holds the prompt drives the parent through the API instead.
- The TUI's prompt (`packages/tui/src/routes/session/permission.tsx`) shows the action and
  resources, and a `source` of type `tool` adds that tool part's input to the presentation (a shell
  command from `input.command`, nothing from `courier_answer`'s input); `metadata` is read only for
  a few keys (`url`, `query`, `provider`, `files`, `diff`), so the child's ids in it are not shown,
  and the request's `message` cannot be set through `assert`. `permission.list` gives the pending
  request with the `metadata` and `source` passed to `assert`, so the asks inbox reads from
  `metadata` which child's request the top's prompt is for.
- `worktree.create`, `worktree.remove` and `worktree.list` take the project, `projectID`
  (`location.project.id`), not a location; `agent.get` takes `location`.

## The question tool and forms

- A plugin can replace the `execute` of any tool, OpenCode's own included, with `tool.transform`
  and the editor's `update` (a missing id is ignored). OpenCode's question tool, `question`, comes
  from a plugin of OpenCode's own that loads before external ones. A plugin loaded after this one
  that replaces `question` as well drops the relay.
- The promise API hands the original `execute` out as a function returning a promise. The question
  relay must withdraw a child's question once the parent's answer is in, and only interrupting the
  call does that: OpenCode's form service withdraws a question's form when its call is interrupted,
  and the plugin API cannot withdraw or answer a form (the context has no form domain). So the
  default export is an Effect plugin (`{ id, effect }`): it runs the promise plugin through
  `fromPromise` from `@opencode/plugin/promise/adapter`, as OpenCode does with a promise plugin,
  and wraps `question` with the Effect API, whose original `execute` can be raced and interrupted.
- The promise adapter builds the promise plugin's context with the very `location` object the
  Effect half is handed, and the relay finds its instance's ports in the hub by it. An adapter that
  copied the object would leave every question call unchanged.
- The question tool asks through a form. `form.created` (ephemeral, never stored) carries the
  form's `metadata.tool.id`, the call's id, and comes only after the call's permission check has
  passed. A person dismissing it makes the tool die with `QuestionTool.CancelledError`, which ends
  the asking session's turn ("The user dismissed this question"). Forms live in memory: a restart
  drops them, and the call stays `running` until the session's next turn marks it aborted.
- What a plugin sees of a form: `form.created` (`data.form`: `id`, `sessionID`, `title`,
  `metadata`, `fields`, each with `key`, `type`, optional `title` and `description`, and `options`
  of `value` and `label` for a choice), `form.replied` (`id`, `sessionID`, `answer`) and
  `form.cancelled` (`id`, `sessionID`). Forms come from the question tool (`kind: "question"`),
  web search (below) and MCP elicitation (`kind: "mcp-elicitation"`, under the session id
  `global`). `DELETE /api/session/:id/form/:form` dismisses one, `GET /api/form` lists every open one.

## The peer dependency and the host's runtime

- **Nothing checks the version.** `opencode plugin add` installs the plugin on any V2 host into
  `~/.cache/opencode/npm/opencode-courier@latest/<timestamp>/`, an empty directory, with the peer
  dependencies next to it at the versions the package names, whatever `opencode --version` says.
  Neither `plugin add` nor the loader reads `peerDependencies` or `engines`. On 2.0.0 to 2.0.3 the
  plugin fails to load (`TypeError: undefined is not an object (evaluating 'host.model.list')`,
  the `model` domain came in 2.0.4); from 2.0.4 on it loads without a word, and what breaks does
  so on use. The plugin's own load-time log line ([the
  reference](../reference.md#the-opencode-version)) is the only runtime signal.
- **From 2.0.25 on the host's copies run.** The CLI calls `ensurePluginRuntime` from
  `@opencode/plugin/runtime` before anything else (`packages/cli/src/index.ts`): every import of
  `effect`, a public `effect/*` path or `@opencode/plugin*` from a plugin or its dependencies
  resolves to OpenCode's own copy (`packages/plugin/src/runtime.ts`), and loading a file of either
  package from a plugin's `node_modules` fails. So the installed peers serve the build, the unit
  tests and hosts before 2.0.25, which run the plugin on the copy installed next to it. Either way
  the question relay's Effects and the host's must compose, so the plugin's `effect` is the host's
  version.
- **The peers stay exact.** `@opencode/plugin` is the same exact version as peer and as
  devDependency: on an older host a range would install the newest matching version, which nothing
  has run the suite with, and on a newer one the pin names exactly one tested version. The README's
  table keeps one version per row for the same reason. `effect` is a peer, not a dependency: the
  host supplies it. Its peer is exact and equal to the `effect` the pinned `@opencode/plugin`
  depends on; a unit test keeps both. The exact peer can make an `npm install` fail with ERESOLVE in
  a project that already uses another `effect`; `opencode plugin add` installs into an empty
  directory and never meets that.
- **No peers for the TUI part** ([below](#tui-and-rpc-entrypoints)).
- OpenCode's loader consults the managed policy before loading a plugin and refuses one an
  organisation's policy denies (`integration.use` on `plugin:<name>`); the load reports `blocked`.

## Update checks and exact versions

`opencode plugin check`, `plugin update` and the TUI's *check for updates* parse the configured
entry with `npm-package-arg` and skip one whose type is `version` without asking the registry:
`opencode-courier@0.2.1` is never reported outdated, while `opencode-courier`,
`opencode-courier@latest` and `opencode-courier@^0.2.0` are compared with what the registry resolves
the spec to. A failed check is logged as `failed to check plugin update` and reads as "no update".
Hence the README's advice to install by name.

## Web search's form

The `websearch` tool first asks the ordinary `websearch` permission, which the permission relay
passes on. With no provider selected it asks through the form service: "Web Search", with
`metadata: { kind: "websearch.provider" }` and one string field `choice` (`allow`, labelled "Allow
search via" and the providers' names; `choose`; `disable`), and on `choose` a second form, "Choose a
web search provider", with the same kind and a field `provider`. The selection has a one-minute
timeout; at the timeout, or when the person dismisses either form, the form is withdrawn and the
call fails with "Web search cancelled", wrapped in "Unable to search the web for <query>", which ends
the call, not the turn. The choice is global (OpenCode's KV, `websearch:provider`), and `disable`
drops the tool from every session. Two children searching at once are asked one after the other. A
plugin adds a provider with `ctx.websearch.transform((editor) => editor.add({ id, name, execute }))`,
as the live test does with `e2e/search-plugin`.

## When a session's turn ended

A session's `time.idle` is when its last turn ended, in epoch milliseconds, stamped by the session
projector from `session.execution.succeeded`, `failed` and `interrupted`, but not from an
interruption by a shutdown (`projectIdle` in `packages/core/src/session/projector.ts`). It is
persisted, never cleared when a turn starts, and always moves forward (`max(created, previous + 1)`).
A join group's release compares it with when its last member joined. The projection is in place by
the time the plugin's watcher sees the turn's end and nudges the scheduler.

## Isolated children's events

An isolated child runs in a location of its own, its worktree, and OpenCode sets the plugin up once
per location. The live test's probe plugin (`e2e/probe-plugin`) showed, with the parent's project,
the child's worktree and an unrelated worktree loaded, that `permission.asked`, `permission.replied`,
`form.created`, `form.replied`, `form.cancelled` and `session.execution.failed` from the child's
worktree reach all three instances: an event's location does not limit who receives it.

## Two servers on one data directory

OpenCode keeps everything in one SQLite database (`$XDG_DATA_HOME/opencode/opencode.db`), and any
number of servers can open it: `opencode serve` twice, or next to `opencode service`. Plugin storage
is a slice of its `kv` table (`plugin:<the plugin id, hex-encoded>:<key>`), so two servers' instances
share the roster, `courier_later` messages and stored questions, but not process memory: the hub's
claim sets, the event bus and pending permission requests. So:

- Without a lock both schedulers would deliver a due message (seen: none to all ten of ten due
  together, varying by run); the owner key ([architecture](architecture.md#two-servers)) makes one
  deliver. The storage has no compare-and-set.
- A child's turn runs in the server that queued the message starting it, and only that server's
  watcher sees its `permission.asked` or `session.execution.failed`: told once.
- `courier_answer` reaches a request only from the server where the child waits; the API has no
  channel between servers. `courier_status` lists only its own server's requests, and the question
  relay sees only questions asked on its own server.

`e2e/two-servers.sh` measures it (not in CI; a few minutes, no API key; `KEEP=1` keeps the logs):

```bash
npm install --prefix <scratch>/oc @opencode/cli@2.0.32
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/two-servers.sh
```

It starts two servers on one data directory with the stand-in model, schedules ten `courier_later`
messages that fall due together, twice (ticks in step, then half a tick apart), starts a child that
asks for a permission and has the parent answer it from each server, and one whose turn fails. It
exits 1 when a message is delivered twice or a result differs from the above. Not covered: the
webhook receiver (one process binds the port) and the question relay.

## Creating a worktree from a given commit

`worktree.create` takes `projectID` and optionally `from`, `branch`, `directory` and `name`
(`packages/core/src/worktree.ts`, `worktree/git.ts`):

- **`from` is a source directory, not a ref**: one the project already knows (its main worktree or
  one it created), else `SourceDirectoryNotFoundError`; the project's own worktree by default.
- **`branch` is a starting ref, not a new branch's name**: the git strategy runs
  `git worktree add --detach -- <dir> <branch ?? HEAD>`, so a commit hash works and the worktree is
  always on a detached HEAD. Uncommitted changes are never carried over.
- Worktrees of one project share one repository, so their commits and branches are visible to each
  other.

`courier_spawn` passes, for a nested isolated child, the isolated parent's worktree as `from` and its
HEAD commit as `branch`, which the child's roster entry records as `base`.

## Skills

- **Registering.** `ctx.skill.transform((editor) => editor.add(info))`, with a `Skill.Info`: `id`,
  `name`, `description` and `autoinvoke` (both optional), `path` and `content`; a wrong shape throws
  from `add`. `path` is typed absolute but checked as a string; its directory is named to the model,
  so a skill without files gives a path of its own, as OpenCode's built-ins do
  (`/builtin/opencode.md`). Registrations are scoped to the instance, and the same id from several
  locations is one entry.
- **Listing.** Every skill with a `description`, `autoinvoke` not `false`, and not denied by a
  `skill` permission rule, is listed in every session's system prompt under the instruction key
  `core/skill-guidance`, in an `<available_skills>` block sorted by id; a change reaches a running
  session as a delta. `GET /api/skill?directory=…` lists them.
- **Loading.** The model calls OpenCode's `skill` tool (`skill({ id })`), which asks the `skill`
  permission for the id (with `save: [id]`, so "always" is offered). Its result is
  `<skill_content name="…">`: `# Skill: <name>`, the content, `Base directory for this skill:
  <dirname(path)>` and a `<skill_files>` list, read from disk only when the path's basename is
  `SKILL.md`.
- **Activating.** The TUI's `/skills` dialog inserts `@<id>` and attaches `skills: [{ id }]` to the
  prompt; the skill's text goes to the model as the first part of that user message. A compaction
  keeps `[Skill activated: <name>]` and the text.

## Native `parentID`

What `nativeChildren` ([reference](../reference.md#native-child-sessions)) rests on:

- **`Session.create` takes a `location` or a `parentID`**, never both: with a parent the child takes
  the parent's location, so an isolated child, which needs its worktree's location, cannot have one.
- **Inheritance.** A child created with a `parentID` and no `permissions` gets its parent's
  session-level ruleset (`input.permissions ?? parent?.permissions` in
  `packages/core/src/session.ts`); `permissions: []` is kept as given, which the plugin passes.
  `metadata` is inherited likewise; the plugin always passes its own.
- **What providers see** (`session/affinity.ts`, `session/model-request.ts`): `parentID ??
  fork?.sessionID ?? id` goes out as `x-session-affinity`, `X-Session-Id`, `x-opencode-session` and
  the `promptCacheKey`, plus `x-opencode-parent-session-id` and `x-parent-session-id` with a parent.
  The GitHub Copilot provider sends `X-Interaction-Type: conversation-subagent` and
  `x-initiator: agent` for a session with a parent; not tried on Copilot.
- **The TUI.** A root session's view (`packages/tui/src/routes/session/index.tsx`) lists the
  permission requests and forms of the root and every descendant, the permission prompt before any
  form, and a child's own view lists none; `autoaccept` replies `once` to every request of the
  family. Home and session dialogs list `parentID: null` only; a native child is reached from the
  subagent tab or "Go to parent session". `data.session.cost` of a root sums its family.
- **`opencode run`** (`packages/cli/src/run/noninteractive.ts`) treats a session whose `parentID`
  chain leads to its session as its own: it replies `once` to its requests with `--auto`, rejects
  them without, and cancels its questions and forms. The live suite drives native scenarios through
  `POST /api/session/:id/prompt` for that reason.
- **Deletion.** `Session.remove` interrupts the session, then removes each native child the same
  way, recursively, with a `session.deleted` each. Interrupts are per session.
- **Otherwise unchanged**: no generated title and no warming for a session with a `parentID` (the
  courier sets the title); nothing at start-up reads it.
- **The paired app's request dock** (`packages/app/src/session/requests/session-request-tree.ts`)
  walks `parentID` edges down from the open session and shows the first pending ask in the tree.
  Read in the source only; not tried on a device.

## TUI and RPC entrypoints

- **Found by export.** `Host.resolve` (`packages/plugin/src/host.ts`) resolves `<name>/server` (else
  the package), `<name>/tui` and `<name>/rpc` with `Bun.resolveSync`, so `package.json` exports
  `./tui` and `./rpc`. For a local directory it resolves `tui` and `rpc` inside it, so `tui.js` and
  `rpc.js` sit next to `index.js` in `dist/`. A local plugin configured by a file path gets `server`
  only.
- **The server runs only `server`**, and records `features: { server, tui, rpc }` from what resolved,
  shown in `GET /api/plugin` once a location has booted. `opencode plugin add` adds a package with a
  `server` entrypoint to the global config's `plugins` (one with only `tui` goes to the TUI's).
- **The TUI loads `tui`** for each active plugin of the server's inventory with `features.tui`
  (`packages/tui/src/plugin/context.tsx`), from the directory the server installed or the local path,
  with a plain `import()`. The module default-exports `{ id, setup }`, as `Plugin.define` from
  `@opencode/plugin/tui` returns; `setup` may return a cleanup.
- **The host provides the TUI's imports.** The TUI's loader calls `ensurePluginRuntime()` and
  OpenTUI's `ensureRuntimePluginSupport`, which rewrite a plugin's imports of `effect`,
  `@opencode/plugin/*`, `@opentui/core`, `@opentui/core/testing`, `@opentui/solid`,
  `@opentui/solid/components`, `@opentui/solid/jsx-runtime`, `@opentui/solid/jsx-dev-runtime`,
  `solid-js`, `solid-js/store` and `@opencode/plugin/tui` to the host's modules without resolving
  them on disk. Anything else (`solid-js/web`, `@opencode/theme`, which the context only types) is
  not provided and must not be imported at runtime. OpenCode patches its `solid-js`; the TUI part
  runs on that copy, the unit tests on the unpatched one.
- **No peers for them.** An exact optional peer `@opentui/core` broke `opencode plugin add` with
  npm's `ERESOLVE`, against the newer `@opentui/solid` npm picked for `@opencode/plugin`'s `>=`
  range; with no such peer npm installs no `@opentui` and the host provides them. The TUI's packages
  are devDependencies at the versions OpenCode's root `package.json` catalog pins (`@opentui/*`
  `0.5.17`, `solid-js` `1.9.15` at `v2.0.32`), and `@opencode/theme` at the pin, for the typecheck and
  the tests.
- **JSX must be compiled before publishing.** The host transforms `.tsx` only outside
  `node_modules`, so `script/build-tui.ts` bundles `src/tui.tsx` with `Bun.build`,
  `createSolidTransformPlugin()` and `packages: "external"`, as OpenCode builds its CLI.
  `@arethetypeswrong/cli` flags an export without types, hence the declaration-only
  `tsconfig.tui.json` pass for `dist/tui.d.ts`.
- **RPC.** `Rpc.define` (`@opencode/plugin/rpc`) takes `{ id, methods: { <name>: { input, output,
  errors? } }, events }`; names starting with `rpc.` are reserved. The promise `ctx.rpc.register` and
  the client's `client.rpc(definition)` take Standard Schema or JSON Schema, so the contracts use
  `Schema.toStandardSchemaV1` and one definition serves both halves. The service is one per location
  and the last registration of an id answers, disposed with the plugin's scope. A call validates the
  input (`rpc.invalid_input`), encodes a declared error, turns a defect into `rpc.internal`, races
  the location's closing (`rpc.unavailable`) and encodes the output (`rpc.invalid_output`). Over
  HTTP: `POST /api/rpc/:rpcID/:method?directory=…` with `{ "input": … }`, answering `{ "output": … }`.
- **A TUI part's options.** `ctx.options` is the `options` of the TUI's own config entry (`cli.json`'s
  `plugins`, the `{ "package", "options" }` form); a plugin the TUI loads from the server's list
  enters as a bare target (`packages/tui/src/plugin/context.tsx`), so the server's `opencode.json`
  options never reach it. The TUI's `animations` setting (`cli.json`, toggled by
  `app.toggle.animations`) is read only by its built-in parts; the plugin API has no settings, so
  the tree panel takes `"animations": false` from its options.
- **The TUI context.** `ctx.client` is the TUI's own client; `ctx.location` may be `undefined`, in
  which case a call goes to the server's default location, so the courier falls back to
  `ctx.data.location.default()`. The prompt footer's slot is on the home screen too, with no
  `sessionID`. `data.session.permission` has no `reply`, so the asks inbox replies through
  `client.permission.reply`; forms go through `data.session.form.reply` and are listed with
  `client.session.form.list`, since the server API has no form domain. OpenCode's own notifications
  part sounds `permission` and `question` for every request and form the TUI sees.
- **A dialog replaces the one open.** `createDialogApi` (`packages/tui/src/plugin/api.tsx`) shows
  every dialog through the TUI's `dialog.replace`, which calls the open one's `onClose`: an open
  `select` then resolves with `undefined`, as on `esc`, and `clear()` does the same. `select` takes a
  fixed list and no starting query (`search` only filters), so the asks inbox shows a changed list by
  opening a new `select`, whose search starts empty, and sets its size again (`replace` resets it).
  Its `current` puts the cursor on the option whose value deep-equals it (`isDeepEqual` in
  `ui/dialog-select.tsx`), the first row with none, so a value read afresh finds its row.
- **A select's rows.** `DialogSelectOption` in the plugin API declares `title`, `value`,
  `description`, `footer`, `category` and `disabled`. The host's row (`DialogSelectRow` in
  `packages/tui/src/ui/dialog-select.tsx`) is one line: the title, truncated to 61 characters, the
  description after it in the same text, cut at the row's end, and the footer right-aligned at its
  full width, which squeezes the two; a `large` dialog is 88 columns, an `xlarge` 116, or the
  terminal's width. `createDialogApi` spreads each option into the host's `DialogSelect`, whose rows
  also take `details: string[]`, muted lines under the row, each cut in the middle to the dialog's
  content width, which the memory view uses for a record's lesson. Undeclared: a later host may drop
  the pass-through, and the lesson line would go from the list, not from the record in full. A
  `disabled` option is left out of the list, not shown greyed.
- **The panel belongs to one session.** `ui.panel.open` targets the route's session; the app closes
  the panel on any route to another (`packages/tui/src/app.tsx`), each session's frame is keyed by
  its id, and a newly mounted panel takes the keyboard (`component/session-frame.tsx`, `onTarget`).
  So the tree panel reopens itself after a route change with `presentation`, and gives the keyboard
  back with `keymap.dispatch("pane.focus.left")`, the host's own command, when it did not have it.
- **A panel splits from 108 columns, measured less the vertical tabs.** `canSplit` in
  `packages/tui/src/context/panel.tsx` is `width() >= SESSION_PANEL_SPLIT_MIN_WIDTH` (64 + 44 = 108,
  `packages/tui/src/ui/layout.ts`); up to 2.0.29 it was `width() > 80`. Narrower, OpenCode shows the
  panel fullscreen whatever was asked. `width` is the terminal's width minus the vertical session
  tabs when they show (`app.tsx`, `panels.setWidth(...)`). The plugin cannot read the tabs' width
  (`PanelInput.width` is the panel's own, `renderer.width` the terminal's), so the tree panel notes
  what was asked only at a `renderer.width` of 108 or more; with vertical tabs showing it still
  takes a narrower split for one.
- **Keys.** `<leader>` bindings OpenCode takes: `a b c e g i l m n q r s t u w x y`, the digits and
  the arrows (`packages/tui/src/config/v1/keybind.ts`); the inbox takes `<leader>k`.
- **A span's colour is not cleared by `undefined`.** `@opentui/solid`'s `setProperty` sets a
  `<span>`'s `style` as `node.bg = value.bg ? parseColor(value.bg) : node.bg`, and `fg` alike, so a
  span whose `bg` goes from a colour to `undefined` keeps the old one, whatever the enclosing box
  paints, and `attributes` only ever gain bits (`|=`). Digby's frames reuse their spans through
  `<Index>`, so `drawn` gives every cell a `bg`: its token's, else a transparent `RGBA`, which shows
  the panel's or the list's background under it. A `<box>`'s `backgroundColor` does clear.
- **Testing.** Unit tests render against a fake TUI context with OpenTUI's `testRender`, which needs
  Solid's transform (`bunfig.toml` preloads `@opentui/solid/preload`). The live check runs the TUI in
  `tmux` and reads `tmux capture-pane -p`; CI's `ubuntu-24.04` image lacks `tmux`, so the job installs
  it. The TUI logs to `$XDG_DATA_HOME/opencode/log/opencode.log`.
