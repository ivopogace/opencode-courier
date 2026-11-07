# Architecture

Why the code is shaped as it is. [CLAUDE.md](../../CLAUDE.md)'s Layout is the short map, and
`test/imports.test.ts` enforces the import rules.

## Modules

`src/` is split by feature: `tree/`, `person/`, `scheduling/` and `memory/`, each hexagonal inside
where it has domain rules (`scheduling/` has no `ports.ts` or `domain.ts`). `kernel/` holds what models see of the protocol; `platform/` the hub, events and
storage helpers. Two composition roots sit on top: `index.ts` (the server plugin) and `tui.tsx`.
The third entrypoint, `rpc.ts`, composes nothing: it only re-exports the modules' RPC contracts.

- **The platform does not import features.** `index.ts` hands it the ordered tick jobs and event
  modules. There is no event bus of our own: OpenCode's event stream is one.
- **Registration lives in closures, not in new hub fields**, so the hub's shape does not change.
  The hub's `subscribe` and its scheduler's `tick` are the last-loaded copy's, and leaving clears
  neither (see Version skew).
- **The silent-turn rule is a query**, `Waits`, which `tree/` declares and `person/` and
  `scheduling/` supply. `index.ts` composes it, so `tree/` does not depend on `person/`. The
  `context` hook takes the tools to hide from a leaf (`hiddenFromLeaf`) the same way.
- **The memory refreshes in the `after` phase**, once the turn-end notices are out and the report
  state is written. It reads only through ports every hub-v2 member has (`storage`, `session`, `now`,
  `log`). What it needs beyond them is process-wide, under the key `opencode-courier.memory`.
- **The TUI bundle carries no server wiring** (no `index.ts`, tool, store or hub): the `tui.tsx` and
  `rpc.ts` entrypoints skip the modules' `index.ts` (see the import rules), and a module's `tui.tsx`
  shares with the server only its `rpc.ts`, its `text.ts` and the pure code those import. The TUI
  part goes through the same use cases as the tools, over the RPCs `courier`, `courier-person` and
  `courier-memory`. The memory view is a dialog, not a panel: the records are the project's, and a
  panel belongs to one session.
- **Text lives next to the module that speaks it**, with one snapshot over all of it.

The import rules:

- A module is imported from outside only through its `index.ts`, except by the two other
  entrypoints. `src/tui.tsx` imports only `@opencode/plugin/tui` itself (no subpath, no `solid-js`
  or `@opentui/*`) and modules' `tui.tsx` and `rpc.ts`; `src/rpc.ts` imports only modules'
  `rpc.ts`.
- The only dependencies between modules are `person/`'s and `memory/`'s on `tree/`, through
  `tree/index.ts`. Each module may import `platform/**` and `kernel/**`; `platform/` imports
  nothing outside itself.
- A module's `text.ts` imports only `kernel/**`, `platform/json.ts` and its own `ports.ts` and
  `domain.ts`.
- `tree/store.ts` and `memory/store.ts` are the only files that know their storage keys; no file
  outside the module imports them, and no other file names their key prefixes.
- A module's `tui.tsx` imports only `@opencode/plugin/tui`, `solid-js` (each with its subpaths),
  `@opentui/*`, its `rpc.ts`, `text.ts` and `mascot.ts`; a module's `rpc.ts` only
  `@opencode/plugin/rpc` and `effect`.

## Storage

The storage is OpenCode's KV, shared by every location, copy and server on one data directory. So a
key or a stored value never changes shape. It has no compare-and-set, so what two writers could
race on gets keys of its own, one writer each (a record's pin and reads). `test/store.test.ts` pins
the tree's and the memory's keys.

| Key | Holds |
|---|---|
| `roster/<parentID>/<sessionID>` | A child's entry: title, directory, `isolated` (with `source`, `project` and `base` commit), `createdAt`, `reports: "status"`, `group`, `native`, `model` (`provider/model#variant`, when not its parent's). |
| `roster-by-child/<sessionID>` | `{ ancestors }`, parent first, top last. Only an index: `roster/` confirms a hit. |
| `report/<sessionID>/prompt` | `{ at }`: when a prompt last reached the session. |
| `report/<sessionID>/settled` | `{ at, by, status, resumesAt }`: when it last reported, failed or was interrupted; `resumesAt` only for a failed turn whose provider limit gave a retry time, the event's `created` plus `retryAfterMs`. |
| `report/<sessionID>/progress` | `{ at }`: when it last messaged its parent without a status. |
| `report/<sessionID>/told` | `{ at }`: when its parent was last told of a silent end. |
| `report/<sessionID>/stopped` | `{ at }`: when `courier_stop` stopped it. |
| `report/<sessionID>/nudged` | `{ at, inboxID }`: when it was last reminded to report, and the reminder's inbox id, whose delivery is not noted as a prompt. One reminder while `nudged` is no earlier than `prompt`. |
| `group/<parentID>/<name>/<sessionID>` | A member: title, `joinedAt`, its held report, or `left: { at, by }`. |
| `later/<id>` | A pending `courier_later` message. |
| `question/<requestID>` | A relayed question, until answered (the 100 newest). |
| `wake/<sessionID>/<inboxID>` | A courier message waiting in an inbox: `at`, `text`, `description`, `running`, `idleAt`, `rewoken`, `stalled`. |
| `scheduler/owner` | `{ server, at }`: the server whose scheduler delivers. |
| `memory/<projectID>/<topSessionID>` | A tree's record. |
| `memory/<projectID>/<topSessionID>/pin` | `{ at }`: the person's pin, written only by the memory view. |
| `memory/<projectID>/<topSessionID>/reads/<readerTopSessionID>` | `{ shown, read, at }`, written only by the reader tree; summed when read. |

