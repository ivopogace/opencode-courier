# Architecture

How the plugin is put together. [CLAUDE.md](../../CLAUDE.md)'s Layout is the file-by-file map,
`test/imports.test.ts` enforces the import rules below, the [reference](../reference.md) says what
the plugin does, and [plugin-api-notes.md](plugin-api-notes.md) what the host does that it works
around.

## Layout

`src/` is split into modules by feature, each hexagonal inside (ports, pure domain rules, use cases,
inbound and outbound adapters):

- `tree/`: the session tree: spawning, sending, reports, join groups, limits, the roster, status,
  stopping, cleanup; its tools, RPC and TUI part.
- `person/`: what a spawned session needs the person for: permission requests, forms and questions
  (`person/question/` wraps OpenCode's question tool, in Effect code that stays inside the folder);
  the asks inbox.
- `scheduling/`: `courier_later` messages.
- `webhook/`: the receiver and subscriptions.
- `memory/`: one record per session tree, kept in the project by an event module and read back with
  `courier_recall`, with the one line `courier_note` writes on it; its RPC and the memory view.
- `kernel/`: what models see of the protocol in every module (`envelope`, `END_TURN`,
  `describeFailure`, …) and the tool editor.
- `platform/`: the hub, following OpenCode's events, storage helpers and JSON readers; it imports
  nothing outside `platform/`.

Three composition roots sit at the top: `index.ts` (the server plugin), `tui.tsx` (the TUI part) and
`rpc.ts` (the RPC contracts), with `skill.ts` beside them. Only `index.ts` imports several modules'
`index.ts`; nothing imports it.

The import rules:

- A module is imported from outside only through its `index.ts`, except that `tui.tsx` and `rpc.ts`
  take a module's `rpc.ts` and `tui.tsx` directly, so the TUI bundle carries nothing of the server
  half.
- The only dependencies between modules are `person/`'s and `memory/`'s on `tree/`, each through
  `tree/index.ts`, which exports the queries they read (`lineage`, `subtree`, `reportState`,
  `stalledAmong`, `contextOf`, `busy`). Each module may import `platform/**` and `kernel/**`.
- Each module's model-facing strings are pure functions in its `text.ts`, which imports only
  `kernel/**`, `platform/json.ts` and its own `ports.ts` and `domain.ts`. One snapshot test,
  `test/notices.test.ts`, gathers every `text.ts`, the skill and the tool descriptions and schemas.
- `tree/store.ts` is the only file that knows the tree's storage keys; no file outside `tree/` imports
  it, and no other file names its key prefixes. `memory/store.ts` is the same for `memory/`.
- A module's `tui.tsx` imports only `@opencode/plugin/tui`, `solid-js`, `@opentui/*`, its `rpc.ts`,
  its `text.ts` and its `mascot.ts` (`tree/`'s, which imports nothing); a module's `rpc.ts` only
  `@opencode/plugin/rpc` and `effect`.

Why it is shaped so:

- **The platform does not import features.** Features register with it: `index.ts` hands the
  scheduler its ordered tick jobs (`dueJob`, `deliverReleased`, then `wakeMissed`) and the event
  follower its ordered event modules (`treeEvents`, `personEvents`, then `memoryEvents`), each with
  phases (`handle` in list order, `after` in a `finally`, `followed`, `left` and `subscribed` around
  the subscription). There is no application event bus: OpenCode's event stream already is one.
- **Registration lives in this copy's closures, never in the hub's state**, so the hub's shape does
  not change and an unloaded copy leaves nothing behind.
- **The silent-turn rule is a query**, `Waits`, which `tree/` declares and `person/`, `scheduling/`
  and `webhook/` each supply; `index.ts` composes them, so `tree/` does not depend on `person/`.
  Likewise the `context` hook takes the tools other modules hide from a leaf (`hiddenFromLeaf`),
  which `index.ts` names.
- **The memory refreshes in the `after` phase**, once the tree's and the person's notices of a turn's
  end have gone out and the report state is written, and reads only through ports every hub-v2
  member joins with (`storage`, `session`), so it runs through whichever member follows the events.
  What it needs beyond them, the models' context windows and the locations with memory off, is
  process-wide state under the fixed key `opencode-courier.memory`, filled as each instance loads.
- **Text lives next to the module that speaks it**, with one snapshot over all of it.

## Storage

The plugin's storage is OpenCode's KV, shared by every location, copy and server on one data
directory, so a key or a stored value never changes shape. `test/store.test.ts` pins the tree's and
the memory's.

| Key | Holds |
|---|---|
| `roster/<parentID>/<sessionID>` | A child's roster entry: title, directory, `isolated` (with its `source` directory, `project` and `base` commit), `createdAt`, `reports: "status"` (briefed to report with a status), `group`, `native`. |
| `roster-by-child/<sessionID>` | The reverse index: `{ ancestors }`, its parent first and the top session last. Only an index: `roster/` confirms a hit, and is scanned at load for entries lacking one. |
| `report/<sessionID>/prompt` | `{ at }`: when a prompt last reached the session. |
| `report/<sessionID>/settled` | `{ at, by, status }`: when it last reported (`by: "report"`, with the report's `status`), failed or was interrupted. |
| `report/<sessionID>/progress` | `{ at }`: when it last messaged its parent without a status. |
| `report/<sessionID>/told` | `{ at }`: when its parent was last told it ended a turn without a report. |
| `report/<sessionID>/stopped` | `{ at }`: when `courier_stop` stopped it. |
| `group/<parentID>/<name>/<sessionID>` | A join group member: title, `joinedAt`, its held report (`at`, status, text, artifacts) or how it left (`left: { at, by }`, `by` being `failed`, `interrupted`, `deleted` or `dropped`). |
| `later/<id>` | A pending `courier_later` message. |
| `question/<requestID>` | A relayed question, kept until answered (the 100 newest). |
| `webhook/<topic, URI-encoded>/<sessionID>` | A webhook subscription. |
| `wake/<sessionID>/<inboxID>` | A courier message waiting in a session's inbox, until delivered or cancelled: `at`, `text`, `description`, `running`, `idleAt`, `rewoken`, `stalled` ([a missed wake](../reference.md#a-missed-wake)). |
| `scheduler/owner` | `{ server, at }`: the server whose scheduler delivers ([below](#two-servers)). |
| `memory/<projectID>/<topSessionID>` | A session tree's record, field by field in [the reference](../reference.md#memory). |
| `memory/<projectID>/<topSessionID>/pin` | `{ at }`: the person's pin on the record, written only by the memory view's RPC ([beside the record](../reference.md#what-lies-beside-a-record)). |
| `memory/<projectID>/<topSessionID>/reads/<readerTopSessionID>` | `{ shown, read, at }`: how often `courier_recall` calls from the tree under `readerTopSessionID` listed the record or gave it in full, written only by that tree's sessions; summed when the record is read. |

A session owes a report while `prompt` is later than `settled`, and its parent waits for it while
`prompt` is later than `told` too. The prompt's time is the one OpenCode published its delivery at
(the event's `created`), and the report's or the progress's the server's clock as `courier_send`
runs, before it delivers, so an event handled late cannot make a report look older than the prompt
it answers. Each key keeps the later of two times, since both of the hub's subscriptions note every
event and one may be behind. A notice that cannot be delivered takes its `told` back, unless a later
one has told the parent since. The `report/` keys go with the child's roster entry; `forgetReports`
removes orphaned ones at load, reading `report/` before the roster so that a child spawned during
the sweep, whose entry is written before its first report key, is never taken for an orphan. A held
report outlives its member's roster entry, so a group's keys live as long as the entries of its
members still out.

## Several copies in one process

OpenCode runs one instance of the plugin per location (project or worktree), all in one process, and
after an update it loads the new copy of the package next to the old one until the old one unloads.
All instances share one process-wide hub (`opencode-courier.hub` on `globalThis`), where each
scheduled message, released join group, OpenCode event, permission request, form and question is
claimed once before any instance acts on it. The hub runs the scheduler once per process and
follows OpenCode's events through two instances, one a standby, so that an instance unloading leaves
no gap. A webhook receiver started by one instance is the one the others join. The `courier_spawn`
calls under way, the types of the items entering spawned sessions' inboxes, and the forms shown now
are kept process-wide under fixed keys of their own, so spawns in every location and copy count
against the limits together, whichever instance sees an item's delivery knows what it was, and every
instance's footer and tree panel see a form.

The hub carries a version, `HUB_VERSION`, which changes only when its shape or the meaning of a field
does (2 since the join groups: the tick delivers released groups too, and takes a nudge to run at
once). A copy that finds a hub of another version runs its own, under a key of its version, and logs
one line saying so. The claim sets are shared across hub versions, under keys whose shape and
meaning are fixed for good, so an old and a new copy loaded together never both deliver or tell the
same thing; a change that needed another meaning for one would make a new key and keep claiming in
the old one as well.

**Version skew.** What a scheduler tick and an event subscription do is the code of the copy loaded
last, run through the instance loaded first (or the earliest without a subscription), which may
belong to an older copy of the same hub version. So the ports an instance joins the hub with are part
of that version too: a tick job or event module may use only ports every hub-v2 member has, and one
that needed a port older instances lack would change the version. A copy that unloads takes its code
with it; the hub keeps none of it. The hub types only what it owns: a member's feature ports and the
feature state it keeps are opaque to it, typed by their owners, who take a value under its fixed key
through `sharedState`.

When an instance unloads, OpenCode waits up to 2 seconds for the work it leaves behind: a tick running
through it, the event subscription it ran (once its replacement has started), and what it started on
loading. Past that, what is under way finishes on its own.

## Two servers

Two OpenCode servers on one data directory share the storage but not the hub
([plugin-api-notes.md](plugin-api-notes.md#two-servers-on-one-data-directory)). The scheduler's owner
key, `scheduler/owner`, picks the one that delivers `courier_later` messages and released groups, and
wakes a session whose wake was missed:

- A server's scheduler delivers while it holds the key, renewing it as it goes, and skips its tick
  while another server's key is less than 60 seconds old (four ticks, so a tick or two skipped by a
  busy event loop does not hand it over).
- A missing or expired key is taken after a random wait of 0.5 to 1 second and a read back, so of two
  servers taking it at once only one delivers, and two re-taking it in the same rhythm do not keep
  finishing in step.
- The owner renews its key without reading it back only while it is less than 30 seconds old, half
  the expiry, which leaves another server 30 seconds of stall before it could take over; an older one
  is taken again like a free one.
- A graceful stop releases the key; after a crash or stall another server takes over within about 75
  seconds.

With no compare-and-set in the storage, a message delivered twice takes a process stalling for half a
second or more between two storage calls, or a delivery running for over a minute. Releases before
the key (0.2.2 and earlier) deliver on their own schedule beside the owner. The live suite's restart
scenario checks the key's lifecycle; `e2e/two-servers.sh` checks that no message is delivered twice.

## The TUI part

The package has three entrypoints: `.` (`dist/index.js`, the server plugin), `./tui` (`dist/tui.js`)
and `./rpc` (`dist/rpc.js`). The server runs only the first; the TUI loads `tui`. `dist/tui.js` is
bundled by `script/build-tui.ts` with OpenTUI's Solid transform, since the host compiles no JSX under
`node_modules`, and with every package left external: the host provides `@opencode/plugin/tui`,
`solid-js`, `@opentui/*` and `effect` to a TUI part, so the package declares none of them for it (the
`effect` peer is the server half's). A peer for them broke `opencode plugin add`
([plugin-api-notes.md](plugin-api-notes.md#tui-and-rpc-entrypoints)); they are devDependencies at the
versions of OpenCode's catalog, for the typecheck and the unit tests. `tsconfig.build.json` leaves the
`tui.tsx` files out of the `tsc` build, and `tsconfig.tui.json` writes `dist/tui.d.ts`.

What the TUI part does goes through the same use cases as the tools (`courier_tree`'s walk,
`courier_stop`'s `stop()`, `courier_answer`'s answer path, the memory's store), over the RPCs
`courier`, `courier-person` and `courier-memory` that each instance registers at its location, so a
model sees only what the tools would tell it. The memory view is a dialog rather than a panel: the
records are the project's, not a session's, and a panel belongs to one session, closed on every route
change; the host's own Sessions dialog is a select with footer actions, which the pinned plugin API
gives a plugin too (`actions` on `dialog.select`, drawn and run by the host without closing the
dialog). `e2e/tui.sh` checks it all live, in `tmux`.
