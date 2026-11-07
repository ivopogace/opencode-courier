# Goldfish Review Report

**Target:** `egm-review/courier-orchestrate.SKILL.md` (`lines 1-51`, FeatureRange = whole document)
**Stage:** 7, Critic Review. Line numbers are those of the rendered file; `line_map.tsv` maps them to `src/skill.ts`.
Raw reviewer reports: `raw/stage7_design.md`, `raw/stage7_structural.md`, `raw/stage7_style.md`. Findings that repeat a Stage 5 or 6 finding are cross-referenced (Z5-n, C6-n) rather than restated in full.

## Reviewer Status

| Reviewer | Status |
| --- | --- |
| `egm-design` | completed (direct dispatch) |
| `egm-structural` | completed (direct dispatch) |
| `egm-style` | completed (direct dispatch) |

## Summary

No Blockers. The design critic traced the procedure against the plugin's source and found eight cases the text does not cover or states wrongly; the ones with the most consequence are a parent spawning or merging on a dirty checkout (C7-1), a replacement started for a failed sub-orchestrator whose children then wake the original (C7-2), the permission and question relay being described as if it reached every session when the code sends it to the top only (C7-4), a partial-report loop with no exit (C7-5), and `native: true` recommended for checking parts without the host caveat that their prompts show only in the TUI or app (C7-6). The style and structural reviewers independently reached the Stage 5 conclusion that a large share of the text restates tool descriptions, briefs and notices, and added: the description's trigger comes after the skill's own first step (C7-9), the fixed-form reply line is not set off from the prose (C7-11), the relay rules sit under the wrong heading (C7-12), and several factual overstatements that need calibration (C7-4, C7-10, C7-16). Three reviewers converge on the undefined "delivers itself" mode (C7-14) and the stage list that differs from the brief's (C7-13).

Claims the design critic checked and found backed by the code: group hold and replace semantics, the isolated brief's merge instruction, skill permission per load, the split lines, courier_note's refusal over the limit, the `shown="native"` rule, the person's-word rule, courier_tree's `owes` field, courier_stop's subtree semantics, and the refusal naming the three limits.

## Prioritized Findings (Blockers -> Major -> Nits)

### C7-1. The parent's checkout is assumed clean; nothing says commit first - Severity: Major
* **Reviewer Lens:** `egm-design`, `egm-structural` (finding 7), `egm-comprehension` (C6-10)
* **Affected Scope:** lines 20, 23, 39
* **Discrepancy Description**: An isolated child's worktree starts from the last commit (reference.md 519). `src/tree/spawn.ts` warns about uncommitted work only when the parent is itself isolated, so a root with a dirty checkout gets no warning: its children never see that work, and the `git merge courier/<session>` of line 39 fails when the uncommitted files overlap the branch. The brief has a "commit first" pre-step (text.ts 43-44); the skill's step 2 does not.
* **Rationale & Recommendation**: Add to line 20: "commit your own checkout first: isolated parts start from its last commit, and a merge into a dirty checkout fails".

### C7-2. Replacing a failed sub-orchestrator duplicates work, and the limit claim is wrong when it has live children - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** lines 48, 34
* **Discrepancy Description**: A child that split its part and then had its turn fail still has children running; their group release wakes it, so a replacement started per line 48 duplicates the job. `src/tree/limits.ts` 44-48 counts every ancestor of a live session as live, so "a failed turn does not count until you message it again" is false while the failed session has live descendants, and the replacement spawn may be refused.
* **Rationale & Recommendation**: Before "or start a replacement" add "after courier_stop on it if it has sessions of its own (one courier_tree shows)", and qualify the counting sentence with "unless sessions under it are live". The Elephant should verify the limits.ts reading before editing; it is a precise claim about code.

