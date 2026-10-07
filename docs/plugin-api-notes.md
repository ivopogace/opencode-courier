# Notes on the V2 plugin API


Found while testing against `0.0.0-beta-19271`:

- A plugin tool is only reachable through code mode's `execute` tool unless it is registered with
  `options: { codemode: false }`. The courier tools are direct tools.
- A tool whose result `metadata` holds an `undefined` value never completes: the call stays
  `running` and no error is reported. Results here drop `undefined` keys.
- A plugin cannot add an HTTP route to OpenCode's own server. The nearest thing, `rpc.register`,
  is reached through the authenticated `/api/rpc` endpoint with a JSON envelope, so neither
  GitHub's headers nor the raw body its signature covers would get through. The webhook receiver
  is therefore its own small listener inside the OpenCode process, shared by the plugin's
  per-location instances. It waits for the previous listener to finish closing before it binds,
  as after a plugin reload, and if binding fails, the next instance to load tries again. A plugin's options come from a `{ "package", "options" }` entry in
  `plugins`, which takes a local directory as `package` too.
- OpenCode errors such as `Session.NotFoundError` can arrive with an empty message, so the tools
  rethrow them with the tag and session id.
- OpenCode decodes a tool's input with its own copy of `effect`, not the plugin's, and schema
  checks and transformations from the plugin's copy do not survive that: `Schema.Finite` refuses
  the number `2` ("Expected a finite number"), and `Schema.FiniteFromString` fails with "Cannot
  convert a symbol to a number". Tool inputs use plain schemas and the tools validate the values
  themselves; a unit test keeps it that way.
- `permission.asked` and `permission.replied` reach a plugin's `event.subscribe()`, as
  `session.execution.failed` does. OpenCode keeps pending permission requests per location, and a
  plugin instance's `permission` domain answers from its own location's, so a request of an
  isolated child is answered through the instance loaded in the child's worktree. The plugin keeps
  the domain of every loaded instance and answers through the one that holds the request.
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
  (`4.0.0-rc.112` at the pinned version), and Effects of the two copies compose. A plugin loaded
  after this one that replaces `question` as well would drop the relay.
- OpenCode's question tool asks through a form. `form.created` reaches `event.subscribe()` (form
  events are ephemeral, never stored), of every location's plugin instance whichever location the
  form is in, with the form's `metadata.tool.id`, the id of the call; the
  form is created only after the call's permission check has passed. A person dismissing a form
  makes the tool die with `QuestionTool.CancelledError`, which ends the asking session's turn
  ("The user dismissed this question"). Forms live in memory: a restart drops them, and the call
  that asked stays `running` until the session's next turn marks it aborted. When OpenCode closes
  a location, as on a graceful server shutdown, it withdraws every open form there, which looks to
  the tool exactly like the person dismissing it, and unloads the plugin there: at the beta the
  plugin unloaded first, so the relay treated a call that ended after its instance unloaded as cut
  off; since 2.0.22 the forms go first (see below), so the relay holds a dismissal for a moment to
  see whether a shutdown follows.
- OpenCode stops every turn in a project location after 60 minutes without a stored session event
  there (`packages/core/src/location-activity.ts`), which withdraws any question still open. A
  tool call has no timeout of its own.
- `Schema.Number` advertises the strings `"Infinity"`, `"-Infinity"` and `"NaN"` in its JSON
  Schema, so models are offered a string where a number is meant. Some send numbers as strings
  regardless, so `courier_later` takes `delayMinutes` as either.

## From `0.0.0-beta-19271` to `2.0.22`

