# CLAUDE.md

opencode-courier is an OpenCode V2 plugin that lets sessions spawn, message and wake each other
without polling. README.md is the user-facing reference and `docs/reference.md` the long form of the
behaviour; read both, and `docs/maintainers/plugin-api-notes.md`, before changing the plugin. The
maintainer docs are in `docs/maintainers/`: `development.md` (commands, suites, CI), `architecture.md`
(layout, import rules, storage keys, the hub and its version skew), `plugin-api-notes.md` (the host's
traps), `real-model.md` and `releasing.md`.

## Layout

`src/` is split into modules by feature, hexagonal inside. `docs/maintainers/architecture.md` has the
import rules and the reasons for them.

`src/`:

- `index.ts`: the plugin, an Effect plugin running the promise one, and the composition root. Builds
  the ports, adds the tools in a fixed order (`addTreeTools`, `addPersonTools`, `addSchedulingTools`,
  `addWebhookTools`, `addMemoryTools`), hands the platform the ordered tick jobs (`dueJob`,
  `deliverReleased`, then `wakeMissed`) and event modules (`treeEvents`, `personEvents`, then
  `memoryEvents`), composes the `Waits` port from its suppliers, wires `courier_stop` to
  `scheduling/`'s `cancelScheduled`, and starts the webhook receiver; the Effect half wraps the
  question tool and binds it to its instance's member in the hub. The only file that imports more
  than one module's `index.ts`; nothing imports it.
- `skill.ts`: the `courier-orchestrate` skill and its text; it imports only `kernel/`.
- `tui.tsx`: the package's `tui` entrypoint, a second composition root, adding each module's TUI part
  (`addAsksInbox`, `tree/tui.tsx`'s `CHANGES`, then `addTreeStatus`, `addTreePanel`, `addTreeAttention`
  and `addMemoryView`); it imports only `@opencode/plugin/tui` and the modules' `tui.tsx` and `rpc.ts`.
  Bundled alone to `dist/tui.js` by `script/build-tui.ts`; `tsconfig.build.json` leaves the `tui.tsx`
  files out and `tsconfig.tui.json` writes `dist/tui.d.ts`. `rpc.ts`: the `rpc` entrypoint, the
  modules' RPC contracts (`treeRpc`, `personRpc`, `memoryRpc`). Neither is imported by the server half.
- `kernel/protocol.ts`: what the models see of the protocol in every module: `envelope`, `END_TURN`,
  `clipText`, `clipWords`, `defuse`, `describeFailure`, `Status`, `SPLIT_LINE` and `SKILL_ID`. It
  imports only `kernel/**` and `platform/json.ts`. `kernel/tool.ts`: `ToolEditor` and `rethrow` for
  the `tools.ts` files.
- The modules, `tree/`, `person/`, `scheduling/`, `webhook/` and `memory/`, each a folder imported from
  outside through its `index.ts` only. The only dependencies between them are `person/`'s and
  `memory/`'s on `tree/`; each may import `platform/**` and `kernel/**`. Each has a `text.ts` with its
  model-facing strings, as pure functions, which imports only `kernel/**`, `platform/json.ts` and its
  own module's `ports.ts` and `domain.ts`, and a `tools.ts` adding its tools.
