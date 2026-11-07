# Consolidated EGM Review: the courier-orchestrate skill

**Target:** the text of the `courier-orchestrate` skill, `src/skill.ts`, reviewed as models load it: `egm-review/courier-orchestrate.SKILL.md` (51 lines, about 1,470 words of body). `line_map.tsv` maps each rendered line to its line in `src/skill.ts`. All line numbers below are rendered-file lines.
**Date:** 2026-11-07. **Pipeline:** EGM Goldfish Review, consolidated (uninterrupted) preset, all five stages. Stage reports: `zoom_out_report.md` (5), `comprehension_report.md` (6), `critic_report.md` (7), `intermediate_zoom_out_report.md` (8), `implementation_readiness_report.md` (9); raw reviewer output in `raw/`.

## How the review was run, and where it departed from the protocol

- The user did not choose a preset and could not answer a checkpoint prompt mid-run, so the consolidated preset ran without stops.
- The `egm-synthesizer` subagent cannot spawn subagents in this environment, so every reviewer was dispatched directly from the main context, in parallel within a stage and sequentially across stages, and the main context compiled each report. Nine reviewer runs, all completed; none `not run`.
- The document has no implementation plan, so the protocol would stop after Stage 8. Stage 9 ran anyway on the whole text, because the skill is itself the executable procedure and the codebase-details lens (every claim checked against the source) is the most valuable check for a document that tells models how tools behave. The style reviewer was not run a second time in Stage 9: it had covered the same range in Stage 7 and the text was unchanged.
- The reviewers were told what the document is (an operating procedure a model follows, not a design doc) and to apply each standard's core principle rather than its section template. They were given the maintainers' two claims to test, not assume: that the skill is "the tools' mechanics", and that it repeats the brief's split rule because the root has no brief.
- The Elephant (main context) spot-checked the three load-bearing code claims after the reviewers finished: the permission and question relay goes to the top of the chain only (`src/person/events.ts`), the limits count every ancestor of a live session (`src/tree/limits.ts` 44-48), and the root's pre-spawn role line already carries the split rule, the heavy-task exception and the split-line forms (`src/tree/text.ts` 75-82). All three hold.

## Verdict in one paragraph

The procedure is sound and executable: every tool, parameter, value and attribute it names exists as spelled, and the step order works. Two things are wrong with it. First, it states five facts about the plugin that the code contradicts, all of them about who receives what: permission and question notices reach only the top session, yet lines 27, 29 and 35 tell every session they will be woken and should answer; a failed sub-orchestrator with live children still counts toward the limits (line 48); "leave native off" is not "standalone" when the `nativeChildren` option is on (line 22); and the root's role line does not name its limits before its first spawn (line 7). Second, about two thirds of the text restates what the model already has in a tool description, the brief, the root role line or the notice that arrives at the moment of use, and every session pays those tokens on every later request. Five of the nine reviewers reached the second conclusion independently; the Stage 8 reviewer, with all earlier reports in hand, laid out a version of about a third the length that keeps everything the plugin's own text does not say and closes every gap that is a gap in the text rather than in the plugin. The maintainers' stated reason for repeating the split rule ("the root has no brief") is literally true but does not carry the conclusion: the root's role line has the rule.

## Action items

Severity is the highest any reviewer assigned. Each item names the lines, the action, and where it belongs. Items under B are plugin changes the review recommends instead of skill text; the maintainers decide whether a skill clause stands in until the plugin changes.

### 🔴 Blockers: statements the code contradicts (fix in the skill now, whichever shape it takes)

| Id | Lines | What is wrong | Action |
| --- | --- | --- | --- |
| B1 | 27, 29 | Permission requests and questions from below reach the top session only; the skill tells every session it is woken and should `courier_answer`. Below the root the bullet is dead text and courier_answer is refused. | Shortest true form: "At the top, a permission request or question from below arrives with its own instructions: follow them, and never answer for the person." Drop the wake-list entries or mark them "(at the top only)". |
| B2 | 35 | "Your own permission prompts are relayed nowhere" is true only at the root; below it they go to the top like any child's. | Drop the clause (Stage 8: it must not survive in any form). Keep "verify first-hand: open the files, run the project's checks yourself". |
| B3 | 22 | "Leave it off" for `native` reads as unset, and unset defers to the `nativeChildren` option; with it on, the part becomes a subagent that dies with the parent. | Write "native: false", or drop the native sentence and put the host caveat in the parameter description (B-side item P5). |
| B4 | 48 | "A failed turn does not count toward the limits until you message it again" is false while any session under it is live. | "unless a session under it is still live", or drop the section (M1) and put the case in the failure notice (P2). |
| B5 | 7 | "Your brief, or the role line, names your depth and its limits": the root's pre-spawn role line names neither. | Drop the line (M1, M3) or write "and, once you have started a session, its limits". |

