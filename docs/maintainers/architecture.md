# Architecture

Why the code is shaped as it is. [CLAUDE.md](../../CLAUDE.md)'s Layout is the short map, and
`test/imports.test.ts` enforces the import rules.

## Modules

`src/` is split by feature: `tree/`, `person/` and `scheduling/`, each hexagonal inside
where it has domain rules (`person/` has no `domain.ts`, `scheduling/` neither `ports.ts` nor `domain.ts`). `kernel/` holds what models see of the protocol; `platform/` the hub, events and
storage helpers. Two composition roots sit on top: `index.ts` (the server plugin) and `tui.tsx`.
The third entrypoint, `rpc.ts`, composes nothing: it only re-exports the modules' RPC contracts.

- **The platform does not import features.** `index.ts` hands it the ordered tick jobs and event
  modules. There is no event bus of our own: OpenCode's event stream is one.
- **Registration lives in closures, not in new hub fields**, so the hub's shape does not change.
  The hub's `subscribe` and its scheduler's `tick` are the last-loaded copy's, and leaving clears
  neither (see Version skew).
- **The silent-turn rule is a query**, `Waits`, which `tree/` declares and `person/` and
  `scheduling/` supply. `index.ts` composes it, so `tree/` does not depend on `person/`.
- **The TUI bundle carries no server wiring** (no `index.ts`, tool, store or hub): the `tui.tsx` and
  `rpc.ts` entrypoints skip the modules' `index.ts` (see the import rules), and a module's `tui.tsx`
  shares with the server only its `rpc.ts`, its `text.ts` and the pure code those import. The TUI
  part goes through the same use cases as the tools, over the RPCs `courier` and `courier-person`.
- **Text lives next to the module that speaks it**, with one snapshot over all of it.

The import rules; `test/imports.test.ts` states them in full, with a few more (no import cycles,
the top-level files of `src/`, which files may import the TUI's packages):

- A module is imported from outside only through its `index.ts`, except by the `tui.tsx` and
  `rpc.ts` entrypoints, which reach only modules' `tui.tsx` and `rpc.ts`. A module's `tui.tsx`
  imports only the TUI's host-provided packages and its own `rpc.ts`, `text.ts` and `mascot.ts`; a
  module's `rpc.ts` only `@opencode/plugin/rpc` and `effect`.
- The only dependency between modules is `person/`'s on `tree/`. Each module may import
  `platform/**` and `kernel/**`; `platform/` imports nothing outside itself.
- What must stay pure does: `kernel/` and `tree/domain.ts` import only `kernel/**` and
  `platform/json.ts`; `skill.ts` only `kernel/**`; a module's `text.ts` those and its own module's
  `ports.ts` and `domain.ts`. `tree/mascot.ts` and `platform/bounded.ts` import nothing.
- `tree/store.ts` is the only file that knows its storage keys; no file outside `tree/` imports it,
  and no other file names its key prefixes.
- `effect` is imported only by `person/question/`, `index.ts`, the `tools.ts` and the `rpc.ts` files.
- Only `index.ts` imports more than one module's `index.ts`, and nothing imports it.

## Storage

The storage is OpenCode's KV, shared by every location, copy and server on one data directory. So a
key or a stored value never changes shape. It has no compare-and-set, so what two writers could
race on gets keys of its own, one writer each. `test/store.test.ts` pins the tree's keys.

| Key | Holds |
|---|---|
| `roster/<parentID>/<sessionID>` | A child's entry: `sessionID`, `parentID`, title, directory, `isolated` (with `source`, `project` and `base` commit), `createdAt`, `reports: "status"`, `native`, `model` (`provider/model#variant`, when not its parent's). |
| `roster-by-child/<sessionID>` | `{ ancestors }`, parent first, top last. Only an index: `roster/` confirms a hit. |
| `report/<sessionID>/prompt` | `{ at }`: when a prompt last reached the session. |
| `report/<sessionID>/settled` | `{ at, by, status, resumesAt }`: when it last reported, failed or was interrupted; `resumesAt` only for a failed turn whose provider limit gave a retry time, the event's `created` plus `retryAfterMs`. |
| `report/<sessionID>/progress` | `{ at }`: when it last messaged its parent without a status. |
| `report/<sessionID>/told` | `{ at }`: when its parent was last told of a silent end. |
| `report/<sessionID>/stopped` | `{ at }`: when `courier_stop` stopped it. |
| `report/<sessionID>/nudged` | `{ at, inboxID }`: when it was last reminded to report, and the reminder's inbox id, by which its delivery is not noted as a prompt when its `enqueued` was missed. One reminder while `nudged` is no earlier than `prompt`. |
| `later/<id>` | A pending `courier_later` message. |
| `question/<requestID>` | A relayed question, until answered, at most 14 days (the 100 newest). |
| `typed/<sessionID>/<inboxID>` | `{ at, text }`: a `user` item typed into a spawned session, from its enqueue until its fan-up is sent or skipped, or the session is forgotten. |
| `passed/<sessionID>/<inboxID>` | `{ at, text, to, delivered }`: text the fan-up passed up, its first 200 characters, the sessions it reached and when it was delivered, until a committed revert removes its message or the session is deleted. It outlives the session's roster entry. |
| `wake/<sessionID>/<inboxID>` | A courier message waiting in an inbox: `at`, `text`, `description`, `running`, `idleAt`, `rewoken`, `stalled`. |
| `scheduler/owner` | `{ server, at }`: the server whose scheduler delivers. |

A user's storage may also hold `webhook/<topic>/<sessionID>`, `memory/<projectID>/<topSessionID>`
with its `pin` and `reads/`, and `group/<parentID>/<name>/<sessionID>` keys, and a `group` field on
a roster entry, written by earlier releases. Nothing reads or writes them.