Releases up to 0.13.8 also wrote `webhook/<topic>/<sessionID>`, a webhook subscription. Nothing
reads those keys now, and none is written again.

A session owes a report while `prompt` is later than `settled`. Its parent waits on it while
`prompt` is later than `told` too. The prompt's time is the event's `created`; the report's is the
server clock as `courier_send` runs, before it delivers, so a late event cannot make a report look
older than its prompt. A note to `prompt`, `settled`, `progress` or `told` keeps the later of two
times, since both hub subscriptions note every event; `stopped` and `nudged` are overwritten. A
failed `courier_send` or silent-end notice undoes its own note if the key still holds it.
`pruneExpired` reads `report/` before the roster at load, so a child spawned during the sweep is
never taken for an orphan. A held report outlives its member's roster entry.

## Missed wakes and session state

The host facts behind this are in [plugin-api-notes.md](plugin-api-notes.md#the-inbox-and-wakes).

- **The wake store** (`wake/`) holds courier messages waiting in an inbox, which the limits and the
  memory's `finished` count (`waitsInInbox`). `courier_send` writes that row itself once `synthetic`
  returns (`noteSent`), since the enqueued event is handled apart from the call.
- **Is it running** (`busy`, `src/tree/domain.ts`; `runs`, `src/tree/running.ts`) reads `time.busy`
  first: `busy` not later than `idle` is rest at `idle`, with no transcript read and none of the
  caching below, whatever a rename, an archive, a switch or a waiting inbox item stamped on
  `updated`; `busy` later than `idle`, or set with no `idle`, goes by the transcript; `busy` absent
  (a host before 2.2.2) goes by `updated > idle` and then the transcript. A new `busy` is a new
  stamp for the cache.
- **The cache.** Each instance caches the answer per session (`ANSWERS_MAX`, 500 per port) until the
  next stamp. A rest read within `FRESH_MS` (10 seconds) of its stamp is read again; a rest answer
  is kept `REST_MS` (30 seconds) at most, a running one until the next stamp. An unreadable or empty
  transcript reads running.
- **Re-sending** (`wakeAgain`, `src/tree/wake.ts`) reads the session first, in case a turn's
  `started` came before the subscription: a `busy` at or after the message was last left waiting
  (enqueued, seen waiting as a turn ended, or sent again) and later than `idle` marks the message as
  a running turn's to take; an earlier one, or one `idle` has passed (that execution ended, its event
  missed), re-sends, with no transcript read. Without `busy` only a transcript actually read marks
  it running, so a failed read re-sends.

## Instruction entries

The courier writes three [keyed session instructions](plugin-api-notes.md#keyed-session-instructions):

- `role`: a spawned session's role part (`spawn.ts`, before the first prompt, so it is in the
  baseline and moves no cached prefix).
- `lessons`: the project's lessons, to a session above the deepest level when memory is on and has
  lessons (`spawn.ts`; `memory/lessons.ts` supplies the text and `courier_note` renews it).
- `standing`: a parent's children (`tree/standing.ts`, from the tools and events that move a child,
  removed with the last child).

Each value stays well under 3 KiB. `standing` and `lessons` are `list`ed and compared before a put
that may be the same, so an unchanged value costs one read and no write. The `context` hook lists a
session's entries once per instance and session.

## `courier_later`'s scheduler

`courier_later` keeps its own scheduler rather than OpenCode's
[schedules](plugin-api-notes.md#opencodes-schedules): a plugin cannot reach them, they are a feature
flag off in release builds, and a firing carries no sender's envelope, does not wait for a running
turn to end, tells `Waits` nothing and cannot be cancelled by `courier_stop`. The `experimental.idle`
hook has no clock, so it cannot wake a session later. `e2e/run.sh`'s `schedules` group turns the
flag on to cover `CHILD_RULES`.

## Several copies in one process

OpenCode runs one plugin instance per location, all in one process. After an update it loads the
new copy next to the old one until the old one unloads. All instances share one hub
(`opencode-courier.hub` on `globalThis`), where each scheduled message, released group, event,
request, form and question is claimed once before any instance acts on it. The hub runs one
scheduler and follows events through two instances, both active, so an unload leaves no gap.
Spawns under way, inbox item types and shown forms are process-wide under fixed keys of their own.

The hub carries `HUB_VERSION`, changed only when its shape or a field's meaning does. A copy that
finds another version runs its own hub under its version's key and logs one line. The claim sets are
shared across versions under keys whose meaning is fixed for good. A change that needs another
meaning makes a new key and keeps claiming in the old one too.

**Version skew.** A tick or event subscription runs the code of the copy loaded last, through the
instance loaded first, which may be an older copy of the same hub version. So a tick job or event
module may use only ports every hub-v2 member has; needing a new one changes the version. A port
that may be missing is optional and skipped: the keyed session instructions (`instructions` on a
member's watch session), which the `standing` entry needs, are left alone on a host before 2.2.0;
every copy's watch session is the host's `ctx.session`, so an older member's ports carry them too. The hub
types only what it owns; feature ports and state are typed by their owners through `sharedState`.
Each event module declares the event types it handles (`types`), and both hub subscriptions ask
`event.subscribe` for their union; one module without a declaration leaves them unfiltered.
The shared claim sets stay plain `Set`s and `Map`s, bounded by functions (`platform/bounded.ts`),
since older copies call `.has` and `.add` on them.

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