OpenCode V2 went GA on 2026-09-12 under a new npm scope, and opencode-courier 0.2.0 moved its pin
from the last beta it was built against to `2.0.22` (2026-10-02). The beta line stopped on
2026-09-17 (`beta` branch of https://github.com/anomalyco/opencode); the V2 code is on the `v2`
branch, and each release is tagged (`v2.0.22`). Everything below was read from the type packages,
`@opencode-ai/*@0.0.0-beta-19271` against `@opencode/*@2.0.22`, and checked by the live suite.

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

What the new types forced in the code (the only four compile errors after the rename):

- `worktree.create` and `worktree.remove` take the project the worktree belongs to, `projectID`,
  instead of a location, `location: { directory }` (`WorktreeCreateInput` and
  `WorktreeRemoveInput` in `@opencode/client`; `worktree.list` likewise). The plugin's context has
  it as `location.project.id`, in the beta too. `src/courier.ts`: `CourierPorts.projectID`, and
  `spawn` passes it; `src/cleanup.ts`: `CleanupPorts.projectID`; `src/roster.ts`: `RosterEntry`
  gains `project`, recorded for an isolated child next to `source`, the directory it was made from,
  and `courier_cleanup` removes the worktree from `entry.project`, or from the plugin's own
  project for an entry recorded before 0.2.0; `src/index.ts` wires `ctx.location.project.id`.
  `agent.get` still takes `location`.
- `permission.reply` takes the answer as `decision` instead of `reply`
  (`PermissionReplyInput`), and so does the HTTP route the live test calls directly,
  `POST /api/session/:id/permission/:request/reply`, which answers 400 to a body with `reply`. The
  `permission.replied` event still carries it as `reply`. `src/relay.ts`: `answer`;
  `courier_answer`'s own parameter is still `reply`.
- Nothing else the courier calls changed shape: `session.get`, `session.create`,
  `session.prompt`, `session.synthetic`, `session.context`, `agent.get`, `tool.transform`,
  `event.subscribe`, `storage`, and the Effect plugin's `fromPromise`.

Changed in the API, not used by the courier:

- The `catalog` domain is gone; `model` and `provider` domains replace it.
- Session hooks: `SessionContext` now extends a `SessionRequest` whose `options` carries the
  generation settings and provider options (`generation` and `providerOptions` are gone), and there
  are new `compaction`, `generate` and `title` hooks and experimental WebSocket hooks. The session
  domain gains `remove`, `compact` and `update`, and `rename` is gone.
- The tool context gains `signal: AbortSignal`, and the tool domain `list()`. The worktree
  editor's strategies get a `signal` too. `integration` gains `status`.

Observed at `2.0.22`, differently from the beta (the live suite found each of these):

- A closing location withdraws its open forms before it unloads the plugin, not after: a child's
  question call dies with `QuestionTool.CancelledError` while the plugin is still loaded, as if the
  person had dismissed it, and the relay forgot the question and told the parent so, instead of
  keeping it for the next load. Some 40 ms later OpenCode publishes a `location.shutdown` event
  (new since the beta; `data` is empty, `location.directory` names the location) and then unloads
  the plugin; the call's own failure is recorded as `aborted`, "Interaction cancelled because the
  location shut down". The relay now holds a dismissal for its dismissal grace (2 s, the
  `dismissalGraceMs` of the `timing` that `src/index.ts` gives its ports) to see whether
  `location.shutdown` or its instance's unload follows, and treats it as cut off then
  (`src/question.ts`: `closingSoon`, `locationClosing`, which `src/watch.ts` calls for the
  event); an unload that comes later, while `settle` still waits for the notice to the top
  session, counts too. A dismissal by the person reaches the other side that much later. The schema marks the
  event's `location` as optional (it was present in every live run): a shutdown reported without
  one counts for every location. The shutdown times are kept per location, and a location whose
  plugin instance loads again forgets its own, so a form dismissed there right after is not taken
  for that shutdown; one recorded for every location is left to age out, since a dismissal held
  in another location may still need it.
- The permission reply route, `POST /api/session/:id/permission/:request/reply`, takes
  `decision` (above); the form dismissal route is `DELETE /api/session/:id/form/:form` (was
  `POST .../cancel`). `GET /api/form` lists every open form (was `/api/form/request`).
- A session's message list records an `idle` message when a turn ends (`SessionMessageIdle`,
  with `outcome: "succeeded" | "failed" | "interrupted"`); the beta recorded nothing, and the
  real-model checkers read the end of a turn from the last step's finish reason. They take the
  marker now.
- The server's `/api/health` route is gone (404); `/api/info` answers with the version, pid and
  urls, and the test harness waits for the server on it. The session API moved several routes
  under `/api/experimental/` (`wait`, `import`, `export`, `stats`, `skill`, the instructions
  entries), none of which the courier uses.

Follow-up material, out of scope of the migration: the promise API's tool context now carries
`signal`, which is aborted when the call is interrupted. The question relay wraps `question` through
the Effect API because the beta's promise `execute` ran without a signal; with the signal, a
promise plugin could race the original `execute` against it. Nothing uses it yet.