### C7-3. The wait is unbounded and the check-in is optional and under-specified - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** lines 27, 49, 50
* **Discrepancy Description**: The check-in is "for long work" only, yet it is the sole cover for a server failure the plugin cannot see and for a group that is not sealed because the top's step ended without `time.idle` after a rejected prompt (plugin-api-notes.md 160-166; group.ts `sealed`). The skill does not say what the check-in should say, what to do when it fires with reports still out (line 27 forbids courier_children, whose description allows a one-off look on a check-in), what to do when it fires after all reports arrived, that courier_cancel needs an id that a compaction loses, or which check-in to cancel when two groups are in flight.
* **Rationale & Recommendation**: One check-in per group, worded "if every report of group X is in, do nothing; else one courier_children, then message, drop or stop the member that is out"; keep its id in the reply; cancel it on the group's release. Weigh against Z5-5, which wants this paragraph shorter: the two agree that the enumeration of wake events can go and the check-in rule should be precise.

### C7-4. Permission and question notices reach the top only; the skill tells every session otherwise - Severity: Major
* **Reviewer Lens:** `egm-design`, `egm-style` (finding 3)
* **Affected Scope:** lines 27, 29, 35
* **Discrepancy Description**: `src/person/events.ts` sends a permission request to the top of the chain and the question relay does the same (reference.md 402-404). For a sub-orchestrator, "a question, a permission request ... each start a new turn for you" and "propose once with courier_answer" never happen, and "your own permission prompts are relayed nowhere" is false: they are relayed to the top like any child's. Only the root's prompts are relayed nowhere. The stall claim holds either way.
* **Rationale & Recommendation**: Prefix line 29 with "At the top:" and change line 35 to "The root's own prompts are relayed nowhere". Combine with Z5-1 and C7-16: line 29 then reduces to "At the top, answering from below: follow the notice, and never answer for the person."

### C7-5. The partial rule has no exit - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** line 34
* **Discrepancy Description**: A child that reports partial twice puts the parent in a loop: each partial is delivered, line 34 says "have the session finish it", and nothing caps the rounds.
* **Rationale & Recommendation**: "partial: have the session finish it once; if it is partial again, do the rest yourself or carry the gap in your own status."

### C7-6. `native: true` for a checking part is unsafe off the TUI - Severity: Major
* **Reviewer Lens:** `egm-design`, `egm-style` (finding 4)
* **Affected Scope:** line 22
* **Discrepancy Description**: A checking part runs a shell and asks permission; a native child's prompt shows only in the view of its nearest non-native ancestor, and under `opencode run` without `--auto` or a bare API client it is rejected or seen by no one (reference.md 660, 666-678). The skill gives the caveat nowhere. The style reviewer adds that `native` has three states (true, false, unset, where unset defers to the `nativeChildren` option), so "leave it off" read as "unset" can produce the opposite of the stated intent.
* **Rationale & Recommendation**: "native: true for a part that only reads, checks or looks something up and reports once, when the person works in the TUI or app; native: false for a part the person may want to open, or that should outlive you."

### C7-7. "Say whether it may split its part further" is a lever the plugin does not provide - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** line 21
* **Discrepancy Description**: `splitRule` in `src/tree/text.ts` puts the split rule in every brief below maxDepth unconditionally; the task text can only ask. A child that splits makes the parent's group wait on the child's group, and a silent grandchild blocks both while its notice goes to the child alone. The parent also cannot budget maxTotal when line 14 has every job repeat the shape.
* **Rationale & Recommendation**: State the limit honestly ("its brief lets it split by the same rule; say so only to forbid it, when depth or total is short"), or change the plugin so the brief honours the task's say. A plugin change is outside this document.

### C7-8. A root that is itself an OpenCode subagent is not addressed - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** lines 7, 13, 15
* **Discrepancy Description**: `src/tree/context.ts` treats any session without roster lineage that has courier_spawn as a root. A session started by OpenCode's own subagent tool inside a tree reads lines 13 and 15 as its own, calls courier_recall, may start one session for the whole task, and starts a second tree with its own record, budget and relay target that nobody opens.
* **Rationale & Recommendation**: Add to line 7: "if OpenCode's subagent tool started you, do not split: report to the session that started you". The Elephant should confirm whether the plugin can detect this case itself; if it can, the fix belongs in context.ts, not the skill.

