# Comprehension (goldfish) review: courier-orchestrate after the shrink

Read as a model sees it: the skill (`egm-review-2/courier-orchestrate.SKILL.md`, "L" = its line) and the
rendered strings in `test/__snapshots__/notices.test.ts.snap`. No source read.

## Findings

**C-1 (major) Sub-orchestrator, maxTotal refusal with none of its own sessions running.**
`refusals 4`: "Do this part yourself, or end your turn and try again once a report has arrived". The
reports that free maxTotal slots arrive at *other* sessions. A depth-1/2 session with no children of
its own that ends its turn is woken by nothing; it gets `reportReminder 1`, then its parent a
`silentNotice`. The "end your turn" branch is only safe for a session with its own sessions out.
`refusals 2` (maxChildren) is fine: its own children wake it.
Fix: `refusals 4`: "if none of the sessions you started is running, do it yourself".

**C-2 (major) Sub-orchestrator ending its turn to wait vs `reportReminder` / `silentNotice`.**
The brief (`childBrief 1`): "start the parts … then end your turn while they work". `reportReminder 1`
says, with no condition shown: "You are about to end your turn without reporting … If you are finished,
send your report now … if you end your turn without a report, the session that started you is told."
`silentNotice 1-5` has no "it has sessions of its own still running" variant (`failureNotice 7` does).
From the texts alone, a waiting sub-orchestrator reads "your parent will be told you went silent", and
may send a premature `partial` or keep the turn alive (polling, which the brief forbids). If the
reminder and the notice are suppressed while children are out, no text says so.
Fix: if suppressed, nothing to change in text, but confirm. If not, add a variant of `reportReminder`
("you have N sessions out; ending your turn to wait for them is right") and of `silentNotice`
(like `failureNotice 7`).

**C-3 (major) Depth-1 sub-orchestrator gets a finding or the person's words relayed from depth 2 that
matter beyond its own subtree.**
`childBrief 1`, L620-621: a session sends findings / the person's message "to the parent … it passes
it on to the sessions it affects"; the person's message "is for the whole job". Skill L25: "courier_send
it at once, only to the sessions it affects". The depth-1 session knows only its own children and its
parent. Nothing tells it to forward *up* when the finding touches its siblings' parts or when it is
the person's word ("for the whole job"). The old flow relied on the root seeing it; now a depth-1 may
pass it only down, and the root and other parts never hear it.
Fix: skill L25 (or the brief's two lines): "below the root, also send it to the session that started
you when it reaches past your part; a person's message always goes up".

**C-4 (minor) Depth-2 (or deeper) session uses its question tool or hits a permission: who answers.**
`childBrief 1`, L622: "it reaches them through the session that started you". The relay notices
(`questionNotice 2`, `permissionNotice 2`, "which ses_middle started … a session started from yours")
and skill L24 ("At the top") show it goes to the top, not the parent. `REJECTED 1`: "Refused by the
session that started you": at depth 2 the refusal came from the person at the top, so the session may
argue with its parent in a blocked report. The depth-1 parent is told nothing (no notice for it in the
snapshot); on a courier_later check-in it sees its child just "working" and may steer or replace it
mid-question.
Fix: brief L622 "through the top session of the tree"; `REJECTED 1` "Refused by the person (or the
session above you)"; ideally a one-line FYI to the middle session, or say in L24 that the middle is
not told.

**C-5 (minor) Verifying an isolated part before merging: where.**
Skill L29 "Open the files and run the project's checks yourself" comes before L33 "Merge each
reported branch". The files are on `courier/<id>` / in the child's worktree (`spawnText 1` "Started
session … in /wt"), not in the verifier's checkout; a literal reading runs the checks on the unmerged
checkout and passes trivially. The old order (check in its worktree or merge then check) is now an
inference.
Fix: L29 "on its branch or in its worktree (the path courier_spawn gave)", or merge-then-verify.

**C-6 (minor) "Never hand that checking to another session" vs "a review of the parts … is a part".**
`childBrief 1`: "Check and integrate each part yourself … (never hand that checking to another
session)" and, two lines up, "One session for one stage is a part … a review of the parts once you
have merged them". A model may read these as conflicting and either never spawn a review or hand the
per-part check to one. Skill L8 defers review to a playbook.
Fix: brief: "checking each report is yours; a review of the merged whole may be a part".

