# EGM round 4: courier-orchestrate on main

**Target:** `SKILL_DESCRIPTION` and `SKILL_CONTENT` in `src/skill.ts` at `origin/main` 98c64cf (after #529, #530, #531), rendered as `courier-orchestrate.SKILL.md` in this folder (37 lines, 710 words with front matter; unchanged since round 3). Read together with `childBrief`, `rolePart` and the notices and refusals in `src/tree/text.ts`, `src/kernel/protocol.ts`, the tool descriptions (`src/*/tools.ts`) and `src/person/text.ts`, `src/scheduling/text.ts`, `src/memory/text.ts`.

**Baseline:** round 3, `egm-review-5/` on `origin/egm-round-3` (closed draft PR #522), findings R3-F1 to R3-F5.

**Date:** 2026-11-08. Nothing was run against a model, real or mock.

## How it was run

Three reviewers in parallel, then one synthesis pass in the main context, which re-read the code for the finding kept below. Line numbers are on 98c64cf.

- **Comprehension (goldfish)**, `egm:egm-comprehension`, `comprehension_report.md`: only the rendered skill and `test/__snapshots__/notices.test.ts.snap`, no source. No findings.
- **Codebase details**, `egm:egm-codebase-details`, `codebase_details_report.md`: every claim against the code, hardest on #529-#531. One minor (K-1).
- **Zoom out**, `egm:egm-zoom-out`, `zoom_out_report.md`: baseline status, duplicates, the reference's accounting. No findings; it looked at K-1's situation and dropped it (see R4-F1 for why the synthesis keeps it).

## Verdict

All five round-3 findings are resolved. #529 and #530 add nothing a model would act on wrongly, and #530's status-less-message test (`Object.keys(metadata).length === 2` plus `indexedParent`) exempts only `courier_send` without a status from the receiver's own child. One minor finding remains, introduced by #531: the limit refusals now count a blocked child, but still offer only "end your turn and start it once one of them has reported", which a blocked child does not do until the caller answers (R4-F1).

## 1. The baseline's items

| Item | Status on 98c64cf |
| --- | --- |
| R3-F1 (`blockedStoppedNotice` and the join group) | Resolved by #529: "It still holds back its join group if it is in one" (`src/tree/text.ts:388`, shared `HOLDS_GROUP` `:375`). True: a `blocked` report takes the member's held report out (`src/tree/send.ts:47`, `src/tree/group.ts:92-98`) and an idle stop settles nothing (`src/tree/stop.ts:160-169`). Reference `docs/reference.md:524-527` puts the clause on both cases. |
| R3-F2 (an idle blocked child stops counting) | Resolved by #531, code variant: `live` returns `"blocked"` (`src/tree/limits.ts:23`, `blocked` from `src/tree/report.ts:35`), which counts the session itself but no session above it (`src/tree/limits.ts:47-55`); refusals say "running, blocked or still owe(s) a report" (`src/tree/text.ts:177`); reference liveness list `docs/reference.md:162-163`. Follow-on: R4-F1. |
| R3-F3 (`stillCounts` and failed or interrupted sessions) | Resolved by #531: "unless it failed or was interrupted, counts until it reports or ... drops it" (`src/tree/text.ts:180`), matching `owes`/`ended` (`src/tree/report.ts:28-34`). |
| R3-F4 (`totalRefusal` with none counting) | Resolved by #531: "only reports already held for a group can still wake you" (`src/tree/text.ts:190`); `docs/reference.md:152-154`. |
| R3-F5 (reference "check-in") | Resolved by #530: "a message it scheduled for itself before that report, such as a check-in" (`docs/reference.md:397-398`). |

## 2. Findings, each confirmed against the code

Severity: **blocking**, the skill cannot be used as is; **major**, a model is likely to act wrongly or stall; **minor**, a gap or claim that misleads with lower stakes; **nit**, wording.

### R4-F1 (minor): the limit refusals count a blocked child, but their only remedy waits on a report it sends only after the caller answers

Raw: K-1 (Z dropped the same situation as one self-explaining refused call).

- Since #531 an idle child whose last report is `blocked` counts in the caller's `mine` (`src/tree/limits.ts:23`, `:51-52`, `:59-60`). It runs again only when a message reaches it (`notePrompt` marks it prompted, `src/tree/events.ts:126`), and its `blocked` report has already been delivered, so it sends no further report until the caller answers it.
- The refusals name it as counting and then give as the only alternative to doing the part oneself: "end your turn and start it once one of them has reported, not in a loop" (`childrenRefusal`, `src/tree/text.ts:183`) and "end your turn and try again once one of the sessions you started has reported" (`totalRefusal`, `yours > 0`, `:190`); the reference says the same (`docs/reference.md:150-151`). When every counted child is blocked, that wait has nothing to end it: the caller is the one they wait on, and the root gets no reminder (it has no parent, `src/tree/events.ts:121-122`).
- The skill's rolling-start line leads into it: "leave them ungrouped and start the next as each report frees a slot" (`src/skill.ts:27`, mirrored `docs/reference.md:263`); a `blocked` report is a report, and before #531 it did free the slot.
- Why the synthesis keeps it although the blocked reports and section 4 ("A blocked report: make the decision it asks for", `src/skill.ts:50`) are in the parent's context: before #531 that spawn was admitted; now the parent gets a refusal whose explicit instruction, at the moment of use, is to end its turn and wait. A model following the refusal rather than the skill's earlier section stalls the tree. With one child blocked and one running, the same reading only delays the answer until the running one reports.
- Scenario: `maxChildren` 2, ungrouped parts. A and B each send `blocked`. The root, woken, starts part C first; the spawn is refused ("2 sessions you started are running, blocked or still owe a report ... end your turn and start it once one of them has reported"). It ends its turn. A and B wait on it; nothing wakes it until the person types.

**Placement:** `src/tree/text.ts:183` and `:190`: after "has reported", add "(answer a blocked one first: it reports only after your answer)", or make the alternative "end your turn, or answer a blocked one, and start it once one of them has reported"; `docs/reference.md:150-151` to match. Snapshot update, a unit test in `test/limits.test.ts` on the refusal text with a blocked child counted, and a sandbox real-model re-run (model-facing string). A smaller alternative, skill-only: `src/skill.ts:27`, "start the next as each report other than blocked frees a slot", which does not cover a refusal met another way.

## 3. Checked and not carried forward

- **#529, `HOLDS_GROUP` on an owing target whose `done` was held, then messaged by its parent before the release, then silent and stopped** (it no longer holds the group back): needs a parent messaging a held member within the same turn and that member going silent; worst case an unneeded cleanup.
- **#530, the exemption's metadata test:** exactly `{source, from}` comes only from `courier_send` without a status (`src/tree/send.ts:42`); every other courier synthetic carries a third key or no `from` (`src/tree/nudge.ts:49`, `src/tree/wake.ts:125`, `src/scheduling/later.ts:108`, `src/tree/group.ts:149`, `src/tree/stop.ts:178`, the `src/person/` sites). A downward message with a dropped status, or a sibling's, fails `indexedParent(from) === sessionID` (`src/tree/events.ts:99-100`). A legacy child without `reports: "status"` is exempt though its message counts as its report: legacy only.
- **#530, a reported sub-orchestrator woken by its child's correction is not reminded:** the brief tells it to forward what reaches past its part and the person's words always (`src/tree/text.ts:21-28`), skill section 3 too (`src/skill.ts:40-46`); the lost reminder asked for a report, not a relay.
- **#531, "A session also counts while one it started is live" (`src/tree/text.ts:180`) when the one below is only blocked** (the code does not count the session above): needs a session that reported while its own child waited on its answer, against its brief; a model would only overestimate the count.
- **#531, `liveBelow` excluding blocked sessions** (`src/tree/limits.ts:74`): used only by `failureNotice`'s `belowLine`, where a blocked session is correctly not "still running"; a failed sub-orchestrator's blocked child holds a `maxTotal` slot until cleanup, which section 5 and the failure notice's cleanup route cover.
- **#531, "only reports already held for a group can still wake you":** the person, a stalled inbox item or the caller's own `courier_later` can also wake it, but none is a report; "do this part yourself" stays right.
- **`stopText`'s idle-stopped line names only the owing case:** nothing false; within the accepted item that the stop texts leave the limits to the refusals.
- **The role lines' "At most N ... run at once" against blocked sessions counting:** same accepted item.
- **`docs/maintainers/plugin-api-notes.md:75` still says "a session's own check-in":** maintainer doc, not model-facing; the reference has the exact wording.
- **Earlier declined items** (section 3 of `egm-review-4/` and `egm-review-5/`, `waits` and the silent notice, partial and failed reports in the skill only): not re-raised.

## Severity totals

| Reviewer | Blocking | Major | Minor | Nit |
| --- | --- | --- | --- | --- |
| Comprehension | 0 | 0 | 0 | 0 |
| Codebase details | 0 | 0 | 1 | 0 |
| Zoom out | 0 | 0 | 0 | 0 |
| **Consolidated** | **0** | **0** | **1** (R4-F1) | **0** |

R4-F1 changes a model-facing string and needs a sandbox real-model re-run.
