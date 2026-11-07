# Goldfish Review Report

**Target:** `egm-review/courier-orchestrate.SKILL.md` (`lines 1-51`, full file)
**Stage:** 5, Initial Zoom Out Review. Line numbers are those of the rendered file; `line_map.tsv` maps them to `src/skill.ts`.
Raw reviewer reports: `raw/stage5_zoom_out.md`, `raw/stage5_inventive_catalyst.md`.

## Reviewer Status

| Reviewer | Status |
| --- | --- |
| `egm-zoom-out` | completed (direct dispatch; the synthesizer could not spawn subagents in this environment) |
| `egm-inventive-catalyst` | completed (direct dispatch) |

## Summary

No Blockers. Both reviewers converge on one theme: about two thirds of the skill restates text the model already sees at the moment it needs it (the brief, the root role line, the tool descriptions, the spawn results and the event notices), and that text is paid for on every later request of the session. Both reviewers tested the maintainers' stated reason for repeating the split rule ("the root has no brief") against the code and report that the root's role line already carries the split rule, the heavy-task exception and the split-line forms. The content both reviewers find stated nowhere else: one group plus isolate plus no shared files (line 20), how to write a child's task (line 21), dependency ordering (line 23), passing a finding to the siblings it affects and upward plus the person's-word rule (line 30), merge, re-check and cleanup (line 39), the definition of done (line 43), the timing of the lesson (line 44), the "several whole jobs are that many parts" sentence (line 14) and the reason for the no-single-hop rule (line 15). The inventive catalyst adds two gaps the skill alone can close: the two ways to run more parts than the limits allow (line 20), and the standing entry as the first place to look after a compaction (line 50).

## Prioritized Findings (Blockers -> Major -> Nits)

### Z5-1. Sections 3 (answering) and "When a part goes wrong" restate the event notices - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** lines 29, 46-51
* **Discrepancy Description**: Each rule here is the closing instruction of a notice the model receives at the moment of the event: the permission notice (propose once unless the person told you to refuse or it goes against what they asked; the native variant says do not call courier_answer), the question notice (do not answer yourself, ask the person with exactly these questions), the failure notice (message it to try again, start a replacement, or carry on without it, word for word line 48), the silent-end notice (counts toward the limits until it reports), the spawn refusals (do this part yourself, or end your turn and start it once one has reported, which is line 49), and the courier_stop and courier_tree descriptions (lines 51 and 50). The only words in these six lines that exist nowhere else are "Do not retry it in a loop", "one look, not a loop" and "a failed turn does not count until you message it again".
* **Rationale & Recommendation**: Line 29 becomes "Answering from below: follow the notice; never answer for the person." Drop lines 46-51; if "do not retry in a loop" is wanted, append it to the refusal strings in `src/tree/text.ts`, the layer read exactly when it matters.

### Z5-2. Section 1 duplicates the brief and the root role line, and the stated reason does not hold - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`, `egm-inventive-catalyst` (both, independently)
* **Affected Scope:** lines 13-16 (and the trigger repeated on line 3)
* **Discrepancy Description**: The root's role line (`rolePart` for depth null in `src/tree/text.ts`, pushed on every request of a root with courier_spawn by `src/tree/context.ts`) already carries courier_recall once, the split criteria, "doing it yourself is fine", the heavy-task-whole exception "but never a small one", and the split-line forms. The child's brief (`splitRule`) carries the non-root rule including "never start exactly one session for the whole task" and the stage-is-a-part clause that line 15 says it repeats "as your brief says". courier_recall's own description says root only, once, not in a loop, spawned sessions read none. Line 15 re-derives from the depth budget a rule the plugin enforces anyway (a leaf has courier_spawn removed). So the maintainers' reason in CLAUDE.md ("the root has no brief") does not survive: the root has the rule in its role line. Stated nowhere else: "Several whole jobs in one prompt, such as 4 tickets, are that many parts" and the reason "a chain of single hops uses up the tree's depth".
* **Rationale & Recommendation**: Collapse to one bullet: "Split or do by the rule in your brief or role line. Several whole jobs in one prompt, such as 4 tickets, are that many parts: each session runs this skill for its job, so the tree below you repeats its shape once per job. Never one session for the whole task below the root: it only adds a hop, and a chain of single hops uses up the tree's depth." Liabilities the catalyst names: a sub-orchestrator whose brief was compacted away loses the stage-is-a-part wording unless its role entry gains that clause (a plugin change); the skill stops being self-contained for a person who reads it through /skills; a later trimming of the root role line would reopen the gap. The Elephant should decide this one with the maintainers' prompt-cache rule in view: the split rule costs the same tokens wherever it lives, so the question is only where it is read.