### 🟡 Major: cut, calibrate or restructure the text

| Id | Lines | Finding | Action |
| --- | --- | --- | --- |
| M1 | 29, 46-51, 34 (done/partial/failed), 27 (second and third sentences), 13 (most), 44 (after first clause) | Restates the notices, refusals, tool descriptions and brief that the model receives at the moment of use. Only "do not retry in a loop", "a failed turn does not count (see B4)", the blocked clause of 34 and the timing of the lesson are new. | Remove. "Not in a loop" goes to the refusal strings in `src/tree/text.ts` (P6). Line 27 keeps "Reply without calling more tools; reports and notices wake you; one courier_later check-in per group, cancelled when its reports arrive." Line 44 keeps "At the root, before you reply to the person: one courier_note if the next tree in this project should know something about running one like this; none when there is nothing." |
| M2 | 13-16 | Duplicates the brief (children) and the root role line (root): split criteria, courier_recall once, the heavy-task exception, all split-line forms. Stated nowhere else: "several whole jobs in one prompt, such as 4 tickets, are that many parts" and the one-hop reason. | One bullet: "Split or do by the rule in your brief (the text above your task) or, at the root, in the opencode-courier role line in your system prompt, and say which in its split line. Several whole jobs in one prompt, such as 4 tickets, are that many parts. Below the root, never one session for the whole task: it only adds a hop, and a chain of single hops uses up the tree's depth." Update CLAUDE.md's reason (D1). If line 15 stays instead, align its stage list with the brief's three stages and its test (M9). |
| M3 | 7 | Guards the leaf, which the plugin already routes away (no courier_spawn; its brief and role line say do it yourself). | Drop; the brief/role-line gloss moves into M2's bullet. |
| M4 | 14 ("4 tickets" tail), 21 (last clause), 23, 39 (second sentence), 43 ("or verified and delivered") | The "whole job that delivers itself" mode is undefined (what is "deliver"?), threads through four sections, contradicts itself between 23 and 39, and belongs to a playbook (`courier-wave` is that playbook). Every orchestrator must decide it per part at step 2 with no criterion. | Drop the mode from the skill. Line 23 becomes "A part that depends on another starts once that one's branch is merged into your checkout." If a mention stays, define it once at 39 with the criterion "its result lives outside your checkout: a PR, a release, another repository" and say at 43 "verified and delivered (each on its own)". |
| M5 | 21, 35 | "So that one permission rule covers the checks" and "one permission rule for skill covers their loads" assert OpenCode permission matching no file supports, and advise on rules the model cannot see; "a tool's own path" names nothing actionable. One reviewer dissents (a cheap hint that reduces stalls). | Reduce line 21's clause to "name one project script for all its checks"; line 35 to "run the project's checks yourself". Advice to the person on writing rules goes to `docs/reference.md` (D2). `test/notices.test.ts` asserts "so that one permission rule covers them"; the assertion moves with the cut. |
| M6 | 21 | "Say whether it may split its part further" is not a lever: the brief lets every non-leaf split by the same rule. "It sees the same list" is false for an isolated part, which sees only committed project skills. | Drop the split clause. Write "(an isolated part sees only committed project skills)" or fold it into P1. |
| M7 | 20 | Forces waves (one group after the first reports) where ungrouped overflow parts would keep the slots busy; the refusal text already points at the ungrouped mode. The plugin cannot resolve it (a group has no partial release). | "When they do not all fit the limits at once, start waves, each its own group, or leave them ungrouped and start the next as each report frees a slot." Drop line 49 (stated three times). |
| M8 | 27 | The check-in: unbounded wait, no delay, no content, cannot be cancelled after a compaction (no listing tool), ambiguous with two groups in flight. | Skill: "one courier_later check-in per group, cancelled when its reports arrive" (in M1's line 27). Delay and content: courier_later's description, if anywhere. The unsealed-group-after-a-plain-decline trap: plugin or docs (P7, D3). |
| M9 | 15 | Lists two one-session stages; the brief and reference list three (core, review, fixing after review) plus the test for "the whole task", while saying "as your brief says". The root never sees the third. | Covered by M2 (defer to the brief and role line). If kept, append "or the fixing of what a review found, once verified". |
| M10 | 34 | The partial rule has no exit (a child that reports partial twice loops the parent). Stage 8 calls a cap arbitrary. | With M1 only the blocked clause stays: "blocked: make the decision it asks for and courier_send it; if only the person can, ask them and pass the answer on." If partial stays: "have it finish, or do it yourself." |
| M11 | 3 | The description says "load before you split", after the skill's own first step (decide); it omits the decision, the lesson and the failure section. A model-facing string: re-run `e2e/real-model.sh` and update `real-model.md`. | "How opencode-courier's session tools work. Load before you decide whether to split a task across sessions with courier_spawn: starting parts, waiting without polling, relaying questions and permissions, reading reports, merging, reporting upward." |
| M12 | 25-30 | The relay rules sit under "End your turn"; a session returning on a notice has no heading to find them under. Failure handling is split across 27, 34 and 46-51 with overlapping remedies. | After M1 the relay rule is one sentence; rename the heading "3. End your turn; what wakes you" or put the sentence under step 4. The closing section goes (M1). |
| M13 | 16 | The three split-line forms share one punctuation set with the prose; the reader cannot tell template semicolons from sentence semicolons or whether ", to keep my context" is literal (it is). | The forms come from `protocol.ts` and also appear in the brief and role line: add the delimiters there once (P8) or nowhere. After M2 the skill no longer carries line 16. |
| M14 | 51, 48 | A stopped member that was idle stays in its group and in the limits until courier_cleanup; the stop result does not say so. | Belongs in the courier_stop result (P9), or one clause on line 51 if the section stays. |
| M15 | 50 | After a compaction nothing shows the orchestrator's own progress (which reported branches it already merged and cleaned up). | If the section stays: "git branch --merged and the worktrees still present show what you already merged." Otherwise the standing entry and git are what the model has; no tool supplies the orchestrator's side. |
| M16 | 30 | Names no subject ("it" five times before a noun); "send it up too" asks for a judgement about the parent's other parts the session cannot make; "progress goes to no one" reads as a fact; the upward half repeats the child's brief. | "Passing on a message from below or from the person: when it changes what other parts need (a wrong assumption of the split, a shared file or API that behaves otherwise, a decision of the person's), courier_send it at once, only to the sessions it affects, then end your turn again; if it breaks the split, courier_stop those sessions and plan them again. A session's account of what the person told it is the person's word: pass it on, do not judge it against the original task, and never tell a session to undo what the person asked." Drop the upward half. |
| M17 | 9 | "Is a playbook's" is jargon with a dangling possessive; "a skill for that" has no clear antecedent. | "This skill says how the tools behave. Planning the parts, staging a core and reviewing the merge are not in it: if a skill for them is listed to you, load it too." |
| M18 | 13-16, 20-23, 43-44 | Bullets of four or five rules each, 80-100 words, no lead keyword; a loop (steps 2-5 repeat per group) numbered as a line. | Mostly dissolved by M1-M4. On what remains, a lead keyword per bullet costs nothing; one clause at the head of step 2 can name the loop. Backticks on every literal: no other model-facing string of the plugin uses them; do not diverge. |

### 🟢 Nits

| Id | Lines | Finding | Action |
| --- | --- | --- | --- |
| N1 | 22 | Model and variant rule of thumb is planning advice; the parameter descriptions give the facts. `docs/reference.md` 142 and 657 lean on the skill for it. | Drop with B3; update reference.md (D4). |
| N2 | 20, 39 | "No two parts edit the same files" cannot hold for lockfiles and generated files (this repo's snapshot file is one). | Git knowledge; nowhere, or "regenerate generated files rather than merging them by hand" if a word is wanted. |
| N3 | 20, 23 | A non-isolated part that only reads what another edits sees the checkout change under it. | Nowhere, or "or reads what another edits" on the isolate condition. |
| N4 | 39, 51 | courier_cleanup leaves the `courier/` branches; cleanup keeps a worktree with unbranched work. | The tool descriptions carry it. |
| N5 | whole | Naming: "root" vs "top" (two senses), "part" vs "session", status `failed` vs a failed turn, "checkout" vs "worktree", "leave it off" vs "unset". | "root" for the tree, "first session" for a subtree; "session" wherever a tool is applied; "failed: read what went wrong" (if the clause stays); one word for the working copy. |
| N6 | 16, 27 | "In one line of your reply" could be read as a turn before the spawns. | "in the same turn as the spawns", if line 16 stays. |
| N7 | 27 | The wake list omits a form, `ended="stopped"` and a courier_later message. | Dissolved by M1 (the list goes). |
| N8 | 49, 50 | The maxDepth refusal offers only "do it yourself" (depth never frees); courier_tree lists at most maxTotal sessions. | Dissolved by M1. |
| N9 | 44 | "At the top" silently narrows what courier_note permits; a sub-orchestrator following the tool and a root following the skill overwrite each other. | Plugin ambiguity (P4); M1's line 44 says "at the root". |

### B. Plugin and host-text changes the review recommends instead of skill text

| Id | Where | Change | Replaces skill items |
| --- | --- | --- | --- |
| P1 | isolate description (`src/tree/tools.ts` 34-36) and `src/tree/spawn.ts` 119-129 | The commit-first rule is stated for the wrong subset ("from a session that is itself isolated") and the uncommitted-work check runs only for an isolated parent; every worktree starts from HEAD. Widen both so the root gets the same warning before it spawns, and say "files and project skills". | C7-1, R9-7, structural 7, C6-10 |
| P2 | failure notice (`src/tree/text.ts` failureNotice) | When the failed child has live sessions under it, say so: "its sessions are still running and their reports will wake it: message it rather than replace it, or courier_stop it first." | B4, C7-2 |
| P3 | `src/tree/context.ts` roleOf/shapeContext | A session started by OpenCode's own subagent tool inside a tree gets the root role line and courier_spawn, and may start a second tree. The plugin can detect it (OpenCode parentID, no roster entry, as `subtree.ts` already does): give it no root role line and no courier_spawn. | C7-8 |
| P4 | courier_note (`src/memory/note.ts`, tools description) | A second note replaces the first, and the tool invites sub-orchestrators to write one. Either refuse below the top ("put the lesson in your report; the top writes the tree's") or keep one lesson per writer. | N9, C7-16 |
| P5 | native description (`src/tree/tools.ts` 42-46) | If the host caveat is wanted model-facing: "its prompts show only in the TUI or the paired app". | B3, C7-6 |
| P6 | refusal strings (`src/tree/text.ts` 169-181) | Append "not in a loop" to the maxChildren and maxTotal refusals. | M1 (line 49) |
| P7 | group sealing (`src/tree/group.ts`, plugin-api-notes 160-166) | A plain decline of the prompt that `courier_answer once` opens ends the top's step with no `time.idle`, so a group whose members have all reported is not released until the top ends another turn. Handle in the plugin or document the trap (D3). | M8, C7-3 |
| P8 | `src/kernel/protocol.ts` SPLIT_LINE, ONE_PART_LINE | Delimit the three forms (backticks or quotes) once, where the brief, role line and skill all read them. | M13 |
| P9 | courier_stop result (`src/tree/text.ts` 314-334) | Say when a member that was idle stays in its group and in the limits until courier_cleanup. | M14, R9-8 |
| P10 | depth-0 role line (`src/tree/text.ts` 83-87) | Unlike the pre-spawn root and sub-orchestrator lines, it does not say to load the skill; after a compaction that drops the skill text the root has only the tool descriptions for steps 4-6. | R9-12 |

### C. Docs and maintainer files

| Id | Where | Change |
| --- | --- | --- |
| D1 | `CLAUDE.md` line 70 | "The skill repeats the brief's split rule on purpose: the root has no brief" does not hold as a reason: the root's role line (`rolePart(null)`) carries the rule, the heavy-task exception and the split-line forms. Rewrite or remove when the skill stops repeating it. |
| D2 | `docs/reference.md` | How the person writes permission rules so a tree does not stall (one rule for the project's check scripts, one for `skill`), moved from the skill. |
| D3 | `docs/reference.md` or `plugin-api-notes.md` | The unsealed-group trap after a plain decline (P7), if not fixed in the plugin. |
| D4 | `docs/reference.md` 222-272, 657-660, 142 | Rewrite the "what the skill adds" passage and the native and model advice to match the shorter skill. |
| D5 | `test/notices.test.ts` 61, 79 and `test/__snapshots__/notices.test.ts.snap` | Assertions on phrases the cuts remove move with them; the snapshot is regenerated. |
| D6 | `docs/maintainers/real-model.md` | Any change to the skill or its description is a model-facing string: re-run `e2e/real-model.sh` and update the table. |

### D. Proposals the review itself rejected (so they are not re-raised)

- Defining brief, role line, notice, limits, group, isolate, native, status and the envelope attributes inside the skill (Stage 6 asked; Stage 8 rejected all but a half-clause gloss for brief and role line): each is defined in the tool text or the message that carries it, and definitions reintroduce the duplication.
- A one-round cap on partial reports (Stage 7): arbitrary; the exit is already "or do it yourself".
- A prescribed check-in wording, keeping its id in the reply, and triage steps (Stage 7): weeds; the notices say what to do with a member that is out.
- A skill line for the OpenCode-subagent root (Stage 7): the session cannot reliably know it; the plugin can (P3).
- "At the top:" prefixes on lines 29 and 35 (Stage 7 and 9): once the restated notices are cut, nothing false remains and no prefix is needed; the Blockers B1 and B2 are fixed by the cut, not the prefix.
- Backticks on every parameter and literal; split bullets with lead keywords on the current text; a loop clause (Stage 7): nothing else model-facing in the plugin uses backticks; the long bullets go with the cuts; the wave sentence implies the loop.
- Naming the standing entry at line 50 (Stage 5 catalyst): a third statement of what the entry says about itself; the section goes.

## The recommended shape (Stage 8, agreed by the Elephant)

Keep, shortened: the front matter with M11's description; the title; line 9 per M17; step 1 as M2's one bullet; step 2 with line 20 per M7 plus "isolate: true for each part that edits files in parallel with another; no two parts edit the same files", line 21 reduced to what the task must contain (what to produce and where, the context it needs, one project script for its checks, what to report, which listed skills to load) and line 23 per M4; step 3 as M1's three clauses; one sentence for the relay (B1); line 30 per M16; step 4 as "verify first-hand: open the files, run the project's checks yourself" plus the blocked clause (M10); step 5 as line 39's first sentence; step 6 as line 43's definition of done ("done only when every part is verified and integrated") and M1's line 44.

Go: lines 7, 13 (all but "At the root, call courier_recall once before you decide; below the root, do not"), 15, 16, 22, the deliver clauses, the restated notices in 29, the upward half of 30, done/partial/failed in 34, line 35 from its second sentence, line 44's remainder, lines 46-51.

Result: six headings, about fourteen bullets or short paragraphs, roughly 500 words against about 1,470 now, with nothing removed that a tool description, brief, role line or notice does not supply at the moment it applies, and the five contradictions gone because the sentences that carried them are gone.

## Traceability matrix

Raw finding ids: Z5-n (Stage 5 report), C6-n (Stage 6 findings 1-21), C7-n (Stage 7 report), Z8-n (Stage 8 report), R9-n (Stage 9 report). Reviewer-local ids are in the `raw/` files.

| Action item | Raw findings |
| --- | --- |
| B1 | C7-4, Z8-8, R9-1, C7-16 (line 29), style 11 |
| B2 | C7-4, R9-4, style 3, Z5-6 |
| B3 | C7-6, Z8-3, R9-3, readiness 2, style 4 |
| B4 | C7-2, Z8-2, R9-2 |
| B5 | C7-10, R9-5, style 2, Z5-9, C6-1 |
| M1 | Z5-1, Z5-4, Z5-5, Z5-10, Z5-11, Z5-13, C7-16, Z8-7, Z8-10, Z8-16, style 10, 11, 13, 14, 15, structural 2, C6-5, C6-21, N7, N8 |
| M2 | Z5-2, Z8-10, C7-13, C7-20, style 5, 15, 18, catalyst finding 2, Z8 disagreements |
| M3 | Z5-9, C7-10, catalyst finding 4, style 2 |
| M4 | Z5-3, C7-14, Z8-9, R9-9, C6-2, C6-15, style 8, 9, design nit 6, readiness 1, 7 |
| M5 | Z5-6, C7-15, C6-6, style 3, 7, readiness 6, Z8 disagreement on Z5-6 |
| M6 | C7-7, Z8-4, R9-7, C6-1 (line 21) |
| M7 | Z5-7, Z5-11, catalyst finding 1 |
| M8 | C7-3, Z8-7, R9-10, readiness 3 |
| M9 | C7-13, R9-6, structural 6, style 5(b) |
| M10 | C7-5, Z8-11, Z5-10, style 21 |
| M11 | C7-9, Z8-14, style 1, structural 8 |
| M12 | C7-12, Z8-15, structural 1, 2, 14, C6-21 |
| M13 | C7-11, Z8-12, structural 3, style 6, C6-14 |
| M14 | R9-8 |
| M15 | R9-11, readiness 4, C7-25 |
| M16 | C7-19, C6-3, C6-18, style 12, Z8 disagreement on Z5-10 |
| M17 | C7-21, style 16, C6-13, structural 9 |
| M18 | C7-17, C7-18, Z8-13, structural 4, 5, 10 |
| N1 | Z5-12, Z8-3, style 20 |
| N2 | C7-23, design nit 1 |
| N3 | C7-24, design nit 2 |
| N4 | C7-26, design nit 4, codebase 11 |
| N5 | C7-22, style 17, structural 11, 12, C6-12 |
| N6 | readiness 9 |
| N7 | codebase 13, style 10 |
| N8 | codebase 9, 10 |
| N9 | C7-16, Z8-6, design nit 5, readiness 5 |
| P1 | C7-1, Z8-1, R9-7, readiness 8, structural 7, C6-10 |
| P2 | C7-2, Z8-2, R9-2 |
| P3 | C7-8, Z8-5 |
| P4 | C7-16, Z8-6, N9 |
| P5 | C7-6, Z8-3 |
| P6 | Z5-1, Z8-16 |
| P7 | C7-3, Z8-7 |
| P8 | C7-11, Z8-12 |
| P9 | R9-8 |
| P10 | readiness 10 |
| D1 | Z5-2, Z8 disagreements, catalyst finding 2, style 18, R9-6 |
| D2 | Z5-6, C7-15, Z8 (Z5-6) |
| D3 | C7-3, Z8-7 |
| D4 | Z5-12, Z8-3 |
| D5 | Z5-6 (test assertions), CLAUDE.md rules |
| D6 | CLAUDE.md rule on model-facing strings |

Findings not carried into an action item, with the reason: C6-4 (blocked report versus question: distinguished by the notice's requestID at the moment of use; dissolved by M1), C6-7 (native rationale: dissolved by B3), C6-8, C6-9, C6-11, C6-16, C6-20 (terms defined in the tool text or envelope; Stage 8 rejected skill definitions), C6-17 (mechanism of the stall: dissolved by B2), C6-19 (two "cannot split" mechanisms: dissolved by M3), style 19, 22, 23 (absorbed by M1 and M7), structural 13 (the "(step 4)" pointer goes with M5), codebase 12 (absorbed by N5 and M1).

## Severity totals across stages (before deduplication)

| Stage | Blocker | Major | Nit |
| --- | --- | --- | --- |
| 5 Zoom out | 0 | 7 | 6 |
| 6 Comprehension | 0 | 7 | 14 |
| 7 Critic | 0 | 18 | 9 |
| 8 Intermediate zoom out | 0 | 11 | 5 |
| 9 Implementation readiness | 5 | 6 | 10 |
| **Consolidated action items** | **5** | **18** | **9** (+10 plugin, 6 docs) |
