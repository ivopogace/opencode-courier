# Goldfish Review Report

**Target:** `egm-review/courier-orchestrate.SKILL.md` (`lines 1-51`, full file; unchanged since Stage 5)
**Stage:** 8, Intermediate Zoom Out Review. Reviewer: `egm-zoom-out`, status completed (direct dispatch). Inputs: the Stage 5, 6 and 7 reports. This stage judges the additions and mitigations those stages proposed, and names where each belongs. Line numbers are those of the rendered file; `line_map.tsv` maps them to `src/skill.ts`.

## Reviewer Status

| Reviewer | Status |
| --- | --- |
| `egm-zoom-out` | completed |

## Code facts the reviewer verified (they decide the placements below)

- Permission and question relays go to the top of the chain only (`src/person/events.ts` 20, 43; `form.ts` 30, 59; `ports.ts` 30). C7-4 is right.
- `limits.ts` 45-47 marks every ancestor of a live session as live; `report.ts` 22-28 makes a failed turn owe nothing. C7-2 is right: a failed sub-orchestrator with live children still counts and will be woken by them.
- `spawn.ts` 119-129 computes the uncommitted-work warning only for an isolated parent; the isolate description (`tools.ts` 34-36) restricts "commit first" to "a session that is itself isolated", while reference.md 519 says every worktree starts from the last commit. C7-1 is right; the root cause is a narrow description plus a narrow check in code.
- `text.ts` 50-66: `splitRule` is in every brief below maxDepth unconditionally. C7-7 is right: "say whether it may split" is not a lever.
- `context.ts` 33: a session with no roster lineage and courier_spawn is a root; `subtree.ts` 108 and reference.md 686-692 show the plugin already identifies OpenCode subagents by their OpenCode parentID. C7-8's case is real and detectable in code.
- `note.ts` 28-34: any orchestrator's note goes to the tree's top record and replaces the previous lesson; the tool description invites "the top session or one that started sessions". C7-16's overwrite is real and is a plugin ambiguity.
- `spawn.ts` 92: `native` unset defers to the `nativeChildren` option. C7-6's three-state point is right.
- `skill.ts` 33 renders the split lines from `protocol.ts`, as the brief and role line do.

## Prioritized Findings (Blockers -> Major -> Nits)

### Z8-1. Commit-first (C7-1) belongs in the isolate description and spawn.ts, not the skill - Severity: Major
* **Affected Scope:** C7-1; lines 20, 23, 39
* **Rationale & Recommendation**: The isolate description is read at the instant of the spawn and states the rule for the wrong subset; drop "From a session that is itself isolated" there, and extend the uncommitted check in `spawn.ts` to a non-isolated parent so the existing warning fires for the root too. A skill line would be a third statement of a rule whose first statement is wrong.

### Z8-2. The failed-with-live-children case (C7-2) belongs in the failure notice - Severity: Major
* **Affected Scope:** C7-2; lines 48, 34
* **Rationale & Recommendation**: The plugin knows at notice time whether the failed child has sessions under it; the notice can say "it has sessions of its own still running, whose reports will wake it: message it rather than replace it, or courier_stop it first". A skill rule asks every orchestrator to remember a rare case the plugin can name when it occurs. Line 48's counting clause is false in that case; Z5-1 drops the line anyway.

### Z8-3. The native sentence (C7-6, Z5-12) goes; the host caveat, if wanted, goes to the native description - Severity: Major
* **Affected Scope:** line 22
* **Rationale & Recommendation**: C7-6's rewrite makes the model condition on the person's host, which it cannot observe, and keeps "leave it off", ambiguous between false and unset. Drop the sentence: the person owns the host and the `nativeChildren` option, and the parameter description states what native does. This also removes the tension with "never hand the checking to another session" (line 35) and reference.md 657-660's dependence on the skill (a docs edit). The model and variant rule of thumb goes with it.

### Z8-4. "Say whether it may split its part further" (C7-7): drop the clause, no plugin change now - Severity: Major
* **Affected Scope:** line 21
* **Rationale & Recommendation**: The brief already lets every non-leaf split by the same rule. A spawn parameter to forbid splitting would be speculative until a tree shows the budgeting problem (YAGNI).

