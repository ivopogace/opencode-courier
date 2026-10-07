# Architecture for agent plugins, and where opencode-courier stands

A research note, not a change: it compares architecture styles for plugins that run inside an
agent host, using OpenCode V2 plugins as the case and other plugin ecosystems as evidence, assesses
this repository against them, and recommends a target with a migration plan in PR-sized steps.
Everything about this repository was read at `8265297` (0.2.2, pinned to `@opencode/plugin@2.0.24`);
everything about OpenCode was read from the type packages in `node_modules` and from the source at
the `v2.0.24` tag. Sources are listed at the end, with the numbers used in the text, such as [S1].

**In short.** Keep the hexagonal shape the plugin already has (ports passed as arguments, fakes in
unit tests, a live e2e against a real host) and its functional core (notices, routing, parsing and
lineage are already mostly pure). Change two things. First, the state the plugin shares across its
per-location instances lives today under six separate `processWide` keys, worked on by every
instance at once and kept consistent with claim sets; give it one versioned owner, a process-wide
**hub** that instances join and leave, and let that hub run each process-wide job (scheduler, event
watcher, webhook receiver) **once**, as the webhook receiver already does. Second, use Effect where
the plugin already needs it, and only there: the question relay's hand-rolled promises, resolvers,
timers and per-key locks become an Effect island with `Deferred`, `Semaphore`, `Scope` and
`TestClock`; the rest stays promise code on ports. Do not go Effect-native everywhere, and do not
move the work out of process into an MCP server or a daemon. The detail is in
[the recommendation](#4-recommendation).

## 1. The forces

What makes a plugin inside an agent host different from an ordinary library or service. Each force
is stated with what it is in OpenCode V2 at 2.0.24, since that is what the styles below must handle.

**F1. Several instances per process.** OpenCode builds a plugin supervisor per *location* (a
project directory or a worktree): `packages/core/src/plugin/supervisor.ts` ends with
`makeLocationNode({ name: "plugin-supervisor", ... })`, and `InstancePlugins` says outright that
"two instances in one process can carry different plugins". So the plugin's `setup` runs once per
location the server has opened, all in one Bun process. A module is imported with a plain dynamic
`import()` (`Host.load` in `plugin/module.ts`), so instances loaded from the same file share
module-level variables, but an update installs the package into a new timestamped directory
(`~/.cache/opencode/npm/opencode-courier@latest/<timestamp>/`, see `docs/plugin-api-notes.md`), and
a reload of that copy is a second module with its own module state, alongside the first until it
unloads. Process-wide state therefore needs a key outside the module graph (`globalThis`,
`Symbol.for`), and must tolerate an *older* copy of the plugin reading and writing it. JetBrains has
the same shape: an application-level service is one instance per process, a project-level one is
"a separate instance for each" project [S20]. VS Code's extension host is the counter-example,
activating each extension once per host [S12].

**F2. Every instance sees every event.** `event.subscribe()` hands each instance the server's
events, not just its location's (documented for `form.created` in `docs/plugin-api-notes.md`, and
relied on by `eventsFollowed` in `src/question.ts`). N instances means N handlers per event unless
something deduplicates, and nothing in the host does.

**F3. No atomic storage.** The plugin's `storage` is `get`, `set`, `remove` and `scan` over a
namespace of OpenCode's global SQLite key-value table (`storage()` in `plugin/host.ts`, over
`kv.ts`, a `makeGlobalNode`). There is no compare-and-set, no transaction and no lease. Shared
across locations by construction, and shared by any second OpenCode process on the same data
directory. A claim made in storage is therefore not a claim; only in-process memory can arbitrate,
and only within one process.

**F4. Tools are read by a model.** A tool's name, description, input schema and result text are
the plugin's user interface, and the user is a nondeterministic model. Small wording changes move
behaviour (this repository tuned "end your turn by replying without calling more tools" against
real models, `docs/real-model.md`). The host adds its own constraints: tools need
`options: { codemode: false }` to be called directly, `undefined` in metadata hangs a call, and the
host decodes input with its own copy of `effect`, which drops the plugin's schema refinements.
Anthropic's guidance on writing tools for agents makes the same point from the other side:
write descriptions as for a new hire, return high-signal text, make errors actionable, and
develop the wording against evals of realistic tasks [S8]; "Building effective agents" calls it
the agent-computer interface and asks for it to be made hard to misuse [S7].

