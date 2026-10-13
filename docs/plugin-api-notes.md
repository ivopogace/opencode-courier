# Notes on the V2 plugin API

What the OpenCode V2 plugin API does that the plugin had to work around, what changed each time the
pin moved, and what was found out about OpenCode's behaviour on the way. For contributors; the
[reference](reference.md) says what the plugin does.

## Working around the API

- A plugin tool is only reachable through code mode's `execute` tool unless it is registered with
  `options: { codemode: false }`. The courier tools are direct tools.
- A tool whose result `metadata` holds an `undefined` value never completes: the call stays
  `running` and no error is reported. Results here drop `undefined` keys.
- A plugin cannot add an HTTP route to OpenCode's own server. The nearest thing, `rpc.register`,
  is reached through the authenticated `/api/rpc` endpoint with a JSON envelope, so neither
  GitHub's headers nor the raw body its signature covers would get through. The webhook receiver
  is therefore its own small listener inside the OpenCode process, shared by the plugin's
  per-location instances. It waits for the previous listener to finish closing before it binds,
  as after a plugin reload, and if binding fails, the next instance to load tries again. A plugin's
  options come from a `{ "package", "options" }` entry in `plugins`, which takes a local directory
  as `package` too.
- OpenCode errors such as `Session.NotFoundError` can arrive with an empty message, so the tools
  rethrow them with the tag and session id.
- OpenCode decodes a tool's input with its own copy of `effect`, not the plugin's, and schema
  checks and transformations from the plugin's copy do not survive that: `Schema.Finite` refuses
  the number `2` ("Expected a finite number"), and `Schema.FiniteFromString` fails with "Cannot
  convert a symbol to a number". Tool inputs use plain schemas and the tools validate the values
  themselves; a unit test keeps it that way. That was seen while the plugin ran on its own copy;
  from 2.0.25 on it runs on OpenCode's ([From `2.0.26` to `2.0.28`](#from-2026-to-2028)), but
  hosts before that still load it.
- `Schema.Number` advertises the strings `"Infinity"`, `"-Infinity"` and `"NaN"` in its JSON
  Schema, so models are offered a string where a number is meant. Some send numbers as strings
  regardless, so `courier_later` takes `delayMinutes` as either.
- `permission.asked` and `permission.replied` reach a plugin's `event.subscribe()`, as
  `session.execution.failed` does. OpenCode keeps pending permission requests per location, and a
  plugin instance's `permission` domain answers from its own location's, so a request of an
  isolated child is answered through the instance loaded in the child's worktree. The plugin keeps
  the domain of every loaded instance and answers through the one that holds the request.
- `session.execution.started`, `.succeeded`, `.failed` and `.interrupted` frame a session's busy
  period, one terminal event however many prompts were steered into it; `.interrupted` carries a
  `reason`, and one of `shutdown` resumes the turn on the next start. A message steered into a
  running turn interrupts nothing: observed on 2.0.26, `inbox.enqueued` (`delivery: "steer"`) as it
  is sent, then `inbox.delivered` at the turn's next step and the one `.succeeded` after it, no
  `.interrupted` between. The schema lists a `superseded` reason, but no code in 2.0.26 (nor on `v2`
  as of 2026-10-09) publishes it: the core's reasons are `user`, `shutdown` and `inactivity`, the last
  when an idle location is evicted, which stops its sessions without resuming them. An interrupt
  with `resume` while a steer waits publishes `.interrupted` (`user`), then `.started` and the
  steer's `inbox.delivered`, later than the interrupt, so the session owes a report again.
  `session.inbox.delivered`
  (`data.inboxID` only) is published as each prompt, synthetic message, requested compaction or
  move reaches the session (the runner compacts on its own without the inbox), and the message it makes is stamped with that event's `created`, not with the time
  a queued item was admitted to the inbox. Only `session.inbox.enqueued`, published as the item is
  admitted, carries its type (`data.item.type`: `user`, `synthetic`, `compaction` or `move`; a
  `session.prompt` is `user`); `delivered` does not. Every event carries `created`, the epoch
  milliseconds OpenCode published it at, which the report state compares with the clock at
  `courier_send`. `session.context()` returns the session's stored messages
  (`SessionMessage.Info[]`), not the model-facing ones the `context` hook sees.
- A permission request rejected without a message ends the asking session's turn ("The user
  declined this tool call"); with a message, only the tool call fails, and its model is told that
  the call could not be run, not the message.
- A plugin can replace the `execute` of any tool, OpenCode's own included, with `tool.transform`
  and the editor's `update` (an id that is missing is ignored). OpenCode's question tool is such a
  tool, `question`, added by a plugin of OpenCode's own that loads before external ones. The
  promise API hands the original `execute` out only as a function returning a promise, run
  without an abort signal, so the call cannot be stopped once started. OpenCode's form service
  withdraws a question's form when the call that asked it is interrupted, and nothing else in the
  plugin API can withdraw or answer a form: the context has no form domain. The question relay
  needs to withdraw a child's question once its parent's answer is in, so the plugin's default
  export is an Effect plugin (`{ id, effect }`): it runs the promise plugin through `fromPromise`
  from `@opencode/plugin/promise/adapter`, which is what OpenCode does with a promise plugin,
  then wraps the question tool with the Effect API, where the original `execute` is an Effect
  that can be raced and interrupted. The plugin's `effect` is the same version as OpenCode's
  (`4.0.1` at the pinned version), and Effects of the two copies compose; since 2.0.25 a plugin
  runs on OpenCode's copy anyway ([From `2.0.26` to `2.0.28`](#from-2026-to-2028)). A plugin
  loaded after this one that replaces `question` as well would drop the relay.
- The promise adapter builds the promise plugin's context with the very `location` object the
  Effect half is handed. The question relay, in the Effect half, relies on that to find its
  instance's ports in the hub: were a later adapter to copy the object, the relay would find no
  ports and leave every question call unchanged, and the live suite's question scenarios would fail.
- OpenCode's question tool asks through a form. `form.created` reaches `event.subscribe()` (form
  events are ephemeral, never stored), of every location's plugin instance whichever location the
  form is in, with the form's `metadata.tool.id`, the id of the call; the form is created only
  after the call's permission check has passed. A person dismissing a form makes the tool die with
  `QuestionTool.CancelledError`, which ends the asking session's turn ("The user dismissed this
  question"). Forms live in memory: a restart drops them, and the call that asked stays `running`
  until the session's next turn marks it aborted. When OpenCode closes a location, as on a graceful
  server shutdown, it withdraws every open form there, which looks to the tool exactly like the
  person dismissing it, and then unloads the plugin; so the relay holds a dismissal for a moment to
  see whether a shutdown follows.
- OpenCode stops every turn in a project location after 60 minutes without a stored session event
  there, which withdraws any question still open. A tool call has no timeout of its own.

## From `0.0.0-beta-19271` to `2.0.22`

OpenCode V2 went GA under a new npm scope, and opencode-courier 0.2.0 moved its pin from the last
beta it was built against to `2.0.22`. The V2 code is on the `v2` branch of
https://github.com/anomalyco/opencode, and each release is tagged (`v2.0.22`).

Names:

- The CLI is `@opencode/cli` (was `@opencode-ai/cli`). Its binary is `opencode`; the package also
  installs `opencode2`, the beta's name, as a second name of the same file. The plugin API is
  `@opencode/plugin` (was `@opencode-ai/plugin`), with the same export map: `@opencode/plugin`,
  `@opencode/plugin/effect` and `@opencode/plugin/promise/adapter` are the three the courier imports.
  The sub-packages are renamed the same way (`@opencode/client`, `@opencode/schema`,
  `@opencode/protocol`, `@opencode/ai`, `@opencode/util`).
- `@opencode/plugin@2.0.22` depends on `effect@4.0.0-rc.112`, the same version as the beta, so the
  courier's own `effect` dependency stays there (the two copies must compose, see the question
  relay above).

