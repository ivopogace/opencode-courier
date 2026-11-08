# Codebase details report, round 6

Reviewer: `egm:egm-codebase-details`. Read `src/tree/{limits,report,text,cleanup,forget,stop,send,wake,events,spawn,domain,tools}.ts`, `src/skill.ts` and `docs/reference.md:145-180` at 8a3f054.

## The #538 claims hold

`stillCounts` (`src/tree/text.ts:179-180`): a blocked child "counts until it reports or ... drops it with courier_cleanup".

- Idle and blocked: `live` returns "blocked" (`src/tree/limits.ts:19-23`, `src/tree/report.ts:35`); counted in `mine` (`limits.ts:51-52`, `:59`).
- Stopped while idle, by its parent or by an ancestor: `interrupt` writes no settled note (`src/tree/stop.ts:106-109`); `forgetWakes` (`stop.ts:98`) clears a queued answer; it stays "blocked" and counts.
- Answered, the answer in its inbox: `waitsInInbox` makes it "live"; once delivered, `notePrompt` (`src/tree/events.ts:126`) sets a new prompt, so it owes and is "live".
- Interrupted while running, or failed: `ended` (`report.ts:33`), not counted, matching "unless it failed or was interrupted".
- "A session also counts while one it started is live": `check` adds ancestors only for "live" (`limits.ts:49-53`); the refusal names live and blocked separately, and `docs/reference.md:163-164` says a blocked session makes none above it live.
- `whoDrops` in `totalRefusal`: shown only when `yours > 0` (`text.ts:189-193`); the only action it asks concerns the caller's own children, which it can drop.

## Raw items

- **C-1 (raised as major): a `kept` cleanup drops nothing.** `src/tree/cleanup.ts:32-40` returns `kept` before `forget()`, so the entry stays, counts and holds its group. The result (`src/tree/text.ts:311-312`) says "Commit or branch what you want to keep, or call courier_cleanup again with force: true", without saying the session is still listed and counted, and the tool description's "Either way, one in a join group that has not reported is dropped from it" (`src/tree/tools.ts:221-222`) is not true of a kept worktree. Scenario: a refused parent cleans up its stopped blocked child, gets `kept`, commits, and ends its turn believing the slot freed.
- **C-2 (raised as minor): `docs/reference.md:172` "A child counts from the moment `courier_send` to it returns"**, read as naming the wrong tool for a spawn.
- **C-3 (raised as nit): a session stops counting without a report or its parent's cleanup** when an ancestor's entry is dropped (`limits.ts:44-45`, `src/tree/domain.ts:137-141`) or the session is deleted (`limits.ts:14,18`). Every exception frees room; no false limit.

No other contradiction in `SKILL_CONTENT` or the tool descriptions in `src/tree/tools.ts`.
