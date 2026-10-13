> The migration this note planned is done: step 6, the tree's stores and `forget.ts`, landed in #137.

Research notes behind this issue's decisions; this text goes into the repository as `docs/research/layout.md` in step 1.

# opencode-courier: five layout decisions for the module-per-feature restructure

Research note, read-only. Code read at `main` @ `23dac7e` (0.3.0, `@opencode/plugin@2.0.26`); OpenCode
source read from tag `v2.0.26` of anomalyco/opencode (sparse clone). Source numbers like [S3] refer to
the list at the end. "Unverified" marks a claim whose primary page I could not open.

## What the code actually says (checked, not assumed)

Import graph of `src/` (from the same regex `test/imports.test.ts` uses):

| file | lines | imports (plugin-internal) |
|---|---|---|
| hub.ts | 621 | group, json, later, limits, notices, relay, roster, storage, webhook |
| watch.ts | 513 | bounded, courier, group, hub, notices, question/index, relay, later, report, roster, webhook (11) |
| roster.ts | 266 | group (`dropMember`), report (`forgetReport`), storage |
| tools.ts | 401 | cleanup, stop, tree, courier, later, notices, question/index, relay, webhook (+ `effect` Schema) |
| notices.ts | 1000 | json only (rule-enforced) |
| later.ts / webhook.ts | 124 / 373 | notices, storage (+ bounded, json) — leaves |

All three motivating findings hold, and the code shows four more things the proposal does not yet handle:

