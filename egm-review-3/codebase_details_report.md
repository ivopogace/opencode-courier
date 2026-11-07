# Codebase details review: courier-orchestrate texts against the code

Base: claude/egm-check-3 = origin/main 6673992. Only claims the code contradicts, verified by reading the code. Line numbers are at that commit.

## K-1 (major): the limit refusals say "wait for a report", but some counted sessions never report

**Claim.** `childrenRefusal` src/tree/text.ts:178-180 says "N sessions you started is running or has not reported yet ... end your turn and start it once one of them has reported". `totalRefusal` text.ts:186 says "try again once a report has arrived". `silentNotice` text.ts:453-456 offers "start a replacement" and says "Until it reports, it counts toward your limits". Skill §2 src/skill.ts:27 says "start the next as each report frees a slot".

**Code.** `live()` src/tree/limits.ts:262-264 counts a child while it owes a report (`report.owes`). A child that ended silently keeps owing until it reports or is dropped. limits.ts:288-291 also counts every ancestor of a live session as active. So a child that already reported (for example the #493 early reporter) still counts while its subtree runs, and it will not report again. Only `courier_cleanup` frees the slot: `forgetChild` in src/tree/forget.ts:137-149 removes the entry that limits.ts:280 reads.

- When the counted children are silent, the refusal's advice cannot work: no report is coming, so a parent that follows it waits forever.
- The way out, `courier_cleanup`, is not in the refusal. It is not in the ungrouped `silentNotice` either: text.ts:457-461 names it only for a group member. The `courier_cleanup` description (src/tree/tools.ts:271-277) does not mention limits.
- The only text that says cleanup frees the slot is `IDLE_STOPPED` (text.ts:323-325), and only `courier_stop` shows it.
- "is running or has not reported yet" is false for a child that has reported but has live sessions under it.

**Placement.** Add to both refusals: "a session that ended without a report counts until it reports or you drop it with courier_cleanup". Say the same in the ungrouped `silentNotice` next to "start a replacement".

## K-2 (major): courier_stop's "a session between you and the target is [told]" does not hold for an idle target

**Claim.** The `courier_stop` description (src/tree/tools.ts:258-259) says: "you are not told of what you stopped; a session between you and the target is." `IDLE_STOPPED` (text.ts:323-325) says an idle stopped session counts "until the session that started it drops it with courier_cleanup".

**Code.**
- `tell` runs only when the target's own outcome is `interrupted` (src/tree/stop.ts:69-72).
- An idle target gets outcome `idle` and no `settled` note (stop.ts:108-111), and `silence` writes only `stopped` (stop.ts:94).
- A typical idle target is a sub-orchestrator waiting on its group. Its parent I (between the caller and the target) still sees it as `awaited`: report.ts:284-287 checks owes and not told, and ignores `stopped`. So I counts as waiting (nudge.ts:194-199). I is never woken, reminded or reported silent.
- The caller is told nothing either, and cannot drop the target: `cleanup` requires the caller to be the target's parent (src/tree/cleanup.ts:18-19).
- So the advice in `IDLE_STOPPED` names an action only I can take, and I was never told. A root awaiting I hangs until a check-in fires.

**Placement.** Either tell the in-between parent for an `idle` target too (code), or have the description and `IDLE_STOPPED` name that case: the caller should message the target's parent or stop that parent instead.

## K-3 (minor): a pending courier_later blocks "the parent is told so", and a stale check-in makes a reported child owe again

**Claim.**
- The brief (text.ts:19-20) says "if you end your turn without a report, the parent is told so".
- `reportReminder` (text.ts:438) says "if you end your turn without a report, the session that started you is told".
- The `courier_spawn` description (src/tree/tools.ts:189) says "you are told if its turn ... ends without a report".
- The skill (skill.ts:37-38), the spawn description (tools.ts:194-196) and `courier_later` (src/scheduling/tools.ts:143-147) tell every orchestrator, sub-orchestrators included, to schedule check-ins.

**Code.**
- `outside = waitsOn(asksPermission, asksQuestion, isScheduled)` (src/index.ts:76). `owedUnwaited` (src/tree/nudge.ts:202-206) treats any message pending for the session (`isScheduled`, src/scheduling/later.ts:92-94) as waiting.
- So a sub-orchestrator that ends owing a report, with its own check-in still pending, gets no reminder. Its parent gets no `silentNotice` until the check-in fires.
- In the other order: the sub-orchestrator reported and forgot `courier_cancel`. The due message is delivered as an ordinary `synthetic` (later.ts:103-110). `notePrompt` (src/tree/events.ts:97-114) marks it as a new prompt, since only `user`, `compaction`, `move` and a released group are exempt. The child owes again, and the reminder asks for a second report, which wakes the parent.
- No text says what a child does with a check-in that fires after it reported.

**Placement.** Add one clause to the skill's §3 check-in line or to `laterText`: below the root, cancel your check-in before you report, or a pending one delays the parent's notice and a late one makes you owe a new report.

## K-4 (minor): "send exactly one report" against owing a report after every courier message

**Claim.** The brief (text.ts:14) says "When you finish, send exactly one report". The brief's split rule (text.ts:63-66) says "send ${parentID} one combined report".

**Code.**
- Every courier message except a released group (events.ts:104-111) makes the child owe a new report, and the reminder (text.ts:433-439) then demands one. This covers a parent's follow-up (skill §4, skill.ts:50-51 "have it finish or retry with courier_send"), a scheduled message, an ungrouped report from the child's own child, and a failure or silent notice.
- The #493 case: a child that reported and then gets its own group (`reportedSincePrompt`, report.ts:259-262) is told nothing about its report. `groupNotice` ends with "Check and integrate each one yourself ... message one with courier_send if it has more to do" (text.ts:495). No text says it may end without reporting again, or that it should report again if integrating changes its result. If it messages a member, the member's next report re-prompts it, and the reminder then asks for a second report that the brief says not to send.

**Placement.** In the brief: "one report per task or message from the session that started you" in place of "exactly one". Optionally add to `groupNotice`, for a session that is itself a child: "if you already reported and this changes nothing, end your turn; otherwise report again".

## K-5 (minor): a report that frees a slot is not free while the reporter's turn runs

**Claim.** Skill §2 (skill.ts:27) says "start the next as each report frees a slot". `childrenRefusal` (text.ts:180) says "start it once one of them has reported".

**Code.** In `live()` (limits.ts:262), `running = ... && !report?.ended && runs(...)`. `reportOf.ended` is false when the turn was settled by a report (report.ts:279). An ungrouped report is steered to the parent at once (send.ts:313, 330). The reporter's turn still runs its last step, because `sendText` tells it to end its turn then. A parent that spawns at once can be refused, with advice to wait for a report that has already arrived. This depends on timing.

**Placement.** Code (do not count a session settled by a non-blocked report as running), or add "or its turn has ended" to the refusal.

## K-6 (nit): the brief says a report "wakes the parent and is the only way it hears from you"

**Claim.** The brief, text.ts:19.

**Code.** A grouped `done`, `partial` or `failed` report is held and does not wake the parent (send.ts:309-312). Progress (text.ts:21-24, send.ts:359) and the silent and failure notices also reach the parent. The `courier_send` description (tools.ts:213-214) has the group case right.

**Placement.** Brief: "A report with a status (held with your group, if you were started in one) is how the parent learns your result".

## K-7 (nit): the "still reaches you at once" lists are incomplete

**Claim.**
- `spawnText` (text.ts:267-268): "a blocked report, a question or a failed turn still reaches you at once".
- The `group` field description (tools.ts:108-110): a blocked report, a failed turn, a question and a permission request.

**Code.** A silent end of a group member reaches the parent at once, whatever the group (`reportSilent`, events.ts:150-176, sends `silentNotice` with the group named). At the top, a permission request also reaches the parent at once (person/events.ts:203-222), and `spawnText` omits it. `docs/reference.md` "What is held" lists all of them.

**Placement.** Align both lists with the reference: blocked report, failed turn, silent end, and at the top a permission request, question or form.

## K-8 (nit): courier_recall's "a session another session started reads none"

**Claim.** The `courier_recall` description, src/memory/tools.ts:35-36.

**Code.** `recall` (src/memory/recall.ts:53-70) serves any caller and only records the read "by a part" (`noteRecall(..., byTop=false)`). Nothing refuses or hides it below the top: only a leaf loses it (`hiddenFromLeaf`, src/index.ts:166).

**Placement.** Make it an instruction ("below the root, do not call it: the root weighed the records") rather than a statement of fact.

## Checked, no contradiction found

- **#493.** `reportSilent` and the reminder use the same `owedUnwaited`, so the wording matches. The blocked status is correctly excluded from `reportedSincePrompt`. The reference documents the case. The only text gap is K-4.
- **#490.**
  - `courier_send` to a session that reported partial or failed is a `synthetic`, so it wakes the session and makes it owe again (events.ts:97-114). After the release it comes on its own, since the member was dropped by `drop` (group.ts:160-177).
  - A replacement is not blocked by the old session, which is no longer live once its turn ends (report.ts:276-279, limits.ts:262-264).
  - `groupNotice` and the bare report envelope carry no partial or failed guidance. The skill §4 holds it.
- **#484 and #489.** `belowTop = depth > 1` (spawn.ts:80). Asks are always relayed to `topOf(chain)` (person/events.ts:203-222). `answeringTop` (roster.ts:50-59) enforces the `courier_answer` claim "only the top ... can answer".
  - A native child of the root is at depth 1, so its children get `belowTop`, which is right.
  - A native child's request carries the native notice only when its native root is the top (person/events.ts:210). This matches the "nearest session above it that is not a subagent" wording in the `native` description.
- **#488.** `cancelScheduled` runs only from `courier_stop` (stop.ts:96), for the stopped sessions' own messages. `courier_cleanup` does not cancel, and no text says it does. The `courier_cancel` claim "Nothing else cancels it but courier_stop of the session it is for" holds. No text describes a check-in that fires after the job is done (see K-3 for the case below the root).
- **Root role.**
  - depth null: the split rule, `ROOT_SPLIT_LINE` and `courier_recall`.
  - depth 0, written once at the first spawn (spawn.ts:178-181): the limits, "check and integrate" and "load the skill". The depth counts ("down to maxDepth levels", "maxDepth − depth levels below you") match `check()` in limits.ts:283.