### Z8-5. The OpenCode-subagent root (C7-8) is a context.ts fix, not a skill line - Severity: Major
* **Affected Scope:** lines 7, 13, 15
* **Rationale & Recommendation**: Such a session does not reliably know it was started by the subagent tool; the plugin does (OpenCode parentID present, no roster entry, which `subtree.ts` already uses). In `roleOf`/`shapeContext` it should get no root role line and, as for a leaf, no courier_spawn. A text rule would rely on self-knowledge the reader may lack and keep line 7 alive after Z5-9 and C7-10 drop it.

### Z8-6. The note overwrite (C7-16) is a plugin ambiguity; resolve it in courier_note - Severity: Major
* **Affected Scope:** lines 29, 44
* **Rationale & Recommendation**: Either courier_note refuses below the top ("put the lesson in your report; the top writes the tree's") or the record keeps one lesson per writer. The critic's skill clause contradicts the tool's description, so a reader with both texts still guesses. Line 44 shrinks to the timing (Z5-4) either way.

### Z8-7. The check-in rule (C7-3) stays as one clause; the rest is weeds or a host trap for the plugin or docs - Severity: Major
* **Affected Scope:** lines 27, 49, 50
* **Rationale & Recommendation**: The check-in's wording, "keep its id in the reply", and the member-triage steps are weeds: courier_children's description already permits the one-off look on a check-in, and the silent-end and failure notices say what to do with a member that is out. The unsealed group after a plain decline (plugin-api-notes 160-166) is a host trap to handle in the plugin or document in reference.md. What stays: one courier_later check-in per group, cancelled when its reports arrive. "For long work" can go.

### Z8-8. The relay-target error (C7-4): agree on the fact, not on the prefix - Severity: Major
* **Affected Scope:** lines 27, 29, 35
* **Rationale & Recommendation**: "At the top:" keeps text that Z5-1 removes. Once line 29 is one sentence deferring to the arriving instructions and line 35's second sentence goes (Z5-6), nothing false about relay targets remains. The clause "your own permission prompts are relayed nowhere" must not survive in any form, since it is false below the root.

### Z8-9. The deliver mode (C7-14, C6-2, C6-15, Z5-3) goes to the playbook; do not define it, drop it - Severity: Major
* **Affected Scope:** lines 14, 21, 23, 39, 43
* **Rationale & Recommendation**: Both proposed definitions add text to a mode that belongs to a playbook (`courier-wave` spells out PR delivery itself). Drop the mode from lines 21, 23, 39, 43. Keep from line 14 only "Several whole jobs in one prompt, such as 4 tickets, are that many parts": a split criterion stated nowhere else that does not need the deliver mode.

### Z8-10. Definitions asked for by Stage 6 (C6-1, C6-5 and the rest): one half-clause in the skill, the rest nowhere - Severity: Major
* **Affected Scope:** lines 7, 15, 21, 29, 48
* **Rationale & Recommendation**: "brief" and "role line" get the half-clause the collapsed step 1 needs: "your brief (the text above your task) or, at the root, the opencode-courier role line in your system prompt"; that is line 7's first sentence folded into step 1. "Notice" needs no definition: remove the term. "A permission request or question from below arrives with its own instructions: follow them, and never answer for the person" is shorter than line 29 and has no undefined word. Limits, group, isolate, native, status, blocked versus question, the envelope attributes: each is defined in the tool text or in the message that carries it at the moment of use; defining them in the skill reintroduces the duplication Z5-1 and Z5-5 found.

### Z8-11. The partial cap (C7-5): nowhere - Severity: Major
* **Affected Scope:** line 34
* **Rationale & Recommendation**: A cap of one round is an arbitrary planning rule; "have it finish, or do it yourself" already states the exit, and the group notice covers the mechanics. With Z5-10 the partial clause goes; if a word stays, "partial or failed: have it finish or try again, or do it yourself" is enough.

### Z8-12. Delimiters on the split line (C7-11) belong in protocol.ts once; backticks throughout (C7-22), nowhere - Severity: Nit
* **Affected Scope:** line 16; whole document
* **Rationale & Recommendation**: The forms come from `protocol.ts`, as the brief's and role line's do. After Z5-2 the skill no longer carries line 16 at all. No model-facing string of the plugin uses backticks; pattern consistency says the skill should not diverge, and the tokens are paid on every request.