## From `2.0.22` to `2.0.23`

`2.0.23` (2026-10-05) is 127 commits on the `v2` branch after `v2.0.22`, mostly the TUI, the
desktop app, ACP and model providers. Read from the type packages, `@opencode/{plugin,client,
schema,protocol}@2.0.22` against `@2.0.23`, and from the commits, and checked by the live suite
(the 0.2.0 build passed it on a 2.0.23 host before the pin moved, and passed it again after):

- Nothing the courier calls changed shape, and the code needed no change: the typecheck, the unit
  tests and the live suite pass as they were.
- In the plugin API: a VCS provider may define `init` (both the Effect and the promise API, and
  the adapter passes it through), and the TUI's select dialog gains `search` and `actions`. The
  courier registers neither.
- In the schema: `SessionEvent` no longer re-exports `FileAttachment` (it stays in
  `@opencode/schema/prompt`), and the unused `QuestionV1`, `SessionV1.WithParts` and IDE event
  definitions are gone.
- In the HTTP API: a session whose location's directory no longer exists answers 404 with a
  `LocationNotFoundError` instead of failing as a defect (anomalyco/opencode#52668), on
  `GET /api/session/:id/permission`, the session diff and `generate`; inside the server the error is
  `FileSystem.DirectoryNotFoundError`, and session `diff`, `command`, `revert`/`clear` and a turn
  of the runner can fail with it. None of the calls the courier makes, `session.synthetic` among
  them, gained it, so the webhook's test for a session OpenCode no longer knows (an error tag with
  `NotFound`) still means only that. `POST /api/vcs/init` is new, and `/api/info` may carry
  `capabilities`. `WorktreeError` gained a `_tag` (anomalyco/opencode#52631); `describeFailure`,
  which the worktree calls fail through, names an error by its `_tag` when it has no message, so an
  empty-message worktree failure is now named by it.

## From `2.0.23` to `2.0.24`

`2.0.24` (2026-10-06) is 55 commits on the `v2` branch after `v2.0.23`, mostly the desktop app, the
TUI, model providers (a native Vercel AI Gateway, GitLab Duo, the ChatGPT OAuth labels) and the
shell scanners. Read from the type packages, `@opencode/{plugin,client,schema,protocol}@2.0.23`
against `@2.0.24`, and from the commits, and checked by the live suite (the 0.2.1 build passed it on
a 2.0.24 host before the pin moved, and passed it again after):

- Nothing the courier calls changed, and the code needed no change: the typecheck, the unit tests
  and the live suite pass as they were.
- `@opencode/plugin`, `@opencode/schema` and `@opencode/protocol` are identical to 2.0.23 apart from
  their version and dependency numbers; `effect` stays at `4.0.0-rc.112`.
- `@opencode/client` moved its startup bookkeeping and health probe into shared modules
  (`service-probe`, `contenderPool`; anomalyco/opencode#53237, anomalyco/opencode#53240);
  `headers` is re-exported from there under the same name, and the Solid data store gained
  `active()` and `sessions()`. The courier uses none of these.

## What `plugin add` and loading do with the peer dependency (2026-10-04)

The peer dependency on `@opencode/plugin` is the range of OpenCode versions a release claims to
work on. Whether anything enforces it was tested on six hosts, for #40, each an `@opencode/cli`
installed into its own npm prefix and run with a fresh home directory (`HOME` and the XDG
directories under a scratch path, as `e2e/lib.sh` does):

| Host (`opencode --version`) | Where it stands | Published |
|---|---|---|
| 2.0.0 | the oldest 2.x release | 2026-09-11 |
| 2.0.3, 2.0.4 | either side of the change that matters below | 2026-09-12, 2026-09-16 |
| 2.0.21 | the release below the pin | 2026-09-30 |
| 2.0.22 | the pin; also the `latest` dist-tag that day | 2026-10-02 |
| 0.0.0-dev-20534 | the `dev` dist-tag: the newest build, two days after 2.0.22, under a version number that sorts below 2.x | 2026-10-04 |

No 2.x release above 2.0.22 existed on npm, so the `dev` build stands in for a newer host. The
package under test was this tree built and packed as `opencode-courier@0.2.0`, with
`"peerDependencies": { "@opencode/plugin": "2.0.22" }`, exact, and served by the stand-in registry
of the live suite (`e2e/registry.mjs`, with `npm_config_registry` pointing at it); the version on
npm at the time, 0.1.6, still named the beta's `@opencode-ai/plugin`, so it could not stand in. On
each host: `opencode plugin add opencode-courier` in a scratch project, its output and exit code
recorded, then the cache directory it installed into inspected, then `opencode serve` started in
that project and `GET /api/plugin?directory=…` called, which makes the location load its plugins
and lists them with their state; the server's log was read with `--print-logs`.

What happened, the same on every host unless said otherwise:

- `plugin add` exited 0 and printed only `Plugin "opencode-courier" installed and added to
  …/opencode.json`. No host warned, asked or refused, below the pin or above it.
- It installed into `~/.cache/opencode/npm/opencode-courier@latest/<timestamp>/`, with a root
  `package.json` of `{ "dependencies": { "opencode-courier": "0.2.0" } }`, and next to the plugin
  `node_modules/@opencode/plugin@2.0.22`: the lockfile marks it `"peer": true`. npm's resolver
  installs a package's peer dependencies by default (npm 7 onwards), and the install root is an
  empty directory, so the host's own version takes no part in the resolution: the peer is
  fetched from the registry at whatever version satisfies the range, 2.0.22 here, whatever
  `opencode --version` says.
- Loading on 2.0.4, 2.0.21, 2.0.22 and 0.0.0-dev-20534: one log line, `msg="loading plugin"
  id=opencode-courier entrypoint=file://…/dist/index.js`, and the plugin listed as
  `{"status":"active"}`. No warning about the version anywhere.
- Loading on 2.0.0 and 2.0.3: `level=WARN message="failed to load plugin" plugin.id=courier
  cause="Cause([Die(TypeError: undefined is not an object (evaluating 'host.model.list'))])"`
  a second after the loading line, and the plugin listed as `{"status":"failed","error":…}` with
  that error and a stack trace into `node_modules/@opencode/plugin/dist/promise/adapter.js`. The
  `model` domain appeared in `@opencode/plugin@2.0.4`, where it replaced `catalog`; the adapter of
  the 2.0.22 copy installed next to the plugin reads it from the host's context when it builds the
  promise API, and dies on a host that has not got it. Nothing about the version is said: the
  failure is reported as any other plugin failure would be.

Why, from the source at `v2.0.22`:

- `opencode plugin add` (`packages/cli/src/commands/handlers/plugin/add.ts`) checks that the
  argument is an npm or Git package specifier, installs it through `Npm.add`
  (`packages/util/src/npm.ts`), resolves the installed package's entrypoints and writes the name
  into `plugins` in the global config. `Npm.add` runs `@npmcli/arborist`'s `reify` with
  `add: [pkg]` and `save: true` in a staging directory under the cache, with npm's own
  configuration (`.npmrc`, `npm_config_*`), which is where `npm_config_registry` comes in; so
  `legacy-peer-deps` or `omit=peer` in a user's npm configuration would leave the peer out, and
  nothing would notice until the import failed. Neither `plugin add` nor `Npm.add` reads
  `peerDependencies` or `engines`, and `OPENCODE_VERSION` is not part of any install. The only
  version comparison in the plugin manager is `Npm.check`, which asks the registry whether a newer
  version of the plugin exists, for `opencode plugin check` and `plugin update`.
- Loading (`packages/core/src/plugin/module.ts`) resolves the installed package's entrypoint and
  imports it (`Host.load`, a plain dynamic import). The plugin's own imports of `@opencode/plugin`
  resolve from its directory, so a package plugin runs on the copy of the plugin API that arborist
  put next to it, never on the host's copy, and the host's copy need not match it. Nothing on the
  load path compares versions either; a failure in the import or the plugin's setup is logged as
  "failed to load plugin" and shown in the plugin's state, as above.

So the peer dependency is a statement, not a check: a mismatched host installs and loads the
plugin without a word, and what breaks does so on use, or on load when the host lacks a domain the
plugin API copy expects. OpenCode itself, `plugin add` and the loader alike, says nothing; the
plugin's own load-time log line, written when `app.version` differs from the version it was built
against (#38, [the reference](reference.md#the-opencode-version)), is the only runtime signal,
apart from that load failure on 2.0.0 and 2.0.3.

The peer dependency does do one thing, though: it picks the copy of the plugin API that
`plugin add` installs next to the plugin, and that the plugin then runs on, on every host. With an
exact `2.0.22` that copy is the one the plugin was built and tested with, whatever the host; with a
range such as `^2.0.22` it would be the newest version on npm that satisfies it, a copy nothing has
run the suite with, and the kind of copy that died above on a host short of a domain it expected.
That is why the peer dependency stays exact, the same version as the devDependency, rather than
becoming the range #40 set out to write, and why the README's table keeps one version per row and
the hosts the suite passed on are named apart from it (under it at first, now in
[reference.md](reference.md#other-versions-it-was-tried-on)): 2.0.22 (the pinned leg of CI, and
`latest` that day) and the `dev` build 0.0.0-dev-20534 (2026-10-04); of the older hosts tried, the
plugin loads on 2.0.4 and 2.0.21 (nothing in between was run, and the suite was not run there) and
does not load on 2.0.0 and 2.0.3, where the `model` domain is missing. The `latest` leg of CI covers
the next host release with this copy of the plugin API, which is exactly what `plugin add` gives a
user there. A pin bump still adds a row to the README's table.

## Update checks skip a plugin pinned to an exact version (2026-10-07)

A user with `opencode-courier@0.2.1` installed found that *check for updates* (ctrl+r) in the TUI's
`/plugins` dialog offered nothing after 0.2.2 was published as `latest`. From the source at
`v2.0.24`:

- `Npm.check` (`packages/util/src/npm.ts`), behind `opencode plugin check`, `plugin update` and the
  TUI's check, parses the configured entry with `npm-package-arg`. A registry spec is `mutable`
  unless its type is `version`, and for an entry that is not mutable `check` returns `false` without
  asking the registry. So `opencode-courier@0.2.1` is never reported outdated, while
  `opencode-courier`, `opencode-courier@latest` and `opencode-courier@^0.2.0` are compared with the
  version the registry resolves the spec to.
- The server's update service (`packages/core/src/plugin/update.ts`) logs a failed check as
  `failed to check plugin update` and keeps the previous answer, `false` the first time, so a failed
  check also reads as "no update".

On 2.0.24, in a scratch home directory, with the installed copy marked 0.2.1 and 0.2.2 on npm:
`opencode plugin check` printed `courier 0.2.1 (current)` for the entry `opencode-courier@0.2.1` and
`(update available)` for the entry `opencode-courier`. Hence the README's advice to install by
name, and to replace an exact-version entry with the name to get update checks back.

## How web search asks for its provider (2026-10-07)

A child calling `websearch` before any search provider was chosen showed OpenCode's "Web Search"
prompt in its own session, and its parent was never told (#61). From the source at `v2.0.24`:

- The `websearch` tool (`packages/core/src/tool/plugin/websearch.ts`) first asks the ordinary
  `websearch` permission, which the permission relay passes on. When no provider is selected
  (`WebSearch.ProviderRequired`), it asks with the form service directly, `forms.ask` with
  `title: "Web Search"`, `metadata: { kind: "websearch.provider" }` and one string field `choice`
  (`allow`, labelled "Allow search via" and the providers' names; `choose`; `disable`). On
  `choose` it asks a second form, "Choose a web search provider", with the same kind and a field
  `provider` listing each provider. The whole selection is under a one-minute
  `Effect.timeoutOrElse`; at the timeout the form is withdrawn (`form.cancelled`, since `ask`
  cancels its form when interrupted) and the call fails with "Web search cancelled", as it does
  when the person dismisses either form; the tool wraps that error in its failure "Unable to
  search the web for <query>", which ends the call, not the turn, so the model carries on.
- The choice is global: `WebSearch.select` stores it in OpenCode's KV under `websearch:provider`,
  and `disable` drops the tool from every session's tool list. Once made, in any session, no
  session is asked again. The selection is serialized by one lock, so two children searching at
  once are asked one after the other.
- Built in at 2.0.24 are Exa, Firecrawl, Parallel, Tavily and TinyFish. A plugin adds a provider with
  `ctx.websearch.transform((editor) => editor.add({ id, name, execute }))`; the live test does so
  with `e2e/search-plugin`, a local plugin directory (a configured local plugin must be a directory,
  "configured plugin path must be a directory", with a `package.json` naming its entry).

What a plugin sees of forms:

- `form.created` (`data.form`: `id`, `sessionID`, `title`, `metadata`, `fields`, each field with
  `key`, `type`, an optional `title` and `description`, and `options` of `value` and `label` for a
  choice), `form.replied` (`id`, `sessionID`, `answer`) and `form.cancelled` (`id`, `sessionID`)
  reach every instance's `event.subscribe()`. They are ephemeral events, never stored.
- Besides web search, at 2.0.24 forms come from the question tool (`kind: "question"`, with
  `tool: { messageID, id }`) and from MCP elicitation (`kind: "mcp-elicitation"`), whose forms belong
  to the session id `global`, not to a real session.
- The plugin API has no form domain: a plugin cannot list, answer or withdraw a form. So the plugin
  tells the session at the top about a form of a spawned session, other than a question, and that
  only the person can answer it; it cannot list the forms a session shows for `courier_status`, nor
  relay one shown while it was not following events.

## Two servers on one data directory (2026-10-07)

OpenCode keeps everything in one SQLite database under its data directory,
`$XDG_DATA_HOME/opencode/opencode.db` (`~/.local/share/opencode` by default), and any number of
servers can open it: `opencode serve` twice, or `opencode serve` next to the background server
`opencode service start` runs, which opens the same file. Plugin storage is a slice of that
database's `kv` table (keys `plugin:<the plugin id, hex-encoded>:<key>`), so the plugin instances
of two servers share the roster, the pending `courier_later` messages and the stored questions.
What they do not share is anything in process memory: the claim set the scheduler marks a message
with (`processWide("opencode-courier.claimed")` in `src/index.ts`), the watcher's handled events,
OpenCode's event bus and its pending permission requests. Whether that delivers anything twice was
untested until #73; `e2e/two-servers.sh` tests it.

Setup: `@opencode/cli@2.0.24` (the pin), one throwaway project and home directory as in the live
suite (`e2e/lib.sh`), the plugin from `dist/` without the webhook receiver (both servers would bind
its port), and `e2e/mock-model.mjs` as the model. Server A on port 4610 and then, once A is up,
server B on 4611, both `opencode serve` in the project with the same `HOME` and XDG directories.
Started at the same moment on a new data directory, the two race to create its tables and one exits
(`SQLiteError: table \`account_state\` already exists`); the script waits for A first. Every prompt
goes to A through `opencode run --server`; B has the plugin loaded for the project (its first
`GET /api/plugin?directory=…` loads it), so B's scheduler and watcher run. Each server's
`/api/event` stream is recorded, which shows which server queued each courier message
(`session.inbox.enqueued` with `metadata.source == "courier"`). The commands:

```bash
npm install --prefix <scratch>/oc @opencode/cli@2.0.24
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/two-servers.sh   # a few minutes, no API key; KEEP=1 keeps the logs
```

It schedules ten `courier_later` messages at once (`COURIER-LATER 0.5`, ten parallel
`opencode run`s), so they fall due within a few seconds of each other, first with the plugin loaded
on both servers at the same moment, so the two schedulers tick some milliseconds apart, then again
after B is restarted and its plugin loaded half a tick (7.5 s) after A's ticks, which fall where
the first round's messages were queued. In between it starts a
child that asks for a permission (`COURIER-ASK`), has the parent answer it with `courier_answer` in
a turn on B and then in one on A, and starts a child whose turn fails (`COURIER-FAIL`). The script
prints the counts and exits 1 when one differs from the results below, except the count with the
schedulers in step, which varies from run to run (below) and is only printed.

Results at 2.0.24, runs on 2026-10-07. Runs 1 to 3 used earlier drafts of the script: run 1
scheduled three messages one after another, and none of the three tried `courier_answer` or
restarted B. Runs 4 to 6 timed B's restart from when A's plugin load was asked for rather than from
A's ticks, so the two were between about 6.5 and 7.5 s apart, give or take the difference in setup
time. Run 8 is the plugin as of #82 (the roster's reverse index), the others as of #68.

| | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 | Run 6 | Run 7 | Run 8 |
|---|---|---|---|---|---|---|---|---|
| `courier_later`, schedulers in step: messages delivered twice | 0 of 3 | 10 of 10 | 6 of 10 | 3 of 10 | 0 of 10 | 3 of 10 | 6 of 10 | 8 of 10 |
| `courier_later`, schedulers half a tick apart: delivered twice | not run | not run | not run | 0 of 10 | 0 of 10 | 0 of 10 | 0 of 10 | 0 of 10 |
| notices of the child's permission request | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| `courier_answer` in a turn on B reaches the request | not run | not run | not run | no | no | no | no | no |
| `courier_answer` in a turn on A reaches the request | not run | not run | not run | yes | yes | yes | yes | yes |
| notices of the child's failed turn | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |

No message was ever delivered more than twice, and none was lost.

Why:

- **A `courier_later` message can be delivered twice.** Both schedulers scan the same storage
  every 15 seconds (`TICK_MS`), and each claims a due message only in its own process. Each
  re-reads the message after claiming it and removes it only after `session.synthetic` returns, so
  the other server skips it if its tick comes after the removal, and delivers it too if its tick
  comes in between. One delivery took about 5 to 10 ms (from the `created` times of the
  `session.inbox.enqueued` events), and due messages are delivered one after the other: in run 2
  each of B's ten deliveries was queued within 10 ms of A's of the same message. How often it happens therefore depends on how far
  apart the two servers' ticks are, which is set by when each loaded the plugin for the project and
  then stays fixed until one of them reloads it: within a few milliseconds, some or all messages due
  in the same tick are delivered twice; half a tick apart, none was. Loading at the same moment does
  not pin the gap down: the server logs put the two loads 23 ms apart in run 4 and 27 ms in run 5,
  yet run 4 delivered three messages twice and run 5 none, with A delivering all twenty, since a
  scheduler starts only once the plugin's setup has run, which takes a varying time. Two servers started at unrelated
  times are rarely that close, so in practice a duplicate is rare, but nothing prevents it, and the
  messages that fall due together while both are up (several check-ins due at once after a restart
  of one) widen the window.
- **A permission request or a failed turn is told once.** The watcher acts on OpenCode's events,
  and a server's event bus, and its `/api/event` stream, carry only what that process does: in run 4
  A's stream carried 754 session events of 24 sessions and B's 121 of 11, each of them a session B
  had itself queued a message into (its ten deliveries and the turn it ran for `courier_answer`),
  none of the sessions only A ran. A turn runs in the server that queued the message starting it (B
  ran a turn for each message it delivered), so a child's turn runs where its `courier_spawn`, or a
  later `courier_send` or prompt to it, was handled, only that server's watcher sees its
  `permission.asked` or `session.execution.failed`, and it tells the parent once. B's watcher also
  relays, on subscribing, the requests already pending for the sessions on the roster, but it lists
  them through its own `permission` domain, which holds only B's pending requests.
- **`courier_answer` reaches a request only from the server where the child waits.** Pending
  permission requests live in the memory of the process that runs the child's turn. A parent whose
  turn ran on B (its own prompt, a scheduled message B delivered, a child's report B queued) called
  `courier_answer`, found no such request among B's, and returned `answered: false`, telling the
  model the child "no longer waits on request …" and that the answer is not needed, while the child
  still waited on A; the same call in a turn on A passed the answer on. By the same reasoning, not
  run here, `courier_status` and `courier_children` list under `pending` only the requests held by
  the server they run on, and the question relay, which follows a child's question by its form's
  events, sees only questions asked on its own server.

Not covered: the webhook receiver (the script leaves it off, since its port can be bound by one
process only) and the question relay.

What would fix the duplicates, not done here (#73 changes no `src/`): a best-effort owner key in
plugin storage with an expiry, such as `later/owner` holding a process id and a time, which a
scheduler writes and re-reads before a tick and renews while it runs, so only the server holding a
fresh key delivers; the storage has no compare-and-set, so two servers could still both believe
they hold it for the moment between the write and the re-read, which a short random wait before
the re-read narrows. The same key could pick the one server whose watcher relays pending requests
on subscribing. Passing an answer to a request held by the other server needs a channel between
the servers, which the plugin API does not offer; the most a fix could do there is say, when no
request is found, that it may be pending on another OpenCode server, instead of that it was
answered.
