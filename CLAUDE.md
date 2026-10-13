# CLAUDE.md

opencode-courier is an OpenCode V2 plugin that lets sessions spawn, message and wake each other
without polling. README.md is the user-facing reference and `docs/reference.md` the long form of the
behaviour; read both, and `docs/plugin-api-notes.md`, before changing the plugin.

## Layout

`src/` is split into modules by feature, hexagonal inside; `docs/research/layout.md` holds the layout,
the import rules and the reasons for them.

`src/`:

- `index.ts`: the plugin, an Effect plugin running the promise one, and the composition root. Builds
  the ports, adds the tools in a fixed order (`addTreeTools`, `addPersonTools`, `addSchedulingTools`,
  `addWebhookTools`), hands the platform the ordered tick jobs (`dueJob`, then `deliverReleased`) and
  event modules (`treeEvents`, then `personEvents`), composes the `Waits` port from its suppliers,
  wires `courier_stop` to `scheduling/`'s `cancelScheduled`, and starts the webhook receiver; the
  Effect half wraps the question tool and binds it to its instance's member in the hub. The only file
  that imports more than one module's `index.ts`; nothing imports it.
- `skill.ts`: the `courier-orchestrate` skill and its text, registered through the skill domain; it
  imports only `kernel/`.
- `tui.tsx`: the package's `tui` entrypoint, a second composition root, adding each module's TUI part
  (`addTreeStatus`); it imports only `@opencode/plugin/tui` and the modules' `tui.tsx` and `rpc.ts`.
  Bundled alone to `dist/tui.js` by `script/build-tui.ts` (OpenTUI's Solid transform, every package
  external, as the host provides them); `tsconfig.build.json` leaves the `tui.tsx` files out and
  `tsconfig.tui.json` writes `dist/tui.d.ts`. `rpc.ts`: the `rpc` entrypoint, the modules' RPC
  contracts (`treeRpc`). Neither is imported by the server half.
- `kernel/protocol.ts`: what the models see of the protocol in every module: `envelope`, `END_TURN`,
  `clipText`, `defuse`, `describeFailure`, `Status`, `SPLIT_LINE` and `SKILL_ID`. It imports only
  `kernel/**` and `platform/json.ts`. `kernel/tool.ts`: `ToolEditor` and `rethrow` for the `tools.ts`
  files.
- The modules, `tree/`, `person/`, `scheduling/` and `webhook/`, each a folder imported from outside
  through its `index.ts` only. The only dependency between them is `person/` on `tree/`; each may
  import `platform/**` and `kernel/**`. Each has a `text.ts` with its model-facing strings, as pure
  functions, which imports only `kernel/**`, `platform/json.ts` and its own module's `ports.ts` and
  `domain.ts`, and a `tools.ts` adding its tools.
- `tree/`: the session tree. `ports.ts` its ports and data types (`CourierPorts`, `WatchPorts`, `Waits`,
  `ChildStore`, `GroupStore`, `Pending`, `CleanupResult`, …); `domain.ts` its pure rules and the data
  they take (`readLimits`, `busy`, `lineageIn`, `standingOf`, `complete`, `isGroupName`, `Limits`,
  `RosterEntry`, `HeldReport`, …), importing nothing of the plugin's but `kernel/**` and
  `platform/json.ts` (and OpenCode's types); `text.ts` the child brief, the role part, the
  refusals, the report body, the failure, silent, stopped and group notices and the tool results.
  Outbound: `store.ts`, the only file that knows the storage keys and layouts of `roster/`,
  `roster-by-child/`, `report/` and `group/`: `childStore(storage)` (a child's roster entry, its
  reverse index and its report state, which go together) and `groupStore(storage)` (join groups'
  members and held reports), built inside `tree/` from the `storage` its ports already carry; no file
  outside `tree/` imports it. `forget.ts`, the one cleanup service: forgetting a child (`forgetChild`:
  its entry and report state and, at once and best effort, its group membership, as a held report
  outlives the entry), courier_cleanup's (`forgetDropped`), expired entries', a deleted session's
  (`forgetDeleted`) and orphaned report keys (`forgetReports`). Taking back a write just made
  (`send.ts`, `spawn.ts`) and dropping a delivered group (`group.ts`) stay with their use case.
  One file per use case: `spawn.ts`, `send.ts`, `status.ts` (`courier_status`, `courier_children`),
  `subtree.ts` (`courier_tree`), `stop.ts` (`courier_stop`), `cleanup.ts` (forgetting a child, with
  its worktree if it is isolated, and dropping it from its join group). `limits.ts` the limits
  `spawn()` checks; `report.ts` whether each spawned session owes its parent a report, read from its
  report notes; `group.ts` join groups' rules (joining, holding, leaving, standing), the reports held
  with them and their delivery from the scheduler's tick (`deliverReleased`); `roster.ts` the
  retention of each parent's children (`current`, `pruneExpired`) and the lineage queries `person/`
  reads (`lineage`, `allEntries`, `answeringTop`). Inbound: `tools.ts` the seven tree tools (`addTreeTools`);
  `rpc.ts` the tree's RPC contract (`treeRpc`, Standard Schema from `effect`'s `Schema`), which imports only
  `@opencode/plugin/rpc` and `effect`, and `rpc-handlers.ts` its server side (`registerTreeRpc`, called
  from `src/index.ts` after the tools), whose `summary` is `summary.ts`'s, read through the subtree walk,
  `busy`, the pending port and `groupStanding`; `tui.tsx` the TUI part, the prompt footer's status entry
  (`addTreeStatus`), which imports only `@opencode/plugin/tui`, `solid-js`, `@opentui/*` and `rpc.ts`;
  `events.ts` `treeEvents`, which tells a parent that a child's turn failed or ended without a report,
  with `waitsOn` and `together` to compose the `Waits` port the silent-turn rule asks, supplied by
  `person/`, `scheduling/` and `webhook/`; `context.ts` the `context` hook naming each spawned
  session's role and hiding `courier_spawn` from a leaf.
