# Comprehension report, round 5

**Reviewer:** `egm:egm-comprehension` (goldfish). **Read:** only `courier-orchestrate.SKILL.md` in this folder and `test/__snapshots__/notices.test.ts.snap` at 13c1b70, no source. Nothing was run.

## What the texts say, as a naive reader takes them

When a spawn is refused for the limits, the parent does the part itself, answers any of its sessions that is blocked, or ends its turn and starts the part (for `maxTotal`, tries again) once a session has reported, not in a loop. Skill section 2 says the same for planning ahead: waves as separate groups, or ungrouped parts started as each report frees a slot. Section 4 says to answer a blocked report with `courier_send`. A session counts while it runs, is blocked, owes a report, or has a live session below it; one that ended silently counts until it reports or is dropped with `courier_cleanup`; one that failed or was interrupted does not.

## Findings

### G-1 (minor): a blocked report is also "a report", so "once one of them has reported" can look met too early

Text: `childrenRefusal` "answer any of them that is blocked, end your turn and start it once one of them has reported, not in a loop"; `totalRefusal` "... try again once one of them has reported". Other texts call a blocked message a report: skill section 4 ("A blocked report"), `courier_send` ("a status (done, partial, blocked or failed)"), the report reminder, the `group` parameter ("A blocked report ... still reaches you at once").

Scenario: `maxChildren` 2, the refusal arrives with none blocked, the model ends its turn. A child sends `blocked` and wakes it. The condition now looks met: the model answers and calls `courier_spawn` again, which is refused again, since the answered child counts. Cost: one refused call; the second refusal sets it right.

### G-2 (nit): a slot can come free without a report

"start it once one of them has reported", while the refusal's last sentence says a failed or interrupted session does not count, and `courier_cleanup` frees one too. A model woken by a failure notice may keep a deferred part waiting with a slot free. Parallelism lost, nothing breaks.

### G-3 (nit): `totalRefusal`'s "one of them" can be read as any session in the tree

The nearest plural is "sessions in this session tree", whose reports do not all reach the caller; the preceding "answer any session you started" points at the intended reading. No wrong action: the model wakes on its own sessions' reports either way.

## Checked, no conflict

- Section 2's "start the next as each report frees a slot" against both refusals: per-report starting is tied to ungrouped parts, waves to groups.
- Section 4's blocked handling against "answer any of them that is blocked": the same instruction.
- The `yours === 0` refusal against the other: consistent, and it covers the case where waiting would never end.
- The brief's "at most N of yours running at once": the declined role-line item.

## Totals

Blocking 0, major 0, minor 1 (G-1), nit 2 (G-2, G-3).