**C-7 (minor) Partial report or a group member's `failed` report: what next.**
Skill: nothing beyond L37 "done only when every part is verified and integrated". `groupNotice 1` ends
"message one with courier_send if it has more to do". The failure options (send it on, replace, carry
on yourself) live only in `failureNotice`, which a *reported* `failed` never shows. An ungrouped
partial arrives as an envelope with `status="partial"` and no instruction. The model has to infer
"finish the rest yourself, send it on, or start a replacement".
Fix: one clause in `groupNotice` and in skill L29: "a partial or failed part: finish it yourself,
message it, or start a replacement".

**C-8 (minor) Root stops a grandchild directly; the middle session replaces it.**
Skill L25: "courier_stop those parts". `stoppedNotice 1` to the middle: "Carry on without it, or start
a replacement if you still need what it was doing." Nothing tells the middle *why* (the split broke),
so it may restart the same part. `stopText 2` tells the stopper that the middle was told, but not to
send it the reason.
Fix: skill L25 "and tell the session above them why", or `stopText`: "send it the reason".

**C-9 (nit) Brief says "one group", skill allows ungrouped.**
`childBrief 1` "start the parts that run at once in one group" vs skill L16 "or leave them ungrouped
and start the next as each report frees a slot". Reconcilable (waves) but reads as two rules.

**C-10 (nit) `silentNotice 2/3` "It ended without a reply" then "or to report if its last reply is
what you needed".** No last reply to judge. Drop the clause in the no-reply variant.

**C-11 (nit) Lessons "from depth 1/2" next to "From the top session only".** `lessonsEntry 1`,
`recordLine with a lesson 2`, `noteText 2` show lessons written below the top; courier_note says top
only and `noteBelowRefusal 1` refuses. A sub-orchestrator seeing an old "from depth 1" lesson may try
once; the refusal recovers it. Cosmetic, legacy records.

**C-12 (nit) Non-isolated parts have no branch to merge.** Skill L33 "Merge each reported branch";
a non-isolated part's edits are already in the shared checkout, and nothing says whether it should
commit. The model infers. One clause in L33: "a part without isolate edited your checkout directly".

**C-13 (nit) OpenCode subagent inside a tree.** Skill L8 covers it ("If courier_spawn is not among
your tools … do the task yourself"), and `courier_tree` says subagents owe no report. Nothing tells
it not to courier_send its parent a report; harmless.

## Situations walked that work

- (a) Root before first spawn: `rolePart 5` says load the skill, courier_recall, split line; skill L12 agrees, including the heavy whole hand-off.
- (b) Root after first spawn and after a compaction: `rolePart 1` says reload the skill; L12 and L16 give the root rule and the waves; `standingEntry` restores the state.
- (c) Depth 1/2 split decision: role lines 2/3 and the brief's rule, which skill L12 defers to; never one session for the whole is stated in both, consistently.
- (c) Isolated sub-orchestrator splitting: `childBrief 3` covers commit first and merging into its own branch before reporting.
- (d) Leaf: `rolePart 4` and `childBrief 2/4`; the maxDepth refusal is consistent.
- Blocked report at a sub-orchestrator or the root: L29, and the group text says blocked arrives at once.
- Permission from a grandchild at the top: `permissionNotice 2` is self-contained, `courier_answer` agrees, and L24 adds no conflict; the native variant (`permissionNotice 5`) is clear.
- Question from below at the top (live, cut off, after a restart, native): the `questionNotice` variants are self-contained.
- Forms: `formNotice` says who can answer and where.
- Child's turn fails, with and without live sessions under it: `failureNotice 1-8`, rate-limit timing included.
- Child ends silently, in a group: `silentNotice 5` (cleanup releases the group).
- maxChildren refusal: `refusals 2/3`.
- Model/variant/native refusals: self-explanatory.
- Finding without status, root parent: brief L620 plus skill L25.
- Person types into a depth-1 child under the root: brief L621 plus L25 ("the person's word").
- Group with a failed member, delivery: `failureNotice 3` and `groupNotice 2` say the group no longer waits.
- Root writing the lesson: skill L37, the courier_note description and `noteText`. A sub-orchestrator gets `noteBelowRefusal 1`, which says to put it in its report.
- courier_later check-in and cancel: L23 plus `laterText 1`.
- Stop/cleanup worktrees: `stopText`/`cleanupText` say what is kept and why.
