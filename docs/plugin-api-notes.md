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
  location shut down". The relay now holds a dismissal for `timing.dismissalGraceMs` (2 s) to see
  whether `location.shutdown` or its instance's unload follows, and treats it as cut off then
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

So the peer range is a statement, not a check: a mismatched host installs and loads the plugin
without a word, and what breaks does so on use, or on load when the host lacks a domain the
plugin API copy expects. The runtime signals are that load failure, and the log line #38 adds for
a host whose `app.version` differs from the version the plugin was built against. The range in
`package.json` is therefore set from the evidence rather than relied on: `^2.0.22`, the version the
live suite ran on (the pinned leg of CI, and `latest` that day) and the `dev` build it also passed
on, 0.0.0-dev-20534 (2026-10-04); below the pin the plugin loads on 2.0.4 to 2.0.21 but was not
tested there, and does not load before 2.0.4. A pin bump still adds a row to the README's table.
