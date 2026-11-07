# EGM round 2: comprehension (goldfish) report

Read only `egm-review-4/courier-orchestrate.SKILL.md` and `test/__snapshots__/notices.test.ts.snap`.

## Events walked

1. Root, two independent parts: `rolePart 5` and skill section 1 lead to `split: 2 parts: …`. Clear.
2. Root spawns 2 parts in group `g`: `courier_spawn` description, `group` schema, `spawnText 3`. Clear.
3. Root schedules a check-in for `g`: `courier_spawn` and `courier_later` descriptions, `laterText 1`. Clear.
4. A depth-1 part (`childBrief 1`, `rolePart 2`) splits into 3 in a group: `spawnText for a child started below the top 2`. Clear.
5. A depth-1 grandchild finds a shared API change that affects a sibling inside the depth-1 part: brief vs skill section 3. **C-3**
6. A depth-3 leaf (`childBrief 2`, `rolePart 4`) does the work and reports done in a group: `sendText 7`. Clear.
7. A depth-2 child ends silently. The depth-1 part gets `silentNotice 5`. **C-6**
8. The depth-1 part tries a replacement while at maxChildren: `refusals 2`. **C-1**
9. All 5 of a parent's counted children are idle (silent or idle-stopped), none running. The parent spawns and gets `refusals 2`. **C-1**
10. maxTotal with none of your own running: `refusals 5`. **C-1**
11. A parent woken by an ungrouped report spawns the next part at once: `refusals 2` "has reported and its turn has ended". **C-2**
12. A grouped parent at maxChildren is told to start the part "once one of them has reported". **C-5**
13. Root `courier_stop`s a running depth-1 subtree: `stopText`, and the in-between gets `stoppedNotice`. **C-8**
14. Root `courier_stop`s an idle depth-2 sub-orchestrator that waits on its running children: the depth-1 part gets `idleStoppedNotice` and messages it to carry on. **C-7**
15. Root stops its own idle direct child that owed a report: `stopText` "until the session that started it drops it". Clear enough.
16. The depth-1 part scheduled a check-in, reported, and then the check-in fires: brief "exactly one report", `courier_later`. Clear, see dropped.
17. Root relays a permission request (`permissionNotice 2`). The person refuses in the prompt without a reason. **C-4**
18. Root relays a question (`questionNotice 1` → question tool → `passedNote 1`). Clear. The `courier_answer` description agrees with it.
19. A child's permission is rejected: `REJECTED`. Clear.
20. A group member's turn fails (`failureNotice 3`), and another is dropped with cleanup (`cleanupText 5`), then `groupNotice 2`. Clear.
21. A check-in fires while parts are still working. **C-10**
22. A brief's count of "running at once" vs the refusals' count. **C-9**

## Findings

### C-1 (major): the maxChildren refusal sends the model to wait when nothing can wake it

`refusals 2`/`refusals 3`: "Do this part yourself, or end your turn and start it once one of them has reported and its turn has ended, not in a loop; a session that ended without a report counts until you drop it with courier_cleanup."

Scenario: all 5 sessions that count are idle: each ended without a report (each already sent its `silentNotice`) or was stopped while idle (`idleStoppedNotice`). None is running. The main instruction is still "end your turn and start it once one of them has reported". The parent ends its turn and nothing wakes it. The cleanup clause reads as an aside, not as the way out. maxTotal has exactly this variant (`refusals 5`: "none of the sessions you started is running, so no report will wake you"), but maxChildren has none.

`refusals 5` has the opposite gap: it says only "Do this part yourself". It does not mention that dropping one's own silent or idle-stopped sessions with courier_cleanup frees a slot.

Fix: add a maxChildren variant for when none of the counted sessions is running: "Not started: … (maxChildren 5), and none of them is running, so no report will wake you: drop those you no longer need with courier_cleanup and start it again, or do this part yourself." Add to `refusals 5`, when the caller has idle sessions that owe it a report: "…or drop those of yours that ended without a report with courier_cleanup and try again."

### C-2 (major, needs a check against the code): a race in "has reported and its turn has ended"

`refusals 2`/`refusals 4`: "start it once one of them has reported and its turn has ended". The texts say the count is "running or have not reported yet", and `sendText 2` shows a report delivered while the child's turn is still on.

Scenario: an ungrouped child reports, which wakes the parent. The parent spawns the next part, as skill section 2 says ("start the next as each report frees a slot"). The child's closing reply has not finished yet, so it still counts and the spawn is refused. The refusal says not to retry in a loop and to end the turn. The end of the child's turn wakes nobody, so the parent stalls.

Fix: if the plugin already frees the slot at the report, drop "and its turn has ended" from both refusals. If it does not, either free it at the report, or add: "if one has just reported, its turn is ending: try once more."

### C-3 (major): skill section 3's parenthesis contradicts the brief for messages inside your own part

Skill section 3: "courier_send it at once, only to the sessions it affects (below the root, to the session that started you as your brief says)".

Brief (`childBrief 1`): "send it to the parent at once … Do the same with one a session you started sends you, when it reaches past your own part."

