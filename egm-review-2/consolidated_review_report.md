# EGM re-check: the shrunk courier-orchestrate skill

**Target:** `SKILL_DESCRIPTION` and `SKILL_CONTENT` in `src/skill.ts` at `origin/main` 15b9314 (after #475), rendered as `courier-orchestrate.SKILL.md` in this folder (37 lines, 658 words with front matter). Skill line numbers below are lines of that rendered file. It was read together with the texts the shrink relies on: `childBrief`, `rolePart`, refusals, tool results and notices (`src/tree/text.ts`), `src/kernel/protocol.ts`, the tool descriptions (`src/tree/tools.ts`, `src/memory/tools.ts`, `src/person/tools.ts`, `src/scheduling/tools.ts`) and `src/person/text.ts`, `src/memory/text.ts`. All of them are rendered in `test/__snapshots__/notices.test.ts.snap`.

**Baseline:** the first full review, `egm-review/consolidated_review_report.md` on `origin/claude/magical-cori-8g4cjl` (closed PR #460).

**Date:** 2026-11-07.

## How it was run

There were three reviewers, run in parallel, and one synthesis pass. No stages were repeated.

- **Comprehension (goldfish),** `comprehension_report.md`. It read only what a model is shown, the skill and the snapshot file, never the source. It walked five roles (root before and after its first spawn, sub-orchestrator, leaf, an OpenCode subagent in a tree) through 14 events.
- **Codebase details,** `codebase_details_report.md`. It checked every factual claim in the skill and in the texts it relies on against the code.
- **Zoom out,** `zoom_out_report.md`. It gave a status for every item of the first review. It also checked each row of PR #475's "where each rule lives now" table against what actually reaches the model.

The synthesis (main context) re-checked each finding below against the code before keeping it, and dropped the ones that failed (see the last section). Nothing was run against a real model.

## Verdict

The shrink holds for the root and for the paths the sandbox run exercised. Failed and silent children, refused spawns at the root, verifying, the root's lesson and the root after its depth-0 switch are each carried by a text that arrives when it is needed. The five contradictions of the first review are gone. 41 of its 48 items are resolved, 4 no longer apply, and 3 small wording items remain open (M6, M17, N5).

What the shrink exposed is one level down. A sub-orchestrator is the role the skill now leaves to the tool texts, and three of those texts fail it:

- They promise it the permission requests and questions of its children, which go only to the top.
- Nothing tells it to pass a finding, or the person's word, upward.
- A maxTotal refusal tells it to wait for a report that will never come when none of its own sessions are running.

Two smaller gaps sit in the skill itself. Its check-in clause reads as if cancelling were automatic, which it is not. And no text says what to do with a `partial` or `failed`-status report.

## 1. The first review's items

The full table, with evidence, is in `zoom_out_report.md` part A. In summary:

| Status | Items |
| --- | --- |
| Resolved | B1-B5 (the five contradictions: cut, or moved into the permission and question notices and `failureNotice`); M1-M5, M7-M14, M16, M18; N1, N6-N9; P1-P10 (PRs #468-#473; P8 backticks, P10 depth-0 skill line); D1-D6 (CLAUDE.md:69-71 now gives the real reason the skill repeats the root's rule) |
| Still open | **M6:** "it sees the same list" (skill line 18) against the `isolate` description (`src/tree/tools.ts:35`: only committed project skills). **M17:** "is a playbook's" (line 8). **N5:** "root" (lines 12, 37) and "top" (line 24) for the same session. |
| No longer applicable | M15 (its section is gone), N2, N3, N4 (left to git and the tool descriptions, as the first review allowed) |

## 2. New findings, each confirmed against the code

Severity: **major** means a model is likely to act wrongly or stall. **Minor** means a gap or wording that misleads with lower stakes. **Nit** means wording.

### F1 (major): a sub-orchestrator is promised its children's permission requests and questions, but they go to the top only

Raw findings: K-1, K-2, K-10, Z-1, Z-2, C-4.

**Claims:**

- The `courier_spawn` description says "you are told if … it waits for a permission or it asks a question" (`src/tree/tools.ts:134-135`).
- The `group` description says "A blocked report, a question, a permission request or a failed turn still reaches you at once" (`src/tree/tools.ts:55`).
- `spawnText` says "a blocked report, a question or a failed turn still reaches you at once" (`src/tree/text.ts:259-260`).
- The brief tells a child its question "reaches them through the session that started you" (`src/tree/text.ts:26`).
- The `courier_answer` description does not say that only the top may call it.

**Code:**

- Both relays address `topOf(chain)` only: `src/person/events.ts:14-20` and `:40-43`, and `src/person/question/relay.ts:113`.
- `courier_answer` refuses any caller other than the top (`src/tree/roster.ts:54`).
- A depth-1 session is never told that its child is waiting. The child shows as "working" in its standing entry, so it may poke, stop or replace a child that is waiting on the person.

This is the first review's B1, moved out of the skill and still present in the tool texts. Skill line 24 is right, but it is the only text that says "at the top".

**Placement:**

- Make `spawnText` depth-aware: below the top, "its permission requests and questions go to the top session of the tree, not to you".
- Add "(at the top of the tree; below it they go to the top)" to the two descriptions.
- In the brief, say "it reaches them through the top session of the tree".
- In the `courier_answer` description, add "only the top session of a tree can answer".

### F2 (major): no text tells a sub-orchestrator to pass a finding, or the person's word, upward

Raw findings: C-3, Z-3.

PR #475 moved "the upward half of passing a message on" to the brief. The brief covers only what the session finds itself (`src/tree/text.ts:21-23`) and what the person types in its own session (`:24-25`). Skill line 25 sends a message only down, "only to the sessions it affects", and a depth-1 session affects only its own children.

So a depth-2 child's finding that breaks a sibling subtree's assumption, or the person's words typed into a depth-2 session ("for the whole job", `:24`), stops at depth 1. The root and the other subtrees never hear it.

**Placement:** one clause in the brief's finding bullet, which every non-root session reads: "this includes one a session you started sends you, when it affects more than your own part, and always the person's words". An alternative is one clause on skill line 25: "and to the session that started you when it reaches past your part".

### F3 (major): the maxTotal refusal tells a session with no sessions of its own running to wait for a report

Raw finding: C-1.

`totalRefusal` (`src/tree/text.ts:180-182`) always says "end your turn and try again once a report has arrived". `check` throws it whatever `mine` is (`src/tree/limits.ts:52-53`).

A sub-orchestrator whose first spawn hits maxTotal, because other subtrees fill the tree, has no session of its own running. No report will wake it. If it follows the text and ends its turn without reporting, it gets the report reminder (nothing it waits on: `src/tree/nudge.ts:17-23`) and then its parent gets a `silentNotice`.

**Placement:** pass `mine` to `totalRefusal`. When it is 0, say "Do this part yourself: none of the sessions you started is running, so no report will wake you."

### F4 (minor): the skill says the check-in is cancelled; nothing cancels it

Raw findings: K-3, Z-5.

Skill line 23 says "One courier_later check-in per group, cancelled when its reports arrive." Nothing cancels a scheduled message on a report or on a group's release. Cancelling happens only through `courier_cancel` (`src/scheduling/tools.ts:42-48`) or `courier_stop` for the stopped sessions' own messages (`src/scheduling/later.ts:86`).

The passive wording reads as automatic, so a stale check-in wakes the root after the job is done. The `courier_spawn` description (`src/tree/tools.ts:138-139`) also says one check-in per session, for long tasks, while the skill says one per group, always.

**Placement:**

- Skill line 23: "…; courier_cancel it when its reports arrive."
- `courier_spawn` description: "for a long task or batch, one courier_later check-in (per group, if you used one)".

### F5 (minor): nothing tells a parent what to do with a partial report or a failed-status report

Raw findings: K-4, Z-4, C-7.

PR #475 names `failureNotice` and `silentNotice` as the new home of "done/partial/failed handling". Those cover a failed turn and a silent end, not a reported status. An ungrouped report arrives as a bare `<courier status="partial">` envelope with no instruction. `groupNotice` says only "Check and integrate each one yourself … message one with courier_send if it has more to do" (`src/tree/text.ts:485`). The skill covers `blocked` only (line 29).

**Placement:** one sentence in skill step 4: "partial or failed: have it finish or retry with courier_send, do the rest yourself, or start a replacement." The first review's M10 wording ("have it finish, or do it yourself") is the minimum.

### F6 (nit): wording left in the skill, and the reference section

Raw findings: K-5, K-6, K-7, C-12, C-10, Z-6, Z-7, Z-9; old M6, M17, N5.

- Line 18, "it sees the same list": an isolated part sees only committed project skills (`src/tree/tools.ts:35`). Write "(an isolated part sees only committed project skills)".
- Lines 19 and 33, "that one's branch" and "Merge each reported branch": a part without `isolate` has no branch, and its edits are already in the shared checkout. Write "its branch, if isolated".
- Line 33, "courier_cleanup the isolated sessions": a stopped idle or silent part of any kind keeps counting toward the limits until it is cleaned up (`IDLE_STOPPED`, `src/tree/text.ts:315-317`). This is already said in the `courier_stop` result, so it only needs to stop reading as "isolated only".
- Line 8: "is a playbook's" (M17). Lines 12, 24 and 37: "root" and "top" used for one session (N5).
- `silentNotice` with no reply says "It ended without a reply." and then "or to report if its last reply is what you needed" (`src/tree/text.ts:443-445`).
- `docs/reference.md` 262-266 overstates what the role lines carry without the skill (one group, no polling). Its "only the skill adds" list leaves out the person's-word rule, "several jobs are that many parts", the blocked-report answer and the root's lesson.

These are model-facing strings, so they need a sandbox real-model re-run.

## 3. Checked and not carried forward

- **C-2,** the report reminder firing on a sub-orchestrator that waits on its children. It does not fire: `waits` holds it back while any child owes a report or a group is complete (`src/tree/nudge.ts:17-23`).
- **K-8 and Z-8,** the root with the skill denied has no split rule after its first spawn. This is by design (CLAUDE.md:69-71). Adding the rule to `rolePart(0)` would be cache-safe, but it is a product choice, not a defect.
- **C-6,** "never hand that checking to another session" against "a review of the parts once you have merged them". The brief separates checking each report from a review stage after the merge. Not a conflict.
- **C-8,** a stopped grandchild's parent is told it "may start a replacement". That is true, and the stopper can say why with courier_send.
- **C-9,** the brief says "one group" and the skill also allows ungrouped. The skill adds an option for the overflow case and contradicts nothing.
- **C-11,** old lessons marked "from depth N". These are legacy records read as they are (#472, by design).
- **K-9,** `courier_recall` says "a session another session started reads none" while sub-orchestrators keep the tool. The text is advice and the tool works. Not worth a string change.
- **K-11** (host caveat outside the `native` description), **K-12** (OpenCode subagent outside a tree keeps the root role, documented), **K-13** (role line says load before deciding, description says before splitting a 2-part task; compatible).
- **K-14,** a status on a message to a sibling or the grandparent is carried along but not recorded as a report. Real (`src/tree/send.ts:56`, `:67`), but no text leads a model to send its report there. Possible later hardening; no issue proposed.
- **C-13,** an OpenCode subagent is not told to avoid courier_send to its parent. Harmless.

## Severity totals

| Reviewer | Blocker | Major | Minor/Nit |
| --- | --- | --- | --- |
| Comprehension | 0 | 3 | 10 |
| Codebase details | 0 | 4 | 10 |
| Zoom out | 0 | 2 | 7 |
| **Consolidated** | **0** | **3** (F1-F3) | **3** (F4-F6) |
