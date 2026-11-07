# Stage 9, raw report of egm-codebase-details

Target: egm-review/courier-orchestrate.SKILL.md, lines 1-51. Status: completed. Persona, standard, goldfish context, the target, src/skill.ts, the snapshot, docs/reference.md and the source under src/tree, src/person, src/scheduling, src/memory and src/kernel were all read.

## Findings

### Blockers (the skill states behaviour the code does not have)

1. Blocker. Lines 27 and 29 (also line 51 by implication). "a question, a permission request ... each start a new turn for you" and "Answering from below: ... propose once with courier_answer".
   Contradicted by src/person/events.ts:19-21 (permission notice sent to `topOf(chain)`), src/person/ports.ts:30 (`topOf` = the last ancestor's parentID, i.e. the tree's top), src/person/question/relay.ts:113 and src/person/question/answer.ts:21-24 (`question.top = chain.at(-1).parentID`; notice sent to `asked.top`), src/person/form.ts:29-31 (forms too), and src/tree/roster.ts:50-58 (`answeringTop` throws for any caller that is not the top: "X's permission requests go to <top> ... <caller> cannot answer them"). A sub-orchestrator is never woken by its children's permission requests or questions, and its courier_answer call is refused. The skill's second person "you" covers every reader; for everyone below the root the whole "Answering from below" bullet is dead text and the wake list on line 27 is wrong. Independently re-verified; matches Stage 7/8. Suggested replacement for the wake list is "a question or a permission request (at the top only)"; for line 29 prefix "At the top:".

2. Blocker. Line 48. "a failed turn does not [count toward the limits], until you message it again."
   Contradicted by src/tree/limits.ts:44-48: `active` is built from every live entry plus every ancestor in its chain, so a session whose turn failed is counted whenever any session under it is still live (running, owing a report, or with a message waiting in its inbox, limits.ts:10-22). The common case, a sub-orchestrator whose turn fails while its own children run, still counts toward maxChildren and maxTotal. docs/reference.md:152-162 states the same ("a session below it is live"). Independently re-verified. The failed session itself is indeed not live (report.ts:23-28 sets `owes: false`, `ended: true`; limits.ts:19 short-circuits `running`), so the claim is true only for a failed leaf. Shorter true form: "a failed turn does not, unless a session under it is still live, or until you message it again."

3. Blocker. Line 22. "native: true for a part that only reads ...; leave it off for a part the person may want to open, or that should outlive you."
   Contradicted by src/tree/spawn.ts:92: `native = (input.native ?? ports.nativeChildren === true) && !worktree`. Unset is not "off": with the plugin option `nativeChildren: true` an unset `native` makes every non-isolated part a subagent, which is deleted with the parent (tools.ts:42-44) and so does not "outlive you". The parameter description (tools.ts:44-45, snapshot line 127) says "false starts a standalone session, whatever the plugin's nativeChildren option says; unset, that option decides", so the skill contradicts the schema the model reads next to it. Independently re-verified. Replace "leave it off" with "native: false".

4. Blocker. Line 35. "Your own permission prompts are relayed nowhere".
   True only at the root (events.ts:14-15: an empty lineage returns without a notice). For any spawned reader, its own permission request is a request from a session in the tree and is relayed to the top like a child's (events.ts:13-21; the notice text for a grandchild, text.ts:53-54). A sub-orchestrator reading line 35 believes its prompt can be answered only in its own session; in fact the top proposes `once` and the person answers in the top's prompt. This is the mirror of finding 1 and can be merged with it; the practical advice (one permission rule) still holds. Shorter true form: "At the root your own prompts are relayed nowhere; below it they go to the top like any other".

5. Blocker. Line 7. "Your brief, or the opencode-courier role line in your system prompt, names your depth in the session tree and its limits."
   The brief does (text.ts:52-56). The role line does not for the reader the skill is written for first: the root before its first spawn gets `rolePart(null)` (src/tree/text.ts:75-82), which names neither a depth nor maxDepth/maxChildren/maxTotal; the root's limits appear only in the depth-0 role entry written at its first spawn (spawn.ts:177-180, text.ts:83-87). Line 20 then asks the session to plan batches against "the tree's limits" that the root does not know. The refusal texts (text.ts:169-181) supply the numbers at the moment of use, so the damage is bounded; but the sentence as written is false. Shorter true form: "... names your depth and, once you have started a session, its limits."

### Major