### Z5-3. The "whole job that delivers itself" mode is a playbook case threaded through four sections - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** lines 14 (the "4 tickets" sentence), 21 (last sentence), 23, 39 (second sentence), 43 ("or verified and delivered")
* **Discrepancy Description**: Line 9 and CLAUDE.md say planning and reviewing the parts is the person's own skill's job, and the repository's own example of that layer, `.claude/skills/courier-wave/SKILL.md`, is exactly this mode (each child takes an issue to a green PR; the orchestrator merges nothing). Every reader carries these clauses, including the common case of three parts merged into one checkout that never uses them. The one mechanics fact a parent needs to override (an isolated child's branch is for the parent to merge) is already in the isolate parameter's description and the child's brief.
* **Rationale & Recommendation**: Drop the deliver-itself clauses; a playbook that runs a wave writes "open a PR; I merge nothing" into the child's task. If one mention stays, line 39's second sentence alone suffices. Note the tension with Z5-2: the "4 tickets" sentence is one of the two the reviewers want kept in section 1, and it describes this mode.

### Z5-4. Line 44 repeats the courier_note description nearly verbatim - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** line 44
* **Discrepancy Description**: From "Name the job it comes from" to the end, the text is courier_note's description (name the job and the reason, one line of at most 300 characters, refused not clipped, a rule that holds every time goes to AGENTS.md or a skill through the person); the tool's result says the last part a third time.
* **Rationale & Recommendation**: Keep only what the skill adds, the timing and quantity: "At the top, before you reply to the person: one courier_note if the next tree should know something about running one like this; none otherwise."

### Z5-5. The no-polling paragraph is the fifth statement of a rule, with an enumeration the group parameter already carries - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** line 27
* **Discrepancy Description**: The rule and the courier_later check-in are already in the brief, the courier_spawn description, every spawn result, the courier_later description and the standing entry ("you need not look with courier_children or courier_tree"); the list of what wakes you is in the group parameter's description.
* **Rationale & Recommendation**: The reviewer concedes some repetition is arguable because models break this rule. Keep the heading plus "Reply without calling more tools; the reports and notices wake you." Drop the seven-item enumeration.

### Z5-6. The permission-rule workaround is stated twice, at command level, as advice the model cannot act on - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** lines 21 ("so that one permission rule covers the checks", "one permission rule for skill covers their loads") and 35 (second sentence onward)
* **Discrepancy Description**: A model cannot create or know the person's permission rules, so "choose commands one rule covers" is a guess; the rationale about how prompts propagate is stated nowhere a model could check. The skill-permission fact is already in `docs/reference.md`; how a person writes rules so a tree does not stall is advice to the person, and belongs there too. The inventive catalyst disagrees in part: it counts "one rule covers the checks" as a sound design-time choice and not a false compromise.
* **Rationale & Recommendation**: Reduce to "Verify first-hand: open the files, run the project's checks yourself." `test/notices.test.ts` asserts the phrase "so that one permission rule covers them", so the assertion moves with the cut. The Elephant should weigh the catalyst's dissent: the clause is a cheap hint that reduces stalls even if the model cannot verify the rules.

