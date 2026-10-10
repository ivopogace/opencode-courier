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
  themselves; a unit test keeps it that way.
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
  `reason`, and one of `shutdown` resumes the turn on the next start. `session.inbox.delivered`
  (`data.inboxID` only) is published as each prompt, synthetic message, compaction or move reaches
  the session, and the message it makes is stamped with that event's `created`, not with the time
  a queued item was admitted to the inbox. Every event carries `created`, the epoch
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
  (`4.0.0-rc.112` at the pinned version), and Effects of the two copies compose. A plugin loaded
  after this one that replaces `question` as well would drop the relay.
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
  Nothing in the package or in the loader calls it at 2.0.26, so a plugin still runs on the copy
  installed next to it, as [below](#the-peer-dependency-is-a-statement-not-a-check); once OpenCode
  does call it, the host's copies take over, which the question relay (whose Effects must compose
  with the host's) is built for either way. A pin bump should re-check which it is.
- OpenCode's plugin loader (`packages/core/src/plugin/module.ts`) now consults the managed policy
  before loading a plugin, and refuses one an organisation's policy denies (`integration.use` on
  `plugin:<name>`); the load reports `blocked`. An administrator's setting, not the plugin's.

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
only runtime signal. The peer dependency does do one thing: it picks the copy of the plugin API
that `plugin add` installs next to the plugin, and that the plugin then runs on, on every host.
With an exact version that copy is the one the plugin was built and tested with; with a range such
as `^2.0.22` it would be the newest version on npm that satisfies it, a copy nothing has run the
suite with. That is why the peer dependency stays exact, the same version as the devDependency,
and why the README's table keeps one version per row.

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
npm install --prefix <scratch>/oc @opencode/cli@2.0.26
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