1. **hub.ts depends on features in two ways, not one.** Values: `deliverDue` (later) and
   `deliverReleased` (group), called inside `tick` (hub.ts:448-449). Types: `Member` carries
   `later: LaterPorts`, `watch: WatchPorts`, `questions: QuestionPorts`, `permission: Permissions`;
   `Hub` carries `WatchState` (with relay's `Waiting`), `QuestionState`, `Receivers` (webhook types),
   and `opened.gate` is limits' `SpawnGate`. A tick registry removes the first; the second needs the
   hub's state slots to stop being typed by features (see decision 0).
2. **The hub already has a "last copy wins" injection point.** `scheduler.tick` (hub.ts:196, 511) and
   `hub.subscribe` (set in `watchFromHub`, watch.ts:508) are closures set by the copy that joined
   last, which then run through `hub.members.values().next()`, i.e. the *first* member, possibly an
   older copy's. Registration must ride on those closures (decision 0).
3. **Event handlers are order-sensitive and have lifecycle hooks.** `handle()` runs `route()` and
   then, in `finally`, `sealGroups` ("a silent end is judged while the group the nudge may deliver is
   still there", watch.ts:391-395). The question relay also needs `eventsFollowed`, `eventsLeft`,
   `formsMayHaveBeenMissed` around the subscription, and `relayPending` runs on every (re)subscribe.
   A plain `on(type, handler)` registry loses all of that.
4. **The silent-turn rule is a cross-module query, not an event.** `waits()` (watch.ts:193-203)
   asks tree (children awaited, complete group), person (`listEverywhere` permissions,
   `pendingQuestions`), scheduling (`scheduledFor`) and webhook (`subscriptions`). Meanwhile person
   reads tree (`answeringTop` in relay.ts:74 and question/answer.ts:171, `lineage` in
   question/relay.ts:139). So tree↔person is a two-way dependency today, hidden inside watch.ts.
5. **The aggregate cascade is in four places**: `roster.remove` (report + group), `cleanup.ts`
   (`markLeft`, `remove`), `watch.noteDeleted` (`forgetReport`, `dropGroups`, `leave`) and
   `roster.dropExpired`. `pruneExpired`/`backfill` sweep orphan reverse keys; I found no sweep for
   orphan `report/<id>/` keys whose `forgetReport` failed (it is `.catch(() => undefined)`).
6. **notices.ts holds domain types** (`Status`, `Limits`, `HeldReport`, `Artifacts`, `Asked`,
   `Outcome`, `Withdrawal`...), imported by hub, courier, group, report, limits, question/*. They are
   there only because "notices imports nothing" forced them there.
7. **Tool descriptions are not in notices.ts**: they are inline in `tools.ts` (`Schema...annotate`,
   `description:`); the "central catalogue" is in practice `test/notices.test.ts` + its 1355-line
   snapshot, which collects both.

---

## Decision 0: inverting platform → feature dependencies

### Options
- **A. Registration (plugin/microkernel style):** platform exposes `TickJob` / `EventHandler` types;
  modules export jobs and handlers; something hands them to the platform.
- **B. Application event bus:** modules publish domain events ("child settled", "group complete");
  others subscribe.
- **C. Dispatcher in the composition root:** `route()` and the tick body move to `src/index.ts`
  (or a `wiring.ts` next to it), which imports every module.

### What the sources say
- Dependency rule: "Source code dependencies must point only inward, toward higher-level policies";
  where control flows outward, invert it with an interface owned by the inner side [S6]. Composition
  happens in a single Composition Root "as close as possible to the application's entry point" [S7].
- Spring Modulith recommends events as the primary means of module interaction, to avoid
  "functional gravity" in the publisher [S4], but its events are reliable only thanks to the Event
  Publication Registry writing a log entry inside the business transaction; without it, "if the
  listener fails ... the event publication is lost" [S4]. Courier's storage has no transaction
  (F3 in the architecture record), so it cannot have that registry.
- Fowler: event notification is low coupling, but "it can be hard to see such a flow as it's not
  explicit in any program text" [S8].
- OpenCode itself (v2.0.26 `packages/core/src/plugin/hooks.ts`) uses registration: `register(domain,
  name, callback)` appends to a list, returns a `dispose` tied to a `Scope` finalizer, and `trigger`
  runs callbacks **sequentially in registration order** [S13].

### Fit with this codebase
- B adds a second bus on top of OpenCode's event stream, which already *is* the bus. The real
  cross-module flows are: a group completing → `nudge()` (already a port), `waits()` (a query; an
  event bus cannot answer a question), and `form.created` fanning out to question relay and form
  notices (a host event, not a domain event). B buys nothing and loses ordering and visibility.
- C is honest but moves the 11-import knot into `index.ts`; the knot is the problem.
- A fits, with three constraints from the code:
  1. **Register per copy, never in the hub.** Pass jobs and handlers into `open(...)` /
     `watchFromHub(...)` so they live in the closures `scheduler.tick` and `hub.subscribe` already
     are. Storing `hub.jobs: TickJob[]` would change the hub's shape, which by docs/reference.md
     §"Several copies" means a new `HUB_VERSION`, i.e. a second hub and second scheduler loop in the
     process (claims still dedupe, but you get exactly the skew you wanted to avoid). It would also
     leave an unloaded old copy's jobs in a shared list, which OpenCode's hooks avoid with
     scope-bound `dispose` [S13].
  2. **Jobs run through the first member, which may be an older copy's.** Today `deliverReleased`
     is fed `owner.later`. A registered job may only use member ports every hub-v2 member has; a
     job needing a new port must feature-test it or the hub version must change.
  3. **Handlers need ordering and lifecycle.** Model it as phases, not a bag:
     ```ts
     // platform/events.ts
     export interface EventModule {
       readonly handle?: (ports: P, event: HostEvent) => Promise<unknown>   // phase 1, in list order
       readonly after?: (ports: P, event: HostEvent) => Promise<void>       // phase 2 (sealGroups)
       readonly followed?: () => void; readonly left?: () => void           // question relay hooks
       readonly subscribed?: (ports: P) => Promise<void>                    // relayPending
     }
     export function watchFromHub(hub, state, modules: readonly EventModule[], retryMs?)
     // platform/hub.ts
     export interface TickJob { readonly name: string; run(owner: Member, claimed: Set<string>): Promise<void> }
     export function open(registry, jobs: readonly TickJob[], timers?, server?)
     ```
     The composition root builds the ordered lists `[tree.events, person.events]` and
     `[scheduling.job, tree.groupJob]`: A's decoupling, C's visible order.
- The `waits()` query is solved the same way: tree declares a required port
  `Waits = (sessionID, since) => Promise<boolean>`; person, scheduling and webhook each export one;
  the root passes `[...]` into tree. This breaks the hidden tree↔person cycle.
- Typed state slots: `SpawnGate` and `inbox` already live "under a fixed key of their own rather than
  in the hub" (hub.ts:313-315), so tree can take them through `processWide` itself; the hub then
  drops the limits import. For `WatchState`/`QuestionState`/`Receivers` (real hub fields), make the
  hub generic over its slots or declare them as plain data types in `platform/` (they are a
  cross-version persistence contract and must not change shape anyway). Do **not** keep `import type`
  from features: `test/imports.test.ts` counts type-only imports, and rightly so.

**Recommendation:** A (registration), with ordered phases, built in the composition root and closed
over by this copy's tick/subscribe closures; no app-level bus. **Confidence: high.**
**Main risk:** the first-member rule: a new job using a port an older copy's `Member` lacks fails
only when two versions are loaded together. Add a unit test that runs every registered job through
a `Member` built the hub-v2 way, and keep `e2e/two-servers.sh`-style skew checks in mind.

---

## Decision 1: model-facing text: co-located or central

### Options
- **A. Central catalogue** (today's `notices.ts`, 1000 lines, 81 exports, imports only json).
- **B. Co-located `text.ts` per module**, next to the adapter that speaks it, with **one** central
  snapshot test that gathers all of it.
- **C. Central folder split by module** (`src/text/tree.ts`, `src/text/person.ts`, ...).

### What the sources say
- Hosts and SDKs keep descriptions with the tool. OpenCode v2.0.26: `tool/plugin/question.ts` has
  `export const description = ...` inline; `tool/plugin/patch.ts` does `import DESCRIPTION from
  "../patch.txt"`; system prompts sit in `plugin/system-prompt/*.txt` next to `optimize.ts`, command
  prompts in `plugin/command/*.txt` next to `command.ts` [S13]. No central catalogue.
  Vercel AI SDK: `description` is a property of the tool object and "can influence when the tool is
  picked" [S14]. MCP TS SDK: `registerTool(name, { title, description, inputSchema }, handler)` [S15].
- i18n practice is "co-locate the source, centralise the extraction": commercetools/FormatJS put
  `messages.js` "next to your React component" and `formatjs extract` gathers `src/**/messages.js`
  into one `core.json` for translators [S16].
- Prompt-regression practice: run evals when prompt files change, gated by a path rule
  (`changes: prompts/**/*` in promptfoo's CI example) [S17]. Jest: "Treat snapshots as code ...
  review them as part of your regular code review" [S18].
- Anthropic: "Even small refinements to tool descriptions can yield dramatic improvements";
  iterate on descriptions and error responses against evaluations, with held-out sets [S12].

### Fit with this codebase
- The reviewable artefact is already the snapshot file, not notices.ts (tool descriptions already
  live in tools.ts and are snapshotted from there). Location of the strings does not change the
  review gate; the snapshot does.
- A keeps forcing domain types into the text file (finding 6) and makes every module depend on one
  1000-line file; the "imports nothing" rule exists to stop the text file depending on modules.
- C reintroduces that problem: `text/tree.ts` needs `Status`, `Limits`, `HeldReport`, which would
  live in `tree/`; then text → tree → text.
- B lets `tree/text.ts` import tree's own types, so the types go back to their module. The
  cross-cutting protocol pieces (`envelope`, `END_TURN`, `clipText`, `defuse`, `describeFailure`)
  are used by 7 modules: they go in one shared kernel file.

**Recommendation:** B. Per-module `text.ts` (pure functions and constants, no I/O); a shared
`kernel/protocol.ts` for envelope and turn-ending phrases; tool descriptions in each module's
`tools.ts` (as OpenCode does), or in `text.ts` if long; keep **one** `test/text.test.ts` that imports
every `*/text.ts` and every module's tool list, so the snapshot stays the single place a wording
change shows. Add the rerun trigger as a path rule: any change under `src/**/text.ts`,
`src/**/tools.ts`, `src/kernel/protocol.ts` or the snapshot → rerun `e2e/real-model.sh` (CLAUDE.md
already says so; a CI comment or PR checklist line can enforce it). **Confidence: medium-high.**
**Main risk:** tone drift between modules (shared phrasing like the "end your turn" sentence was
tuned against real models, docs/real-model.md). Keep every such phrase in `kernel/protocol.ts` and
compose, never copy.

---

## Decision 2: layering depth

### Options
- **A. Full `domain/ application/ adapters/in/ adapters/out/` in every module** (the proposal).
- **B. Layers only where a module has a domain**; small modules flat with `ports.ts`; roles
  expressed by file names (`tools.ts`, `events.ts` = inbound; `store.ts` = outbound).

### What the sources say
- Cockburn's pattern is about the boundary: events arrive at a port, a "technology-specific adapter
  converts it"; the application is "blissfully ignorant of the nature of the input device" [S1, via
  arc42's summary; Cockburn's own page was unreachable: unverified at source]. It prescribes no
  inner folders.
- Fowler: split the top level into "domain oriented modules which are internally layered", but
  layering "should only be applied at a relatively small granularity" and "a small program may just
  put separate functions for the layers into different files" [S5].
- Spring Modulith: a "simple" module is one package whose public types are its API; an "advanced"
  module adds internal sub-packages; it says nothing about layers inside [S3]. Its
  `allowedDependencies` and named interfaces are the boundary tool, not folders [S3].
- Simon Brown, package by component: business and data access per component behind a public
  interface, enforced by access rules; ports and adapters inside a component only where async
  messaging or third-party calls make testing need them, "the exception, not the rule" [S9].
- Evans: modules should "tell the story of the system and contain a cohesive set of concepts" [S10].
- Enforcement in TS: dependency-cruiser ("Validate and visualise dependencies. With your rules.")
  [S19], eslint-plugin-boundaries (element types by path pattern, `default: "disallow"` policies)
  [S20], `import/no-restricted-paths` zones (`target`/`from`/`except`) [S21]. This repo has no
  ESLint at all; `test/imports.test.ts` already builds the import graph and checks cycles.

### Fit with this codebase
Estimated module sizes after the move (source lines incl. their share of tools/watch/notices):

| module | from | ~lines | domain logic? |
|---|---|---|---|
| tree | courier, roster, report, group, limits, tree, stop, cleanup, part of watch/tools/notices | ~2,500 | yes: group standing (`standingOf`, `complete`), report states, limits `admit`, `lineageIn` |
| person | relay, question/ (894), part of watch/tools/notices | ~1,400 | some (question/pure.ts); question/ already layered |
| webhook | webhook, part of tools/notices | ~500 | parsing/HMAC; no aggregate |
| scheduling | later, part of tools/notices | ~200 | none |
| platform | hub, storage, bounded, json, version | ~730 | n/a |

A full A layout gives scheduling four folders for ~200 lines. Even in tree, the "domain" is today
interleaved with storage calls (`report.prompted(storage, ...)`, `group.markLeft(storage, ...)`);
a `domain/` folder would be a rewrite, not a move. The pure parts fit in one `tree/domain.ts`.

**Recommendation:** B. Every module gets `index.ts` (its only public surface) and `ports.ts`
(what it requires) and `text.ts`; inbound adapters are `tools.ts`, `events.ts` (and `context.ts`
for tree's context hook); outbound is `store.ts`. Only `tree` splits further, and only by files
(`domain.ts` for the pure core, one file per use case), with folders only if a file passes ~400
lines. Enforce with `test/imports.test.ts` (rules below), no new dependency.
**Confidence: high.** **Main risk:** convention-by-filename is weaker than folders; the import test
must encode it (e.g. only `*/tools.ts`, `*/events.ts` may import `@opencode/plugin` tool types;
`domain.ts` imports nothing but kernel).

---

## Decision 3: persistence port granularity

### Options
- **A. One aggregate-level port** (`TreeStore`) over all of `roster/`, the reverse index,
  `report/`, `group/`.
- **B. One repository per key prefix** (RosterRepo, ReverseIndexRepo, ReportRepo, GroupRepo).
- **C. One repository per aggregate root**, after deciding what the roots are.

### What the sources say
- Evans: "Provide repositories only for aggregate roots that actually need direct access"; "Within
  an aggregate boundary, apply consistency rules synchronously"; "Use the same aggregate boundaries
  to govern transactions and distribution" [S10].
- Vernon: "Model True Invariants in Consistency Boundaries", "Design Small Aggregates"; a well
  designed bounded context "modifies only one aggregate instance per transaction" [S11a]; "Use
  Eventual Consistency Outside the Boundary", "Prefer references to external aggregates only by
  their globally unique identity", with subscribers updating other aggregates later and retrying
  [S11b]. His service examples use one repository per aggregate type [S11a].

### Fit with this codebase
Applying "true invariants" to the keys:
- **Child** (root: roster entry `roster/<parent>/<child>`; plus reverse index, which is a storage
  index, and `report/<child>/{prompt,settled,progress,told,stopped}`): report state changes with
  the child's turns and dies with it (`roster.remove` drops it). One root.
- **JoinGroup** (`group/<parent>/<name>/<member>`, with the held reports stored under it):
  its invariant (release when every member settled or left, `complete()`, `deliverReleased`) spans
  members and is checked on its own; members are referenced by session id (Vernon's rule). A
  second root.
- The cascade "child forgotten → leave group" crosses the two, and the code already treats it as
  best-effort: `dropMember(...).catch(() => false)`, and `noteDeleted` notes "a held report outlives
  the member's entry". That is eventual consistency outside the boundary, as Vernon prescribes.
- B (per prefix) would make the reverse index a public repository, though it is just a derived
  index that `backfill` rebuilds; and would let any module write `report/` keys without the child.
- A would hide a real boundary and grow a god-port (today's `RosterStorage = Storage` alias is
  that already).
- Persisted key shapes are a cross-version contract (older copies and a second server read and
  write the same keys); the restructure must keep every key byte-identical. Ports change, keys
  don't.

Without transactions, consistency comes from ordering and repair, which the code already does in
places: write the root last on create / remove it first on forget so a partial failure leaves
orphans of the parts, never a root without its parts; make each sweep idempotent ("a rerun changes
nothing", `backfill`); and sweep orphans on load. Gap found: no sweep for `report/<id>/` keys left
by a failed `forgetReport`; `pruneExpired` should cover them.

Who owns the cascade: not the repository (it would hide a cross-aggregate write inside a "delete"),
not the domain objects (they have no I/O here); an **application service** in tree
(`forgetChild`, `sessionDeleted`, `expire`) that calls `ChildStore.remove` then
`GroupStore.leave`, the one place `roster.remove`, `cleanup`, `noteDeleted` and `dropExpired` go
through.

**Recommendation:** C: two ports in `tree/ports.ts`, `ChildStore` and `GroupStore`, both
implemented by `tree/store.ts` over the existing keys (reverse index private to it); cascade in one
tree application service; read-only lineage queries (`lineage`, `answeringTop`) exported through
`tree/index.ts` for person. **Confidence: medium** (the Child/JoinGroup split is a judgement; a
single `TreeStore` with grouped methods is a defensible simpler fallback).
**Main risk:** the group-held report: a report held in a group outlives the child entry by design,
so `ChildStore.remove` must not drop group keys; tests in `test/group.test.ts` and
`test/watch.test.ts` around `noteDeleted` are the guard.

---

## Decision 4: permission, question and form relays: one module or three

### Options
- **A. One `person` module** with `permission.ts`, `form.ts`, `question/` (Effect island) inside.
- **B. Three modules** (permission, form, question).

### What the sources say
- Evans: a module is "a cohesive set of concepts", with "low coupling in the sense of concepts that
  can be understood and reasoned about independently" [S10].
- Spring Modulith defines a module by its provided interface (API + events it publishes), internal
  components, and required interface [S3]; one provided interface to the outside argues for one
  module.
- Common Closure Principle (classes that change together belong together): commonly cited from
  Martin's package principles [S22]; primary text not fetched, treat as unverified wording.
- Vernon IDDD ch. 9 (Modules) covers module naming and design; only its preview was reachable
  [S11c], so I do not quote it.

### Fit with this codebase
They are one concept ("a child needs the person"), and the code couples them tightly:
- **One inbound adapter:** `courier_answer` answers both permission requests and questions
  (tools.ts:326-337, branching to `answer` (relay.ts) or `answerQuestion` (question/)).
- **One host event split between them:** `form.created` goes to `formShown` (question relay) and to
  `reportForm`, which skips forms whose kind is `QUESTION_FORM` (watch.ts:299, 407-412).
- **Shared rules and state:** both check `answeringTop` on tree; hub state `waiting`, `answered`,
  `forms`, `questions` belongs to the three together; their notices are one family in docs
  (reference.md "A child that asks for permission / shows a form / asks a question" are adjacent
  sections).
- **One answer to `waits()`:** "does this session wait on the person?" = pending permission or
  pending question.
Three modules would need cross-imports among themselves for every one of these. What differs is
technology (question/ is Effect, the rest promises), which is an internal boundary; the existing
rule "outside question/, use question/index.ts only" already handles it.

**Recommendation:** A, one module; keep `question/` as an internal sub-module with its existing
index-only rule. Name it after the docs' language (e.g. `asks/` or `person/`).
**Confidence: medium-high.** **Main risk:** the module becomes the home of everything Effect;
keep the rule that `effect` (beyond `Schema` in tool adapters) is imported only under
`person/question/` and the Effect half of `src/index.ts`.

---

## Revised layout

Changes from the proposal: no `domain/application/adapters` folders; a shared kernel for the model
protocol; text co-located; tree split into two stores; registration built in the root and kept out
of hub state; skill stays top-level.

```
src/
  index.ts            composition root: builds ports, ordered TickJob[] and EventModule[] lists,
                      wires tree's Waits port from person/scheduling/webhook, registers tools/hooks
  tui.tsx             the `tui` entrypoint, a second composition root: each module's TUI adapter
  rpc.ts              the `rpc` entrypoint: each module's RPC contract, for clients
  skill.ts            courier-orchestrate registration + text (spans all tools; imports kernel only)
  kernel/             shared kernel: imports platform/json only
    protocol.ts       envelope, END_TURN, clipText, defuse, describeFailure, Status
  platform/           imports nothing outside platform/
    hub.ts            hub shape unchanged (HUB_VERSION 2), open(registry, jobs, ...)
    events.ts         subscription loop (until, resubscribe), runs EventModule phases
    storage.ts json.ts bounded.ts version.ts
  tree/               ~2.5k lines
    index.ts          public: tools, events, context hook, lineage queries, Waits type
    ports.ts          ChildStore, GroupStore, SessionPort, Waits
    domain.ts         pure: standing, complete, lineageIn, admit rules
    spawn.ts send.ts status.ts report.ts group.ts limits.ts subtree.ts stop.ts cleanup.ts forget.ts
    store.ts          KV adapter for roster/, reverse index, report/, group/ (keys unchanged)
    tools.ts events.ts context.ts text.ts
    rpc.ts            the RPC contract the TUI part and the server share (rule 16)
    rpc-handlers.ts   its server side, registered from index.ts after the tools
    tui.tsx           the TUI adapter: the prompt footer's status entry (rule 15)
  person/             (or asks/)
    index.ts ports.ts permission.ts form.ts tools.ts events.ts text.ts
    rpc.ts            the person's RPC contract: the asks of a tree, a question's answer (rule 16)
    rpc-handlers.ts   its server side, registered from index.ts after the tree's
    tui.tsx           the TUI adapter: the asks inbox, its dialogs, command and sounds (rule 15)
    question/         unchanged inner layout (Effect island)
  scheduling/         index.ts later.ts tools.ts text.ts (exports its TickJob and Waits)
  webhook/            index.ts receiver.ts subscriptions.ts tools.ts text.ts (exports its Waits)
```

Migration order that keeps every step green: (1) kernel + types out of notices; (2) registration
API in platform with today's two jobs and one handler module, hub imports gone; (3) move modules
one at a time, leaving `notices.ts` re-exports until the last; (4) tree stores and the cascade
service. Each step touches `test/*` imports; snapshots must come out byte-identical except for the
snapshot file name.

## Enforcement rules (as checks in `test/imports.test.ts`)

Modules = `tree`, `person`, `scheduling`, `webhook`. All existing checks stay (no cycles; bounded
imports nothing).

1. `platform/**` imports only `platform/**`.
2. `kernel/**` imports only `kernel/**` and `platform/json`.
3. A file in module M imports from module N ≠ M only `N/index`. (Spring Modulith's API-package rule.)
4. Allowed module dependencies (Spring Modulith `allowedDependencies` style):
   `person → tree`; `tree → ∅`; `scheduling → ∅`; `webhook → ∅`. Anything else fails.
5. Every module may import `platform/**` and `kernel/**`.
6. `*/text.ts` imports only `kernel/**`, `platform/json`, and its own module's `ports.ts`/`domain.ts`.
7. `tree/domain.ts` imports only `kernel/**` and `platform/json`.
8. Only `src/index.ts` imports more than one module's `index`; no module imports `src/index`.
9. `person/**` outside `person/question/**` imports `person/question/index` only (today's rule, moved).
10. `effect` imported only by `person/question/**`, `src/index.ts`, `*/tools.ts` and `*/rpc.ts` (for `Schema`).
11. No module's `store.ts` is imported outside its module (persistence stays private).
12. The snapshot test imports every `src/**/text.ts` and every module's tool list; a test fails if a
    `text.ts` exists that it does not import.

The TUI and RPC entrypoints (#143, after the spike for #130 in `docs/plugin-api-notes.md`) add a
second composition root and five rules. The scanner reads `.tsx` files as well as `.ts`.

13. The only files of `src/` outside a folder are `index.ts`, `skill.ts`, and the entrypoints
    `rpc.ts` and `tui.tsx`. Rule 3 holds for them too, except that `rpc.ts` may import a module's
    `<module>/rpc.ts` and `tui.tsx` its `<module>/rpc.ts` and `<module>/tui.tsx` directly, since a
    module's `index.ts` would pull its server half into the TUI bundle.
14. `src/tui.tsx` imports only `@opencode/plugin/tui` and the modules' `tui.tsx` and `rpc.ts`;
    `src/rpc.ts` only the modules' `rpc.ts`.
15. A module's `tui.tsx`, its TUI adapter, imports only `@opencode/plugin/tui`, `solid-js`,
    `@opentui/*` and its own module's `rpc.ts` and `text.ts`: nothing of the server half.
16. A module's `rpc.ts`, the contract both halves share, imports only `@opencode/plugin/rpc` and
    `effect`, so the TUI bundle takes nothing else of the module.
17. Only `src/tui.tsx` imports a `tui.tsx`, and only the `tui` files import `@opencode/plugin/tui`,
    `solid-js` or `@opentui/*`, so the server bundle carries no TUI code. A module's server-side
    RPC adapter is its `rpc-handlers.ts`, exported through its `index.ts` like its `tools.ts`.

If the rule set grows past this, `dependency-cruiser` [S19] or `eslint-plugin-boundaries` [S20]
express the same rules declaratively; for twelve rules the existing test needs no new dependency.

## Sources

- [S1] arc42 patterns, Hexagonal (summarising Cockburn): https://patterns.arc42.org/patterns/hexagonal/ . Cockburn's original (https://alistair.cockburn.us/hexagonal-architecture/) was unreachable from here: unverified at source. Index page: https://alistaircockburn.com/Articles/Hexagonal-Architecture
- [S3] Spring Modulith reference, Fundamentals: https://docs.spring.io/spring-modulith/reference/2.0/fundamentals.html
- [S4] Spring Modulith reference, Events: https://docs.spring.io/spring-modulith/reference/2.0/events.html
- [S5] Martin Fowler, PresentationDomainDataLayering: https://www.martinfowler.com/bliki/PresentationDomainDataLayering.html
- [S6] Robert C. Martin, The Clean Architecture (book excerpt): https://www.informit.com/articles/article.aspx?p=2832399 . The 2012 blog post (https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html) was unreachable.
- [S7] Mark Seemann, Composition Root: https://blog.ploeh.dk/2011/07/28/CompositionRoot/
- [S8] Martin Fowler, What do you mean by "Event-Driven"?: https://www.martinfowler.com/articles/201701-event-driven.html
- [S9] Simon Brown, Package by component and architecturally-aligned testing (DZone repost): https://dzone.com/articles/package-component-and
- [S10] Eric Evans, DDD Reference (2015): https://domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf
- [S11a] Vaughn Vernon, Effective Aggregate Design part I: https://dddcommunity.org/wp-content/uploads/files/pdf_articles/Vernon_2011_1.pdf
- [S11b] Vaughn Vernon, Effective Aggregate Design part II: https://www.dddcommunity.org/wp-content/uploads/files/pdf_articles/Vernon_2011_2.pdf
- [S11c] Vernon, IDDD ch. 9 Modules (preview only): https://www.oreilly.com/library/view/implementing-domain-driven-design/9780133039900/ch09lev1sec2.html
- [S12] Anthropic, Writing effective tools for agents: https://www.anthropic.com/engineering/writing-tools-for-agents
- [S13] OpenCode v2.0.26 source (tag `v2.0.26`): https://github.com/anomalyco/opencode/tree/v2.0.26 — files `packages/core/src/plugin/hooks.ts`, `packages/core/src/tool/plugin/question.ts`, `packages/core/src/tool/plugin/patch.ts` + `tool/patch.txt`, `packages/core/src/plugin/optimize.ts` + `system-prompt/*.txt`, `packages/core/src/plugin/command.ts` + `command/*.txt`
- [S14] Vercel AI SDK, Tools: https://ai-sdk.dev/docs/foundations/tools
- [S15] MCP TypeScript SDK, Tools: https://ts.sdk.modelcontextprotocol.io/v2/servers/tools
- [S16] commercetools, Translations (FormatJS co-located messages, extracted catalogue): https://docs.commercetools.com/merchant-center-customizations/development/translations
- [S17] promptfoo, GitLab CI integration: https://promptfoo.dev/docs/integrations/gitlab-ci
- [S18] Jest, Snapshot Testing: https://jestjs.io/docs/snapshot-testing
- [S19] dependency-cruiser: https://github.com/sverweij/dependency-cruiser
- [S20] eslint-plugin-boundaries: https://github.com/javierbrea/eslint-plugin-boundaries
- [S21] import-x `no-restricted-paths`: https://github.com/antfu/eslint-plugin-import-x/blob/master/docs/rules/no-restricted-paths.md
- [S22] Common Closure Principle as cited (secondary): https://blog.avenuecode.com/principles-of-package-and-component-design (not fetched: unverified)
- Repository: `docs/reference.md` §"Several copies in one process"; architecture record on `origin/issue-126-architecture-record:docs/research/architecture.md`.