- `person/`: what a spawned session needs the person for: its permission requests, forms and questions.
  `index.ts` is its public API; `permission.ts` passes a permission answer back (`answer`), lists a
  session's pending requests (`pendingOf`) and says whether it waits on one (`asksPermission`, a `Waits`
  supplier); `form.ts` the forms OpenCode shows in a spawned session, which only the person can answer,
  and the notices of one shown and one settled; `events.ts` `personEvents`, the event module: permission
  asked and replied, forms created and settled, `relayPending` on every (re)subscribe, and the signals to
  the question relay (events followed or left, forms shown, locations closing); `ports.ts` its
  `PersonPorts`, `PersonState` and `Form`, and the types `text.ts` takes of the files that own them;
  `tools.ts` adds `courier_answer`, which answers both a permission request and a question; `text.ts`
  the permission, form and question notices, `REJECTED` and the result of `courier_answer`. It reads the
  tree through `tree/index.ts`; `tree/ports.ts` declares the question shape its `Pending` needs
  (`PendingPrompt`), and `index.ts` checks `Prompt` against it at compile time.
  `person/question/`: relaying a child's question by wrapping OpenCode's `question` tool. `index.ts` is
  what the rest of `person/` imports; `relay.ts` wraps the tool; `answer.ts` passes an answer on;
  `lifecycle.ts` takes the signals `person/events.ts` and `src/index.ts` send (forms shown, shutdowns,
  instances joining, events followed); `shared.ts` the hub's question state, filled in field by
  field, its storage keys and `portsAt`;
  `types.ts` the relay's types (`Prompt`, `Asked`, `Outcome`, `QuestionPorts`, `QuestionState`, …);
  `pure.ts` the pure parts; `runtime.ts` the copy's own Effect runtime and clock, which tests swap
  for a `TestClock`. Inside the folder the relay is Effect code; what it exports, and the hub's
  shared fields, which copies of other versions use, stay promises and plain functions. Effect
  stays inside the folder.
- `scheduling/`: scheduled messages. `later.ts` stores and delivers them (`courier_later`'s logic,
  `deliverDue`), cancels a session's for `courier_stop` (`cancelScheduled`) and says whether a session
  waits on one (`isScheduled`); `tools.ts` adds `courier_later` and `courier_cancel`; `text.ts` their
  result texts. It exports `dueJob`, its tick job, and `isScheduled`, its `Waits` supplier.
