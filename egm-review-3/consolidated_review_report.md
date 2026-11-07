# EGM check 3: courier-orchestrate on main

**Target:** `SKILL_DESCRIPTION` and `SKILL_CONTENT` in `src/skill.ts` at `origin/main` 6673992 (after #484, #485, #488, #489, #490, #493, #496), rendered as `courier-orchestrate.SKILL.md` in this folder (37 lines, 705 words with front matter). Read together with `childBrief`, `rolePart` and the notices in `src/tree/text.ts`, `src/kernel/protocol.ts`, the tool descriptions (`src/tree/tools.ts`, `src/person/tools.ts`, `src/memory/tools.ts`, `src/scheduling/tools.ts`) and `src/person/text.ts`, `src/scheduling/text.ts`.

**Baseline:** the last re-check, `egm-review-2/` on `origin/claude/egm-recheck-skill` (closed draft PR #476), whose findings F1-F6 were filed as #477-#482.

**Date:** 2026-11-07. Nothing was run against a model, real or mock.

## How it was run

Three reviewers in parallel, then one synthesis pass in the main context. The reviewers ran as general-purpose agents briefed in the EGM roles; the plugin's `egm:*` agent types became available only after they had started.

- **Comprehension (goldfish)**, `comprehension_report.md`: only the rendered skill and `test/__snapshots__/notices.test.ts.snap`, no source. Six roles through about twenty events.
- **Codebase details**, `codebase_details_report.md`: every claim in the texts against the code, hardest on the areas changed since the baseline.
- **Zoom out**, `zoom_out_report.md`: status of every baseline item (part A), then duplication, conflicts and the reference's accounting across the current text set (part B).

The synthesis re-checked each raw finding against the code before keeping it. Line numbers in the raw reports are sometimes off; the ones below were re-read on 6673992.

## Verdict

The fixes since the baseline hold. F1-F6 are resolved, and so are the old M6, M17 and N5; no fix introduced a contradiction. #493's rule matches every text about the report reminder and the silent end: no text tells a child it owes a report after its group arrives.

What remains sits at the edges of those fixes:

- #493 exempts a session's own group delivery from owing a new report, but not the session's own `courier_later` check-in. A sub-orchestrator that follows the skill's check-in advice and forgets to cancel it is asked for a second report when it fires (F1).
- Two texts give advice the code does not back: the `courier_stop` description promises the in-between session is told, which holds only for a running target (F2); and the limit refusals tell a parent to wait for a report that, for a silent child or a reported one with live sessions below it, never comes (F3).
- `REJECTED` names the wrong refuser below depth 1 (F4), the baseline's C-4 residue.
- Small wording drift: the `courier_answer` description against the question notice (F5), the "still reaches you at once" lists (F6), and the check-in rule now in four places with the reference's "says only what no other text says" no longer true (F7).

## 1. The baseline's items

| Item | Status on 6673992 |
| --- | --- |
| F1 / #477 (asks go to the top) | Resolved by #484: `spawnText` `belowTop` (`src/tree/text.ts:262-268`), brief (`:28`), `courier_answer` description (`src/person/tools.ts:62-63`), `group` and `courier_spawn` descriptions (`src/tree/tools.ts:54-55`, `:134-135`). |
| F2 / #478 (pass findings and the person's words up) | Resolved by #489: brief `src/tree/text.ts:23-27`. |
| F3 / #479 (maxTotal with none of one's own running) | Resolved by #485: `totalRefusal` `src/tree/text.ts:182-186`, `mine` passed at `src/tree/limits.ts:52`. |
| F4 / #480 (check-in not cancelled automatically) | Resolved by #488: skill lines 37-38, `courier_spawn`, `courier_later`, `courier_cancel` descriptions. The rule now sits in four texts (see F7 below). |
| F5 / #481 (partial or failed report) | Resolved by #490: skill step 4 (`src/skill.ts:50-51`). Carried only by the skill (see "Not carried forward"). |
| F6 / #482, all seven bullets; old M6, M17, N5 | Resolved by #490: isolated-skills note, "branch, if isolated", cleanup "isolated or not", the intro wording, "the root, the top session of the tree", `silentNotice` no-reply variant (`src/tree/text.ts:453-455`), the reference's accounting (`docs/reference.md:281-288`). |
| Baseline "checked and not carried forward" (C-2, K-8/Z-8, C-6, C-8, C-9, C-11, K-9, K-11, K-12, K-13, K-14, C-13) | Still hold as judged. C-2 is stronger: #493 also holds back the reminder after a group delivery to a child that already reported. |
| Baseline C-4 residue (`REJECTED`) | Still open: F4 below. |

## 2. Findings, each confirmed against the code

Severity: **major**, a model is likely to act wrongly or stall; **minor**, a gap or claim that misleads with lower stakes; **nit**, wording.

### F1 (major): a session's own check-in, firing after it reported, makes it owe a second report

Raw: K-3, K-4, C-1.

- The skill (lines 37-38), `courier_spawn` (`src/tree/tools.ts:140-142`) and `courier_later` (`src/scheduling/tools.ts:26-28`) tell every orchestrator, sub-orchestrators included, to schedule a check-in for itself and cancel it when the reports arrive.
- When it fires, `deliverDue` delivers it as a synthetic courier message without a `group` (`src/scheduling/later.ts:103-107`). `kindOf` records it as plain `synthetic` (`src/tree/events.ts:85-88`), and `notePrompt` moves the `prompt` note forward (`:111`): only `user`, `compaction`, `move` (`:82`) and a group delivery to a session that already reported (`:108`, #493) are exempt.
- So a sub-orchestrator that reported and forgot to cancel owes again. At its idle the report reminder says "If you are finished, send your report now" (`src/tree/text.ts:433-439`): it sends a second report to its parent, or ends and its parent gets a `silentNotice`. Both are what #493 removed for the group case.
- On the text side, the brief says "send exactly one report" (`src/tree/text.ts:14`), and `groupNotice` (`:495`), which reaches a sub-orchestrator that already reported in the #493 case, says only "Check and integrate each one yourself". Nothing tells a session that has reported whether a wake-up of its own needs a new report.

**Placement:** in `notePrompt`, treat a scheduled message the session scheduled for itself (`due.from === due.sessionID`, carried in the synthetic's metadata) like a group delivery: no new owed report when `reportedSincePrompt`. Optionally one clause in `groupNotice` when the receiver already reported: "You have reported already: report again only if this changes your report." Unit test in `test/watch.test.ts`/`test/nudge.test.ts`; e2e next to `early-report`.

### F2 (minor): the `courier_stop` description says the in-between session is told; it is not when the target was idle

Raw: K-2.

- `courier_stop` description: "you are not told of what you stopped; a session between you and the target is" (`src/tree/tools.ts:204-205`).
- `stop` tells the target's parent only when the target's own outcome was `interrupted` (`src/tree/stop.ts:69-72`). `docs/reference.md:511` says so ("unless it is the caller or the target was not running"); the description does not.
- An idle target that owed a report still owes it, stays in its group and counts toward the limits "until the session that started it drops it with courier_cleanup" (`IDLE_STOPPED`, `src/tree/text.ts:323-325`). Only that parent may (`src/tree/cleanup.ts:18-19`), and it is not told. A sub-orchestrator whose idle child the root stopped keeps waiting on it.

**Placement:** tell the target's parent whenever the target owed a report, idle or not (a code change), or at least make the description say "a session between you and the target is, when the target was running" and have the stop result tell the caller to message that session. The first fixes the stall.

### F3 (minor): the limit refusals say to wait for a report that may never come

Raw: K-1, K-5.

- `childrenRefusal`: "end your turn and start it once one of them has reported"; `totalRefusal` (when `mine > 0`): "try again once a report has arrived" (`src/tree/text.ts:178-186`).
- `live` (`src/tree/limits.ts:10-22`) counts a child that owes a report, so one that ended silently keeps counting with no report coming. `check` also counts every ancestor of a live session (`:46-48`), so a child that reported while sessions under it still run keeps counting, and their reports wake it, not the caller. A child that just reported still counts while its turn finishes (`running` holds while `report.ended` is false, `src/tree/report.ts:33`), so an immediate spawn on the report's arrival can be refused.
- The ungrouped `silentNotice` says "Until it reports, it counts toward your limits" (`src/tree/text.ts:456`) without saying `courier_cleanup` frees the slot; the `courier_cleanup` description names that use only for a group member (`src/tree/tools.ts:221-223`).

**Placement:** the refusals: "once one of them has reported and its turn has ended; a session that ended without a report counts until you drop it with courier_cleanup". The ungrouped `silentNotice` line: "…, or until you drop it with courier_cleanup".

### F4 (minor): `REJECTED` names the wrong refuser below depth 1

Raw: C-6, Z-8, baseline C-4 residue.

- `REJECTED`: "Refused by the session that started you." (`src/person/text.ts:42`), used as the default reason on a reject from `courier_answer` (`src/person/permission.ts:162`) and from the TUI (`src/person/tui.tsx:265`).
- Only the top session may answer (`courier_answer` refuses others, `src/tree/roster.ts:50` `answeringTop`), and in the TUI the person refuses. For a grandchild, neither is the session that started it.

**Placement:** "Refused by the person or the top session of the tree. Do without it, or report back why you cannot."

### F5 (nit): the `courier_answer` description and the question notice disagree on who passes an answer on

Raw: C-5.

- `courier_answer` description: "For a question, answers is what the person chose: ask them first, with your question tool if you have one" (`src/person/tools.ts:66-67`), which reads as: ask, then call `courier_answer`.
- `questionNotice`: what they choose in the question tool "is passed on to the session"; `courier_answer` only if the tool cannot be used or they answer some other way (`src/person/text.ts:186-188`). The linked-answer result then says "do not call courier_answer" (`:256`), so a double call is caught, one turn late.

**Placement:** the description: "For a question, the notice's question tool call passes the answer on by itself; use answers only when the person answered some other way."

### F6 (nit): the "still reaches you at once" lists are incomplete

Raw: Z-7, K-7.

- At the top, grouped `spawnText` lists "a blocked report, a question or a failed turn" (`src/tree/text.ts:267`); the `group` description also lists the permission request (`src/tree/tools.ts:54-55`), which does reach the top at once.
- Neither lists a member's silent end, which `reportSilent` sends to the parent at once, group or not (`src/tree/events.ts:150-175`).

**Placement:** both lists: "a blocked report, a failed turn or an end without a report, and at the top a question or a permission request".

### F7 (minor): the check-in rule now sits in four texts and drifts; the reference overstates what the skill alone says

Raw: Z-1, Z-2, Z-3, Z-4.

- Check-in: skill lines 37-38 and `courier_spawn` (`src/tree/tools.ts:140-142`) say "for a long task or batch"; `courier_later` (`src/scheduling/tools.ts:26-28`) says it unconditionally; `courier_cancel` and `laterText` (`src/scheduling/text.ts:4-5`) say it a fourth and fifth time. "Per session when ungrouped" with the skill's rolling-slot mode (line 27) asks for one check-in per running session.
- `docs/reference.md:244` says the skill "says only what no other text a model has at that moment says". The check-in clause, the reply/wake line, "isolated or not" and "never answer for the person" are also in tool descriptions or notices.
- Skill line 42, "courier_send it at once, only to the sessions it affects", can read to a sub-orchestrator as excluding its parent, against the brief's upward clause (`src/tree/text.ts:23-24`); the reference's "the children it affects, and only to them" (`docs/reference.md:265-266`) narrows it to children.

**Placement:** cut the check-in clause from the skill (the `courier_spawn` description carries it at the moment of use), give `courier_later` the same "for a long task or batch" trigger, and say "one check-in for the ungrouped sessions, cancelled at the last report". Soften `docs/reference.md:244` to "mostly". Skill line 42: "only to the sessions it affects (below the root, to the session that started you as your brief says)".

## 3. Checked and not carried forward

- **C-2,** the reminder or silent notice firing on a sub-orchestrator that waits on its children. `waits` holds back both (`src/tree/nudge.ts:17-23`, `owedUnwaited` used by `reportSilent`, `src/tree/events.ts:155`).
- **K-3, first half,** a pending check-in holds back the reminder. By design: the check-in will wake the session.
- **C-3,** a native child of a sub-orchestrator: its prompt shows in the sub-orchestrator's view for the person while the notice goes to the top. Decided in #484 ("Decisions"); `nativeRootOf(chain) === topOf(chain)` picks the native notice only when they coincide (`src/person/events.ts:17-18`).
- **C-4,** an OpenCode subagent inside a tree fits "the root, which has no brief". Baseline K-12, documented.
- **C-7, K-8,** `courier_recall`/`courier_note` "top only" wording. Baseline K-9, advice.
- **C-8,** the root after its first spawn has no split rule but the skill's. By design (CLAUDE.md, baseline K-8).
- **C-9, C-10, C-11, C-12, C-13, C-14, K-6, Z-6, Z-9:** either covered by the text that arrives at the moment (a refused part gets the refusal; `stopText` says what cleanup does), decided in #489 (the upward clauses read right for a leaf, kept for the prompt cache), or wording without a wrong action.
- **Z-5,** partial and failed handling only in the skill. True, but a product choice: `groupNotice` already says "message one with courier_send if it has more to do" (`src/tree/text.ts:495`), and the reference lists it among what the skill alone adds. Left to the owner; no issue proposed.

## Severity totals

| Reviewer | Major | Minor | Nit |
| --- | --- | --- | --- |
| Comprehension | 4 | 5 | 5 |
| Codebase details | 2 | 3 | 3 |
| Zoom out | 0 | 3 | 6 |
| **Consolidated** | **1** (F1) | **4** (F2, F3, F4, F7) | **2** (F5, F6) |

F4-F7 change model-facing strings and need a sandbox real-model re-run; F1 and F2 (the code variant) need unit and e2e tests.