### C7-9. The description's trigger comes after the skill's own first step - Severity: Major
* **Reviewer Lens:** `egm-style` (finding 1), `egm-structural` (finding 8)
* **Affected Scope:** line 3
* **Discrepancy Description**: "Load before you split a task" tells a model to load the skill after it has decided to split, so step 1 (courier_recall, the decision, the reply line) is skipped; the root role line says to load it before deciding. The description also omits the decision step, the lesson and the failure section, and its colon reads two ways.
* **Rationale & Recommendation**: "How opencode-courier's session tools work. Load before you decide whether to split a task with courier_spawn: 2 or more independent, substantial parts touching separate files or areas. Starting the parts, waiting without polling, relaying questions and permissions, reading reports, merging, reporting upward." A change here is a model-facing string: re-run `e2e/real-model.sh` per CLAUDE.md.

### C7-10. Line 7 is false for the root before its first spawn - Severity: Major
* **Reviewer Lens:** `egm-style` (finding 2); also Z5-9, C6-1
* **Affected Scope:** line 7
* **Discrepancy Description**: The root's role line before its first spawn names neither depth nor any limit; only the depth-0 line written after the first spawn does. The second sentence repeats the leaf's role line and brief.
* **Rationale & Recommendation**: CALIBRATE to "Below the root, your brief names your depth and the tree's limits." and DROP the second sentence, or drop the line (Z5-9). If C7-8 is taken, line 7 gains the subagent clause instead.

### C7-11. The fixed-form reply line is not set off from the prose - Severity: Major
* **Reviewer Lens:** `egm-structural` (finding 3), `egm-style` (finding 6), `egm-comprehension` (C6-14)
* **Affected Scope:** line 16
* **Discrepancy Description**: The first form contains a semicolon, " or " joins the second, and "; the root has a third form" is prose, so a reader cannot tell template punctuation from sentence punctuation, or whether ", to keep my context" is literal (it is, per `ONE_PART_LINE`). This is the one line the session must reproduce verbatim.
* **Rationale & Recommendation**: Backticks around each form: "Say which in one line of your reply before you start: `split: no, because …; considered: <the parts you weighed>` or `split: <n> parts: … (one phrase per part)`; at the root also `split: 1 part: <the task>, to keep my context`." The same raw strings appear in the brief and role line; `protocol.ts` is the place to add the delimiters once.

### C7-12. The relay rules sit under "End your turn", and failure handling is split across three places - Severity: Major
* **Reviewer Lens:** `egm-structural` (findings 1, 2, 14), `egm-comprehension` (C6-21); overlaps Z5-1
* **Affected Scope:** lines 25-30, 34, 46-51
* **Discrepancy Description**: Lines 29-30 are rules for a later turn, not for ending this one; a session returning on a permission request has no heading to find them under. Failure handling appears at 27 (wake list), 34 (status failed), 48 (failed turn) with near-identical remedies; limits at 20 and 49; courier_stop at 30 and 51; cleanup at 39 and 51 without saying the parameter belongs to courier_stop.
* **Rationale & Recommendation**: Either a heading of its own for the relay rules, or move them into step 4; let the closing section own every "went wrong" rule and step 4 the four statuses, not both. If Z5-1 drops lines 46-51, the split resolves itself.

### C7-13. Line 15's stage list differs from the brief it cites - Severity: Major
* **Reviewer Lens:** `egm-structural` (finding 6), `egm-style` (finding 5)
* **Affected Scope:** line 15
* **Discrepancy Description**: The skill lists two stages (a core, a review); the brief and reference.md 177 list three, adding "the fixing of what a review found once you have verified it", and give the test for "the whole task". "As your brief says" is false for the root, which has no brief, and for a child it admits its own redundancy. The reason clause after "never starts exactly one session" is longer than the rule, and "it" shifts referent.
* **Rationale & Recommendation**: Align the list with the brief or defer to it wholly (Z5-2). The style reviewer's rewrite keeps the root exception and the three-item list and drops the reasons.

