---
name: courier-egm-loop
description: >-
  Run EGM review rounds on the courier-orchestrate skill until one confirms no finding: a review
  session per round, the orchestrator verifies and files the findings as issues, a courier-wave
  wave fixes them, the round's review PR is closed, the next round reviews main again. Load when
  the user asks to loop, repeat or automate the EGM review of the skill, or invokes
  /courier-egm-loop. Arguments: the maximum number of rounds (default 3).
---

# EGM rounds on courier-orchestrate until none is found

The orchestrator writes no product code and no review. Each round has one review session and
one wave of fix sessions; the orchestrator verifies, files, merges and decides when to stop.

## The go

Invoking this skill is the owner's go, for this run only, to file each finding the orchestrator
confirmed as an issue, and to merge each fix PR that meets courier-wave's merge bar. Record the
invocation verbatim with its time in the roster. It covers nothing else: a release, a post
outside this repository, anything that costs money, and every `NEEDS USER DECISION` that
courier-wave gives the owner stay the owner's. Children cannot file or merge on a relayed go;
the orchestrator does both itself.

## The roster

Keep `egm-loop-roster.md` in the scratchpad and read it first on every check-in. Per round: the
review session and its draft PR, each finding with its verdict, the issues filed, the fix PRs and
their merge shas. Across rounds, a **declined** list: every finding the orchestrator rejected,
with the reason, so later rounds don't raise it again.

## A round

1. **Review.** Start one review session (local: `start_session` `user_asked`, `fresh`, its own
   worktree cut from `origin/main`) with `references/review-prompt.md`, every bracket filled.
   Wait for its final message without polling; it reports each finding with file:line evidence
   and a severity, and proposes an issue per finding.
2. **Verify.** Check every proposed finding against the code yourself, never from the
   session's summary. Reject one the code contradicts, one already on the declined list, one
   that restates an open issue, and one that asks the skill to repeat what a text the model reads
   at the moment of use already says (the skill keeps only what no other text says). Add each
   rejection to the declined list.
3. **Stop?** Stop when the round confirms no finding: the loop has converged. Stop and ask the
   owner when the round count reaches the maximum, or when a round confirms as many findings as
   the round before, or re-raises one an earlier round fixed: the reviews are not converging, and
   another round will not help.
4. **File.** One issue per confirmed finding with `gh issue create`, the session's evidence and
   suggested placement in its body, titled as the repo's issues are. Assign them to the owner.
5. **Fix.** Run the issues as a wave with the `courier-wave` skill: its planning, its child
   prompt, its merge bar and loop. In this desktop app the children are local worktree sessions
   (`start_session` `user_asked`, worktree from `origin/main`, follow-ups by `SendMessage`).
6. **Close the review PR** with a comment that lists the issues filed and the PRs that fixed
   them; it was a reference, never for merging.
7. **Real-model check.** When the wave changed a model-facing string, CLAUDE.md asks for
   `e2e/real-model.sh` and a row in `docs/maintainers/real-model.md`. Run it where the owner runs
   real models; if that place isn't known yet, ask once and record the answer in the roster. A
   failed check is a finding of the next round.
8. Tell the owner in three lines: the round, what was found and fixed, and what's next. Then
   start the next round.

## Close-out

When the loop stops, give the owner a table: round, findings proposed, confirmed, fixed (with
PRs), and why it stopped. Archive the review and fix sessions once the owner has seen it.
