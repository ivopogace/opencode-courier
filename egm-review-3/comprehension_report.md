# Comprehension (goldfish) review: courier-orchestrate

Read: `egm-review-3/courier-orchestrate.SKILL.md` and `test/__snapshots__/notices.test.ts.snap`, nothing else. Snapshot entries are cited by name. "Skill Lx" is a line of the SKILL.md file.

## Walk-through (role, event: the text the model has, whether it knows what to do)

| Role / event | Text in hand | Knows? |
|---|---|---|
| Root, before first spawn | `rolePart 5`, skill description; skill §1 once loaded | Yes: load the skill, recall, decide, write a split line. |
| Root, after first spawn | `rolePart 1` (no split rule), skill if loaded, `standingEntry` | Mostly. The split rule is in the skill only. Staging and a revised split line are covered by no text (C-8). |
| Sub-orchestrator (depth 1) | `childBrief 1/3`, `rolePart 2`, skill | Yes for split/spawn/end turn. Unclear about reporting again (C-1) and about the silent-turn warning (C-2). |
| Leaf at maxDepth | `childBrief 2/4`, `rolePart 4`, `refusals 1` | Yes. Some brief lines don't apply to a leaf (C-13). |
| Native child / native grandchild | `courier_spawn` `native` schema, `forms formNotice of a native child`, `questions question notices of a native child`, `permissionNotice 5` | The root knows what to do for a direct native child. For a native child of a sub-orchestrator, the texts conflict (C-3). |
| OpenCode subagent in a tree | Only `courier_tree` ("subagent: true, which owe no report") | No role line or brief is shown. If it loads the skill, it can read itself as the root (C-4). |
| Split decision | skill §1, brief, `rolePart 5` | Yes. |
| Group / waves / ungrouped | skill §2, `group` schema, `spawnText 3`, `spawnText for a child started below the top 2` | Yes. |
| maxTotal / maxChildren refusal | `refusals 2–5` | Yes (C-11 is a nit). |
| End turn | skill §3, `spawnText *`, `END_TURN` | Yes for the root. A sub-orchestrator is warned against it (C-2). |
| courier_later: schedule, cancel, fire | skill §3, `courier_later`, `laterText 1`, `courier_cancel`, `courier_children` | Scheduling and cancelling, yes. No text says what to do when a check-in fires while children still work, or after their reports arrived (C-9). |
| Report done/partial/failed/blocked | skill §4, `groupNotice *`, `failureNotice *` | Yes for the parent. For the child, "exactly one report" clashes with blocked and with being re-tasked (C-1). |
| Early grouped report, then the group is released | `sendText 7/9` ("Nothing more is needed from you"), `groupNotice` ("message one with courier_send if it has more to do") | **No** (C-1). |
| Report reminder | `turn failures reportReminder 1` | Yes for a leaf. Wrong for a sub-orchestrator that waits on children (C-2). |
| Silent child / failed turn | `silentNotice *`, `failureNotice *` | Yes. `failureNotice 7/8` cover a child with running children; `silentNotice` has no such variant (C-2). |
| Permission / question from a grandchild | Root: `permissionNotice 2`, `questionNotice 2`, skill L24. Sub-orch: `spawnText for a child started below the top` | The root, yes. The sub-orchestrator learns of it only from a spawn result. A grandchild told "no" is told its parent refused (C-6). |
| Finding up/down | brief paragraph 4, skill L25 | Mostly (C-12). |
| Person types mid-tree | brief paragraph 5, skill L25 | Yes, unless the session had already reported (C-1). |
| Verify, merge, cleanup | skill §4–5, `isolate` schema, `childBrief 3`, `stopText *`, `cleanupText *` | Yes. Stop-then-cleanup is spelled out only in the tool result (C-10). |
| Done, courier_note | skill §6, `courier_note`, `noteBelowRefusal`, `noteText` | Yes. Labels that conflict about "from depth N" (C-7). |

## Findings

### C-1 (major): no text says whether a session that already reported must report again when it is woken with more work

Three paths lead to this:

- **A re-tasked member.** `join groups groupNotice 1/2` ends: "The sessions that reported are idle; message one with courier_send if it has more to do." `silentNotice 1` also offers "message it … to report". The child's brief (`childBrief 1–4`) says "When you finish, send **exactly one** report", and the held-report result says "Nothing more is needed from you for it." (`tool results sendText 7`, `9`). A child that gets a new task after reporting has only the "exactly one" rule. So it either does the work and ends silently, or reports again without knowing whether that is allowed or where the report goes. No text says a second report to a delivered group "comes on its own"; only `cleanupText 5` says that, and only for a dropped member.
- **A sub-orchestrator that reported before its own group arrived.** For example, it reported partial to unblock the root. Its group's `groupNotice` then arrives in a new turn and says only "Check and integrate each one yourself." Its brief says to send "one combined report", which it has already sent. Nothing tells it to send an updated report, so the integrated result never reaches the root. Nothing triggers a reminder either, because the release does not make it owe a report.
- **Blocked counted against "exactly one".** `courier_send.status` lists blocked as a report status ("For a report … done, partial, blocked … or failed"). The brief says "send exactly one report", and separately "send status blocked … then … wait". A literal reader counts blocked as its one report and may not send the final one.

Fix direction: one line in the brief, such as "A blocked report is not your final one; and if the session that started you sends you more work after your report, report again when it is done." A matching clause in `groupNotice` would also help ("messaging it gets a new report from it").

### C-2 (major): the sub-orchestrator's brief tells it both to end its turn while children work and that ending without a report alerts the parent

- `childBrief 1` (split bullet): "start the parts … in one group …, then **end your turn while they work**."
- Same brief, paragraph 3: "if you end your turn without a report, the parent is told so."
- `turn failures reportReminder 1`: "You are about to end your turn without reporting … If you are finished, send your report now … This reminder comes once: if you end your turn without a report, the session that started you is told."

A sub-orchestrator that waits correctly is told by its own brief that the parent will be alerted. If the reminder fires for it, the reminder pushes it to report now (prematurely, which leads into C-1), to send progress, or to keep working ("carry on"). Nothing in the texts exempts a session with running children.

On the parent side, `silentNotice 1–5` has no variant for "it has sessions of its own still running". `failureNotice 7/8` has one ("message it rather than replace it"). If the silent notice ever reaches a root about a waiting sub-orchestrator, it says the session "does nothing more on its own" and suggests "start a replacement", which is wrong.

Fix direction: the brief clause "unless sessions you started are still working; their reports wake you". The reminder and the silent notice should either skip that case or say it.

### C-3 (major when nativeChildren is on): where a native grandchild's prompts appear is stated two ways

- `courier_spawn` `native` schema: the person answers its requests "in the view of the nearest session above it that is not a subagent, usually the top one".
- `tool results spawnText for a child started below the top 1/2` (what a sub-orchestrator reads after spawning): "Its permission requests and questions go to the top session of the tree, not to you".

For a native child of a standalone sub-orchestrator, the first text says the prompt shows in the **sub-orchestrator's** view, and the second says it does not concern the sub-orchestrator. At the root, `forms formNotice of a native child 2` correctly says "in session ses_middle". But the permission notice (`permissionNotice 5`: "as its own permission prompt in your session") and the question notice (`question notices of a native child 1`: "in your own session") exist only in the "your session" wording, and they also tell the root "do not call courier_answer". If those are what a native grandchild produces, the root sends the person to the wrong session and is told not to answer. The person may never open the middle session.

### C-4 (major): an OpenCode subagent in a tree has no role text and can read itself as the root

The only model-facing text about subagents is in `courier_tree` ("marked subagent: true, which owe no report"). No role line or brief for one is shown. If it has the courier tools and loads the skill, which its description invites on any split decision, the skill tells it at L12: "At the root, the top session of the tree, which has no brief: …". A subagent has no brief either. It can then take root-only actions: the `split: 1 part … to keep my context` handoff, a courier_note (refused by `noteBelowRefusal`, which tells it to "Put what you learned in your report", a report it has no channel for), and treating permission notices as its own. Skill L8 covers only the case where courier_spawn is absent.

Fix direction: either a role line for subagents, or a skill clause such as "a session started by OpenCode's subagent tool is not the root".