### C7-14. "Delivers itself" is undefined and lines 23 and 39 pull against each other - Severity: Major
* **Reviewer Lens:** `egm-style` (findings 8, 9), `egm-comprehension` (C6-2, C6-15), `egm-design` (nit 6); overlaps Z5-3
* **Affected Scope:** lines 21, 23, 39, 43
* **Discrepancy Description**: "Deliver" is never defined; line 39 says merge nothing of a delivered job while line 23 tells a dependent sibling to merge its branch; line 23's parallelism makes "started" and "told" read as states of the finished part; and two delivered jobs are never checked together, so "done" at line 43 asserts more than was verified.
* **Rationale & Recommendation**: Define once at line 39 ("a whole job whose result goes somewhere other than your checkout: its session puts it there and reports the place; verify it there and merge nothing of it"), rewrite line 23 as the style reviewer proposes, and at line 43 say "verified and delivered (each on its own)". Or drop the mode from the skill (Z5-3) and leave it to the playbook.

### C7-15. The description of what the parent must put in the child's task carries unsupported claims - Severity: Major
* **Reviewer Lens:** `egm-style` (finding 7); overlaps Z5-6, C6-6
* **Affected Scope:** line 21
* **Discrepancy Description**: "one permission rule for skill covers their loads, as one covers the checks" asserts something about OpenCode's permission matching that no listed file supports (reference.md 227 says only that loading asks the skill permission). "(step 4)" reads as a reference or an instruction; "it sees the same list, not your choice" is cryptic; the "since" clause is longer than its rule.
* **Rationale & Recommendation**: DROP the permission-matching clause; "Name the skills it should load, from those listed to you (it sees the same list). Say whether it may split further (see C7-7), and whether it delivers its own result (step 5) instead of leaving its branch for you to merge."

### C7-16. Line 29 and line 44 restate notices and the courier_note description, and line 44 misstates who may write a lesson - Severity: Major
* **Reviewer Lens:** `egm-style` (findings 11, 13), `egm-design` (nit 5); same as Z5-1, Z5-4
* **Affected Scope:** lines 29, 44
* **Discrepancy Description**: Every sentence of line 29 after "follow the notice" is a notice's closing sentence, and "their answer goes on by itself" overclaims (only when the question tool is used with the notice's exact wording; the unlinked case has its own notice). Line 44 after its first clause is courier_note's description, and "At the top" contradicts the tool, which lets any session that started sessions write a lesson; a second note replaces the first, so a sub-orchestrator following the tool and a top following the skill overwrite each other.
* **Rationale & Recommendation**: Line 29: "At the top, answering from below: follow the notice, and never answer for the person." Line 44: "At the top, before you reply to the person: one courier_note if the next tree in this project should know something about running one like this; none when there is nothing. A sub-orchestrator puts its lesson in its report, not in a note." (The last clause resolves the overwrite without widening the skill.)

### C7-17. The procedure loops but is numbered as a line - Severity: Major
* **Reviewer Lens:** `egm-structural` (finding 4)
* **Affected Scope:** lines 11-44
* **Discrepancy Description**: Lines 20, 23 and 30 send the reader from step 5 back to step 2 or step 3, and nothing says the cycle exists.
* **Rationale & Recommendation**: One clause at the head of step 2 or in line 9 naming the loop ("steps 2 to 5 repeat for each group").

### C7-18. Dense multi-rule bullets without a lead keyword - Severity: Major
* **Reviewer Lens:** `egm-structural` (finding 5)
* **Affected Scope:** lines 13-16, 20-23, 29-30, 43-44
* **Discrepancy Description**: Lines 15, 21, 30 and 44 hold four or five rules each; a reader returning for one rule scans 80-100 words. The closing section and line 29-30's lead words are the model; line 34's four statuses would be four keyed bullets.
* **Rationale & Recommendation**: Split the long bullets by rule with a lead keyword. This trades a few tokens for findability; weigh against the Stage 5 cuts, which remove most of the dense material anyway.

### C7-19. Line 30 names no subject and "progress goes to no one" reads as a fact - Severity: Nit
* **Reviewer Lens:** `egm-style` (finding 12), `egm-comprehension` (C6-3, C6-18)
* **Affected Scope:** line 30
* **Rationale & Recommendation**: "Passing on a message from below, from the person or from your parent: when it changes ..."; replace "when your parent's other parts need it" (a judgement the session cannot make) with "when it may concern work outside your part"; model the progress clause on the brief's "Progress alone is not worth a message".