- `webhook/`: webhook deliveries. `receiver.ts` the HTTP server, the signature check, dispatch and the
  process-wide receiver (`joinReceiver`, under the hub's `receiver` key); `subscriptions.ts` the
  subscription store and topics; `tools.ts` `courier_subscribe` and `courier_unsubscribe`; `text.ts`
  their texts and the delivery summaries. It exports `subscribedSince`, its `Waits` supplier.
- `platform/`: imports nothing outside `platform/`. `hub.ts`: the plugin's process-wide state in one
  versioned hub, which instances join with their ports and location and leave on unload, and the
  scheduler's loop, run once per hub and by one server per data directory (the owner key
  `scheduler/owner` in the plugin's storage). It types only what it owns: a member's feature ports
  and the feature state it keeps are opaque to it, typed by their owners, who take a value under its
  fixed process-wide key through `sharedState`. `events.ts`: following OpenCode's events (subscribing,
  resubscribing after `RESUBSCRIBE_MS`, the hub's two watchers through `watchFromHub`), running each
  event through the event modules by phase: `handle` in list order, then `after` in a `finally`;
  `followed` and `left` around each subscription, `subscribed` alongside it. Tick jobs
  (`open(registry, jobs)`) and event modules (`watchFromHub(hub, modules)`) are registered by
  `src/index.ts` and live in the closures the hub runs, the copy loaded last's, never in hub state;
  they run through the first loaded member, which may be another copy's, so they use only the ports
  every hub-v2 member has. The version-skew rule is in `docs/reference.md`. `storage.ts`: storage
  helpers and `processWide`, which only `hub.ts` uses. `json.ts`: readers for untyped JSON.
  `bounded.ts`: the bounded `Set` and `Map` of remembered ids; it imports nothing of the plugin's.
  `version.ts`: the log line on an OpenCode version other than the pinned one.

`test/imports.test.ts` checks these import rules, `tree/store.ts`'s privacy and that no other file
names its key prefixes; `test/store.test.ts` pins the exact keys and values the stores write.
`test/tui.test.tsx` renders the TUI part against a fake TUI context with OpenTUI's `testRender`
(`bunfig.toml` preloads its Solid transform). `test/notices.test.ts` snapshots every `text.ts`,
imported each by its path (the import test fails on one it misses), the skill and the twelve tools'
descriptions and schemas, so a wording change shows up as a diff in `test/__snapshots__/`; update it
with `bun test --update-snapshots`.

`test/`: unit tests against a fake plugin context (`bun test`); `fixtures/reset.ts` clears the
process-wide state between them, `fixtures/events.ts` has the fake ports and events the event-module tests share, and
`fixtures/two-copies.ts` loads two copies of the platform.

`e2e/`: `run.sh` is the live test against a real OpenCode V2 server, driven by `mock-model.mjs`, a
scripted OpenAI-compatible stand-in model, with `search-plugin` as a stand-in web search provider,
`probe-plugin` logging the events each location's instance receives, and `kv.ts` to read, remove or
set the plugin's storage keys in OpenCode's database. New behaviour gets a scenario there.
`tui.sh`, in CI after `run.sh`: the TUI part live, the TUI in `tmux` (CI installs it with `apt-get`),
its footer entry and the RPC behind it, from `dist/` and from the package `opencode plugin add` installs.
`two-servers.sh`, not in CI: two servers on one data directory; its findings are in
`docs/plugin-api-notes.md`. `real-model.sh` (with `real-model.mjs`, `real-model-permission.mjs`,
`real-model-question.mjs` and `real-model-recursive.mjs` for `COURIER_SCENARIO=permission`, `question`
and `recursive`): smoke test with a real model, free on OpenCode Zen by default, not in CI. Re-run it
after any change to `src/**/text.ts`, `src/kernel/protocol.ts`, `src/skill.ts` or a tool description
(in a `src/**/tools.ts`), which is every model-facing string; `docs/real-model.md`
describes it and its results.

`.github/workflows/ci.yml`: both suites on every push to `main` and every pull request (the live one is
`run.sh` then `tui.sh`), and the live suite once more on the `latest` OpenCode release, allowed to fail. Its `sonar` job scans
`src/` on SonarCloud with the unit coverage and fails when the quality gate does: no new bug,
vulnerability or unreviewed hotspot, and at least 80% coverage on new code. `release-start.yml`,
`release-tag.yml` and `release.yml`: the release flow, `docs/releasing.md`.

## Commands

```bash
bun install
bun run typecheck
bun test
bun run build      # dist/: tsc for the server half and rpc, script/build-tui.ts for tui
# live test: install the CLI once, at the version of the pinned plugin API
npm install --prefix <scratch>/oc @opencode/cli@2.0.28
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode npm run test:e2e   # ~2 min, no API key
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/tui.sh         # the TUI part, needs tmux
```

## Rules

- The V2 plugin API is pinned to an exact version, `@opencode/plugin@2.0.28`, as devDependency and
  as peer dependency alike (the peer picks the copy `opencode plugin add` installs next to the
  plugin, which OpenCode 2.0.25 and later replace with their own at load, see
  `docs/plugin-api-notes.md`; a unit test keeps the two equal), and the live test
  installs `@opencode/cli` at that same version. Read the API's types in `node_modules` rather than
  guessing; the OpenCode V2 source is on the `v2` branch of https://github.com/anomalyco/opencode,
  with each release tagged (`v2.0.28`). A pin bump adds a row to README.md's Supported OpenCode
  version table, moves the version README names elsewhere (Quickstart, OpenCode V2 native, the
  install command; a unit test checks them), and adds a section to `docs/plugin-api-notes.md` on
  what changed. It also reads OpenCode's root `package.json` catalog at the new tag for `@opentui/*`
  and `solid-js`, and moves the devDependencies `@opentui/core`, `@opentui/solid`, `solid-js` and
  `@opencode/theme` to its versions; they are never peers (the host provides them to the TUI part,
  and a peer broke `opencode plugin add`; a unit test checks).
- Every tool is registered with `options: { codemode: false }`, returns metadata without
  `undefined` values, and rethrows failures through `describeFailure`.
- Behaviour changes come with unit tests and an e2e scenario, and update README.md and
  `docs/reference.md`.
- Feature work goes on a branch and through a PR with green CI; `Closes #N` in the body.
- Code comments and TSDoc only where the code cannot say it itself, and at most two lines each.
- Running several issues at once in child sessions: the `courier-wave` skill.