A session owes a report while `prompt` is later than `settled`. Its parent waits on it while
`prompt` is later than `told` too. The prompt's time is the event's `created`; the report's is the
server clock as `courier_send` runs, before it delivers, so a late event cannot make a report look
older than its prompt. A note to `prompt`, `settled`, `progress` or `told` keeps the later of two
times, since both hub subscriptions note every event; `stopped` and `nudged` are overwritten. A
failed `courier_send` or silent-end notice undoes its own note if the key still holds it.
`pruneExpired` reads `report/` before the roster at load, so a child spawned during the sweep is
never taken for an orphan.

A `passed/` row holds all a take-back needs once `courier_cleanup` or the roster's expiry has
forgotten the session: `to` names the sessions to tell, and the tree that must be at work is the one
under the roster's top for the session, or, without a roster entry, under the top above the highest
session in `to`. Only a committed revert that takes its message and `session.deleted` remove a row;
a compaction that passes its message leaves it. The load sweep drops the `passed/` rows of a session
the host [does not find](plugin-api-notes.md#locations), whatever the roster says, and the
`typed/` rows of a session with no roster entry.

## Missed wakes and session state

The host facts behind this are in [plugin-api-notes.md](plugin-api-notes.md#the-inbox-and-wakes).

- **The wake store** (`wake/`) holds courier messages waiting in an inbox, which the limits count
  (`waitsInInbox`). `courier_send` writes that row itself once `synthetic`
  returns (`noteSent`), since the enqueued event is handled apart from the call.
- **Is it running** (`busy` in `src/tree/domain.ts`, `runs` in `src/tree/running.ts`) trusts
  `time.busy` against `time.idle` first and reads the transcript only when they cannot tell, since
  `time.updated` moves for things that are no turn. Each instance caches the answer per session until
  the next stamp; a rest answer is re-read soon after its stamp and kept only briefly, because a
  delivered item stamps nothing until its first step. An unreadable or empty transcript reads
  running.
- **Re-sending** (`wakeAgain`, `src/tree/wake.ts`) reads the session first, in case a turn's
  `started` came before the subscription: a `busy` since the message was last left waiting, and
  later than `idle`, leaves the message to that running turn; otherwise it re-sends. Without `busy`
  only a transcript actually read marks it running, so a failed read re-sends.

## Instruction entries

The courier writes two [keyed session instructions](plugin-api-notes.md#keyed-session-instructions):

- `role`: a spawned session's role part (`spawn.ts`, before the first prompt, so it is in the
  baseline and moves no cached prefix). At a parent's first `native: true` spawn, `spawn.ts` puts
  its entry again, ending with the line about OpenCode's own message at a
  [native child's turn end](plugin-api-notes.md#native-parentid): that put comes after the
  parent's first prompt, so it leaves the baseline and the cached prefix alone and reaches the model
  as one instruction update, as a root's entry does at its first spawn. Later native spawns put the
  same value, which announces nothing; the puts for one parent run one at a time, so two spawns in
  one step cannot leave the older value. Where the role goes in a system part instead, `context.ts`
  adds the same line.
- `standing`: a parent's children (`tree/standing.ts`, from the tools and events that move a child,
  removed with the last child).

A fork copies a session's entries; `tree/fork.ts` removes `role` and `standing` from it and leaves
any other, such as a `lessons` entry an earlier release wrote.

Each value stays well under 3 KiB. `standing` is `list`ed and compared before a put
that may be the same, so an unchanged value costs one read and no write. The `context` hook lists a
session's entries once per instance and session.

## `courier_later`'s scheduler

`courier_later` keeps its own scheduler rather than OpenCode's
[automations](plugin-api-notes.md#opencodes-automations): a person can turn them off, the plugin API
sends no event for them, and a firing carries no sender's envelope, does not wait for a running
turn to end, tells `Waits` nothing and cannot be cancelled by `courier_stop`. The `experimental.idle`
hook has no clock, so it cannot wake a session later. `e2e/run.sh`'s `schedules` group covers
`CHILD_RULES`.

The hub's tick, every 15 seconds, delivers what is due, and is the only way for a message that fell
due before the plugin loaded. On top of it `scheduling/timer.ts` keeps one timer per message due
within two ticks (`NEAR_MS`), so a message arrives within about a second of its time:

- `schedule` sets the timer of a message that is near, and each tick's scan of `later/` those of
  the messages that have come near, another server's included. `cancel` and the delivery clear it.
- A timer delivers nothing. It asks the hub for a tick at once (`tickNow`, behind a tick under way),
  so the owner key and the claim set decide as at any tick: a server that is not the owner delivers
  nothing, and a message it scheduled under a tick ahead waits for the owner's next tick.
- A timer that fires before the clock reaches its message's time is set again by the tick it asked
  for.
- The timers live in memory, per loaded copy, and do not hold the process open. None runs longer
  than `NEAR_MS`, so a far-away time never meets `setTimeout`'s limit, and the ones a copy leaves
  behind when it unloads fire within that time, each asking for a tick like any other.

## Several copies in one process

OpenCode runs one plugin instance per location, all in one process. After an update it loads the
new copy next to the old one until the old one unloads. All instances share one hub
(`opencode-courier.hub` on `globalThis`), where each scheduled message, missed wake, event,
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
- A missing or expired key is written, then read back after a random wait of 0.5 to 1 second, so
  of two servers only one wins.
- The owner renews without reading back only while the key is under 30 seconds old.
- A graceful stop releases the key. After a crash, another server takes over within about 75
  seconds.

A double delivery needs a stall of half a second or more between two storage calls, or a delivery
running over a minute.
`e2e/two-servers.sh` checks that no message is delivered twice.
