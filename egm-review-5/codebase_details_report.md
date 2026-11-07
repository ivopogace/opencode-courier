# EGM round 3, codebase-details review: courier-orchestrate at 2dacfe4

Reviewer: `egm:egm-codebase-details`. Read every file in scope, `CLAUDE.md`, the round-2 reports and the diff since 476df67. Nothing was run. Line numbers on 2dacfe4.

**Verdict:** R2-F1, R2-F2, R2-F3 and R2-F5 resolved; R2-F4 partly (code narrower, round-2 example still exempt). No blocking or major items; 3 minor, 4 nits, at the edges of the new counting text.

## A. The round-2 findings

| Item | Status |
| --- | --- |
| R2-F1 | **Resolved.** `inTurn` (`src/tree/limits.ts:19-20`) with `reportedAt` (`src/tree/report.ts:35`); refusals and `stillCounts` (`src/tree/text.ts:179-192`); `check` counts ancestors of a live session (`limits.ts:46-48`); `live()` says "still owes a report". Leftovers: K-1, K-4. |
| R2-F2 | **Resolved.** `tellParent` falls through to `lastStatus === "blocked"` (`src/tree/stop.ts:166-168`, `src/tree/text.ts:382-387`); description `src/tree/tools.ts:205` and `docs/reference.md:521-525` match. |
| R2-F3 | **Resolved.** `src/skill.ts:41-44` matches the brief (`text.ts:21-28`) and `docs/reference.md:269-272`. |
| R2-F4 | **Partly resolved.** Only a message scheduled before the report is exempt (`src/tree/events.ts:86-98`, `src/scheduling/later.ts:108`). R2-F4's own example is scheduled before the report, so still exempt; the reference says "check-in" (K-5). |
| R2-F5 | **Resolved** (`src/scheduling/text.ts:4-5`). Nit: K-6. |

## B and C. Findings

### K-1 (minor): `stillCounts` says every session that ended without a report counts until cleanup; failed and interrupted ones do not, and reporting also ends the count
- `text.ts:180`. A failed turn records `settled.by = "failed"` (`events.ts:40`), an interrupt `"interrupted"` (`events.ts:133`, `stop.ts:108`); `reportOf` gives `owes: false, ended: true` (`report.ts:28-34`), so `live` is false unless something below is live (`limits.ts:20-22`). Only a silent end or an idle stop of an owing session keeps `owes`. The refusal also omits "until it reports" (`silentNotice` `text.ts:477`, `docs/reference.md:166`).
- Scenario: one failed and one silent child at `maxChildren`; the parent cleans up the failed one and frees nothing.
- Fix: "one whose turn ended without a report (not failed or interrupted) counts until it reports or until you drop it with courier_cleanup".

### K-2 (minor): an idle child that sent `blocked` does not count, but the texts treat it as still owing; answering it goes past `maxChildren`
- `blocked` is recorded as `settled` (`src/tree/send.ts:72`), `owes` false, no `reportedAt` (`report.ts:35`), not live once idle (`limits.ts:20-22`). Brief: "end your turn and wait for its answer" (`text.ts:17-18`); refusal "still owe a report" (`text.ts:177`); skill "start the next as each report frees a slot" (`skill.ts:26-27`). Nothing gates `courier_send`.
- Scenario: `maxChildren` 2; A sends `blocked`, goes idle; the parent spawns C, then answers A: three run at once.
- Fix: count an idle session whose last status since its prompt is `blocked` as live (`limits.ts:22`), test in `test/limits.test.ts`; or say "a blocked report frees no slot: answer it before starting another" at `skill.ts:27` and in `docs/reference.md:159-162`.

### K-3 (minor): `courier_cleanup` on a counted child takes its whole subtree out of the limits while those sessions keep running
- `forgetDropped` removes the roster entry (`src/tree/forget.ts:29`); `check` builds `tree` from roster lineages (`limits.ts:42-44`), so the sessions under it stop counting. The description says "It never deletes the session itself, nor the sessions it started" (`tools.ts:223`), not that they leave the limits; `cleanup` accepts only the caller's own child (`src/tree/cleanup.ts:18-19`).
- Scenario: root at `maxTotal`, child P reported `partial` with two children running; root cleans up P and spawns two more.
- Fix: keep counting sessions under a dropped entry, or add to the description "sessions it started keep running but no longer count toward your limits: courier_stop them first if you no longer need them".

### K-4 (nit): `totalRefusal` with `yours === 0` says "no report will wake you" while a complete join group can still be held
- Reported idle members do not count (`report.ts:28`, `limits.ts:20-22`); the group is delivered once the caller's turn ends (`text.ts:294`, `tools.ts:53-55`). Same claim in `docs/reference.md:153-154`. Advice safe, reason wrong.
- Fix: "none of the sessions you started counts, so only reports already held for a group will reach you".

### K-5 (nit): R2-F4 remainder, "check-in" against what the code exempts
- `docs/reference.md:396` vs any `courier_later` message to itself created before the latest report (`events.ts:90-91`, `:97`; `report.ts:16`).
- Fix: "a message it scheduled for itself before that report (such as a check-in)".

### K-6 (nit): `laterText` (own) assumes a check-in on children
- `own` is any message to oneself (`src/scheduling/tools.ts:36`); "Once the last report it covers arrives, cancel it" (`scheduling/text.ts:4-5`) means nothing for a leaf's reminder.
- Fix: "If it is a check-in on sessions you started, cancel it with courier_cancel once the last report it covers arrives."

### K-7 (nit): `inTurn` depends on `time.idle` moving after the report
- A turn ended by a plain permission decline records no idle (`src/tree/domain.ts:47-50`). After a report and such an end, a later person-prompted turn (UNOWED, `events.ts:114`) runs uncounted, against `docs/reference.md:161`.
- Fix: compare with the latest execution start where available, or qualify the reference.

## Claims checked that hold
- "A session that reported still counts while sessions it started are live": `active` adds every ancestor of a live session (`limits.ts:46-48`).
- A reporter run again by a parent's or courier message is prompted (`events.ts:121`), clearing `reportedAt` and counting; a group release or earlier own message runs in a later turn and `runs` counts it; a stopped running reporter is `interrupted`.
- `blockedStoppedNotice`: sent only for an idle target whose parent is not the caller (`stop.ts:70`), not owing, last status `blocked`; if the answer arrived, `idleStoppedNotice` goes instead; "a session above you" and "together with the sessions under it" hold (`stop.ts:45`, `:63-65`).
- The `courier_stop` description clause (`tools.ts:205`) matches `tellParent`.
- `ownAfterReport` matches `docs/reference.md:396-401` except "check-in".
- #521's brief sentence (`text.ts:28`) matches `skill.ts:45-46` and `docs/reference.md:198-199`.
- `failureNotice` uses `liveBelow`, correctly leaving out a grandchild in its reporting turn.

## Severity totals
Blocking 0, major 0, minor 3 (K-1, K-2, K-3), nit 4 (K-4 to K-7).
