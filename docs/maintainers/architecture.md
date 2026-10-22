# Architecture

Why the code is shaped as it is. [CLAUDE.md](../../CLAUDE.md)'s Layout is the file-by-file map, and
`test/imports.test.ts` enforces the import rules.

## Modules

`src/` is split by feature: `tree/`, `person/`, `scheduling/`, `webhook/` and `memory/`, each
hexagonal inside. `kernel/` holds what models see of the protocol; `platform/` the hub, events and
storage helpers. Three composition roots sit on top: `index.ts` (the server plugin), `tui.tsx` and
`rpc.ts`.

- **The platform does not import features.** `index.ts` hands it the ordered tick jobs and event
  modules. There is no event bus of our own: OpenCode's event stream is one.
- **Registration lives in this copy's closures, never in the hub's state**, so the hub's shape does
  not change and an unloaded copy leaves nothing behind.
- **The silent-turn rule is a query**, `Waits`, which `tree/` declares and `person/`, `scheduling/`
  and `webhook/` supply. `index.ts` composes it, so `tree/` does not depend on `person/`. The
  `context` hook takes the tools to hide from a leaf (`hiddenFromLeaf`) the same way.
- **The memory refreshes in the `after` phase**, once the turn-end notices are out and the report
  state is written. It reads only through ports every hub-v2 member has (`storage`, `session`). What
  it needs beyond them is process-wide, under the key `opencode-courier.memory`.
- **The TUI bundle carries nothing of the server half**: `tui.tsx` and `rpc.ts` import modules'
  `tui.tsx` and `rpc.ts` directly. The TUI part goes through the same use cases as the tools, over
  the RPCs `courier`, `courier-person` and `courier-memory`. The memory view is a dialog, not a
  panel: the records are the project's, and a panel belongs to one session.
- **Text lives next to the module that speaks it**, with one snapshot over all of it.

The import rules:

- A module is imported from outside only through its `index.ts`, except that `tui.tsx` and `rpc.ts`
  take a module's `tui.tsx` and `rpc.ts` directly.
- The only dependencies between modules are `person/`'s and `memory/`'s on `tree/`, through
  `tree/index.ts`. Each module may import `platform/**` and `kernel/**`; `platform/` imports
  nothing outside itself.
- A module's `text.ts` imports only `kernel/**`, `platform/json.ts` and its own `ports.ts` and
  `domain.ts`.
- `tree/store.ts` and `memory/store.ts` are the only files that know their storage keys; no file
  outside the module imports them, and no other file names their key prefixes.
- A module's `tui.tsx` imports only `@opencode/plugin/tui`, `solid-js`, `@opentui/*`, its `rpc.ts`,
  `text.ts` and `mascot.ts`; a module's `rpc.ts` only `@opencode/plugin/rpc` and `effect`.

## Storage

The storage is OpenCode's KV, shared by every location, copy and server on one data directory. So a
key or a stored value never changes shape. It has no compare-and-set, so what two writers could
race on gets keys of its own, one writer each (a record's pin and reads). `test/store.test.ts` pins
the tree's and the memory's keys.

| Key | Holds |
|---|---|
| `roster/<parentID>/<sessionID>` | A child's entry: title, directory, `isolated` (with `source`, `project` and `base` commit), `createdAt`, `reports: "status"`, `group`, `native`. |
| `roster-by-child/<sessionID>` | `{ ancestors }`, parent first, top last. Only an index: `roster/` confirms a hit. |
| `report/<sessionID>/prompt` | `{ at }`: when a prompt last reached the session. |
| `report/<sessionID>/settled` | `{ at, by, status }`: when it last reported, failed or was interrupted. |
| `report/<sessionID>/progress` | `{ at }`: when it last messaged its parent without a status. |
| `report/<sessionID>/told` | `{ at }`: when its parent was last told of a silent end. |
| `report/<sessionID>/stopped` | `{ at }`: when `courier_stop` stopped it. |
| `group/<parentID>/<name>/<sessionID>` | A member: title, `joinedAt`, its held report, or `left: { at, by }`. |
| `later/<id>` | A pending `courier_later` message. |
| `question/<requestID>` | A relayed question, until answered (the 100 newest). |
| `webhook/<topic, URI-encoded>/<sessionID>` | A subscription. |
| `wake/<sessionID>/<inboxID>` | A courier message waiting in an inbox: `at`, `text`, `description`, `running`, `idleAt`, `rewoken`, `stalled`. |
| `scheduler/owner` | `{ server, at }`: the server whose scheduler delivers. |
| `memory/<projectID>/<topSessionID>` | A tree's record. |
| `memory/<projectID>/<topSessionID>/pin` | `{ at }`: the person's pin, written only by the memory view. |
| `memory/<projectID>/<topSessionID>/reads/<readerTopSessionID>` | `{ shown, read, at }`, written only by the reader tree; summed when read. |

A session owes a report while `prompt` is later than `settled`. Its parent waits on it while
`prompt` is later than `told` too. The prompt's time is the event's `created`; the report's is the
server clock as `courier_send` runs, before it delivers, so a late event cannot make a report look
older than its prompt. Each key keeps the later of two times, since both hub subscriptions note
every event. `forgetReports` reads `report/` before the roster at load, so a child spawned during
the sweep is never taken for an orphan. A held report outlives its member's roster entry.

## Several copies in one process

OpenCode runs one plugin instance per location, all in one process. After an update it loads the
new copy next to the old one until the old one unloads. All instances share one hub
(`opencode-courier.hub` on `globalThis`), where each scheduled message, released group, event,
request, form and question is claimed once before any instance acts on it. The hub runs one
scheduler and follows events through two instances, one a standby, so an unload leaves no gap.
Spawns under way, inbox item types and shown forms are process-wide under fixed keys of their own.

The hub carries `HUB_VERSION`, changed only when its shape or a field's meaning does. A copy that
finds another version runs its own hub under its version's key and logs one line. The claim sets are
shared across versions under keys whose meaning is fixed for good. A change that needs another
meaning makes a new key and keeps claiming in the old one too.

**Version skew.** A tick or event subscription runs the code of the copy loaded last, through the
instance loaded first, which may be an older copy of the same hub version. So a tick job or event
module may use only ports every hub-v2 member has; needing a new one changes the version. The hub
types only what it owns; feature ports and state are typed by their owners through `sharedState`.

On unload OpenCode waits up to 2 seconds for work the instance leaves behind.

## Two servers

Two servers on one data directory share the storage but not the hub. The owner key,
`scheduler/owner`, picks the one whose scheduler delivers and re-sends missed wakes:

- The owner renews the key as it delivers. Others skip their tick while the key is under 60 seconds
  old (four ticks).
- A missing or expired key is taken after a random wait of 0.5 to 1 second and a read back, so of
  two servers only one wins.
- The owner renews without reading back only while the key is under 30 seconds old.
- A graceful stop releases the key. After a crash, another server takes over within about 75
  seconds.

A double delivery needs a stall of half a second or more between two storage calls, or a delivery
running over a minute. Releases up to 0.2.2 deliver on their own schedule beside the owner.
`e2e/two-servers.sh` checks that no message is delivered twice.