### Z5-7. Line 20 forces waves where ungrouped parts would keep the slots busy - Severity: Major (advisory)
* **Reviewer Lens:** `egm-inventive-catalyst`
* **Affected Scope:** line 20, last sentence
* **Discrepancy Description**: A group releases only when every member has reported, so the second wave waits for the slowest member of the first; with 8 parts under maxChildren 5, three slots idle through the tail. The refusal text already points at the other mode ("end your turn and start it once one of them has reported"), which only works for ungrouped parts, whose reports wake the parent at once. The plugin cannot resolve this itself (a group has no partial release), so the skill is the only place the reader learns there are two modes.
* **Rationale & Recommendation**: "When they do not all fit the limits at once, start waves, each its own group, or leave them ungrouped and start the next as each report frees a slot." Liability: one parent turn per report in the ungrouped mode, and the parent tracks what is still to start (the standing entry does this for direct children on OpenCode 2.2.0 and later).

### Z5-8. Line 50 sends the reader to courier_tree when the standing entry already has the answer - Severity: Nit
* **Reviewer Lens:** `egm-inventive-catalyst`
* **Affected Scope:** line 50
* **Discrepancy Description**: The standing entry is a baseline instruction the plugin keeps current, survives compaction, and says "you need not look with courier_children or courier_tree". The skill never names it.
* **Rationale & Recommendation**: "Lost track, after a compaction or a restart: your standing entry lists the sessions you started and their state; one courier_tree for what is below them, or when there is no entry. One look, not a loop." Liabilities: the entry lists at most 10 direct children, and is absent before OpenCode 2.2.0, so courier_tree stays named. If Z5-1 drops the section, this goes with it.

### Z5-9. Line 7 guards a case the plugin already routes away - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`, `egm-inventive-catalyst` (both)
* **Affected Scope:** line 7
* **Discrepancy Description**: A leaf has courier_spawn removed from its tools, and its brief and role line both say "do the task yourself" and report with courier_send to the session that started you. The first sentence (your brief names your depth) tells the model nothing to do. The catalyst keeps the first sentence and drops the second; the architect drops both.
* **Rationale & Recommendation**: Drop at least the second sentence. Liability: a leaf that opens the skill through /skills gets no instruction from the skill itself.

### Z5-10. Line 34 repeats the failure notice and the status meanings - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** line 34
* **Discrepancy Description**: The failed clause is the failure notice verbatim and is repeated again at line 48; partial and blocked are defined in courier_send's status description and the brief.
* **Rationale & Recommendation**: Keep only the clause stated nowhere else: what to do with blocked when only the person can decide.

### Z5-11. Parts that do not fit the limits are handled three times - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** line 20 (last sentence), line 49, and the refusal texts
* **Discrepancy Description**: The refusal arrives exactly when the limit bites. (Z5-7 wants line 20's sentence kept and corrected; the two findings agree the rule is stated once in the skill.)
* **Rationale & Recommendation**: State once, at line 20, as Z5-7 proposes; drop line 49.

### Z5-12. Line 22's model and variant advice is planning, not mechanics - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** line 22
* **Discrepancy Description**: The tool descriptions already say leave model and variant unset for your own model and give every fact behind the native heuristic. "Cheaper for a small part, stronger for a hard bug" is the kind of advice line 9 assigns to a playbook. `docs/reference.md` leans on the skill for it, so it is not a pure duplicate.
* **Rationale & Recommendation**: Keep the native sentence, the only one derived from mechanics; consider dropping the model and variant rule of thumb.

### Z5-13. Line 43 repeats the brief's combined report; only the definition of done is new - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** line 43
* **Rationale & Recommendation**: Keep "done only when every part is verified and integrated"; the rest is the brief plus courier_send's description.

## Examined and not raised

The inventive catalyst checked and cleared: relaying permissions versus keeping the tree moving (a rule saved at the top passes later proposals; the asks inbox needs no model); not polling versus losing a silent child (courier_later plus the failure, silent-end and reminder notices); child autonomy versus parent control; the depth, lesson-length and live-session limits (bounds, not compromises); prompt-cache stability versus per-session tailoring (a real bound of the skill registry, already handled by baseline instruction entries). It flags, for a consistency reviewer, the wording tension between "never hand the checking to another session" (line 35) and "native: true for a part that only reads, checks or looks something up" (line 22).

## Severity counts

| Severity | Count |
| --- | --- |
| Blocker | 0 |
| Major | 7 |
| Nit | 6 |