What the new types forced in the code:

- `worktree.create` and `worktree.remove` take the project the worktree belongs to, `projectID`,
  instead of a location (`worktree.list` likewise). The plugin's context has it as
  `location.project.id`. The roster entry of an isolated child records its project, and
  `courier_cleanup` removes the worktree from there, or from the plugin's own project for an entry
  recorded before 0.2.0. `agent.get` still takes `location`.
- `permission.reply` takes the answer as `decision` instead of `reply`, and so does the HTTP route
  the live test calls directly, `POST /api/session/:id/permission/:request/reply`. The
  `permission.replied` event still carries it as `reply`, and `courier_answer`'s own parameter is
  still `reply`.
- Nothing else the courier calls changed shape: `session.get`, `session.create`,
  `session.prompt`, `session.synthetic`, `session.context`, `agent.get`, `tool.transform`,
  `event.subscribe`, `storage`, and the Effect plugin's `fromPromise`.

Changed in the API, not used by the courier: the `catalog` domain is gone, replaced by `model` and
`provider`; session hooks take their generation settings from `options`, and there are new
`compaction`, `generate` and `title` hooks; the session domain gains `remove`, `compact` and
`update`, and `rename` is gone; the tool context gains `signal: AbortSignal` (so a promise plugin
could now race the original `execute` against it; the relay still wraps `question` through the
Effect API) and the tool domain `list()`.

Observed at `2.0.22`, differently from the beta:

- A closing location withdraws its open forms before it unloads the plugin, not after: a child's
  question call dies with `QuestionTool.CancelledError` while the plugin is still loaded, as if the
  person had dismissed it. Some 40 ms later OpenCode publishes a `location.shutdown` event (new
  since the beta; `location.directory` names the location) and then unloads the plugin. The relay
  therefore holds a dismissal for 2 seconds to see whether `location.shutdown` or its instance's
  unload follows, and treats it as cut off then. A dismissal by the person reaches the other side
  that much later.
- The form dismissal route is `DELETE /api/session/:id/form/:form` (was `POST .../cancel`), and
  `GET /api/form` lists every open form (was `/api/form/request`).
- A session's message list records an `idle` message when a turn ends, with
  `outcome: "succeeded" | "failed" | "interrupted"`; the beta recorded nothing. The real-model
  checkers take the marker as the end of a turn.
- The server's `/api/health` route is gone; `/api/info` answers with the version, pid and urls, and
  the test harness waits for the server on it.

## From `2.0.22` to `2.0.23`

Nothing the courier calls changed shape, and the code needed no change. In the plugin API a VCS
provider may define `init`, and the TUI's select dialog gains `search` and `actions`; the courier
registers neither. In the HTTP API, a session whose location's directory no longer exists answers
404 with a `LocationNotFoundError` instead of failing as a defect, on routes the courier does not
call, so the webhook's test for a session OpenCode no longer knows (an error tag with `NotFound`)
still means only that. `WorktreeError` gained a `_tag`; `describeFailure` names an error by its
`_tag` when it has no message, so an empty-message worktree failure is now named by it.

## From `2.0.23` to `2.0.24`

Nothing the courier calls changed, and the code needed no change. `@opencode/plugin`,
`@opencode/schema` and `@opencode/protocol` are identical to 2.0.23 apart from their version and
dependency numbers; `effect` stays at `4.0.0-rc.112`.

## From `2.0.24` to `2.0.26`

2.0.25 and 2.0.26 were released on the same day. Read from the type packages,
`@opencode/plugin@2.0.24` against `@2.0.26`, from OpenCode's plugin loader at the two tags, and
checked by the live suite (the 0.2.2 build passed it on a 2.0.26 host, in CI's `latest` leg, before
the pin moved, and passed it again after):

- Nothing the courier calls changed, and the code needed no change. `effect` stays at
  `4.0.0-rc.112`, and the promise adapter still builds the promise plugin's context with the very
  `location` object the Effect half is handed.
- Integrations gained an "external" connect method (`IntegrationExternalMethod`, with
  `integration.connect.external` in both APIs and the adapter). The courier registers no
  integration.
- `@opencode/plugin` gained a `runtime` export (`dist/runtime.js`, `runtime-modules.js`): under
  Bun, it registers a loader that makes a plugin's imports of `@opencode/plugin` and `effect`
  resolve to OpenCode's own copies, and the Bun source scanner skips those packages once it has.
  This note first said nothing called it at 2.0.26; the CLI does, from 2.0.25 on, and a plugin runs
  on OpenCode's copies: see [From `2.0.26` to `2.0.28`](#from-2026-to-2028).
- OpenCode's plugin loader (`packages/core/src/plugin/module.ts`) now consults the managed policy
  before loading a plugin, and refuses one an organisation's policy denies (`integration.use` on
  `plugin:<name>`); the load reports `blocked`. An administrator's setting, not the plugin's.

## From `2.0.26` to `2.0.28`

2.0.27 came out on 2026-10-12 and 2.0.28 on 2026-10-13; the pin skips 2.0.27. Read from
`@opencode/plugin@2.0.26`, `@2.0.27` and `@2.0.28` as published, from OpenCode's source at the three
tags, and checked by the live suite on 2.0.28 and by a probe on all three hosts. The code needed no
change; one unit test did (the schema snapshots, below).

2.0.27:

- `@opencode/plugin` moves `effect` from `4.0.0-rc.112` to the stable `4.0.1`, and so does
  OpenCode itself (the root `package.json`'s catalog), so the courier's `effect` moves with it. The
  only code change in the package is in `dist/promise/adapter.js`, which imports
  `effect/http-api` instead of `effect/unstable/httpapi`; the courier imports neither.
- Effect 4.0.1 renders a `Schema.Struct` as an open object by default, `additionalProperties: true`
  ([Effect-TS/effect#8147](https://github.com/Effect-TS/effect/pull/8147)), and drops the
  per-schema `parseOptions` annotation ([#8131](https://github.com/Effect-TS/effect/pull/8131)):
  a closed object is asked for per call, with `{ onExcessProperty: "error" }`. OpenCode does so for
  every tool (`Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })` in
  `packages/core/src/tool/runtime.ts`, line 175, at both tags), so models are still sent
  `additionalProperties: false`, as at 2.0.26. `test/notices.test.ts` renders the tool schemas the
  same way, and its snapshots did not move.
- An undeclared key in a tool's input never reaches the courier, as before: OpenCode's own
  `tool-input-repair` plugin (`packages/core/src/plugin/tool-input-repair.ts`, the same at the
  three tags) deletes, on `execute.before`, each key a closed schema does not declare, and the
  decode ignores it too. OpenCode removes keys from a tool's input and never adds one. A renamed
  optional key would therefore have to stay declared under its old name for as long as it is
  accepted.

2.0.28:

- `@opencode/plugin` adds `credential.activate` to both plugin contexts (`Pick<CredentialApi,
  "activate">`, anomalyco/opencode#52797), which the courier does not use; `@opencode/schema`
  and `@opencode/protocol` change only around models and providers, which it does not read
  either.
- The promise adapter runs a promise tool's `execute` with `Effect.tryPromise` instead of
  `Effect.promise` (anomalyco/opencode#54913): a throw becomes a `Tool.Error` carrying the message
  and the thrown value, instead of a defect, and a permission decline or dismissed question a tool
  rethrows is recognised inside it. The courier's tools throw their refusals and failures through
  `describeFailure`. What the model gets did not change: `courier_status` for an unknown session
  gives it `{"type":"unknown","message":"courier_status failed: Session.NotFoundError ses_missing"}`
  as the tool's error, and the turn goes on, on 2.0.26, 2.0.27 and 2.0.28 alike.

The `runtime` loader, re-checked: OpenCode's CLI calls it, and has since 2.0.25. Its entrypoint,
`packages/cli/src/index.ts`, imports `ensurePluginRuntime` from `@opencode/plugin/runtime` (line 3)
and calls it before anything else (line 21), at `v2.0.26`, `v2.0.27` and `v2.0.28` alike; it came in
with "fix(cli): give plugins the host's Effect" (anomalyco/opencode#53422, first released in
2.0.25), which also makes the compiled binary list the host's `effect` and `@opencode/plugin`
modules at build time (`packages/cli/script/build.ts`). Under it, every import of `effect`, a public
`effect/*` path or `@opencode/plugin*` from a plugin or its dependencies resolves to OpenCode's own
copy (`build.module` in `packages/plugin/src/runtime.ts`), and loading a file of either package from
a plugin's `node_modules` fails with an error naming it. A live probe confirmed it on all three
hosts: a plugin whose own `node_modules/effect` sets a marker when it runs, and that has no
`@opencode/plugin` installed at all, loaded with the marker never set and
`@opencode/plugin/promise/adapter` imported. So on 2.0.25 and later the courier runs on OpenCode's
`effect` and plugin API, whatever is installed next to it: its `effect` dependency and the peer copy
serve the build, the unit tests and hosts before 2.0.25. The question relay's Effects and the host's
are one copy there, and the live suite, the question relay's scenarios included, passes on 2.0.28.

## The peer dependency is a statement, not a check

Whether anything enforces the `@opencode/plugin` peer dependency was tested on six hosts (2.0.0,
2.0.3, 2.0.4, 2.0.21, 2.0.22 and a `dev` build), each a fresh `@opencode/cli` install with a fresh
home directory, with the plugin served from the live suite's stand-in registry:

- `opencode plugin add` exited 0 and printed only `Plugin "opencode-courier" installed and added to
  …/opencode.json` on every host, below the pin or above it. It installs into
  `~/.cache/opencode/npm/opencode-courier@latest/<timestamp>/` with the peer dependency next to the
  plugin, fetched from the registry at the version the range names, whatever `opencode --version`
  says: npm installs peer dependencies by default, and the install root is an empty directory, so
  the host's own version takes no part. Neither `plugin add` nor the loader reads
  `peerDependencies` or `engines`; the only version comparison in the plugin manager asks the
  registry whether a newer plugin exists, for `plugin check` and `plugin update`.
- Loading resolves the installed package's entrypoint and imports it. The plugin's own imports of
  `@opencode/plugin` resolve from its directory, so a package plugin runs on the copy of the plugin
  API installed next to it, never on the host's copy. On 2.0.4 and above the plugin loaded with no
  warning; on 2.0.0 and 2.0.3 it failed to load with `TypeError: undefined is not an object
  (evaluating 'host.model.list')`, since the `model` domain appeared in 2.0.4 and the adapter of the
  installed plugin API copy reads it from the host's context. Nothing about the version is said
  either way.

So a mismatched host installs and loads the plugin without a word, and what breaks does so on use.
The plugin's own load-time log line ([the reference](reference.md#the-opencode-version)) is the
only runtime signal. The peer dependency picks the copy of the plugin API that `plugin add`
installs next to the plugin. On the six hosts above, all before 2.0.25, that is the copy the plugin
runs on; from 2.0.25 on it is installed but not run, as the CLI resolves a plugin's imports of
`@opencode/plugin` and `effect` to its own copies ([From `2.0.26` to `2.0.28`](#from-2026-to-2028)),
and the pin says which OpenCode the plugin was tested on, which the live suite on that version
checks. Either way the peer stays exact, the same version as the devDependency: on an older host a
range such as `^2.0.22` would install the newest version on npm that satisfies it, a copy nothing
has run the suite with, and on a newer one the pin names exactly one tested version. The README's
table keeps one version per row for the same reason.

## Update checks skip a plugin pinned to an exact version

`opencode plugin check`, `plugin update` and the TUI's *check for updates* parse the configured
entry with `npm-package-arg`, and skip an entry whose type is `version` without asking the registry:
`opencode-courier@0.2.1` is never reported outdated, while `opencode-courier`,
`opencode-courier@latest` and `opencode-courier@^0.2.0` are compared with what the registry
resolves the spec to. A failed check is logged as `failed to check plugin update` and reads as "no
update" too. Hence the README's advice to install by name, and to replace an exact-version entry
with the name to get update checks back.

## How web search asks for its provider

The `websearch` tool first asks the ordinary `websearch` permission, which the permission relay
passes on. When no provider is selected, it asks with the form service directly: a form titled "Web
Search" with `metadata: { kind: "websearch.provider" }` and one string field `choice` (`allow`,
labelled "Allow search via" and the providers' names; `choose`; `disable`), and on `choose` a second
form, "Choose a web search provider", with the same kind and a field `provider` listing each
provider. The whole selection is under a one-minute timeout; at the timeout the form is withdrawn
and the call fails with "Web search cancelled", as it does when the person dismisses either form;
the tool wraps that in "Unable to search the web for <query>", which ends the call, not the turn.

The choice is global: it is stored in OpenCode's KV under `websearch:provider`, and `disable` drops
the tool from every session's tool list. Once made, in any session, no session is asked again. Two
children searching at once are asked one after the other. Built in at 2.0.24 are Exa, Firecrawl,
Parallel, Tavily and TinyFish; a plugin adds a provider with
`ctx.websearch.transform((editor) => editor.add({ id, name, execute }))`, as the live test does
with `e2e/search-plugin` (a configured local plugin must be a directory with a `package.json` naming
its entry).

What a plugin sees of forms: `form.created` (`data.form`: `id`, `sessionID`, `title`, `metadata`,
`fields`, each field with `key`, `type`, an optional `title` and `description`, and `options` of
`value` and `label` for a choice), `form.replied` (`id`, `sessionID`, `answer`) and
`form.cancelled` (`id`, `sessionID`) reach every instance's `event.subscribe()`, as ephemeral
events. Besides web search, at 2.0.24 forms come from the question tool (`kind: "question"`) and
from MCP elicitation (`kind: "mcp-elicitation"`), whose forms belong to the session id `global`.
The plugin API has no form domain: a plugin cannot list, answer or withdraw a form, so the plugin
can only tell the top session about one.

## When a session's turn ended

A session's `time.idle` is when its last turn ended, as epoch milliseconds: OpenCode's session
projector stamps it from `session.execution.succeeded`, `failed` and `interrupted`, but not from an
interruption by a shutdown, which the next start resumes (`projectIdle` in
`packages/core/src/session/projector.ts`, at `v2.0.26`). It is persisted, never cleared when a
new turn starts, and always moves forward (`max(created, previous + 1)`). A join group's release
compares it with when its last member joined, so a group waits for the turn that started it to
end. On the live server the group's message followed the parent's turn end by a few milliseconds,
so the projection is in place by the time the plugin's watcher sees the event and nudges the
scheduler.

## Which plugin instances receive an isolated child's events

OpenCode sets the plugin up once per location, and an isolated child runs in a location of its
own, its worktree. The live test's probe plugin (`e2e/probe-plugin`, loaded next to the courier in
every location, logging every event its `event.subscribe()` receives) shows, at 2.0.24, with three
locations loaded (the parent's project, the child's worktree, and an unrelated worktree):

| Event, from the child's worktree | Parent's instance | Child's instance | Third location's instance |
|---|---|---|---|
| `permission.asked` | yes | yes | yes |
| `permission.replied` | yes | yes | yes |
| `form.created` (both forms) | yes | yes | yes |
| `form.replied` | yes | yes | yes |
| `form.cancelled` | yes | yes | yes |
| `session.execution.failed` | yes | yes | yes |

Every event type the watcher handles reaches every location's instance, once per instance, with
the same event id; an event's location does not limit who receives it. An instance only receives
events published while it is subscribed, which is why the hub keeps a standby subscription for the
hand-over when an instance unloads, and relays pending permission requests when it (re)subscribes.
On a graceful shutdown OpenCode closes the locations one after another, and each
`location.shutdown` reaches every instance still loaded. `GET /api/plugin?directory=<worktree>`
does not boot that worktree's location; a session run from the directory does.

## Two servers on one data directory

OpenCode keeps everything in one SQLite database under its data directory
(`$XDG_DATA_HOME/opencode/opencode.db`, `~/.local/share/opencode` by default), and any number of
servers can open it: `opencode serve` twice, or `opencode serve` next to the background server
`opencode service start` runs. Plugin storage is a slice of that database's `kv` table (keys
`plugin:<the plugin id, hex-encoded>:<key>`), so the plugin instances of two servers share the
roster, the pending `courier_later` messages and the stored questions. What they do not share is
anything in process memory: the hub's claim sets, OpenCode's event bus and its pending permission
requests.

`e2e/two-servers.sh` measures what that does, at the pinned version:

```bash
npm install --prefix <scratch>/oc @opencode/cli@2.0.28
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/two-servers.sh   # a few minutes, no API key; KEEP=1 keeps the logs
```

It starts two servers on one data directory with the live suite's stand-in model, schedules ten
`courier_later` messages that fall due together, twice (with the two schedulers ticking in step,
and half a tick apart), starts a child that asks for a permission and has the parent answer it in a
turn on each server, and starts a child whose turn fails. Each server's event stream shows which
server queued each courier message.

What was found:

- **Without an owner key, a `courier_later` message could be delivered twice.** Both schedulers
  scanned the same storage every 15 seconds and claimed a message only in their own memory; each
  removed it only after delivering, so the other delivered it too when its tick fell in between.
  With the ticks some milliseconds apart, from none to all ten messages due together were
  delivered twice, varying from run to run; half a tick apart, none was. Since the owner key
  (`scheduler/owner`, described in [the reference](reference.md#two-servers-on-one-data-directory)),
  no message is delivered twice in either round, and none is lost; which server takes the key first
  varies. The script fails when a message is delivered twice, and the live suite's restart scenario
  checks that the key is held, released by a graceful stop, and that another server's key, planted
  while the server is stopped, holds the restarted server's delivery off until it expires.
- **A permission request or a failed turn is told once.** A server's event bus carries only what
  that process does: a child's turn runs in the server that queued the message starting it, so
  only that server's watcher sees its `permission.asked` or `session.execution.failed`.
- **`courier_answer` reaches a request only from the server where the child waits.** Pending
  permission requests live in the memory of the process that runs the child's turn. From the other
  server the call finds no such request; it used to tell the model the child "no longer waits",
  while the child still waited, and now says that nothing was passed on and that the request may
  wait in another OpenCode server, to be answered there. The plugin API offers no channel between
  servers. By the same token, `courier_status` lists only the requests held by the server it runs
  on, and the question relay sees only questions asked on its own server.

The owner key's numbers: a tick skips while another server's key is less than 60 seconds old (four
ticks, so a tick or two skipped by a busy event loop does not hand the key over, and after a crash
the others take over within 75 seconds); the owner renews its key, without reading it back, only
while it is less than 30 seconds old, half the expiry, which leaves another server 30 seconds of
stall to cover before it could take over; a server taking a free key waits a random 0.5 to 1
second before reading it back, which bounds the race the missing compare-and-set leaves to a
process stalling that long between two storage calls, and is random so that two servers re-taking
the key in the same rhythm do not keep finishing in step.

Not covered by the script: the webhook receiver (its port can be bound by one process only) and
the question relay.

## Creating a worktree from a given commit (v2.0.26)

Read in OpenCode's source at tag `v2.0.26` (`packages/core/src/worktree.ts`, `worktree/git.ts`,
`git.ts`):

- The client's `worktree.create` takes `projectID`, and optionally `from`, `branch`, `directory`
  and `name`. **`from` is a source directory, not a ref**: the worktree is created from the
  repository of that directory, which must be a directory the project already knows (its main
  worktree or one it created), else the call fails with `SourceDirectoryNotFoundError`. It
  defaults to the project's own worktree.
- **`branch` is a starting ref, not the name of a new branch**, as the plugin-side strategy input
  documents it. The built-in git strategy runs `git worktree add --detach -- <dir> <branch ?? HEAD>`,
  so a commit hash works as well as a branch name, and the new worktree is always on a detached
  HEAD. With neither, it starts from `HEAD` of the source directory, which for the project is its
  last commit; uncommitted changes are never carried over.
- Worktrees of one project share one repository, so a commit made in any of them is visible to
  `git worktree add` from another, and so are the branches they create.

`courier_spawn` uses it for a nested isolated child: `from` is the isolated parent's worktree and
`branch` the commit its HEAD is on, which is also what the child's roster entry records as `base`.

## Skills (v2.0.26)

Read in the plugin API's types (`@opencode/plugin/dist/promise/skill.d.ts`, `@opencode/schema/skill`) and
in OpenCode's source at tag `v2.0.26` (`packages/core/src/skill.ts`, `skill/instructions.ts`,
`plugin/skill.ts`, `tool/plugin/skill.ts`, `session/session.ts`, `session/prompt.ts`,
`session/runner/to-llm-message.ts`, `packages/tui/src/component/prompt/index.tsx`), and checked by the
live suite's skill scenario:

- **Registering.** `ctx.skill.transform((editor) => editor.add(info))`, with `info` a `Skill.Info`:
  `id`, `name`, `description` (optional), `autoinvoke` (optional), `path` and `content`. The host
  decodes it with the schema, so a wrong shape throws from `add`. `path` is typed as an absolute
  path but checked as a string; it is where OpenCode would look for the skill's files, and its
  directory is named to the model (below), so a plugin without files gives a path of its own, as
  OpenCode's built-in skills do with `/builtin/opencode.md`. The editor also has `list`, `get`,
  `update` and `remove`. Registrations are scoped: an instance's are dropped when it unloads, and the
  list is rebuilt from the registrations left. Instances of several locations each add the same
  skill under one id, which is one entry.
- **Listing.** Every skill with a `description`, with `autoinvoke` not `false`, and not denied by a
  `skill` permission rule for its id, is listed in every session's system prompt, under the
  instruction key `core/skill-guidance`: "Skills provide specialized instructions and workflows for
  specific tasks. Use the skill tool to load a skill when a task matches its description. …" and an
  `<available_skills>` block with one `<skill>` of `<id>`, `<name>` and `<description>` per skill,
  sorted by id. A change to the list reaches a running session as a delta. `GET /api/skill?directory=…`
  lists them for a location.
- **The model loads one** with OpenCode's `skill` tool (`skill({ id })`), a direct tool whose
  permission check asks the `skill` action for the id (with `save: [id]`, so OpenCode's prompt offers
  "always"); a spawned session's request is relayed like any other. Its result is
  `<skill_content name="…">`: `# Skill: <name>`, the content, `Base directory for this skill:
  <dirname(path)>`, a note that relative paths are relative to it, and a `<skill_files>` list, which is
  read from disk only when the path's basename is `SKILL.md`, and is empty otherwise.
- **The person activates one** in the TUI's `/skills` dialog, which inserts `@<id>` into the prompt and
  attaches `skills: [{ id }]` to it (`POST /api/session/:id/prompt`); the skill's text, in the same
  `<skill_content>` shape, goes to the model as the first part of that user message, before the
  prompt's text. The experimental `POST /api/experimental/session/:id/skill { id, resume? }` instead
  publishes `session.skill.activated` (a durable session event: `id`, `name`, `text`), projected as a
  `skill` message in the transcript, sent to the model as a user message carrying the raw `content`,
  and resumes the session unless `resume` is `false`. A compaction keeps `[Skill activated: <name>]`
  and the text.

## TUI and RPC entrypoints (spike for #130)

Phase 0 of [#130](https://github.com/ivopogace/opencode-courier/issues/130): can this package ship a
TUI part and an RPC, how, and should non-isolated children get OpenCode's own `parentID`. Read in
`@opencode/plugin@2.0.28`'s types and in OpenCode's source at tag `v2.0.28` (file and line numbers
below are at that tag), and checked on a real OpenCode 2.0.28, server and TUI, with the spike on the
branch [`spike-130-tui`](https://github.com/ivopogace/opencode-courier/tree/spike-130-tui): a minimal
`tui` entrypoint (one `prompt.footer.status` entry), a minimal `rpc` definition with one server
handler, the build for them, a unit test of the TUI part, and `e2e/spike-tui.sh`, the live script
whose output is quoted here. The entrypoints, the build, the RPC and the footer entry it proved ship
since [#143](https://github.com/ivopogace/opencode-courier/issues/143) (`docs/reference.md`, *In the
terminal*); the spike's own code, and its native-`parentID` checks, stay on the branch.

#130 was written against `v2.0.26`. Of the files it cites and this note reads, these changed between
`v2.0.26` and `v2.0.28`, none in what is cited: `packages/core/src/plugin/host.ts` (`credential.activate`
added, lines 255-257), `packages/core/src/session/model-request.ts` (the `effect/http` import and the
recovery of declines, [From `2.0.26` to `2.0.28`](#from-2026-to-2028); the parent header lines are the
same), `packages/protocol/src/groups/rpc.ts` (the `effect/http-api` import), the app's request dock
(`packages/app/src/session/requests/model.ts` and `auto-approve.ts`: auto-approval is now per project),
`packages/client/src/solid/data.ts` (an `error` on a failed turn's idle message; archived projects
hidden), `packages/tui/src/routes/session/index.tsx` (that error rendered) and
`packages/cli/src/commands/handlers/default.ts` (release highlights). Unchanged: `packages/plugin/src/tui/*`,
`host.ts`, `rpc.ts`, `runtime.ts`, `runtime-modules.ts`, `packages/core/src/plugin/module.ts`,
`packages/core/src/session.ts`, `session/affinity.ts`, `plugin/warming.ts`, `session/runner/llm.ts`,
`packages/core/src/rpc.ts`, `packages/schema/src/rpc.ts`, `packages/tui/src/plugin/*`,
`packages/app/src/session/requests/session-request-tree.ts` and
`packages/cli/src/commands/handlers/plugin/add.ts`. The TUI's versions are the same at both tags: the
root `package.json`'s catalog pins `@opentui/core` and `@opentui/solid` `0.5.17` and `solid-js`
`1.9.15` (lines 57-59 and 112 at `v2.0.28`), and `@opencode/plugin`'s peers are `>=0.5.17` and
`>=1.9.0`, optional, at both.

### 1. Entrypoints

**How they are found.** `Host.resolve` (`packages/plugin/src/host.ts`, lines 17-44) looks up three
module specifiers per plugin and returns a file URL for each it resolves, `undefined` for the rest:
`server` is `<name>/server` when the package exports it, else the package itself, `tui` is
`<name>/tui` and `rpc` is `<name>/rpc`, each through `resolveModule(specifier, directory)`, which is `Bun.resolveSync`
(`packages/util/src/runtime/import.bun.ts`, lines 7-10). For a package that is Node's export
resolution, so `package.json` needs `exports["./tui"]` and `exports["./rpc"]`. For a configured local
directory the specifiers are `path.resolve(directory, "tui")` and `"rpc"`, and Bun's extension
inference finds `tui.js` (or `.ts`, `.tsx`) in it: the files must sit at the top of the directory, next
to `index.js`, not under a subfolder. The spike's `package.json`:

```json
"exports": {
  ".":     { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./tui": { "types": "./dist/tui.d.ts", "import": "./dist/tui.js" },
  "./rpc": { "types": "./dist/rpc.d.ts", "import": "./dist/rpc.js" }
}
```

with `src/tui.tsx` built to `dist/tui.js` (its types in point 5) and `src/rpc.ts` to `dist/rpc.js`;
`files` stays `["dist"]`.

**What the server does with them.** `PluginModule.load` (`packages/core/src/plugin/module.ts`) resolves
the three at load (lines 112-115; a local plugin configured by a file path rather than a directory gets
`server` only, so the `dist/` directory is what a local configuration names) and records `features: { tui: true, rpc: true }` from their presence
(137-140); it imports and runs only `server`. The features show in `GET /api/plugin` (`Plugin.Info`,
`packages/schema/src/plugin.ts`, lines 23-27 and 37-42), the inventory of a booted location
(`packages/core/src/plugin.ts`, lines 42-44; before a session has run in the project the list is
empty). Observed, with the plugin configured as the local directory `dist/`, the way `e2e/run.sh`
loads it, and again from the installed package:

```
{"id":"courier","state":"active","features":{"server":true,"tui":true,"rpc":true},"source":{"type":"local","path":"/…/dist/index.js"}}
{"id":"courier","state":"active","features":{"server":true,"tui":true,"rpc":true},"source":{"type":"package","target":"opencode-courier","version":"0.3.0"}}
```

**`opencode plugin add`** (`packages/cli/src/commands/handlers/plugin/add.ts`, lines 17-45) installs the
package with npm as before and then calls `Host.resolve` (line 21): a package with a `server`
entrypoint is added to the global config's `plugins`, as today, whatever else it has; one with only
`tui` is added to the TUI's config (38-44; `configurationTarget`, 47-50). Observed through the live suite's stand-in registry:
`Plugin "opencode-courier" installed and added to …/opencode.json`, the server loading
`…/.cache/opencode/npm/opencode-courier@latest/<timestamp>/node_modules/opencode-courier/dist/index.js`
and reporting the three features, the RPC answering, and the TUI showing the entry.

**How the TUI loads `tui`.** The TUI's plugin provider (`packages/tui/src/plugin/context.tsx`) takes the
server's inventory and keeps the active plugins with `features.tui === true` whose source is a package
or a local path (lines 96-103); each becomes a target with `install: false` (301-305), next to the
TUI's own discovered and configured plugins. `resolvePlugin` (652-697) prepares a package target
with `npm.resolve(spec)` (the CLI's `packages.prepare`, `packages/cli/src/commands/handlers/default.ts`,
line 141), the directory the server installed, takes `Host.resolve(target).tui` (670) and imports it
with `Host.load`, a plain `import()` (678); a local directory goes through the source reader
(`packages/plugin/src/source.bun.ts`), which scans the file's imports to watch and hot-reload it. The
module must default-export `{ id, setup }` (741-751), as `Plugin.define` from `@opencode/plugin/tui`
returns (`packages/plugin/src/tui/plugin.ts`); `setup(context)` may return a cleanup. The TUI logs
`plugin reconciliation completed … plugins=13` to `$XDG_DATA_HOME/opencode/log/opencode.log`: the
twelve built-in parts and the courier's.

**The host's runtime covers the TUI's imports; the package ships none of them.** The TUI's loader
imports `#runtime-plugin-support` (`packages/tui/src/plugin/runtime-plugin-support.bun.ts`, lines 1-11),
which calls `ensurePluginRuntime()`, the loader described in [From `2.0.26` to `2.0.28`](#from-2026-to-2028)
for `effect` and `@opencode/plugin/*`, and OpenTUI's `ensureRuntimePluginSupport({ additional: {
"@opencode/plugin/tui": … }, preserve: provides })`. OpenTUI's runtime plugin
(`@opentui/solid/scripts/runtime-plugin-support-configure.js`, `@opentui/core/runtime-plugin.js`)
rewrites a plugin's imports of `@opentui/core`, `@opentui/core/testing`, `@opentui/solid`,
`@opentui/solid/components`, `@opentui/solid/jsx-runtime`, `@opentui/solid/jsx-dev-runtime`,
`solid-js`, `solid-js/store` and `@opencode/plugin/tui` to the host's own modules, in sources outside
`node_modules` and in ESM files under `node_modules` that need it, without resolving them on disk.
Anything else (`solid-js/web`, `@opencode/theme`, which the context types only) is not provided and
must not be imported at runtime. Proof: the spike's `dist/tui.js` imports `@opencode/plugin/tui`,
`@opencode/plugin/rpc`, `@opentui/solid`, `solid-js` and `effect`, nothing is installed next to it
(the local `dist/` has no `node_modules`; the npm install put no `@opentui` next to the package), and
it loaded and rendered from both.

**Solid's JSX must be compiled before publishing.** The host transforms JSX itself only for `.tsx` and
`.jsx` files outside `node_modules` (`@opentui/solid/scripts/solid-plugin.js`, the `sourceFilter`),
that is for a local plugin under development; an installed package is under `node_modules`. The
spike builds `src/tui.tsx` with `Bun.build` and `createSolidTransformPlugin()` from
`@opentui/solid/bun-plugin`, `packages: "external"` (`script/build-tui.ts`), the way OpenCode's own CLI
is built (`packages/cli/script/build.ts`, lines 8, 33 and 161); the output is 2.2 KB. `tsc` keeps
building the server half, with `src/tui.tsx` excluded from `tsconfig.build.json` and `jsx: "preserve"`,
`jsxImportSource: "@opentui/solid"` in `tsconfig.json` for the typecheck.

**Peers: none to add.** Declaring `@opentui/core: 0.5.17` as an optional peer broke `opencode plugin add`
with npm's `ERESOLVE unable to resolve dependency tree`: npm had already picked `@opentui/solid@0.6.3`
(published 2026-10-13) for `@opencode/plugin`'s `>=0.5.17`, and the exact pin conflicted. Without such
peers, and with `>=` ranges marked optional alike, npm installs no `@opentui` at all, and the host
provides the modules anyway. The pinned versions go in `devDependencies` only, for the typecheck and
the unit tests (point 5).

**Observed in the TUI** (`tmux`, 140 columns), the prompt's footer with the spike's entry between
OpenCode's own:

```
/…/project:master     courier spike: 1 children  2 (0%)  ctrl+p commands    /…/project:master
```

### 2. One RPC round trip

**The contract.** `Rpc.define` (`@opencode/plugin/rpc`, which is `@opencode/schema/rpc`,
`packages/schema/src/rpc.ts`, lines 43-60) takes `{ id, methods: { <name>: { input, output, errors? } },
events }`; error names starting with `rpc.` are reserved. The promise API's
`ctx.rpc.register(definition, handlers)` (`packages/plugin/src/promise/rpc.ts`, lines 25-31) and the
client's `client.rpc(definition)` (`@opencode/client/dist/promise/rpc.d.ts`, `RpcApi`) are typed over a
`PortableDefinition`: Standard Schema or JSON Schema values. The Effect API's `register`
(`effect/rpc.ts`) takes Effect schemas, which is what `@opencode/plugin-browser` does
(`packages/plugin-browser/src/rpc.ts`, lines 548-569, registered in its `connection.ts`, line 77). The spike's
`src/tree/rpc.ts` uses the host's `effect` and `Schema.toStandardSchemaV1(Schema.Struct(…))`, so one
definition serves the promise half and the TUI:

```ts
export const treeRpc = Rpc.define({
  id: "courier",
  methods: {
    children: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.Struct({ children: Schema.Array(Child) })),
    },
  },
  events: {},
})
```

**The server side.** `Rpc.Service` is one per location (`packages/core/src/rpc.ts`, lines 35-40). `register`
(69-106) keeps the registrations per id, the last one answering (`registrations.get(rpcID)?.at(-1)`,
line 111), and disposes them with the plugin's scope (82-85), so a reload replaces the handler. `call`
(108-142) parses the input with the schema's own kind (Effect schema decoded, Standard Schema
validated, JSON Schema compiled to a codec; 203-224) and fails `rpc.invalid_input`, runs the handler,
encodes a declared error, turns a defect into `rpc.internal` after logging it, races the location's
closing (`rpc.unavailable`) and encodes the output (`rpc.invalid_output`). `events.emit` (91-104)
publishes an ephemeral `rpc.<id>.<name>` event at the location, which a client's `events.on` receives.
The HTTP route is `POST /api/rpc/:rpcID/:method?directory=…` with `{ "input": … }`, answering
`{ "output": … }` (`packages/protocol/src/groups/rpc.ts`, lines 14-20; `packages/server/src/handlers/rpc.ts`,
which waits for plugin activation first). Observed, with the spike's handler reading the roster:

```
POST /api/rpc/courier/children {"input":{"sessionID":"ses_…parent"}}
{"output":{"children":[{"sessionID":"ses_…child","title":"Report back to your parent.","isolated":false}]}}
POST /api/rpc/courier/children {"input":{"wrong":1}}
{"_tag":"RpcError","type":"rpc.invalid_input","message":"Missing key\n  at [\"sessionID\"]"}
POST /api/rpc/courier/nothing  →  {"type":"rpc.method_not_found", …}
```

**The TUI side.** The TUI context's `client` is the TUI's own `OpenCodeClient`
(`packages/tui/src/plugin/api.tsx`, line 159), so `ctx.client.rpc(treeRpc).children({ sessionID },
{ location })` is the whole call. `ctx.location` is `LocationRef | undefined` (`context.ts`, line 546):
without a location the request goes to the server's default location, where the courier's handler may
not be registered, so the spike falls back to `ctx.data.location.default()`. It puts the call in a Solid
`createResource` keyed by the footer slot's `sessionID`, which is optional too (`PromptFooterInput`,
`context.ts`, line 160): the prompt's footer, slot included, is on the home screen as well
(`packages/tui/src/component/prompt/index.tsx`, line 1877), so the entry renders nothing there. The TUI's plugin context (`packages/plugin/src/tui/context.ts`, lines
544-560) also has `data`, `ui`, `keymap`, `storage`, `attention` and `theme`, as #130 lists.

**The handler's ports and the layout.** The handler takes `CourierPorts` and calls `listChildren`
(`tree/status.ts`), what `courier_children` returns, so it reads the roster through the same use case
as the tool. In the spike:

- `src/tree/rpc.ts`: the contract, importing `@opencode/plugin/rpc` and `effect`'s `Schema` only, as a
  `tools.ts` does.
- `src/tree/rpc-handlers.ts`: the inbound adapter, `registerTreeRpc(ctx.rpc, ports)`, exported through
  `tree/index.ts` and called from `src/index.ts` after the tools are added; one such file per module
  that gets an RPC (`person/rpc-handlers.ts` for the answer path).
- `src/rpc.ts` and `src/tui.tsx`: the two entrypoints, next to `index.ts` and `skill.ts`, taking a
  module's contract from `<module>/rpc.ts` directly, so the TUI bundle carries the contract and nothing
  else of the module. Three tests in `test/imports.test.ts` change for them: `effect` may be imported by a
  `*/rpc.ts`, `rpc` joins `index` and `skill` as a top-level file, and the two entrypoints may reach
  `<module>/rpc` directly; and its scanner reads `.tsx` files too, which it did not, so `src/tui.tsx`
  is under the rules at all.
- The unit tests' fake plugin context gains an `rpc.register` stub.

Each location's plugin instance registers the same id in its own location's `Rpc.Service`, and a TUI
asks at `ctx.location`; the handler reads the roster, which is one store for every location.

### 3. Native `parentID` for non-isolated children

Checked in the source, and on the live server by creating a child with `parentID` over HTTP next to a
courier child made with a location (`e2e/spike-tui.sh`, step 5).

- **`Session.create` takes `location` or `parentID`** (`packages/core/src/session.ts`, lines 91-92): a
  parent given, the child's location is the parent's (266-270); an unknown parent is a `NotFoundError`.
  The plugin API's `session.create` (`packages/core/src/plugin/host.ts`, lines 539-553) and the HTTP
  route (`packages/server/src/handlers/session.ts`, lines 137-139) build the one or the other: with
  `parentID` the `location` is dropped. Observed: the child's `location.directory` is the parent's, with
  both fields sent too. An isolated child needs its worktree as location, so it cannot have a
  `parentID`, nor can a nested isolated grandchild. For OpenCode an isolated child is therefore a root,
  and a courier tree with isolation is several native trees, split at each isolated child.
- **What a native child inherits** (lines 287-288): `metadata` and `permissions` when the input gives none.
  The courier always passes its `metadata`; it passes no `permissions`, so a native child would run on
  its parent's session-level ruleset (merged after the agent's, `packages/core/src/permission.ts`, line
  162), where a courier child today has none. `opencode run --auto` sets no such ruleset (it answers
  requests with `once`, `packages/cli/src/run/noninteractive.ts`, lines 166-179); the TUI's dev tools do.
- **Affinity** (`packages/core/src/session/affinity.ts`, lines 7-8): `parentID ?? fork?.sessionID ?? id`
  goes out as `x-session-affinity`, `X-Session-Id`, `x-opencode-session` and the `promptCacheKey`
  (`session/model-request.ts`, lines 278-295): a native child's model requests carry its parent's id
  for the provider's cache routing, where a courier child today carries its own. OpenCode's GitHub
  Copilot provider goes further (`packages/core/src/plugin/provider/github-copilot.ts`, lines 286-289 and
  512-517): a session with a `parentID` sends `X-Interaction-Type: conversation-subagent` and
  `x-initiator: agent` instead of `conversation-agent`, which Copilot meters differently from a
  person's own requests. Headers and a cache key, but provider-visible; this is what needs the
  real-model rerun #130 asks for, on Copilot in particular.
- **The two parent headers** (`model-request.ts`, lines 284 and 287): `x-opencode-parent-session-id`
  and `x-parent-session-id`, sent only with a `parentID`; informational.
- **Warming** (`packages/core/src/plugin/warming.ts`, lines 58-61): the context hook returns before
  anything for a session with a `parentID`, so a native child is never kept warm. Courier children run
  a task and end; nothing lost.
- **Titling** (`packages/core/src/session/runner/llm.ts`, line 174): no generated title for a session
  with a `parentID`. `courier_spawn` sets the title (`tree/spawn.ts`, lines 94-97); observed kept.
- **`list({ parentID })`** (`packages/core/src/session/store.ts`, lines 110-112; `GET /api/session?parentID=…`):
  lists native children; observed, the native child and not the courier child. The TUI's home and
  session dialogs list `parentID: null` only (`packages/tui/src/app.tsx`, line 664;
  `component/dialog-open.tsx`, line 65; `component/dialog-session-list.tsx`, lines 98, 145, 185): a native
  courier child leaves the session lists and is reached from its parent's subagent tab
  (`routes/session/composer/subagents-tab.tsx`, through `sessionFamily`, `util/session.ts`, lines 9-43),
  by the "Go to parent session" command the other way (`routes/session/index.tsx`, lines 1290-1296), or
  by id.
- **Removal** (`session.ts`, lines 367-376): `Session.remove` interrupts the session, waits for it to
  settle, then removes each native child the same way, recursively, and publishes `session.deleted` per
  session, which the courier's `forgetDeleted` handles. Observed: deleting the parent deleted the native
  child (404 after) and left the courier child made with a location (200). Today a parent's deletion
  leaves its children; with native `parentID` it takes them, a change for the reference and for
  `courier_cleanup`.
- **Interrupts** (`session.ts`, line 219; `session/execution.ts`, lines 153-169): per session; no code
  interrupts a session's children with it. Unchanged.
- **Restarts**: nothing in the core reads `parentID` at start-up; a turn a shutdown interrupted resumes
  the same for any session ([When a session's turn ended](#when-a-sessions-turn-ended)). The subagent
  job recovery (`session/subagent-job.ts`) is for sessions OpenCode's own `task` tool runs as jobs, not
  for sessions created through the API. Location eviction after inactivity is per location, which a
  non-isolated child shares with its parent today already.
- **The TUI's `data.session.family`** (`packages/client/src/solid/data.ts`): the family index is built from
  each session's `parentID` as its info arrives (502-545, on `session.created` and sync, 637-700);
  `root()` and `family()` (1364-1369); `cost()` of a root sums its family (1377-1385). A root session's
  view lists the permission requests and forms of the root and every descendant
  (`packages/tui/src/routes/session/index.tsx`, lines 198-211), and a child's own view lists none of its
  own (`if (session()?.parentID) return []`): a native child's ask is answered from the root. Observed:
  with the native child waiting on `echo courier-asks`, the parent's view showed

  ```
  ┃  △ Permission required
  ┃
  ┃  - echo courier-asks
  ┃
  ┃   Allow once   Always allow   Reject           ctrl+f fullscreen  ⇆ select  enter confirm
  ```

  The TUI also hides the sidebar in a child's view (`component/session-frame.tsx`, lines 107-108), counts
  running descendants in the footer ("1 subagent", `feature-plugins/prompt/footer.tsx`, lines 20-26),
  sends no desktop notification for a child and plays `subagent_done` for it
  (`feature-plugins/system/notifications.ts`, lines 11-17 and 41), and `opencode run` streams a native
  child's steps under its parent (`packages/tui/src/mini/stream-v2.subagent.ts`, lines 5-7, 593 and
  1052).
- **The app's request dock** (`packages/app/src/session/requests/session-request-tree.ts`, lines 20-50;
  `model.ts`, lines 30-37, 39-41 and 71-79): `sessionTreeIDs` walks the `parentID` edges down from the
  open session, syncs every descendant's forms and shows the first pending permission, question or form
  in the tree; `primary()` (89-93) is a session without `parentID`. So a grandchild's ask would show and
  be answered from the root session on a paired phone, by the same code path as OpenCode's own
  subagents. Read in the source only: the app was not run (no paired device here), so this is
  unverified live.
- **Courier's own lineage**: `lineage` and `lineageIn` read the roster, written from
  `metadata.courier.parentID`, for every child alike. A native `parentID` cannot replace that: isolated
  children cannot carry one, and the roster holds what OpenCode does not (depth, group, report state,
  retention). The metadata stays; `parentID` is set in addition, for OpenCode's UIs.

**Recommendation for Phase 2: yes**, set `parentID` on non-isolated children, keeping the courier's
metadata and roster as they are. What it buys is the request dock on a paired phone and the TUI's
family (asks, subagent tab, footer count, cost) for every non-isolated subtree, with no UI of the
courier's own. The risks, each to be covered in the reference and the live suite:

1. Deleting a parent deletes its native children (the courier's `forgetDeleted` already cleans the
   roster; the reference and `courier_cleanup` must say so).
2. The affinity, the two parent headers and Copilot's `conversation-subagent` interaction type
   change what providers see and may meter: a real-model rerun, on Copilot too.
3. A native child inherits its parent's session-level permission ruleset when one is set.
4. Native children leave the session lists; a child's own view answers none of its asks, the root's does.
5. A tree with isolation shows as several trees in OpenCode's UIs, split at each isolated child; the
   courier's `courier_tree` keeps showing the whole.
6. `data.session.cost` of a root includes its native children.

### 4. Testing a TUI part

**Unit tests against a fake TUI context**, the way OpenCode tests its own parts
(`packages/tui/test/feature-plugins/prompt-footer.test.tsx`, lines 1-60, a plain object cast
`as unknown as Context` with only the fields the part reads; `packages/tui/test/plugin-toast.test.tsx`,
lines 19-41, for a fake host). Headless rendering comes from OpenTUI: `testRender(() => <Part/>,
{ width, height })` from `@opentui/solid` wraps `createTestRenderer` from `@opentui/core/testing`
(`renderOnce`, `waitForFrame`, `captureCharFrame`, `mockInput`, `mockMouse`, `resize`), no terminal
needed. The test file needs Solid's JSX transform: `bunfig.toml` with `[test] preload =
["@opentui/solid/preload"]` and `jsxImportSource: "@opentui/solid"` (in `tsconfig.json` or a
`/** @jsxImportSource @opentui/solid */` pragma). The spike's `test/tui.test.tsx` passes under
`bun test` here:

```tsx
const context = {
  location: { directory: "/workspace" },
  theme: { text: { muted: RGBA.fromInts(120, 120, 120) } },
  client: { rpc: () => ({ children: async () => ({ children: [a, b] }) }) },
  ui: { slot: (value: SlotClaim) => { claim = value; return () => {} } },
} as unknown as Plugin.Context
await tui.setup(context)
const app = await testRender(() => claim!.render({ sessionID: "ses_parent", mode: "normal", showDetails: true }), { width: 60, height: 2 })
await app.waitForFrame((frame) => frame.includes("2 children"))
expect(app.captureCharFrame()).toContain("courier spike: 2 children")
```

**A live check in CI**: the TUI runs in `tmux`, which worked in this cloud session (no terminal of its
own; `script` was not needed): `tmux new-session -d -x 140 -y 40 "opencode --server $SERVER --session
$id"`, with `OPENCODE_PASSWORD` in its environment, then `tmux capture-pane -p` and a `grep` of the
footer line, polled for up to a minute (`e2e/spike-tui.sh`, step 3). The TUI's log at
`$XDG_DATA_HOME/opencode/log/opencode.log` has the plugin reconciliation lines at `INFO`, the
per-plugin setup lines at `DEBUG`. CI's `ubuntu-24.04` image does not list `tmux` among its installed
software (`actions/runner-images`, `images/ubuntu/Ubuntu2404-Readme.md`), so the live job installs it
with `apt-get` first.

### 5. Versions, build and the live suite

- **Pins.** `devDependencies` only: `@opentui/core` `0.5.17`, `@opentui/solid` `0.5.17`, `solid-js`
  `1.9.15`, the versions OpenCode's root catalog pins at `v2.0.28` and the host's own copies, and
  `@opencode/theme` `2.0.28` for the context's types. No new peer dependency (point 1). A pin bump must
  now read the catalog's `@opentui/*` and `solid-js` as well as `@opencode/plugin`. OpenCode patches its
  `solid-js` (`patches/solid-js@1.9.15.patch`, the order of cleanups in `cleanNode`); the TUI part runs on
  that copy, the unit tests on the unpatched one.
- **Build.** `tsc -p tsconfig.build.json && tsc -p tsconfig.tui.json && bun script/build-tui.ts`;
  `tsconfig.json` gets `jsx: "preserve"`, `jsxImportSource: "@opentui/solid"` and `script` in
  `include`, `tsconfig.build.json` excludes `src/tui.tsx`. `bun run typecheck`, `bun test`, `bun run build` and `publint` pass on the spike branch.
  `@arethetypeswrong/cli`, which CI runs on the package too, flags `./tui` with "No types" when the
  export has none, so a third, declaration-only `tsc` pass (`tsconfig.tui.json`, `emitDeclarationOnly`
  over `src/tui.tsx`) writes `dist/tui.d.ts` and the export names it; with that, `attw --pack --profile esm-only` passes on the spike branch.
- **The live suite stays unchanged**: `e2e/run.sh` passed on the spike branch as it is, on 2.0.28, the
  `plugin add` scenario included; the server half behaves as before. The TUI gets its own scenario
  (point 4), in `run.sh` or a script of its own.

### Recommendations for Phase 1

- **Slots.** `prompt.footer.status` for the status entry (what the spike does), `session.panel` for the
  tree (it has focus and fullscreen, `ui.panel.open`), `ui.dialog.select` with `actions` for the inbox,
  `attention.notify` with `question` and `permission` sounds, `keymap.layer` commands with `slash` for
  `/courier …`. The slot map and inputs are in `packages/plugin/src/tui/context.ts`, lines 191-203.
- **Where the code goes**, in short; the rules themselves go into `docs/research/layout.md` and
  `test/imports.test.ts` with Phase 1, which this note does not restate afterwards. `src/tui.tsx` is a
  second composition root, next to `index.ts`: it imports each module's contract (`<module>/rpc.ts`)
  and its TUI adapter (`tree/tui.tsx`, `person/tui.tsx`), which import only `@opencode/plugin/tui`,
  `solid-js`, `@opentui/*`, the module's `rpc.ts` and `text.ts`; nothing of the server half, so the
  bundle stays small. The server adapters are `<module>/rpc-handlers.ts`, registered from `index.ts`.
- **What the inbox answers through.** Permissions and forms through the TUI's `data.session.permission`
  and `data.session.form.reply`, which OpenCode settles itself; questions and the "settle the parent's
  relayed notice" rule through a `person` RPC that calls what `courier_answer` calls, so the root's
  model is not told twice.
- **How to test.** Unit tests with the fake context and `testRender` (point 4); one `tmux` scenario in
  the live suite for the footer entry.

Open questions, not settled here: the paired app's request dock with native `parentID` (source only;
no device); the RPC's `events` from a TUI attached to a remote server (not tried); the providers' side
of the affinity change (a real-model rerun); whether the TUI's own `question` dialog and the courier's
relay compose for a native child (the relay wraps the question tool at the server; the TUI shows a
native child's form in the root's view, so a person could answer there what the relay has already
passed up).

### What the asks inbox found (#144)

Read in OpenCode's source at `v2.0.28` and checked live by `e2e/tui.sh`.

- **Replying to a permission request.** The plugin TUI context's `data.session.permission` types `list`,
  `sync` and `invalidate` only (`packages/plugin/src/tui/context.ts`); the host's own data store has a
  `reply` (`packages/tui/src/routes/session/permission.tsx`, line 138, and the auto-accept in
  `routes/session/index.tsx`, line 268), which a plugin is not typed to reach. The inbox replies through
  the context's `client.permission.reply`, the same `POST /api/session/:id/permission/:request/reply` route.
  Forms go through the typed `data.session.form.reply`, as the TUI's form view does (`routes/session/form.tsx`,
  line 271). Both are session routes: the server finds the session's location, so an isolated child's
  request needs no location from the TUI.
- **Forms are listed by the TUI.** The server plugin API has no form domain, so the person's RPC lists
  permission requests and questions, and the TUI lists each session's forms with `client.session.form.list`.
- **Sounds.** OpenCode's own `opencode.notifications` part (`packages/tui/src/feature-plugins/system/notifications.ts`)
  already sounds `permission` on every `permission.asked` and `question` on every `form.created` the TUI
  receives, courier children's included; the inbox's own notice adds where the ask comes from.
- **Keys.** `<leader>` bindings OpenCode takes at `v2.0.28` (`packages/tui/src/config/v1/keybind.ts`):
  `a b c e g i l m n q r s t u w x y`, the digits and the arrows; the inbox takes `<leader>k`.
- **The question dialog and the relay.** Without a native `parentID` a child's question form shows only in
  the child's own view; the person sees it there, in the root's view when the root's model asks the same
  (the relay links the two), and in the inbox. Whichever answers first settles the others: the relay
  withdraws the linked call and the child's form, and the inbox reads the tree again. With a native
  `parentID` (#146) the root's view would show the child's form too, next to the root's own linked question.