### C7-20. Line 13 says one thing four ways and repeats courier_recall's description - Severity: Nit
* **Reviewer Lens:** `egm-style` (finding 15); same as Z5-2
* **Affected Scope:** line 13
* **Rationale & Recommendation**: "At the root, call courier_recall once before you decide. Below the root, do not call it."

### C7-21. Line 9's "is a playbook's" is jargon with a dangling possessive - Severity: Nit
* **Reviewer Lens:** `egm-style` (finding 16), `egm-comprehension` (C6-13), `egm-structural` (finding 9)
* **Affected Scope:** lines 5, 9
* **Rationale & Recommendation**: "This skill says how the tools behave. Planning the parts, staging a core and reviewing the merge are not in it: if a skill for them is listed to you, load it too." The structural reviewer notes the title and line 9 describe a tool-mechanics document while every heading is a procedure step; the headings are right, the framing is the mismatch.

### C7-22. Inconsistent naming: root/top, part/session, failed status/failed turn, checkout/worktree, and parameter formatting - Severity: Nit
* **Reviewer Lens:** `egm-style` (finding 17), `egm-structural` (findings 11, 12), `egm-comprehension` (C6-12)
* **Affected Scope:** whole document
* **Rationale & Recommendation**: "root" for the tree and "first session" for a subtree; "session" wherever a tool is applied; "failed: read what went wrong" at line 34 to match the brief; one word for the parent's working copy; backticks for every parameter, status value and literal so "done" and "group name" read as values.

### C7-23. Lockfiles and generated files break "no two parts edit the same files" - Severity: Nit
* **Reviewer Lens:** `egm-design` (nit 1)
* **Affected Scope:** lines 20, 39
* **Rationale & Recommendation**: "regenerate lockfiles and generated files rather than merging them by hand" (this project's own snapshot file is one).

### C7-24. The isolation rule covers editors only - Severity: Nit
* **Reviewer Lens:** `egm-design` (nit 2)
* **Affected Scope:** lines 20, 23
* **Rationale & Recommendation**: A non-isolated part that reads what another part edits sees the parent's checkout change under it when a branch is merged. Add "or reads what another edits" to the isolate condition.

### C7-25. After a compaction the plan, group names and check-in ids are gone - Severity: Nit
* **Reviewer Lens:** `egm-design` (nit 3); overlaps Z5-8
* **Affected Scope:** lines 16, 50
* **Rationale & Recommendation**: Have the reply line of line 16 also name the group and the check-in id, so a summary keeps them; point line 50 at the standing entry first (Z5-8).

### C7-26. courier_cleanup leaves the courier/ branches, and cleanup: true keeps a worktree holding unbranched work - Severity: Nit
* **Reviewer Lens:** `egm-design` (nit 4), `egm-style` (finding 14, cleanup caveat)
* **Affected Scope:** lines 39, 51
* **Rationale & Recommendation**: "removes their worktrees, except one holding work on no branch; delete merged courier/ branches yourself", or drop line 51 (Z5-1) and let courier_stop's description carry the caveat.

### C7-27. Smaller redundancies and wording - Severity: Nit
* **Reviewer Lens:** `egm-style` (findings 18-23), `egm-structural` (findings 10, 13)
* **Affected Scope:** lines 14, 20, 21, 22, 27, 34, 39
* **Rationale & Recommendation**: Drop "so that you are woken once with every report" (the group parameter says it), "so a part runs on your own model" (the model parameter says it), and the figurative "repeats its shape"; "partial: what is left and why" has no verb; "send it" at line 34 should be "send your decision"; "(step 4)" at line 21 points to a rule about the parent's own checks, not the child's; line 27's wake list omits a form (reference.md 321); step 5 is one paragraph holding two rules where the other steps use bullets.

## Severity counts

| Severity | Count |
| --- | --- |
| Blocker | 0 |
| Major | 18 |
| Nit | 9 |