**F5. Long-lived async work.** A plugin here is not request/response. Courier runs a 15 s
scheduler, a reconnecting event stream, an HTTP listener on a fixed port, timers that hold a
dismissal for 2 s or a cut-off notice for 30 s, and tool calls that wait indefinitely for a form.
All of it must stop on unload (a reload, a location closing, a server shutdown), and some of it
must hand over to a surviving instance.

**F6. Host API churn.** OpenCode V2 went GA on 2026-09-12 and released 2.0.22, 2.0.23 and 2.0.24
within five days; the plugin API's `effect` is a release candidate (`4.0.0-rc.112`), and the two
copies of `effect` (host's and plugin's) must compose. The peer dependency is not enforced by the
host (`docs/plugin-api-notes.md`). Each bump needs reading the types and running the live suite.

**F7. Testing with a nondeterministic model.** The behaviour that matters most (does the parent
end its turn, does a child report) happens only with a model in the loop. Unit tests cannot see
it; a real model is slow, costs money or quota, and flakes: at 75% per trial, three passes in a
row happen 42% of the time (pass^k, [S24]). The usual tiers are a scripted stand-in model (AI SDK's
`MockLanguageModel`, Inspect's `mockllm`) [S23, S24], recorded HTTP replayed from cassettes [S25],
and evals with a real model graded on outcomes.

## 2. Candidate styles

For each: the idea, how it meets F1 to F7, and where it is used.

### 2.1 Ports and adapters (hexagonal)

The application core talks to the outside world only through interfaces it owns (ports); the host
API, the HTTP server, git and the clock are adapters plugged into them [S15]. In a plugin, the
host's context object is the main adapter, and a port is a narrow `Pick<>` of it.

- F1/F2/F3: says nothing about them on its own; shared state and deduplication are left to the
  core. F4: tool definitions are the *driving* adapter and can be kept apart from the core.
  F5: lifecycle sits in the composition root. F6: churn is absorbed in the adapter, as
  `CourierPorts.projectID` absorbed the `worktree.create` change at 2.0.22. F7: the main win;
  the core runs against fakes.
- Seen in: VS Code extensions, which receive their whole world through `vscode` and
  `ExtensionContext` and are tested by swapping it [S12, S13]; MCP's split of host, client and
  server [S5]; JetBrains services [S20].

### 2.2 Functional core, imperative shell

Decisions are pure functions of data (what to say, whom to wake, whether a delivery is valid);
the shell does the I/O and calls them [S16]. It pairs with 2.1: the core has no ports at all, the
shell has them.

- F4: model-facing text becomes plain functions that can be snapshot-tested. F7: most logic is
  tested without fakes or time. F1 to F3 and F5 remain the shell's problem, which is honest: they
  *are* imperative problems.
- Seen in: Zed's extensions, compiled to WebAssembly and allowed only the host calls their granted
  capabilities permit, which pushes them towards pure code over host-provided input [S21]; the AI
  SDK's tools, which take their shared runtime context as a validated argument rather than reading
  globals [S23].

### 2.3 Effect-native services and layers

Everything is an `Effect`: host domains are services, the plugin's parts are `Layer`s, lifetimes are
`Scope`s with finalizers, concurrency uses fibers, `Deferred`, `Queue`, `Semaphore`, and tests
supply test layers and `TestClock` [S9, S10, S11]. OpenCode's own core is written this way, and
the Effect plugin API hands a plugin `Effect<void, never, Scope>` (`effect/plugin.d.ts`), run in a
child scope forked per activation, so a plugin's finalizers run on unload; the plugin API's own
design notes consume events as a `Stream` forked into that scope (`Stream.runForEach` with
`Effect.forkScoped`) [S2].

- F5: the strongest answer of any style. Interruption is structured: a fiber racing a host tool's
  `execute` can be stopped, which a promise cannot (this is why the question relay is an Effect
  plugin at all). Timers become `Effect.sleep` under `TestClock`. F2/F3: `Semaphore`, `Ref` and
  `SynchronizedRef` give clean in-process arbitration. F7: layers make fakes cheap.
- Against it, here: F6. The plugin's `effect` must be exactly the host's release candidate, and
  schema features from the plugin's copy already fail in the host's decoder. Every line of
  Effect code is a line that a host bump of `effect` can break, and Effect 4 is not final. It also
  raises the bar for contributors, and the unit suite (262 tests over promise ports) would be
  rewritten for no behaviour gained.
- Seen in: OpenCode V2 core and its built-in plugins (`packages/core/src/plugin/*`); Effect's own
  guidance for embedding in a non-Effect host is `ManagedRuntime`, which is what the promise
  adapter `fromPromise` does in reverse [S10].

### 2.4 Single owner per resource (actor-style), with or without event sourcing

Each resource (the scheduler, the event stream, a question, the HTTP port) has exactly one owner,
which serialises everything that touches it; others send it messages. This is the single-writer
principle [S17] and the actor model; event sourcing goes further and stores the messages as the
source of truth [S18].

- F1/F2: the direct answer. N instances do not each run the scheduler or handle each event; one
  owner does, and instances register with it. F3: in one process, the owner's memory is the
  arbitration that storage cannot give. F5: the owner holds the timers and stops them once.
- Event sourcing proper does not fit: storage has no append-only log or atomic append (F3), the
  host's form events are ephemeral and never stored (`docs/plugin-api-notes.md`), and the persisted
  state (roster, scheduled messages, questions, subscriptions) is small records, not histories.
- Seen in: courier's own webhook receiver (`joinReceiver` in `src/index.ts`: first instance starts
  the listener, the last to leave stops it, requests use any live instance's ports); Cline's
  `McpHub`, one object owning every MCP connection, settings watcher and refresh timer [S22];
  JetBrains application-level services, one per process and disposed with it [S20].
- A cautionary contrast: oh-my-opencode's `BackgroundManager` tracks background agents in one
  3.2k-line in-memory class and decides completion from a `session.idle` event *plus* 3 s polling
  with a 10 s stability window, which its own notes call the production hotspot [S19]. A single
  owner does not by itself make the design simple; courier's wake-by-message avoids that polling.

### 2.5 Thin plugin over an MCP server or a separate daemon

The work lives in a separate process (an MCP server, or a daemon with its own API); the in-host part
is a shim. Claude Code is built this way: a command hook is a process per event with JSON on stdin
and its exit code as the verdict, hooks keep no state between runs, and a plugin's long-lived work
is an MCP server, an LSP server or a monitor process the host supervises, with state under
`${CLAUDE_PLUGIN_DATA}` because the plugin's root directory changes on every update [S3, S4, S5].

- F1/F2/F3: solved by moving state into one process with its own storage. F6: the protocol is more
  stable than an in-process API. F7: the server can be tested on its own.
- Against it, here: what courier does is reach *into* the host. It wraps OpenCode's own `question`
  tool and races its `execute`; it calls `session.synthetic` to wake a session; it answers a
  permission request through the instance of the location that holds it; it follows the event bus.
  MCP gives a server none of these: an MCP tool cannot wrap a host tool, wake a session or see the
  host's events [S5, S6]. A daemon could reach them only over OpenCode's HTTP API, which the
  e2e uses but which has its own churn (routes moved at 2.0.22), and would add a second process
  to install, start, secure and version. The webhook receiver is the one part that looks
  daemon-shaped, and it already runs in-process for want of an HTTP route in the plugin API.
- Seen in: Claude Code plugins (hooks, MCP servers, monitors, subagents bundled) [S3, S4]; Cline,
  which extends through MCP [S22]; OpenCode itself supports MCP servers next to plugins.

### 2.6 Plain modules with dependency injection by argument

No framework: modules export functions that take their dependencies as the first argument. This is
the cheapest form of 2.1, and what the repository mostly is.

- Strong on F7 and readability. Silent on F1, F2 and F5: nothing stops each module from keeping
  its own globals and its own timers, which is how the shared state in this repository spread.
- Seen in: OpenCode V1 plugins, a function of `{ project, directory, worktree, client, $ }`
  returning hooks, with no lifecycle or teardown in the docs [S1]; Vercel AI SDK and LangChain
  tools, plain objects or decorated functions with an `execute` [S23]; Neovim's Lua plugins, plain
  modules `require`d lazily [S21].

### 2.7 How the styles compare on the forces

| | F1 instances | F2 events | F3 storage | F4 model-facing | F5 async lifetime | F6 churn | F7 testing |
|---|---|---|---|---|---|---|---|
| Ports and adapters | – | – | – | ✓ adapters apart | ~ composition root | ✓ | ✓ |
| Functional core | – | – | – | ✓ snapshot text | – | ✓ | ✓✓ |
| Effect-native | ~ | ✓ | ✓ in-process | – | ✓✓ | ✗ rc coupling | ✓ |
| Single owner | ✓✓ | ✓✓ | ✓ in-process | – | ✓ | – | ✓ |
| MCP/daemon | ✓✓ | ✓ | ✓ own store | ✓ | ✓ | ✓ | ✓ |
| ...but | | | | | | | ✗ cannot wrap tools, wake sessions or follow the bus |
| Plain modules + DI | ✗ | ✗ | ✗ | ~ | ✗ | ✓ | ✓ |

No single style covers the forces; the combination that does, without the MCP style's
disqualifier, is ports and adapters at the host boundary, a functional core for decisions and text,
a single owner per process-wide resource, and Effect where interruption and timing are the problem.

## 3. Assessment of this repository

### What already fits

- **Ports by argument.** Every module takes a narrow `Pick<>` of the context: `CourierPorts`,
  `LaterPorts`, `WatchPorts`, `QuestionPorts`, `WebhookPorts`, `CleanupPorts`, `AnswerPorts`. Git is
  a port (`head`, `inspect`), so is the clock (`now`) and id generation (`newID`). This is why 262
  unit tests run in 7 s against a fake context (`test/plugin.test.ts`, `setUp`).
- **A functional core already exists.** Notices are pure (`permissionNotice`, `formNotice`,
  `settledNotice` in `src/relay.ts`, `failureNotice` in `src/watch.ts`, `questionNotice` in
  `src/question.ts`, `childBrief` and `envelope` in `src/courier.ts`); so are `parseTopic`,
  `githubEvent`, `checkSignature`, `readConfig` (`src/webhook.ts`), `fireTime` (`src/later.ts`),
  `lineageIn` (`src/roster.ts`), `keepReason` (`src/cleanup.ts`), `versionNotice`
  (`src/version.ts`).
- **One single owner already exists.** The webhook receiver (`startReceiver`, `joinReceiver` in
  `src/index.ts`) is a ref-counted, process-wide owner that instances join and leave, that waits
  for its predecessor to close before binding, and that serves requests with any live instance's
  ports. It is the pattern the rest should follow.
- **The Effect boundary is where it must be.** The default export is an Effect plugin because
  only the Effect API hands out the question tool's `execute` as an interruptible Effect
  (`relayQuestions`, `asking`, `linking` in `src/question.ts`); everything else runs through the
  host's own `fromPromise` adapter, which is how OpenCode runs every promise plugin. The host
  rules are encoded once: `describeFailure`, `withoutUndefined`, `codemode: false`.
- **Testing in layers against F7.** A fake context for logic, a live server with a scripted
  OpenAI-compatible model (`e2e/mock-model.mjs`) for integration, deterministic and keyless in CI,
  a pinned-host leg and an allowed-to-fail `latest` leg for F6, and an out-of-CI real-model smoke
  test (`e2e/real-model.sh`) for F4. This is the scripted tier of what agent teams
  recommend, plus a small real-model check for wording [S8, S24]. One tier is missing: recorded
  real-model exchanges replayed in CI [S25], which would catch a tool description change that a
  scripted model, keyed on markers, cannot. Worth considering, not part of this plan.
- **F6 is handled as a process.** The exact pin, a unit test keeping peer and dev dependency
  equal, a section per bump in `docs/plugin-api-notes.md`, and a load-time version notice
  (`src/version.ts`).

### Where it fights its own structure

1. **Six process-wide keys, no owner.** `processWide` is called for `opencode-courier.receiver`,
   `.claimed`, `.watched`, `.forms`, `.locations` (all `src/index.ts`) and `.questions`
   (`src/question.ts`). Each is an ad-hoc schema; `.forms` exists separately only because an
   older copy loaded first would not have made it, and `.questions` is filled field by field
   (`sharedState.questions ??= new Map()` and nine more) for the same reason. There is no version
   on any key, so a newer copy cannot tell that an older copy with different semantics is writing
   the same `Set`. Tests reset this state by hand (`forgetQuestions`), and `timing` is a mutable
   exported object the tests overwrite.
2. **Every instance runs every loop.** Each `setup` starts its own scheduler (`setInterval(tick,
   TICK_MS)`), its own `watchChildren` subscription, its own `pruneExpired` and `noticeCutOff`.
   With N locations open, `deliverDue` scans `later/` N times per 15 s, every event is handled N
   times and dropped N−1 times by `claim(state.seen, event.id)`, and `relayPending` lists every
   roster session's permissions N times on each (re)subscribe. Correctness rests on claim sets
   (`claimed`, `seen`, `waiting`, `answered`, `forms.told`), each with its own comment on why the
   claim is taken *after* an await and not before. It works, and the e2e proves it, but it is the
   receiver's single-owner problem solved a second way, by consensus instead of ownership.
3. **Per-event full scans.** `entriesOf` and `lineage` (`src/roster.ts`) scan the whole `roster/`
   prefix to find one session; `reportFailure`, `reportAsked`, `reportForm` and the question
   relay's `asking` call them per event or per call, times N instances.
4. **Hand-rolled concurrency inside an Effect island.** `src/question.ts` (951 lines) races the
   host's `execute` with `Effect.raceFirst`, but around it manages promises with exported
   resolvers (`let answered!`, `let accept!`, `shared.shown` holding resolve functions), a
   per-question lock with a timeout built from a `Map` of promises and a `setTimeout`
   (`deliver`), a timeout helper (`within`), a waiter set woken by shutdowns (`closingSoon`,
   `closingWaiters`) and a delayed notice (`tellLater`). These are `Deferred`, `Semaphore`,
   `Effect.timeout` and a scoped fiber in Effect, testable with `TestClock`; as written they read
   `Date.now()` directly (`locationClosing`, `closingSoon`, `deliver`), bypassing `ports.now`, so
   their tests run on wall-clock time with shortened `timing` values.
5. **The promise/Effect seam is a mutable slot.** `courier(relay: RelaySlot)` writes
   `relay.ports = questionPorts` inside the promise `setup`, and the Effect side reads it through
   `() => relay.ports`. The two halves of one plugin share a hidden variable instead of a value
   passed at construction, and `relay.ports` and `shared.loaded` are two registries of the same
   thing.
6. **`index.ts` is composition root, tool catalogue and lifecycle at once.** `setup` is one
   ~330-line closure holding port construction, ten tool definitions with their descriptions and
   result text, the `answerRequest` dispatch, the scheduler loop, the watcher and the receiver.
   Model-facing text (F4) is spread over `index.ts` (descriptions, results), `courier.ts`
   (`childBrief`, `END_TURN`), `relay.ts`, `watch.ts`, `question.ts` and `webhook.ts` (notices),
   with no single place to review it, though CLAUDE.md asks for a real-model rerun whenever it
   changes.
7. **Module cycles and duplicates.** `courier.ts` imports `Prompt` from `question.ts`, which
   imports `END_TURN` and `envelope` from `courier.ts`; `watch.ts` calls five functions of
   `question.ts` that act on its process-wide state (`formShown`, `locationClosing`,
   `eventsFollowed`, `eventsLeft`, `formsMayHaveBeenMissed`). There are two `claim` functions
   (`watch.ts`, `question.ts`), two `clip`s (`relay.ts`, `webhook.ts`) and three bounded
   collections (`claim`, `remember`, `Seen`).
8. **Fire-and-forget work outlives its instance.** `void pruneExpired(...)`, `void noticeCutOff(...)`,
   `void tick()` and `void watchChildren(...)` are not awaited on unload; the cleanup aborts the
   watcher and clears the interval, but a tick or a prune in flight finishes against a context
   whose location may be closing.

### Risks

- **Version skew in one process (F1).** Two copies of the plugin can run side by side after an
  update until the old one unloads. Both see the same `processWide` objects, with no version check.
  Any change to a shared structure's meaning is a latent bug that no test covers, since every test
  loads one copy. This is the highest architectural risk.
- **Cross-process duplicates (F3).** Claim sets are per process. Two OpenCode servers on one data
  directory (a `opencode service` and a second `opencode serve`, say) share the KV table but not the
  claims, so both schedulers can deliver the same `courier_later` message, and both watchers relay
  the same request. Not verified in this study; worth one experiment, and at least a line in
  `docs/reference.md`. Storage offers no lease, so the fix would be best effort (an owner key with
  an expiry), not a guarantee.
- **Event visibility assumption (F2).** Moving to one watcher per process is safe only if every
  instance really receives every event type the watcher handles. It is documented for forms; for
  `permission.asked` and `session.execution.failed` of an isolated child (another location) it must
  be shown by the live suite before the per-instance watchers go.
- **Effect version coupling (F6).** Every new Effect line binds the plugin closer to
  `4.0.0-rc.112`. Kept to the question relay, a host bump of `effect` touches one module.
- **Module size.** `src/question.ts` (951 lines), `src/index.ts` (527) and `src/webhook.ts` (503)
  each mix several concerns; `test/question.test.ts` is 1340 lines. Size is a symptom of items 4
  and 6 above more than a problem of its own.

## 4. Recommendation

### Target style

**Hexagonal plugin with a functional core, one process-wide owner per shared resource, and Effect
confined to the question relay.** Concretely:

- `src/hub.ts`: one versioned process-wide object (`processWide("opencode-courier.hub")` holding
  `{ version, ... }`), the only `processWide` call. Instances `join(instance)` with their ports and
  location and get a `leave` back. The hub owns the shared sets and maps, the scheduler, the event
  watcher, the webhook receiver and the per-location permission domains, and runs each job once,
  through any live instance's ports, handing over when that instance leaves; the receiver's
  existing ref-counting is the model. Claim sets stay, as a second line of defence against an
  older copy in the same process, but stop being the primary mechanism.
- Functional core modules: `notices.ts` (every model-facing string: tool descriptions, results,
  briefs, notices, with snapshot tests), plus the pure parts already in `webhook.ts`, `later.ts`,
  `roster.ts`, `cleanup.ts`.
- Use-case modules on ports, as now (`courier.ts`, `later.ts`, `relay.ts`, `cleanup.ts`,
  `webhook.ts`), with the clock and timers always taken from ports.
- The question relay split into its pure part, its state (in the hub) and an Effect island that
  uses Effect primitives inside, exposing promise functions to the rest.
- `index.ts` as composition root only: build ports, join the hub, register tools from
  `tools.ts`, return `leave`.

Why this and not the alternatives: it keeps everything that works and that the tests rest on
(ports, fakes, e2e), and it puts each force where one mechanism handles it: F1 to F3 in the hub,
F4 in `notices.ts` and `tools.ts`, F5 in the hub and the Effect island, F6 in the adapters and a
small Effect surface, F7 in the existing three test layers. Going Effect-native everywhere would
answer F5 best but tie the whole plugin to a release candidate the host chooses (F6) and rewrite
the unit suite for no behaviour gained; revisit when Effect 4 is final and OpenCode documents the
Effect API as the primary one. An MCP server or daemon cannot do what the plugin is for.

### Migration plan

Each step is one PR, changes no behaviour a user or a model sees unless it says so, keeps the unit
and live suites green as they are, and can stop after any step with the code better than before.
Tool descriptions and results do not change in any step, so no real-model rerun is needed until
someone changes them on purpose.

| # | Step | What it buys | Risk and how CI covers it |
|---|---|---|---|
| 1 | **Tool surface module.** Move the ten tool schemas, descriptions and result builders out of `setup` into `src/tools.ts`, and every model-facing string (`childBrief`, `END_TURN`, `envelope`, the notices of `relay.ts`, `watch.ts`, `question.ts`, `webhook.ts`) into `src/notices.ts`, with one snapshot test over all of them. | One file to review for F4; a snapshot diff makes a wording change visible and triggers CLAUDE.md's real-model rerun rule. Breaks the `courier.ts` ↔ `question.ts` cycle. | Mechanical; unit tests and e2e unchanged. |
| 2 | **Small shared helpers.** One `BoundedSet`/`BoundedMap` (replacing both `claim`s, `remember` and `Seen`), one `clip`. | Less to keep in sync; one bound for every remembered id. | Unit tests for the helper; existing tests pass. |
| 3 | **Clock and timing through ports.** `QuestionPorts` gains `now` use everywhere `Date.now()` is called in `question.ts`, and `timing` becomes a port value instead of a mutable export. | Deterministic question tests; no test can leak timing into another. | Unit only. |
| 4 | **The hub, state only.** `src/hub.ts` with a versioned shape; the six keys move into it. On load, a hub of another version found under the key is logged, and the new copy runs its own hub under a versioned key, with the old copy's keys still honoured for claims until it unloads. | One place where shared state is declared, versioned and reset in tests; a defined answer to version skew. | Unit tests for join/leave, and a test that imports the module twice (`import("../src/hub.js?copy=2")`) to stand in for two copies in one process, which neither suite covers today (the e2e stops the server before it swaps the local build for the installed one). |
| 5 | **Single-owner scheduler.** The hub runs `deliverDue` once per tick through one live instance, handing over on leave; per-instance intervals go. | N× fewer storage scans; scheduler lifetime is the hub's. | e2e restart scenario (pending `courier_later` across a restart) and unit hand-over tests. |
| 6 | **Verify event visibility, then single-owner watcher.** First an e2e assertion that an isolated child's `permission.asked` and `session.execution.failed` reach the instance of the parent's location; then one `watchChildren` per process, re-subscribed through another instance on leave. If the assertion fails, keep one watcher per location and stop here. | One handler per event; `relayPending` once per (re)subscribe; the claim comments simplify. | The new e2e assertion gates the change. |
| 7 | **Roster lookups without full scans.** A reverse key (`roster-by-child/<sessionID>`) written with each entry, or a hub cache filled on join and written through; `entriesOf` and `lineage` read it. Old entries are back-filled on load. | O(depth) lineage per event instead of O(roster). | Persisted layout changes: unit tests for back-fill, e2e restart covers reading old data. |
| 8 | **Question relay as an Effect island.** Split `question.ts` into `question/state.ts` (in the hub), `question/notices` (step 1), and `question/relay.ts`, where the resolvers become `Deferred`, `deliver`'s lock a `Semaphore` per question with `Effect.timeout`, `closingSoon` a race of a `Deferred` and `Effect.sleep`, `tellLater` a forked fiber in the hub's scope; tests move to `TestClock` where they wait on time. Keep exported functions promise-shaped. | Structured cancellation where the plugin most needs it; tests independent of wall time; the largest module in four parts. | The question e2e scenarios (answered in parent, in child, dismissed, cut off, restart) are the safety net; do it last and in two PRs if needed. |
| 9 | **Lifecycle-tracked background work.** The hub tracks every started promise (`pruneExpired`, `noticeCutOff`, a tick) and `leave` awaits them before resolving; the promise/Effect slot (`RelaySlot`) goes, since both halves get the instance from the hub. | No work against an unloaded instance; one registry of instances instead of `relay.ports` and `shared.loaded`. | Unit tests for leave; e2e reinstall and restart. |

The three steps that buy the most are **1** (the tool surface, because F4 is the plugin's actual
user interface and has no single place today), **4** (the hub, because version skew in one process
is the largest untested risk), and **5 with 6** (single owners for the scheduler and the watcher,
because they remove the N-instance duplication that most of the claim logic exists for).

### What not to change

- The entry shape: an Effect plugin running the promise plugin through `fromPromise`. It is the
  host's own adapter, and the only way to get an interruptible `execute` for the question tool.
- The exact pin, the peer equal to the dev dependency, the `latest` leg, and the notes per bump.
- `codemode: false`, `withoutUndefined`, `describeFailure`, and plain input schemas with
  validation in the tool: each is a workaround for observed host behaviour. VS Code's
  `subscriptions` do not await async disposal [S14]; OpenCode awaits a promise plugin's cleanup,
  which step 9 relies on.
- Ports passed as arguments and the fake-context unit suite; no DI container, and no Effect
  `Layer` graph for the use cases.
- The scripted mock model as the CI driver, and the real-model smoke test outside CI.
- Storage key layouts, except in step 7, and then with a back-fill: users' rosters, scheduled
  messages and stored questions must survive an update.
- In-process webhook receiver: moving it out of process adds an install step for a part that works.
- The claim sets, even after steps 5 and 6: an older copy of the plugin in the same process still
  runs its own loops until it unloads.

## 5. Sources

Repository files are cited inline by path. OpenCode V2 source paths are on the `v2.0.24` tag of
https://github.com/anomalyco/opencode (`packages/core/src/plugin/supervisor.ts`,
`packages/core/src/plugin/instance.ts`, `packages/core/src/plugin/module.ts`,
`packages/core/src/plugin/host.ts`, `packages/core/src/kv.ts`), and the plugin API's types are
`@opencode/plugin@2.0.24` (`dist/effect/plugin.d.ts`, `dist/effect/storage.d.ts`,
`dist/promise/adapter.d.ts`).