6. Major (Missing Logic Detail). Line 15. "One session for one stage is a part, not the whole, as your brief says: a core ... or a review of the parts once you have merged them."
   The brief lists three stages and a closing test: core, review, "the fixing of what a review found once you have verified it", and "One session alone, with nothing of the task done before it by you or by 2 or more parts, and fewer than 2 parts after it, is the whole task" (src/tree/text.ts:57-59; docs/reference.md:175-179). The skill omits the third stage and the test, while pointing the reader to "your brief". CLAUDE.md:69-70 says the skill repeats the split rule because the root has no brief; so the root, the one reader with no brief, never sees the fix-after-review stage and may refuse a legitimate single fixing session. No tool description or notice supplies this at the moment of use; only text.ts (the brief) does. Suggested: append "or the fixing of what a review found, once verified".

7. Major (Undocumented Edge Case). Line 21. "Name the skills it should load for its part, from those listed to you: it sees the same list, not your choice".
   Not the same list for an isolated part: its worktree starts from HEAD (spawn.ts:85-89; reference.md:519, 280 "in a project the skill must be committed, since an isolated child's worktree starts from HEAD"), so project skills not yet committed (`.opencode/skills/`, `.claude/skills/`, `.agents/skills/`) are absent from an isolated child's list. A parent naming an uncommitted project skill sends the child after a skill it cannot load. Nothing at the moment of use says so (the isolate description, tools.ts:34-36, speaks of files, not skills). Source that would supply it: docs/reference.md:278-280. Suggested insertion: "(an isolated part sees only committed project skills)".

8. Major (Missing Logic Detail). Lines 51 and 48. "courier_stop its top session; everything under it is stopped too, and nothing in it reports back."
   Two consequences the procedure needs and the skill omits, and the stop result does not say: (a) a stopped member leaves its join group only if its turn was actually interrupted (events.ts:96-108 `noteInterrupted` -> `leave(..., "interrupted")`; stop.ts:103-116 marks `settled("interrupted")` only on `interrupted: true`); a member that was idle when stopped (typically one that already ended silently) stays "out" and the group never completes (group.ts:192 `complete`) until courier_cleanup drops it (forget.ts:25-31, tools.ts:217-219). (b) The same idle-stopped member still owes its report (report.ts:26; limits.ts:21), so it keeps counting toward maxChildren/maxTotal; line 48's "a silent end counts toward the limits until it reports" remains true after a stop. The stop result (text.ts:314-334) lists `idle` outcomes but says nothing about the group or the limits; only the standing entry's "stopped; group X waits for it" (text.ts:143-146, on OpenCode 2.2.0+) hints at it. Source that would supply it: docs/reference.md:329-331 and text.ts:429. Suggested addition to line 51: "a member that was not running stays in its group and in the limits until you courier_cleanup it."

### Nits

9. Nit. Line 49. "do that part yourself, or end your turn and start it once a report has arrived" is lumped over maxDepth, maxChildren and maxTotal. The maxDepth refusal (text.ts:169-171) says only "Do the task yourself, and report with courier_send": depth never frees, and a session at maxDepth has courier_spawn removed anyway (context.ts:20, limits.ts:40). The refusal text corrects the reader at the moment of use.

10. Nit. Line 50. "one courier_tree shows every session under you": at most maxTotal are listed, live first then newest, with a count of the rest (subtree.ts:119-131, text.ts:306-312, tools.ts:185-186). The tool output says so.

11. Nit. Line 51. "cleanup: true removes their worktrees": one with uncommitted changes or commits on no branch is kept and listed (stop.ts:179-193 via cleanup.ts:31-40; tools.ts:102-107). The parameter description supplies it.

12. Nit. Line 34. "failed: read the error" conflates a child's `status: failed` report (a held group report with the child's own account, send.ts:22, tools.ts:155) with a failed turn (the `failed="<type>"` notice with an error, events.ts:51, text.ts:388-406). The advice works for both; the wording is the failure notice's.

13. Nit. Line 27. The wake list omits three notices that also start a turn for a parent: `ended="stopped"` from courier_stop of a session below your own child (stop.ts:162-172; tools.ts:200-201), a form (`asks="form"`, form.ts:29-39, top only), and a courier_later message. Not claimed exhaustive; the tool descriptions supply them.

