# Goldfish Review Report

**Target:** `egm-review/courier-orchestrate.SKILL.md` (`lines 1-51`, DetailedRange = whole document; the procedure itself is the executable part)
**Stage:** 9, Implementation Readiness Test. Line numbers are those of the rendered file; `line_map.tsv` maps them to `src/skill.ts`.
Raw reviewer reports: `raw/stage9_implementation_readiness.md`, `raw/stage9_codebase_details.md` (the latter has a line-by-line verdict table: for every claim in lines 7-51, backed by, contradicted by, or unverifiable, with `file:line`).

## Reviewer Status

| Reviewer | Status |
| --- | --- |
| `egm-implementation-readiness` | completed (direct dispatch) |
| `egm-codebase-details` | completed (direct dispatch) |
| `egm-style` | not run in this stage: it reviewed the same range in Stage 7 and the document is unchanged |

## Summary

The procedure is executable end to end: every tool, parameter, status value, attribute name and branch name the skill cites exists with that spelling (no Non-Existent References), and the step order produces every id a later step needs. The codebase-details audit found five statements the code contradicts, which its persona rates Blocker because every later reader inherits them. Four were asserted in Stage 7 and confirmed in Stage 8; this stage re-verified them independently and added a fifth (line 7 is false for the root before its first spawn). It also found three omissions no tool text supplies at the moment of use. The readiness walk of three readers (a root with three parts, a depth-1 child that may split, a root after compaction) found four decisions the text leaves to the session: which parts "deliver themselves", what "leave native off" means, the check-in's delay and content, and how a compacted root tells which branches it already merged.

The readiness reviewer wrote that line 48's limits claim "matches" the code; the codebase-details reviewer and the Stage 7 critic read `limits.ts` 44-48 and find it false when the failed session has live descendants. Both are right about what they checked: a failed leaf does not count, a failed sub-orchestrator with running children does. The sentence as written does not make that distinction.

## Prioritized Findings (Blockers -> Major -> Nits)

### R9-1. Permission and question notices reach the top only; lines 27 and 29 address every reader - Severity: Blocker
* **Reviewer Lens:** `egm-codebase-details` (finding 1); confirms C7-4, Z8-8
* **Affected Scope:** lines 27, 29 (and 51 by implication)
* **Discrepancy Description**: `src/person/events.ts` 19-21 and `ports.ts` 30 send the permission notice to the top of the chain; `question/answer.ts` 21-24 and `form.ts` 29-31 do the same for questions and forms; `src/tree/roster.ts` 50-58 refuses courier_answer from any caller that is not the top. For every reader below the root the "Answering from below" bullet is dead text and the wake list is wrong.
* **Rationale & Recommendation**: Wake list: "a question or a permission request (at the top only)". Line 29: prefix "At the top:", or reduce to one sentence per Z8-10 so nothing false remains.

### R9-2. "A failed turn does not count toward the limits" is false when a session under it is live - Severity: Blocker
* **Reviewer Lens:** `egm-codebase-details` (finding 2); confirms C7-2, Z8-2
* **Affected Scope:** line 48
* **Discrepancy Description**: `src/tree/limits.ts` 44-48 builds the active set from every live entry plus every ancestor in its chain. A sub-orchestrator whose turn fails while its children run still counts toward maxChildren and maxTotal; only a failed leaf does not (`report.ts` 23-28, `limits.ts` 19).
* **Rationale & Recommendation**: "a failed turn does not, unless a session under it is still live, or until you message it again." Or drop the line (Z5-1) and put the case in the failure notice (Z8-2).

### R9-3. "Leave native off" is not "standalone": unset defers to the nativeChildren option - Severity: Blocker
* **Reviewer Lens:** `egm-codebase-details` (finding 3), `egm-implementation-readiness` (finding 2); confirms C7-6, Z8-3
* **Affected Scope:** line 22
* **Discrepancy Description**: `src/tree/spawn.ts` resolves `native` as `input.native ?? nativeChildren === true` (and never with a worktree). With the option on, an unset native makes the part a subagent that is deleted with the parent, the opposite of "should outlive you". The parameter description says so; the skill contradicts the schema the model reads next to it.
* **Rationale & Recommendation**: "native: false" in place of "leave it off", or drop the sentence (Z8-3).

### R9-4. "Your own permission prompts are relayed nowhere" is true only at the root - Severity: Blocker
* **Reviewer Lens:** `egm-codebase-details` (finding 4); confirms C7-4 (second half), style finding 3
* **Affected Scope:** line 35
* **Discrepancy Description**: `events.ts` 14-15 returns without a notice only for an empty lineage. A spawned reader's own request is relayed to the top like a child's. A sub-orchestrator reading line 35 believes its prompt can be answered only in its own session.
* **Rationale & Recommendation**: "At the root your own prompts are relayed nowhere; below it they go to the top like any other", or drop the clause (Z8-8 says it must not survive in any form).

### R9-5. Line 7 is false for the root before its first spawn - Severity: Blocker
* **Reviewer Lens:** `egm-codebase-details` (finding 5); confirms style finding 2, C7-10
* **Affected Scope:** line 7
* **Discrepancy Description**: `rolePart(null)` in `src/tree/text.ts` 75-82 names neither a depth nor any limit; the root's limits appear only in the depth-0 role entry written at its first spawn. Line 20 then asks the root to plan batches against limits it does not know; the refusal texts supply the numbers at the moment of use, so the damage is bounded.
* **Rationale & Recommendation**: "... names your depth and, once you have started a session, its limits", or drop the line (Z5-9, Z8-10 fold the gloss into step 1).