Sources marked *(read via source repo)* were read in the documentation's own repository because
the rendered site was not reachable from the research environment; *(unverified)* means the claim
rests on a search snippet or memory.

- [S1] OpenCode V1 plugins documentation. https://opencode.ai/docs/plugins/
- [S2] OpenCode V2 plugin API: `packages/plugin/src/effect/plugin.ts`, `packages/plugin/src/effect/README.md`,
  `packages/plugin/src/effect/PLAN.md` (Boot Batching, Event API), `packages/core/src/plugin.ts`
  (per-activation scope), `packages/core/src/plugin/instance.ts`. https://github.com/anomalyco/opencode/tree/v2/packages/plugin
- [S3] Claude Code hooks reference. https://code.claude.com/docs/en/hooks
- [S4] Claude Code plugins reference. https://code.claude.com/docs/en/plugins-reference
- [S5] Model Context Protocol, architecture (2025-06-18). https://modelcontextprotocol.io/specification/2025-06-18/architecture
  *(read via source repo: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-06-18/architecture/index.mdx)*
- [S6] Model Context Protocol, tools and tasks (2025-11-25), `server/tools.mdx` and `basic/utilities/tasks.mdx`.
  https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/docs/specification/2025-11-25
- [S7] Anthropic, Building effective agents. https://www.anthropic.com/engineering/building-effective-agents
- [S8] Anthropic, Writing effective tools for agents. https://www.anthropic.com/engineering/writing-tools-for-agents
- [S9] Effect, Scope and finalizers (v4). https://github.com/Effect-TS/website/blob/main/apps/web/src/content/docs/v4/resource-management/scope.mdx *(read via source repo)*
- [S10] Effect, ManagedRuntime (v4). https://github.com/Effect-TS/website/blob/main/apps/web/src/content/docs/v4/runtime.mdx *(read via source repo)*
- [S11] Effect, Layers and TestClock (v4): `requirements-management/layer-memoization.mdx`, `testing/testclock.mdx`.
  https://github.com/Effect-TS/website/tree/main/apps/web/src/content/docs/v4 *(read via source repo)*