- `tree/`: the session tree. `ports.ts` its ports and data types (`CourierPorts`, `WatchPorts`, `Waits`,
  `ChildStore`, `GroupStore`, `Pending`, `CleanupResult`, …); `domain.ts` its pure rules (`readLimits`,
  `busy`, `lineageIn`, `standingOf`, `complete`, `isGroupName`, …), importing nothing of the plugin's
  but `kernel/**` and `platform/json.ts`; `text.ts` the child brief, the role part, the refusals, the
  report body, the notices and the tool results. `store.ts` is the only file that knows the storage
  keys and layouts of `roster/`, `roster-by-child/`, `report/`, `group/` and `wake/`: `childStore`,
  `groupStore` and `wakeStore`, built inside `tree/`; no file outside `tree/` imports it. `forget.ts`
  is the one cleanup service (`forgetChild`, which drops the child's group membership too, best
  effort, `forgetDropped`, expired entries, `forgetDeleted`, `forgetReports`); taking back a write
  just made (`send.ts`, `spawn.ts`) and dropping a delivered group (`group.ts`) stay with their use
  case. One file per use case: `spawn.ts`, `send.ts`, `status.ts` (`courier_status`,
  `courier_children`), `subtree.ts` (`courier_tree`), `stop.ts` (`courier_stop`), `cleanup.ts`.
  `limits.ts` the limits `spawn()` checks; `report.ts` whether each spawned session owes a report;
  `group.ts` join groups (joining, holding, leaving, standing, `deliverReleased`); `roster.ts` the
  retention of each parent's children (`current`, `pruneExpired`) and the lineage queries `person/` and
  `memory/` read (`lineage`, `allEntries`, `answeringTop`, `indexedLineage`, `childrenOf`,
  `reportState`). `tools.ts` the seven tree tools (`addTreeTools`); `rpc.ts` the tree's RPC contract
  (`treeRpc`), importing only `@opencode/plugin/rpc` and `effect`; `rpc-handlers.ts` its server side
  (`registerTreeRpc`, called from `src/index.ts` after the tools): `summary` from `summary.ts`, `tree`
  from `panel.ts` (the tree panel's rows), `stop` from `stop.ts`, `cleanup` from `cleanup.ts`, run as
  the target's parent once `by` is above it. `tui.tsx` the TUI part: the footer's status entry
  (`addTreeStatus`), the tree panel with one timer for what moves in it (`addTreePanel`, whose further
  verbs such as `memory` `src/tui.tsx` hands it as `Verb`s) and the report sounds (`addTreeAttention`);
  it imports only `@opencode/plugin/tui`, `solid-js`, `@opentui/*`, `rpc.ts`, `text.ts` and
  `mascot.ts`. `mascot.ts` Digby, the panel's mole: his frames as pixel tokens, pure and importing
  nothing, snapshotted in `test/__snapshots__/tui.test.tsx.snap`. `wake.ts` the missed wake
  (`watchWake`, `wakeMissed`, `stalledAmong`); `events.ts` `treeEvents`, with `waitsOn` and `together`
  to compose the `Waits` port; `context.ts` the `context` hook naming each spawned session's role and
  hiding `courier_spawn` and the tools `hiddenFromLeaf` names from a leaf.
- `person/`: what a spawned session needs the person for. `permission.ts` passes a permission answer
  back (`answer`: a proposed `once` first goes through OpenCode's `permission.assert` in the caller's
  session; `isDeclined` tells the plain rejection the tool rethrows), lists pending requests
  (`pendingOf`) and supplies `asksPermission` to `Waits`; `form.ts` the forms OpenCode shows in a
  spawned session, their notices and `formsShown`, the tree's `forms` port; `events.ts` `personEvents`
  (permission asked and replied, forms created and settled, `relayPending` on every (re)subscribe, and
  the signals to the question relay); `ports.ts` `PersonPorts`, `PersonState` and `Form`; `tools.ts`
  `courier_answer`; `text.ts` the permission, form and question notices and `REJECTED`. `rpc.ts` the
  person's RPC contract (`personRpc`, id `courier-person`: `asks`, `answer`), `rpc-handlers.ts` its
  server side (`registerPersonRpc`, after the tree's); `tui.tsx` the asks inbox (`addAsksInbox`), which
  answers permissions and forms through the TUI's own client. `tree/ports.ts` declares the question
  shape its `Pending` needs (`PendingPrompt`), and `index.ts` checks `Prompt` against it at compile time.
  `person/question/`: relaying a child's question by wrapping OpenCode's `question` tool. `index.ts` is
  what the rest of `person/` imports; `relay.ts` wraps the tool; `answer.ts` passes an answer on;
  `lifecycle.ts` takes the signals from `person/events.ts` and `src/index.ts`; `shared.ts` the hub's
  question state, its storage keys and `portsAt`; `types.ts` the relay's types; `pure.ts` the pure
  parts; `runtime.ts` the copy's own Effect runtime and clock, which tests swap for a `TestClock`.
  Inside the folder the relay is Effect code; what it exports stays promises and plain functions.
- `scheduling/`: scheduled messages. `later.ts` stores and delivers them (`deliverDue`), cancels a
  session's for `courier_stop` (`cancelScheduled`) and supplies `isScheduled` to `Waits`; `tools.ts`
  adds `courier_later` and `courier_cancel`; `text.ts` their result texts. It exports `dueJob`, its
  tick job.
- `webhook/`: `receiver.ts` the HTTP server, the signature check, dispatch and the process-wide
  receiver (`joinReceiver`, under the hub's `receiver` key); `subscriptions.ts` the subscription store
  and topics; `tools.ts` `courier_subscribe` and `courier_unsubscribe`; `text.ts` their texts and the
  delivery summaries. It exports `subscribedSince`, its `Waits` supplier.
- `memory/`: one record per session tree, under `memory/<projectID>/<topSessionID>`, and its lesson; beside
  it, each key with one writer, the person's pin (`…/pin`) and each reader tree's reads (`…/reads/<readerTop>`),
  which the store merges in as `pinned` and `reads` and never writes with the record.
  `domain.ts` the record's shape (`TreeRecord`, `PartRecord`, `PartStatus`, `Lesson`, `Revision`, `Reads`, `Pinned`), the
  `memory` option (`readMemory`), `partStatus`, `isSettled`, what a part whose session cannot be read keeps
  (`unreadPart`), the split line (`splitOf`: a stated line, `isStated`, outranks a mention once), its append-only
  revisions (`revise`, and `replacingMention` for a record written before the rule) and how the listing shows it
  (`splitProse`), `oneLine`, `lessonText`
  (clips a hand-written record's lesson at `LESSON_MAX`, which `courier_note` refuses instead), the
  merge that keeps parts the roster forgot, the reads (`noteRead`, `sumReads`), the listing order
  (`pinnedFirst`) and the retention (`keep`: the pinned outside both bounds, then lesson-bearing records
  first); `ports.ts` `RefreshPorts` (what
  every hub-v2 member's watch ports have), `MemoryPorts` and `MemoryState` (process-wide); `store.ts`
  the only file that knows the keys and layout, reading a hand-written record leniently; `record.ts` the
  refresh (`refresh`);
  `events.ts` `memoryEvents`, which refreshes a tree's record in the `after` phase of each turn end in
  it; `recall.ts` `courier_recall`'s logic, which counts the listing or the read on each other tree's
  record, best effort; `note.ts` `courier_note`'s; `forget.ts` the memory view's
  forget; `pin.ts` its pin; `sweep.ts` the sweep at load, strays included; `tools.ts` adds `courier_recall` and `courier_note`; `text.ts`
  the listing line and the tools' texts. `rpc.ts` the memory's RPC contract (`memoryRpc`, id
  `courier-memory`: `records`, `forget`, `pin`), `rpc-handlers.ts` its server side (`registerMemoryRpc`, after
  the person's); `tui.tsx` the memory view (`addMemoryView`), a `select` dialog, which imports only its
  `rpc.ts` and `text.ts`.
- `platform/`: imports nothing outside `platform/`. `hub.ts`: the plugin's process-wide state in one
  versioned hub, which instances join with their ports and location and leave on unload, and the
  scheduler's loop, run once per hub and by one server per data directory (the owner key
  `scheduler/owner`). It types only what it owns: a member's feature ports and state are opaque to it,
  typed by their owners through `sharedState`. `events.ts`: following OpenCode's events (subscribing,
  resubscribing after `RESUBSCRIBE_MS`, the hub's two watchers through `watchFromHub`), running each
  event through the event modules by phase: `handle` in list order, then `after` in a `finally`;
  `followed` and `left` around each subscription, `subscribed` alongside it. Tick jobs
  (`open(registry, jobs)`) and event modules (`watchFromHub(hub, modules)`) are registered by
  `src/index.ts` and live in the closures the hub runs, the copy loaded last's, never in hub state;
  they run through the first loaded member, which may be another copy's, so they use only the ports
  every hub-v2 member has. `storage.ts`: storage helpers and `processWide`, which only `hub.ts` uses.
  `json.ts`: readers for untyped JSON. `bounded.ts`: the bounded `Set` and `Map` of remembered ids.
  `version.ts`: the log line on an OpenCode version other than the pinned one.

`test/`: unit tests against a fake plugin context (`bun test`); `fixtures/reset.ts` clears the
process-wide state between them, `fixtures/events.ts` has the fake ports and events the event-module
tests share, and `fixtures/two-copies.ts` loads two copies of the platform. `imports.test.ts` checks
the import rules above, `tree/store.ts`'s and `memory/store.ts`'s privacy and that no other file names
their key prefixes; `store.test.ts` pins the exact keys and values the stores write;
`e2e-shards.test.ts` checks that every live-suite group is in exactly one shard of any count;
`links.test.ts` resolves every relative Markdown link and `#anchor` in README.md, CLAUDE.md, `docs/**`
and `.claude/**`. `tui.test.tsx`, `inbox.test.tsx` and `memory-view.test.tsx` render the TUI parts
against a fake TUI context with OpenTUI's `testRender` (`bunfig.toml` preloads its Solid transform);
`person-rpc.test.ts` and `memory-rpc.test.ts` their RPCs. `notices.test.ts` snapshots every `text.ts`,
the skill and the fourteen tools' descriptions and schemas, so a wording change shows up as a diff in
`test/__snapshots__/`; update it with `bun test --update-snapshots`.

`e2e/`: `run.sh` is the live test against a real OpenCode V2 server, in groups of scenarios that
`E2E_SHARD=k/n` deals out to shards, driven by `mock-model.mjs`, a scripted OpenAI-compatible stand-in
model, with `search-plugin` as a stand-in web search provider, `probe-plugin` logging the events each
location's instance receives, and `kv.ts` to read, remove or set the plugin's storage keys. New
behaviour gets a scenario there. `tui.sh`, a CI job next to `run.sh`: the TUI part live in `tmux`.
`two-servers.sh`, not in CI: two servers on one data directory. `real-model.sh` (with `real-model.mjs`,
`real-model-permission.mjs`, `real-model-question.mjs` and `real-model-recursive.mjs` for
`COURIER_SCENARIO=permission`, `question` and `recursive`): smoke test with a real model, not in CI.
Re-run it after any change to `src/**/text.ts`, `src/kernel/protocol.ts`, `src/skill.ts` or a tool
description (in a `src/**/tools.ts`), which is every model-facing string; `docs/maintainers/real-model.md`
describes it and holds a results table per scenario, which a re-run updates.

`.github/workflows/ci.yml`: both suites on every push to `main` and every pull request: `run.sh` in
four shards and `tui.sh` in parallel, all skipped on a pull request that changes only documentation.
The required `Live test against OpenCode V2` job is the gate over them and passes with all of them
skipped. Its `sonar` job scans `src/` on SonarCloud and fails when the quality gate does. Its unit job
also runs `bun script/compat-table.ts --check`. `latest.yml`: the live suite on the `latest` OpenCode
release, on pushes to `main` and nightly, allowed to fail, and one issue for a release newer than the
pin. `release-start.yml`, `release-tag.yml` and `release.yml`: the release flow,
`docs/maintainers/releasing.md`.

## Commands

```bash
bun install
bun run typecheck
bun test
bun run build      # dist/: tsc for the server half and rpc, script/build-tui.ts for tui
bun script/compat-table.ts --check   # the version tables against the release tags (git fetch --tags)
# live test: install the CLI once, at the version of the pinned plugin API
npm install --prefix <scratch>/oc @opencode/cli@2.0.32
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode npm run test:e2e   # every scenario in one run, no API key; E2E_SHARD=k/n for a part
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/tui.sh         # the TUI part, needs tmux
```

## Rules

- The V2 plugin API is pinned to an exact version, `@opencode/plugin@2.0.32`, as devDependency and
  as peer dependency alike (the peer picks the copy `opencode plugin add` installs next to the
  plugin, which OpenCode 2.0.25 and later replace with their own at load, see
  `docs/maintainers/plugin-api-notes.md`; a unit test keeps the two equal; the exact `effect` peer and
  devDependency move with it, to the `effect` the new `@opencode/plugin` depends on), and the live
  test installs `@opencode/cli` at that same version. Read the API's types in `node_modules` rather than
  guessing; the OpenCode V2 source is on the `v2` branch of https://github.com/anomalyco/opencode,
  with each release tagged (`v2.0.32`). The Supported OpenCode version tables, README.md's
  newest three rows and `docs/reference.md`'s all, are generated from the release tags by
  `script/compat-table.ts`, which Start a release runs and CI checks: never edit them by hand. A pin
  bump, asked for by the issue `latest.yml` opens for a new OpenCode release, moves the version README
  names (Quickstart, OpenCode V2 native, the install command, the terminal part's line under the
  table; a unit test checks the first three), is followed by a patch release, and updates the affected
  traps in `docs/maintainers/plugin-api-notes.md` and the version they are current at; that file has no
  per-version sections. It also reads OpenCode's root `package.json` catalog at the new tag for
  `@opentui/*` and `solid-js`, and moves the devDependencies `@opentui/core`, `@opentui/solid`,
  `solid-js` and `@opencode/theme` to its versions; they are never peers (the host provides them to the
  TUI part, and a peer broke `opencode plugin add`; a unit test checks).
- Every tool is registered with `options: { codemode: false }`, returns metadata without
  `undefined` values, and rethrows failures through `describeFailure`, except the plain permission
  decline `courier_answer` rethrows as it is, which ends the step as OpenCode's own tools do (the
  reasons: `docs/maintainers/plugin-api-notes.md`, Tools).
- Behaviour changes come with unit tests and an e2e scenario, and update README.md and
  `docs/reference.md`.
- Feature work goes on a branch and through a PR with green CI; `Closes #N` in the body.
- Code comments and TSDoc only where the code cannot say it itself, and at most two lines each.
- Running several issues at once in child sessions: the `courier-wave` skill.