Non-existent references: none found. `failed="..."` (events.ts:51), `ended="without-report"` (events.ts:146), `maxDepth`/`maxChildren`/`maxTotal` in refusals (text.ts:169-181), `courier/<session>` (text.ts:8), `isolate`, `native`, `model`, `variant`, `group`, `cleanup: true`, every `courier_*` tool named (snapshot lines 3-71), the split lines (protocol.ts:8-13) and the role line prefix "opencode-courier role" (text.ts:68) all exist with that spelling.

## Line-by-line verdict table

Line 7
- Brief names depth and limits: backed by src/tree/text.ts:52-56.
- Role line names depth and limits: contradicted by src/tree/text.ts:75-82 for the root before its first spawn (finding 5); backed for depth 0, sub-orchestrator and leaf (text.ts:83-96).
- No courier_spawn means you cannot split: backed by src/tree/context.ts:20 and src/tree/limits.ts:40.
- Report upward as your brief says: backed by src/tree/text.ts:14-20.

Line 9
- Skill says how the tools behave; planning is a playbook's; load such a skill if listed: unverifiable in code (host behaviour); consistent with docs/reference.md:274-278 and CLAUDE.md:14-15.

Line 13
- Root calls courier_recall once, not in a loop; it lists how earlier trees were split and how each part went; below the root read none: backed by src/memory/tools.ts:35-40 and src/memory/text.ts:50-67; leaf has no courier_recall, src/index.ts:167 with context.ts:20.

Line 14
- Split when 2+ independent substantial parts; do it yourself when small, sequential, coupled: backed by src/tree/text.ts:55-57.
- Several whole jobs are that many parts; the tree repeats per job: unverifiable (planning rule, not in code); a child is told to load the skill, text.ts:90-91.

Line 15
- Only the root may hand the whole task to one session, when heavy: backed by src/tree/text.ts:77-81 (root role) and text.ts:57 (brief forbids it below).
- Root still verifies and integrates: backed by text.ts:85-86.
- Chain of single hops uses up depth: backed by src/tree/limits.ts:40.
- "as your brief says: a core ... or a review": partially backed by text.ts:57-58; the brief's third stage and closing test are omitted (finding 6).

Line 16
- Split line forms: backed by src/kernel/protocol.ts:8-13.

Line 20
- One spawn per part, same group name, woken once: backed by src/tree/tools.ts:52-55, src/tree/group.ts:130-160.
- isolate: true for parallel editors; non-isolated parts share the parent's directory: backed by src/tree/spawn.ts:86-98, tools.ts:33-36.
- Parts that do not fit the limits go in a later group: backed by src/tree/limits.ts:51-53 (refusals) and tools.ts:55 (name free after delivery); the root does not know the limits beforehand (finding 5).

Line 21
- Child sees none of your conversation: backed by src/tree/spawn.ts:145 (brief + task only).
- One permission rule covers checks and skill loads: unverifiable (OpenCode rules); skill permission action per docs/reference.md:227-231.
- "it sees the same list": contradicted for isolated parts by src/tree/spawn.ts:85-89 with docs/reference.md:278-280 (finding 7).
- Isolated brief says its branch is for you to merge: backed by src/tree/text.ts:38-40.