- [S12] VS Code, extension host and activation events. https://code.visualstudio.com/api/advanced-topics/extension-host,
  https://code.visualstudio.com/api/references/activation-events *(read via source repo: https://github.com/microsoft/vscode-docs/tree/main/api)*
- [S13] VS Code, extension manifest (`engines.vscode`) and proposed APIs. https://code.visualstudio.com/api/references/extension-manifest,
  https://code.visualstudio.com/api/advanced-topics/using-proposed-api *(read via source repo)*
- [S14] VS Code API typings: `ExtensionContext.subscriptions`, `Memento`. https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts
- [S15] Alistair Cockburn, Hexagonal architecture. https://alistair.cockburn.us/hexagonal-architecture/
- [S16] Gary Bernhardt, Boundaries (talk, 2012). https://www.destroyallsoftware.com/talks/boundaries *(unverified: page not reachable)*
- [S17] Martin Thompson, Single Writer Principle. https://mechanical-sympathy.blogspot.com/2011/09/single-writer-principle.html *(unverified: page not reachable)*
- [S18] Martin Fowler, Event Sourcing. https://martinfowler.com/eaaDev/EventSourcing.html *(unverified: page not reachable)*
- [S19] oh-my-opencode, background agent notes: `packages/omo-opencode/src/features/background-agent/AGENTS.md`. https://github.com/code-yeongyu/oh-my-opencode
- [S20] IntelliJ Platform SDK, Services. https://github.com/JetBrains/intellij-sdk-docs/blob/main/topics/basics/plugin_structure/plugin_services.md
- [S21] Zed, developing extensions and capabilities. https://github.com/zed-industries/zed/blob/main/docs/src/extensions/developing-extensions.md;
  Neovim, Lua plugin guide. https://github.com/neovim/neovim/blob/master/runtime/doc/lua-plugin.txt
- [S22] Cline, `McpHub`. https://github.com/cline/cline (`apps/vscode/src/services/mcp/McpHub.ts`)
- [S23] Vercel AI SDK docs (tools, runtime and tool context, testing with `MockLanguageModel`). https://github.com/vercel/ai/tree/main/content/docs/03-ai-sdk-core;
  LangChain tools. https://github.com/langchain-ai/docs/blob/main/src/oss/langchain/tools.mdx
- [S24] Anthropic, Demystifying evals for AI agents. https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents;
  Inspect AI mock model. https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/model/_providers/mockllm.py
- [S25] VCR.py, HTTP record and replay. https://github.com/kevin1024/vcrpy; pytest-recording. https://github.com/kiwicom/pytest-recording
