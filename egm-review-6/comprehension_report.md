# Comprehension (goldfish) report, round 4

**Reviewer:** `egm:egm-comprehension`. **Read:** only `courier-orchestrate.SKILL.md` in this folder and `test/__snapshots__/notices.test.ts.snap` at 98c64cf (all 1685 lines), plus section 3 of the round-3 report to know what was declined. No source.

**Seats:** the root (no brief), a sub-orchestrator (brief and role line), and a parent receiving notices and refusals.

## Verdict

No findings. None of the recently changed texts conflicts with another text, leaves a rule missing at the moment it is needed, or leads a model to act wrongly.

## How the system works, per these texts

A session started with `courier_spawn` counts toward `maxChildren` and `maxTotal` while it is running, blocked or still owes a report. It also counts while one it started is live, and after a silent end until it reports or is dropped. A failed or interrupted session stops counting. A join group delivers its reports once every member has reported or left and the parent's turn has ended; a member leaves by failing, being interrupted, deleted or dropped with `courier_cleanup`. A stopped session that was idle stays in the group and keeps counting until it reports or is dropped.

## Checked and dropped

- **`idleStoppedNotice` and `blockedStoppedNotice`, "holds back its join group if it is in one":** agrees with `stopText` ("stays in its join group"), the `courier_cleanup` description and `groupNotice 2` (an interrupted member leaves, an idle-stopped one does not). Each notice names the way out.
- **`stoppedNotice` (a running child, so interrupted) says nothing about its group:** correct, an interrupted member no longer holds the group back.
- **`childrenRefusal` / `totalRefusal`'s `live` wording and `stillCounts`** against `silentNotice`, `failureNotice 7/8`, `idleStoppedNotice` and `stopText`: silent end counts until it reports or is dropped; failed or interrupted does not; failed with live sessions below counts; idle-stopped counts. All agree. "Live" in `stillCounts` is undefined there but reads as the set the sentence before names.
- **Stopped children taken for interrupted:** `stopText` lists idle against interrupted per session and says idle ones still count; the parent's notice says the same.
- **`totalRefusal 5`, "only reports already held for a group can still wake you":** a `courier_later` message or a retry can also wake it, but neither is a report; the advice is right.
- **`stopText` omits "until it reports" for an idle-stopped session:** the stopper is usually not the parent; the parent's notice gives both ways out.
- **Role lines' "At most N ... run at once" against blocked or owing sessions counting:** under the accepted item (the refusals cover the limits).
- **Skill section 3 and the person's words; "do not send that answer" against carrying on; refusals with live sessions below:** declined in earlier rounds (Z-3, Z-4, C-1, C-3/C-4, Z-1, K-3).