Line 22
- Unset model/variant runs on your own model (or the agent's): backed by src/tree/model.ts:15-18, 29-39 and tools.ts:20-21.
- Variant is reasoning effort: backed by tools.ts:27.
- native: true for read-only parts: backed by tools.ts:42-46 (allowed; refused with isolate, spawn.ts:41).
- "leave it off ... outlive you": contradicted by src/tree/spawn.ts:92 and tools.ts:44-45 (finding 3).

Line 23
- Dependent part starts after merge or, when delivered, isolated and told to merge courier/<session>: branch name backed by src/tree/text.ts:8, 38-39; worktree start point for a non-isolated parent unverifiable in this code (host worktree.create without `from`, spawn.ts:87; docs/reference.md:519 says the project's last commit); for an isolated parent backed by spawn.ts:85-87, 119-129.

Line 27
- Reply without tools; no polling with courier_children, courier_tree or sleep: backed by tools.ts:135-137, text.ts:62.
- Group reports start a turn: backed by group.ts:138-149.
- Blocked report at once: backed by send.ts:22, 47.
- Message without a status: backed by send.ts:35-44.
- Question, permission request start a turn "for you": contradicted by src/person/events.ts:19-21 and src/person/question/answer.ts:21-24 (top only; finding 1).
- Failed turn: backed by src/tree/events.ts:47-56 (to entry.parentID; suppressed if stopped since prompt, events.ts:44-46).
- Silent end: backed by events.ts:143-150 with the conditions in src/tree/nudge.ts:17-30.
- courier_later check-in, courier_cancel: backed by src/scheduling/tools.ts:26-29, 44.

Line 29
- Propose once or reject with reason; person decides in OpenCode's prompt: backed by src/person/text.ts:72-78, src/person/permission.ts:148-166; but only the top can (roster.ts:50-58; finding 1).
- Question: ask with your question tool with the notice's questions; answer goes on by itself: backed by src/person/question/relay.ts:172-185, 207-252 (only when wording and options match exactly, and only in the top session, relay.ts:173; the notice says "exactly these questions", text.ts:186-188).
- When the notice says OpenCode already shows it, call nothing: backed by text.ts:80-84, 192-201.

Line 30
- courier_send to the affected sessions; no target restriction: backed by send.ts:17-49, docs/reference.md:495-497.
- courier_stop the parts it breaks (only from above): backed by src/tree/stop.ts:41-47.
- Send it up without a status (progress): backed by send.ts:64-72, text.ts:286-287.
- Person's word rule: policy, mirrors text.ts:24-25; unverifiable beyond that.

Line 34
- Statuses done/partial/blocked/failed: backed by src/kernel/protocol.ts:3.
- Message a reported/blocked session with courier_send to continue: backed by tools.ts:150-151; blocked member stays out until it reports again, group.ts:92-98.
- "failed: read the error; message to try again, replacement, or carry on": backed by text.ts:394-398 for a failed turn; a `failed` report has no error field (finding 12).

Line 35
- Own prompts relayed nowhere: backed at the root (events.ts:14-15); contradicted below the root (events.ts:13-21; finding 4).
- Each request waits on the person and stalls: backed by text.ts:63 ("does nothing until it is answered").

Line 39
- git merge courier/<session>: backed by text.ts:8, 38-40.
- courier_cleanup the isolated sessions: backed by tools.ts:214-219, cleanup.ts:17-47 (kept when dirty or unbranched commits).
- Delivering session still names its branch when isolated: backed by text.ts:39.
- Verify delivery, merge nothing: policy; unverifiable.

Line 43
- One courier_send with one status and artifacts: backed by text.ts:14-16, tools.ts:60-84.

Line 44
- One courier_note at the top, one line, refuses over the limit rather than clipping: backed by src/memory/note.ts:24-32, src/memory/text.ts:114-116, src/memory/domain.ts:10 (300).
- Rule that holds every time goes to AGENTS.md or a skill: backed by src/memory/text.ts:94.
- "none when there is nothing": backed (no tool requirement); sub-orchestrators may also note (note.ts:24, reference.md:637-638) but the skill's restriction to the top is policy, not a contradiction.

Line 48
- failed="...": backed by src/tree/events.ts:51 (`failed: error.type`).
- ended="without-report", quoting the last reply: backed by events.ts:146, text.ts:419-437 (first 2,000 characters).
- Message it to carry on/report/try again, or replace: backed by text.ts:396-398, 428.
- Silent end counts until it reports: backed by text.ts:429, limits.ts:21, report.ts:26.
- Failed turn does not count until messaged: contradicted by limits.ts:44-48 when a descendant is live (finding 2); backed otherwise (report.ts:23-28, limits.ts:19).

Line 49
- Refusals name maxDepth/maxChildren/maxTotal: backed by text.ts:169-181.
- Do it yourself or wait for a report: backed for maxChildren/maxTotal (text.ts:176-181); for maxDepth only "do it yourself" applies (text.ts:170-171; finding 9).

Line 50
- courier_tree shows depth, parent, owes a report: backed by src/tree/subtree.ts:140-147.
- "every session under you": contradicted for long trees by subtree.ts:119-131 and text.ts:308-311 (at most maxTotal; finding 10).

Line 51
- courier_stop stops the subtree, deepest first, nothing reports back: backed by stop.ts:37-80, tools.ts:198-202.
- cleanup: true removes their worktrees: backed with the kept exception by stop.ts:179-193, tools.ts:102-107 (finding 11).
- Omitted: idle-stopped members stay in their group and in the limits (finding 8); the intermediate parent is told `ended="stopped"` (stop.ts:162-172).

## Note on scope
The eleven tools, their parameters and every attribute name the skill cites exist as spelled. The four Stage 7/8 contradictions are all confirmed against the current source; findings 4, 5, 6, 7 and 8 are new. All cited code lines are current as read; no file was unreadable.
