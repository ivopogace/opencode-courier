# Zoom-out report, round 4

**Reviewer:** `egm:egm-zoom-out`. **Read:** `CLAUDE.md`, `src/skill.ts` and the rendered skill (they match), `src/tree/text.ts`, `src/kernel/protocol.ts`, the blocked, limit and stop wording in `src/*/tools.ts`, `docs/reference.md` (145-303, 331-370, 392-419, 502-550, "Steering a running tree"), the round-3 and round-2 reports and the diff 2dacfe4..98c64cf. Nothing was run.

## Verdict

No findings. Every R3 item is closed in code, model-facing text and the reference; #529-#531 put no rule in two places in conflict and leave no rule missing at its moment of use.

## 1. Baseline status

| Item | Status |
| --- | --- |
| R3-F1 | Closed: `blockedStoppedNotice` says "It still holds back its join group if it is in one" (`src/tree/text.ts:388`, `HOLDS_GROUP` `:375`); the reference clause covers both cases (`docs/reference.md:526-527`). |
| R3-F2 | Closed with the code variant: a blocked child counts (`src/tree/limits.ts:23`) and makes nothing above it live; the refusals say "running, blocked or still owe(s) a report" (`src/tree/text.ts:177`); liveness list `docs/reference.md:162-163`. |
| R3-F3 | Closed: `src/tree/text.ts:180`, matching `silentNotice` and `docs/reference.md:167-168`. |
| R3-F4 | Closed: `src/tree/text.ts:190`, `docs/reference.md:152-153`. |
| R3-F5 | Closed: `docs/reference.md:397-398`. |

## 2. Findings

None.

## 3. Checked and dropped

- **Skill section 2 "start the next as each report frees a slot" (`src/skill.ts:27`, `docs/reference.md:263`) now that a blocked report frees no slot:** a spawn after a blocked report is refused, and the refusal names "blocked"; section 4 tells the parent to answer. Judged a self-explaining refused call. (The synthesis keeps the follow-on case, see R4-F1.)
- **The refusals' "once one of them has reported" with a counted blocked session:** "blocked" is listed as counting in the same sentence; "not in a loop" covers a retry. (Re-examined in synthesis, R4-F1.)
- **Skill section 4 against the refusals and `blockedStoppedNotice`:** consistent; the stop notice is the specific exception (round 3 C-3, C-4).
- **#530, a reported parent getting its own child's status-less message is not reminded:** the brief tells it to pass such a message up when it reaches past its part, and the person's words always (`src/tree/text.ts:23-28`); skill section 3 adds the downward relay (`src/skill.ts:40-46`). No report is owed for a relay.
- **Reference accounting (`docs/reference.md:251-291`):** still matches; answering a blocked, partial or failed report is skill-only apart from the stopped case.
- **`stillCounts`'s "while one it started is live" when the one below is only blocked:** needs a session that reported while its child waited on its answer, against its brief; the code decides admission anyway.
- **`docs/maintainers/plugin-api-notes.md` still calls the exempt message "a session's own check-in":** maintainer doc, not model-facing.
- **#531's two-state `live`:** the smallest fix; `liveBelow` keeps the old meaning.