### C-5 (minor): the courier_answer description and the question notice disagree on who passes a question's answer on

- `courier_answer` description: "For a question, answers is what the person chose: ask them first, with your question tool if you have one". This reads as "ask, then call courier_answer".
- `questionNotice 1`: "using your question tool … What they choose there is passed on to the session. **If you cannot use your question tool**, or they answer some other way, call courier_answer". `passedNote 1` then says "do not call courier_answer for question_1."

A model working from the tool description makes a double call. The notice wins in the moment, but the description should say the same thing.

### C-6 (minor): a grandchild whose permission is refused is told its parent refused it

`permission requests REJECTED 1`: "Refused by the session that started you." For a grandchild, the decision came from the person at the root (`permissionNotice 2`), and its parent (ses_middle) knows nothing about it. The natural reaction, a blocked report to its parent asking why or asking it to reconsider, reaches a session that cannot help. It should say "Refused by the person".

### C-7 (nit): the "top session only" rules conflict with lesson and recall labels

- `courier_note`: "From the top session only". `noteBelowRefusal` agrees.
- Yet `recordLine with a lesson 2`, `noteText 2` and `lessonsEntry 1` show "lesson (…, from depth 1/2)".
- `courier_recall`: "a session another session started reads none". Yet `recallListText 3` shows "recalled by a part".

A model reading these cannot tell which rule is real. It might try courier_note from below, which is harmless because the call is refused.

### C-8 (minor): the root has no text for staging or for revising its split line

The brief defines staging ("a core you stage before the rest, when 2 or more parts follow it; a review …"), but the root has no brief. The skill pushes staging out (L8: "staging a tightly coupled core and reviewing the merge are not in this skill"). The root's split-line forms (`rolePart 5`, skill L12) include none for "stage a core, then split". The recall records show a revised line ("split: 1 part: the core · then, after 1 part: split: 2 parts …", `recordLine with a revised split line 1`), but no text tells the root to write a second split line after a stage, or after a heavy single handoff reports. After the first spawn, `rolePart 1` carries no split rule at all.

### C-9 (minor): no text covers a check-in when it fires

`courier_children` says only "For a one-off look, e.g. on a scheduled check-in". No text says what to do next when the check-in finds children still working: schedule another and end the turn, or leave them. Without that, the likely moves are polling, or replacing a child that is only waiting on the person. That risk is real below the root, since the "may be waiting on the person" hint sits only in the spawn result, possibly compacted away, and neither `standingEntry` nor `courier_tree` shows a "waiting on the person" state.

No text covers a check-in that fires after the reports arrived (it was not cancelled) either. The stale message should be ignored, but nothing says so.

Also a nit: `courier_spawn` and the skill say "For a long task or batch", while `courier_later` says to schedule one "when you start sessions", with no qualifier.

### C-10 (minor): the skill's "courier_stop those parts" omits the cleanup that frees the slot and the group

Skill L25: "if it breaks the split, courier_stop those parts or send them a corrected task." The stop result (`stopText *`) says an idle stopped session "still owes it, stays in its join group and counts toward maxChildren and maxTotal until … courier_cleanup". A model acting on the skill alone leaves a group that is never delivered and slots that are never freed, unless it reads the tool result closely.

### C-11 (nit): a refusal partway through a group

Skill L16 says to plan waves "when they do not all fit", but a model usually finds that out from `refusals 2/4` after part of a group has started. Neither text says whether the refused part may join the still-open group later, or must go into a new group.

### C-12 (nit): relaying down past a sub-orchestrator

Skill L25 says to send a finding "only to the sessions it affects". Since courier_send reaches any session, the root may message a grandchild directly and bypass the sub-orchestrator that orchestrates it. No text says to go through the sub-orchestrator.

### C-13 (nit): a leaf's brief carries lines it can never use

`childBrief 2/4` (depth 3) still says "Do the same with one a session you started sends you" and "The person's words a session you started passes you". Both are dead text for a leaf.

### C-14 (nit): two rules in the brief can read as contradictory

`childBrief 1`: "Check and integrate each part yourself … (never hand that checking to another session)". The same brief allows "a review of the parts once you have merged them" as a session of its own. The line between "checking" and "review" is not stated.