### R9-6. Line 15 omits the brief's third stage and its test for "the whole task" - Severity: Major
* **Reviewer Lens:** `egm-codebase-details` (finding 6); confirms C7-13
* **Affected Scope:** line 15
* **Discrepancy Description**: The brief (`text.ts` 57-59) and reference.md 175-179 list core, review, and "the fixing of what a review found once you have verified it", plus the test "one session alone, with nothing of the task done before it by you or by 2 or more parts, and fewer than 2 parts after it, is the whole task". The root, the one reader with no brief, never sees the fixing stage and may refuse a legitimate single fixing session. Nothing at the moment of use supplies it.
* **Rationale & Recommendation**: Append "or the fixing of what a review found, once verified", or defer to the brief and role line wholly (Z5-2, Z8-10).

### R9-7. An isolated part does not see uncommitted project skills - Severity: Major
* **Reviewer Lens:** `egm-codebase-details` (finding 7)
* **Affected Scope:** line 21
* **Discrepancy Description**: "it sees the same list" is false for an isolated part: its worktree starts from HEAD, so project skills not yet committed are absent from its list (reference.md 278-280). A parent naming an uncommitted project skill sends the child after a skill it cannot load. The isolate description speaks of files, not skills.
* **Rationale & Recommendation**: "(an isolated part sees only committed project skills)". Alternatively, this is one more reason for the commit-first rule to live in the isolate description (Z8-1), where it can say "files and project skills".

### R9-8. A stopped member that was idle stays in its group and in the limits until courier_cleanup - Severity: Major
* **Reviewer Lens:** `egm-codebase-details` (finding 8)
* **Affected Scope:** lines 51, 48
* **Discrepancy Description**: A stopped member leaves its join group only if its turn was interrupted (`events.ts` 96-108, `stop.ts` 103-116); one that was idle when stopped (typically one that ended silently) stays out, the group never completes until courier_cleanup drops it (`forget.ts` 25-31), and it still owes its report so it still counts toward the limits. The stop result says nothing about the group or the limits; only the standing entry hints at it on OpenCode 2.2.0 and later.
* **Rationale & Recommendation**: Add to line 51 "a member that was not running stays in its group and in the limits until you courier_cleanup it", or, per the Stage 8 placement rule, put it in the courier_stop result where it applies.

### R9-9. "Delivers itself" must be decided per part at step 2, and no criterion is given - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (finding 1); confirms C7-14, Z8-9
* **Affected Scope:** lines 21, 23, 39
* **Discrepancy Description**: The orchestrator must choose merge or delivered for each part in the task text, before any report exists; the criterion and the meaning of "deliver" in tool terms are never stated, and the tools only know the merge mode. The reader with three parts in one repository has to guess.
* **Rationale & Recommendation**: Either give the criterion in one clause at line 21 ("a part delivers itself only when its result lives outside your checkout: a PR, a release, another repository") and move the definition up, or drop the mode from the skill (Z8-9).

### R9-10. The check-in's delay and content are unnamed, and after a compaction it cannot be cancelled - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (finding 3); confirms C7-3, Z8-7
* **Affected Scope:** line 27
* **Discrepancy Description**: courier_later requires a delay or a time and the skill suggests neither, nor what the message should say; after a compaction the id is gone and no tool lists scheduled messages, so "courier_cancel it" is unexecutable (the consequence is one stray wake).
* **Rationale & Recommendation**: Name a default ("about twice the time you expect the longest part to take") and the content ("look once with courier_children"), or keep only "one check-in per group, cancelled when its reports arrive" (Z8-7) and let courier_later's description carry the rest.

### R9-11. After a compaction nothing shows the orchestrator's own progress - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness` (finding 4); overlaps C7-25
* **Affected Scope:** line 50
* **Discrepancy Description**: courier_tree, courier_children and the standing entry show the children's side (reported, owes, ended). None shows whether the two reports already in were verified, merged and cleaned up, or whether the outstanding one was already re-messaged once. Git holds the first answer (`git branch --merged`, the worktrees still present); nothing holds the second.
* **Rationale & Recommendation**: One clause at line 50: "git branch --merged and the worktrees still present show which reported branches you have already merged and cleaned up". Weigh against Z8-16, which drops line 50; if the section goes, this clause is the one piece of it that no tool supplies.

### R9-12. Smaller gaps - Severity: Nit
* **Reviewer Lens:** both reviewers
* **Affected Scope:** lines 16, 21, 27, 34, 44, 49, 50, 51
* **Rationale & Recommendation**: Line 44's "At the top" narrows what courier_note permits without saying what a sub-orchestrator should do instead (readiness 5; same as C7-16). Line 21's "permission rule" is configuration vocabulary two steps before line 35 explains the intent (readiness 6). Lines 21 and 23 use "delivered (step 5)" before step 5 defines it (readiness 7). The isolate description's commit-first warning covers only an isolated parent and the spawn warning arrives after the spawn (readiness 8; same as C7-1). "In one line of your reply" could be read as a turn before the spawns (readiness 9). The maxDepth refusal offers only "do it yourself"; depth never frees (codebase 9). courier_tree lists at most maxTotal sessions (codebase 10). cleanup keeps a worktree with unbranched work (codebase 11; same as C7-26). "failed: read the error" uses the failed-turn notice's wording for a `status: failed` report that has no error field (codebase 12). The wake list omits `ended="stopped"`, a form, and a courier_later message (codebase 13). Outside the target: the depth-0 role line does not tell the root to load the skill, so after a compaction that drops the skill text the root has only the tool descriptions for steps 4-6 (readiness 10, for the maintainers).

## Severity counts

| Severity | Count |
| --- | --- |
| Blocker | 5 |
| Major | 6 |
| Nit | 1 (grouping 10 items) |
