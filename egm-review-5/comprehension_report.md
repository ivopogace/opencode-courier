# Goldfish round 3: courier-orchestrate skill and model-facing texts

Reviewer: `egm:egm-comprehension`. Read only `courier-orchestrate.SKILL.md` (this folder) and `test/__snapshots__/notices.test.ts.snap` (1685 lines), both in full. No source.

## What the texts tell a model
- **Root:** role line (`rolePart 1/5`), the skill, tools, notices. Starts parts in groups, ends its turn, is woken by reports and notices, relays permission requests and questions to the person, verifies, merges, cleans up.
- **Sub-orchestrator:** brief (`childBrief 1/3`), `rolePart 2/3` (load the skill), tools, notices. Splits or does it, passes on what reaches past its part and the person's words, sends one combined report.
- **Leaf:** brief (`childBrief 2/4`), `rolePart 4`, tools, notices. Does the task, forwards the person's words, sends exactly one report.

## Findings

**C-1 (major, medium-high): a stop from above gives the middle session no reason, and the notices invite it to redo what was stopped.** `stoppedNotice` "start a replacement if you still need what it was doing"; `idleStoppedNotice`/`blockedStoppedNotice` "message it ... to have it carry on" / "if you still need it to carry on". The `courier_stop` description does not tell the stopper to explain the stop. The middle session judges "do I still need it?" against its own task and may restart the work.

**C-2 (major, medium): `blockedStoppedNotice` leaves out the limits and group consequence `idleStoppedNotice` states** ("still counts toward maxChildren and maxTotal, and holds back its join group if it is in one"). The middle session may treat the child as finished; its group never arrives.

**C-3 (minor, medium): `blockedStoppedNotice` says both "do not send it that answer" and "message it ... to carry on".** The child waits for an answer; any message reads to it as that answer.

**C-4 (minor, high): `blockedStoppedNotice` can contradict skill section 4 by timing.** A sub-orchestrator asks the person; the notice arrives before the answer; section 4 says pass it on, the notice says not to.

**C-5 (major, medium): a reported child woken again meets "send exactly one report".** `groupNotice` ("message one with courier_send if it has more to do") or the person writing in a done child; "exactly one report" against `sendText 4` "when you finish, send one with status".

**C-6 (minor, high): a check-in is never cancelled when its sessions are stopped or dropped instead of reporting.** `laterText 1` and the descriptions tie cancelling to a report; `courier_cancel`: "Nothing else cancels it but courier_stop of the session it is for."

**C-7 (minor, medium): "the last report it covers" is ambiguous for ungrouped sessions started in waves.**

**C-8 (minor, medium): a spawn refused after a report can be refused again with nothing left to wake the session**, when the reporter's own children are still live ("A session that reported still counts while sessions it started are live"); `totalRefusal` likewise for slots freed elsewhere.

**C-9 (minor, low-medium): "reported" is unclear for a blocked report.** A model may read a blocked child as reported, expect a free slot and be refused (or the reverse).

**C-10 (minor, medium): skill section 3 against itself when the person's words break the split:** "courier_stop those parts or send them a corrected task" against "never tell a session to undo what the person asked".

**C-11 (minor, medium): nothing says what to do when the person's words conflict with each other.**

**C-12 (nit, medium): the `courier_stop` description's "a session between you and the target is, when the target was running, still owed it a report or ..." reads as "is ... still owed a report"**; write "is told".

**C-13 (nit, low): `blockedStoppedNotice` states a cause it cannot know** ("since the work it asked about was stopped above you").

**C-14 (nit, low): "They"/"undo them" in the brief's new clause** follows the sentence about a child's words; a leaf may read it as not covering its own session's words.

## Checked and consistent
- Permission request relayed up: `permissionNotice` at the root; "a child slow to report may be waiting on the person" below the top; `REJECTED` at the leaf.
- Where a change goes (skill section 3) agrees with the brief.
- A leaf at the depth limit: `refusals 1` agrees with `childBrief 2` and `rolePart 4`.
