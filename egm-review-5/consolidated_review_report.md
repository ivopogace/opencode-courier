# EGM round 3: courier-orchestrate on main

**Target:** `SKILL_DESCRIPTION` and `SKILL_CONTENT` in `src/skill.ts` at `origin/main` 2dacfe4 (after #516, #517, #518, #521), rendered as `courier-orchestrate.SKILL.md` in this folder (37 lines, 710 words with front matter). Read together with `childBrief`, `rolePart` and the notices and refusals in `src/tree/text.ts`, `src/kernel/protocol.ts`, the tool descriptions (`src/*/tools.ts`) and `src/person/text.ts`, `src/scheduling/text.ts`, `src/memory/text.ts`.

**Baseline:** round 2, `egm-review-4/` on `origin/claude/egm-round-2` (closed draft PR #510), findings R2-F1 to R2-F5.

**Date:** 2026-11-08. Nothing was run against a model, real or mock.

## How it was run

Three reviewers in parallel, then one synthesis pass in the main context, which re-read the code for every finding kept below. Line numbers are on 2dacfe4.

- **Comprehension (goldfish)**, `egm:egm-comprehension`, `comprehension_report.md`: only the rendered skill and `test/__snapshots__/notices.test.ts.snap`, no source.
- **Codebase details**, `egm:egm-codebase-details`, `codebase_details_report.md`: every claim against the code, hardest on #516-#518 and #521.
- **Zoom out**, `egm:egm-zoom-out`, `zoom_out_report.md`: the baseline's status, duplicates and the reference's accounting.

## Verdict

The round-2 fixes hold: R2-F1, R2-F2, R2-F3 and R2-F5 are resolved, R2-F4 is resolved in code with a reference-wording residue (R3-F5). The skill's own text has no claim the code contradicts and no conflict with the brief; #521's clause and the skill's person's-word sentence say the same thing. What remains sits in the notices and refusals #517 and #518 added:

- `blockedStoppedNotice` leaves out that the stopped session still holds back its join group (R3-F1).
- An idle child that sent `blocked` stops counting toward the limits, so the parent can start another session and then answer it, past `maxChildren`; no text says a `blocked` report frees the slot (R3-F2).
- Two nits in the refusals' new wording (R3-F3, R3-F4) and one in the reference (R3-F5).

## 1. The baseline's items

| Item | Status on 2dacfe4 |
| --- | --- |
| R2-F1 (refusals' retry moment; reported child with live subtree) | Resolved by #518. `live` no longer counts a reporter's own reporting turn (`inTurn`, `src/tree/limits.ts:19-20`, `reportedAt` from `src/tree/report.ts:35`); the refusals say "once one of them has reported" (`src/tree/text.ts:184`, `:191`) and `stillCounts` names the reporter with live sessions below it (`:179-180`); `live()`'s wording is "still owes a report" (`:177`). Wording residue: R3-F3, R3-F4. |
| R2-F2 (`courier_stop` and an idle `blocked` target) | Resolved by #517: `tellParent` sends `blockedStoppedNotice` (`src/tree/stop.ts:166-168`, `src/tree/text.ts:382-387`); description `src/tree/tools.ts:205`; reference `docs/reference.md:521-525`. The notice's group gap: R3-F1. |
| R2-F3 (where a change goes below the root) | Resolved by #516: `src/skill.ts:41-44`, matching the brief (`src/tree/text.ts:21-28`) and `docs/reference.md:269-272`. |
| R2-F4 (exemption wider than a check-in) | Resolved in code by #517 as #514 scoped it: only a message the session scheduled for itself before its report is exempt (`kindOf`/`ownAfterReport`, `src/tree/events.ts:86-98`; `scheduledAt`, `src/scheduling/later.ts:108`). R2-F4's own example (schedule "re-run and report", then report) is still exempt, being scheduled before the report, and the reference still calls it a "check-in": R3-F5. |
| R2-F5 (`laterText`'s cancel trigger) | Resolved by #516 (`src/scheduling/text.ts:4-5`). |

## 2. Findings, each confirmed against the code

Severity: **blocking**, the skill cannot be used as is; **major**, a model is likely to act wrongly or stall; **minor**, a gap or claim that misleads with lower stakes; **nit**, wording.

### R3-F1 (minor): `blockedStoppedNotice` does not say the stopped session still holds back its join group

Raw: Z-2, C-2.

- A `blocked` report takes the member's held report out of the group and the group waits for it to report again (`src/tree/send.ts:47`, `unholdForBlocked` `src/tree/group.ts:92-98`; reference `docs/reference.md:343`, "the member stays out until it reports again"). An idle stop does not settle it or take it out of the group: only an interrupted (`src/tree/events.ts:133-135`), failed (`:40-44`), deleted or dropped (`src/tree/forget.ts:28`) member leaves.
- `idleStoppedNotice` says it "holds back its join group if it is in one" (`src/tree/text.ts:378`); `blockedStoppedNotice` says only "Do not send it that answer ... Drop it with courier_cleanup if you no longer need it, or message it with courier_send if you still need it to carry on" (`:385-386`). The reference also attaches the group clause to the owing case only (`docs/reference.md:523-525`). The parent never sees the caller's `stopText` (`:330-332`).
- Root R stops C, a member of sub-orchestrator P's group `g`, after C sent P `blocked`. P obeys "do not send it that answer", carries on with its other work and neither drops nor messages C (the notice's "if" allows that). `g`'s other reports stay held; P's own report reminder waits on its children, and the root waits on P.

**Placement:** `src/tree/text.ts:385-386`: add "It still holds back its join group if it is in one, until you drop it with courier_cleanup or it reports." In `docs/reference.md:523-525`, move "holds back its join group if it is in one" into the clause that covers both cases. Snapshot, and a unit test in `test/stop.test.ts` (a grouped blocked target); e2e: stop a grouped blocked grandchild and check the group is delivered after the parent's cleanup.

### R3-F2 (minor): an idle child that sent `blocked` stops counting, so the parent can start another session and then answer it, past `maxChildren`

Raw: K-2 (C-9 reads the same texts the other way).

- A `blocked` report settles the child (`src/tree/send.ts:72`; reference `docs/reference.md:330`), so `reportOf` gives `owes: false`, `ended: false` and no `reportedAt` (`src/tree/report.ts:28-35`); once its turn ends, `live` is false (`src/tree/limits.ts:20-22`) and `check` leaves it out of `mine` (`:52`). `courier_send` has no limit gate; only `courier_spawn` calls `admit` (`src/tree/spawn.ts:42`).
- The texts treat the blocked child as still in its task: the brief has it "end your turn and wait for its answer" (`src/tree/text.ts:17-18`), the skill's section 4 has the parent answer it (`src/skill.ts:50-51`), and the refusals count what "still owe[s] a report" (`src/tree/text.ts:177`), which a model reads as including a child waiting on its answer. No text says a `blocked` report frees a slot; the skill's "start the next as each report frees a slot" (`src/skill.ts:27`) is literally true of it.
- `maxChildren` 2, children A and B running. A sends `blocked` and ends its turn. The parent, in rolling mode, spawns C (admitted: A does not count), then answers A as section 4 says. Three of its sessions run at once, "the most allowed at once" being 2 (`src/tree/text.ts:182-184`).

**Placement:** preferably code: in `live` (`src/tree/limits.ts:22`), count a session whose last report since its prompt is `blocked` as live, and say so in the reference's liveness list (`docs/reference.md:157-163`); unit test in `test/limits.test.ts`, e2e: spawn at `maxChildren` after a `blocked` report is refused. Otherwise, in `src/skill.ts:26-27`: "a blocked report frees no slot: answer it before you start another".

### R3-F3 (nit): `stillCounts` says every session that ended without a report counts until cleanup

Raw: K-1.

- `stillCounts`: "one that ended without a report counts until you drop it / its parent drops it with courier_cleanup" (`src/tree/text.ts:180`).
- A failed turn settles the session `failed` (`src/tree/events.ts:40`), an interrupt `interrupted` (`:133`, `src/tree/stop.ts:108`); both give `ended: true, owes: false` (`src/tree/report.ts:28-34`) and do not count unless a session below is live (`src/tree/limits.ts:20-22`, `:46-48`). Only a silent end keeps `owes`. The refusal also drops "until it reports", which `silentNotice` (`src/tree/text.ts:477`) and `docs/reference.md:166` say.
- A parent at `maxChildren` with one failed and one silent child cleans up the failed one expecting a slot, or cleans up the silent one where a `courier_send` would have had it report.

**Placement:** `src/tree/text.ts:180`: "and one whose turn ended quietly, without a report, counts until it reports or until ... drops it with courier_cleanup".

### R3-F4 (nit): `totalRefusal` with none of the caller's sessions counting says "no report will wake you" while a complete group can still be held for it

Raw: K-4.

- `totalRefusal` (`yours === 0`): "none of the sessions you started counts, so no report will wake you" (`src/tree/text.ts:190`); the reference says the same (`docs/reference.md:153-154`).
- Members that reported and went idle owe nothing and do not count (`src/tree/report.ts:28-35`, `src/tree/limits.ts:20-22`), so `mine` is 0 (`:52`), while their group is delivered only once the caller's current turn ends (`docs/reference.md:335-338`; `group` description `src/tree/tools.ts:53-55`). That delivery wakes the caller. The advice ("do this part yourself") stays safe; only the reason is wrong.

**Placement:** `src/tree/text.ts:190`: "none of the sessions you started counts, so no report beyond any already held for a group will wake you"; match `docs/reference.md:153-154`.

### R3-F5 (nit): the reference calls the exempt self-scheduled message a "check-in"

Raw: K-5 (R2-F4 residue).

- `docs/reference.md:396`: "a check-in it scheduled for itself before that report". The code exempts any `courier_later` message the session scheduled for itself before its latest non-blocked report, whatever it says (`src/tree/events.ts:90-91`, `:94-98`; `src/tree/report.ts:16`).
- A child schedules "in 10 minutes, re-run the flaky test and report", then reports `done`; when the message wakes it and it ends without a report, it gets no reminder and the parent no silent notice, against the brief's "if you end your turn without a report, the parent is told so" (`src/tree/text.ts:19-20`).

**Placement:** `docs/reference.md:396`: "a message it scheduled for itself before that report, such as a check-in". The code cannot tell a check-in from a task, so a code fix is not proposed.

## 3. Checked and not carried forward

- **Z-1, C-8,** a refusal after a report whose sender still has live sessions below it, with nothing to wake the caller when they end (and the group-release exemption for a child that reported before its group was delivered): the refusal names the case (`stillCounts`), and it needs a sub-orchestrator that reports before its own children, against its brief (`src/tree/text.ts:66-67`).
- **Z-3,** the skill sends the person's words up only "when a message changes what other parts need": the brief, which every session below the root reads, says it unconditionally (`src/tree/text.ts:25-28`), and the skill defers to it ("as your brief says").
- **Z-4,** the reference lists the person's word under both "the brief carries" and "the skill alone adds": the skill's part is passing it on to the affected sessions and the root's rule; no wrong action.
- **K-3,** `courier_cleanup` of a reported child takes its live subtree out of the limits: a code property no text contradicts, noted in round 2 (R2-F1); the refusals point cleanup at a session that ended quietly, not at one with live sessions below it, and `failureNotice`'s `belowLine` says to stop those first.
- **K-6,** `laterText`'s cancel line on a leaf's reminder to itself: harmless, it covers no report.
- **K-7,** a reporting turn that ends on a plain permission decline stamps no idle, so a later person-prompted turn runs uncounted: rare, person-driven, and the limits are an admission check, not a cap on running turns.
- **C-1, C-13,** a stop from above gives the session in between no reason, and the notices let it restart the work: the stopper can send it one; `blockedStoppedNotice` already says not to send the answer, and "the work it asked about was stopped above you" holds (the target's own work was stopped). Close to round 2's C-8.
- **C-3, C-4,** `blockedStoppedNotice`'s "do not send that answer" against "message it ... to carry on" and against the skill's section 4: the notice is specific, arrives when it applies, and keeps carrying on as the parent's choice.
- **C-5,** a reported child woken again and "send exactly one report": a new message makes it owe again (`src/tree/events.ts:121`), and the reminder and `courier_send`'s text ask for its report at that moment.
- **C-6, C-7,** a check-in left after its sessions are stopped or dropped, and "the last report it covers" for ungrouped waves: the worst case is one extra wake with nothing to do.
- **C-10, C-11,** a corrected task against "never undo what the person asked", and the person's words conflicting with each other: the skill's later sentence constrains the earlier one, and a decision only the person can make goes to them (section 4).
- **C-12, C-14,** the `courier_stop` description's elliptical "is" (now 15 words from its verb) and "They"/"undo them" in the brief's new clause: wording only, no wrong action found; a cheap fix is "is told" and "undo what the person asked".

## Severity totals

| Reviewer | Blocking | Major | Minor | Nit |
| --- | --- | --- | --- | --- |
| Comprehension | 0 | 3 | 8 | 3 |
| Codebase details | 0 | 0 | 3 | 4 |
| Zoom out | 0 | 0 | 2 | 2 |
| **Consolidated** | **0** | **0** | **2** (R3-F1, R3-F2) | **3** (R3-F3, R3-F4, R3-F5) |

R3-F1, R3-F3 and R3-F4 change model-facing strings and need a sandbox real-model re-run; R3-F2 (code variant) needs unit and e2e tests; R3-F5 is the reference only.
