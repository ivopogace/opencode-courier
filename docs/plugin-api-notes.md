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
  from `@opencode-ai/plugin/promise/adapter`, which is what OpenCode does with a promise plugin,
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
  event). A dismissal by the person reaches the other side that much later.
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