Scenario: a depth-1 sub-orchestrator gets word from child A that an API behaves otherwise, and the change affects its own child B. The brief forwards upward only "when it reaches past your own part", which implies a within-part message goes to B. The skill's parenthesis reads as "below the root, send it to the parent instead". B is never told, and the parent gets a message it can only send back down.

Fix: "…only to the sessions it affects, and, below the root, also to the session that started you when it reaches past your own part, as your brief says".

### C-4 (major): `permissionNotice` leaves the root with no next step after a refusal without a reason

`permissionNotice 1–4`: "A refusal there with a reason fails the call with it, which the session is given; one without a reason ends your turn, and the session waits on."

Scenario: the person refuses in the prompt without typing a reason. The root's turn ends and the child waits indefinitely. The person's next message wakes the root, but no text says what to do with the child still waiting on per_1. The root may propose once again, or say nothing. `refusedText` ("do not propose it again unless they ask") comes only on the with-reason path.

Fix: "…one without a reason ends your turn while the session waits on: when the person next writes, pass their refusal on with courier_answer reply reject (with their reason if they give one), unless they now allow it."

### C-5 (nit): the refusals assume a report wakes you, which a grouped report does not

`refusals 2`: "start it once one of them has reported". Scenario: all 5 are in one group. A member's report is held and does not wake the parent, which wakes only at group delivery. There is no stall, but the model expects to be woken earlier. Fix (optional): add "(for a group, once the group's reports reach you)".

### C-6 (minor): the silentNotice cleanup clause understates the limits and orders the replacement badly

`silentNotice 1–5`: "Decide what it needs: … or start a replacement. Until it reports, it counts toward your limits on the sessions you run at once, or until you drop it with courier_cleanup."

- "your limits on the sessions you run at once" reads as maxChildren alone. `idleStoppedNotice` and `refusals 4` say it counts toward maxTotal as well.
- "Until it reports, …, or until you drop it" is awkward to parse.
- "start a replacement" comes before the clause that says the original still holds a slot. At the limit, the replacement is refused.

Fix: "…or start a replacement, dropping it first with courier_cleanup. Until it reports or you drop it, it counts toward maxChildren and maxTotal."

### C-7 (minor): `idleStoppedNotice` "message it to carry on" hides that its subtree was stopped too

`idleStoppedNotice 1`: "…together with the sessions under it. … or message it with courier_send to have it carry on."

`courier_stop`: "the messages scheduled for them with courier_later are cancelled".

Scenario: the stopped target is an idle sub-orchestrator waiting on running children. Those children were interrupted, its check-ins were cancelled, and the target itself got no notice. Revived with a "carry on" message, it may end its turn waiting for reports. Only the standing entry ("stopped") can save it.

Fix: "…to have it carry on; the sessions under it were stopped too and it was not told, so say which it should wake with courier_send or replace."

### C-8 (nit): `stoppedNotice` leaves out the cheaper resume

`stoppedNotice 1`: "Carry on without it, or start a replacement if you still need what it was doing." The `courier_stop` description says "A stopped session can be woken again with courier_send", and `idleStoppedNotice` offers courier_send. Fix: "Carry on without it, message it with courier_send to resume it, or start a replacement."

### C-9 (nit): two definitions of what counts toward the limits

`childBrief 1` and `rolePart 1–3` say "at most 5 of yours running at once". The refusals say "running or have not reported yet". `failureNotice 1` implies that a failed session with no running children does not count, yet it literally "has not reported". A model counting its children against a refusal's number gets a different total. Fix: in the refusals, say "running, or idle and still owing you a report".

### C-10 (nit): the check-in lifecycle

`courier_spawn`/`courier_later`: "one for the ungrouped sessions … cancel each when its last report arrives".

- With rolling ungrouped starts (skill section 2), "its last report" moves each time a part starts.
- No text says what to do when a check-in fires with parts still working. `courier_children` says only "a one-off look, e.g. on a scheduled check-in". Nothing says to schedule the next check-in.

Fix (optional): in `courier_later`, add "if parts are still working when it fires, look once and schedule the next".

## Considered and dropped

- Grouped `spawnText 3`, and the below-top variant, vs the `group` schema: the lists agree. The top/below split for questions and permissions is consistent.
- The `courier_answer` wording on questions agrees with `questionNotice`, `passedNote 1–4` and `unlinkedNote`.
- `REJECTED`: clear for a child at any depth.
- The `courier_stop` clause "when the target was running or still owed it a report" agrees with `stoppedNotice`, `idleStoppedNotice` and `stopText`.
- The child's own check-in firing after it reported: the brief's "send exactly one report" is enough, and at worst it costs one idle wake.
- Skill section 1 "never start one session for the whole task" vs the brief's stage exceptions: the skill defers to "the rule in your brief".
- A failed group member releasing the group (`failureNotice 3`) vs a silent one holding it (`silentNotice 5`): each notice states its own case at the moment of use.
- `stopText` printing the "Stopping an idle session" line: every snapshot has an idle target, so I could not judge it.