### Z8-13. Loop clause, split bullets, reply line naming group and check-in id, lockfiles, isolate readers, cleanup caveats (C7-17, C7-18, C7-25, C7-23, C7-24, C7-26): nowhere - Severity: Nit
* **Rationale & Recommendation**: The wave sentence of line 20 implies the cycle; after the Stage 5 cuts the long bullets are gone (lead words on the bullets that remain are fine, no added structure); the standing entry carries group names and courier_later's result carries the id; lockfile merging and worktree-keeping are git knowledge and the courier_stop and courier_cleanup descriptions.

### Z8-14. The description's trigger (C7-9) is the skill's own and should change, with a shorter rewrite - Severity: Nit
* **Affected Scope:** line 3
* **Rationale & Recommendation**: "How opencode-courier's session tools work. Load before you decide whether to split a task across sessions with courier_spawn: starting parts, waiting without polling, relaying questions and permissions, reading reports, merging, reporting upward." Shorter than line 3.

### Z8-15. The section 3 heading (C7-12): structure only, no added text - Severity: Nit
* **Rationale & Recommendation**: Rename to "## 3. End your turn; what wakes you" or move the shortened lines 29-30 under step 4.

### Z8-16. "Not in a loop" goes to the refusal strings; the standing entry needs no mention - Severity: Nit
* **Affected Scope:** Z5-1, Z5-8; lines 49, 50
* **Rationale & Recommendation**: Agree with Z5-1. Line 50 goes with the section; naming the standing entry would be a third statement of what the entry says about itself.

## Where this stage disagrees with Stage 5

- Z5-2's collapsed bullet keeps "each session runs this skill for its job, so the tree below you repeats its shape once per job". Derivable; drop it. Keep the 4-tickets sentence and the one-hop reason.
- Z5-2 left where the split rule lives to the Elephant. From altitude it is settled: the rule is in the brief and the root role line, both written once per session; CLAUDE.md's reason ("the root has no brief") is false by `text.ts` 75-82. Update CLAUDE.md when the skill stops repeating it.
- Z5-6: side with the architect over the catalyst's dissent. "Run the project's checks yourself" is all the model can act on; advice to the person about permission rules belongs in reference.md.
- Z5-12 kept the native sentence; drop it (Z8-3).
- Z5-3 kept line 39's second sentence as an option; drop it (Z8-9).
- Z5-10 keeps only the blocked clause of line 34; agree, and line 30's upward half ("Send it up too ... Progress goes to no one") should go too: the brief gives the child that rule (`text.ts` 21-23), and removing it dissolves C6-3 and C7-19 without new text.

## Shape of the document that meets the bar and closes the real gaps

**Stay (shortened where noted):** lines 1-5 (line 3 per Z8-14); line 9 as one sentence (C7-21's form); step 1 as one bullet: the brief/role-line gloss, "say which in its split line", the 4-tickets sentence, the one-hop reason; line 20 with Z5-7's two modes; line 21 reduced to what the task must contain and which listed skills to load; line 23 reduced to "a part that depends on another starts once that one's branch is merged into your checkout"; line 27 reduced to "reply without calling more tools; reports and notices wake you; one courier_later check-in per group, cancelled when its reports arrive"; line 29 as one sentence (Z8-10); line 30's downward half plus the person's-word rule; line 35's first sentence; line 34's blocked clause; line 39's first sentence; line 43's definition of done; line 44's first clause with "At the root" instead of "At the top".

**Go:** lines 7, 13, 15 (as a separate bullet), 16, 22, the deliver clauses of 21, 23, 39, 43, line 29's remainder, line 30's upward half and "Progress goes to no one", line 34's done, partial and failed clauses, line 35 from its second sentence, line 44's remainder, lines 46-51.

**Move to the plugin:** commit-first (isolate description and `spawn.ts`), the failed-with-live-children case (failure notice), the OpenCode-subagent root (`context.ts`), the note overwrite (courier_note), "not in a loop" (refusal strings), the native host caveat (native description, if kept at all).

**Move to docs:** how the person writes permission rules so a tree does not stall; the unsealed-group trap; reference.md 222-272 and 657-660 rewritten to match the shorter skill. Update CLAUDE.md's "the root has no brief" line.

**Size:** 6 headings, about 14 bullets or short paragraphs, roughly 500 to 550 words against about 1,700 now: Stage 5's "about a third", closing every Stage 6 and 7 gap that is a gap in the text rather than in the plugin.

## Severity counts

| Severity | Count |
| --- | --- |
| Blocker | 0 |
| Major | 11 |
| Nit | 5 |
