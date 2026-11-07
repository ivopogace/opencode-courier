# EGM round 2, zoom out: courier-orchestrate on main 476df67

Baseline: `egm-review-3/` on `origin/claude/egm-check-3` (F1-F7 and its section 3). Fixes read with
`git diff 2cb1aa9^ HEAD -- src docs/reference.md` (#507, #509, #508). Nothing was run.

## Part A: the baseline's items on 476df67

| Item | Status | Evidence |
| --- | --- | --- |
| F1 own check-in after a report | Resolved (#507) | `kindOf` marks a courier synthetic with `scheduled` metadata and `from === sessionID` as `OWN` (`src/tree/events.ts:85-90`), the same exemption as a group delivery (`:110`); `deliverDue` sets both (`src/scheduling/later.ts:106-108`). Reference `docs/reference.md:390-396`. The optional `groupNotice` clause was not added; with the code fix no text asks for a second report, so nothing is left. |
| F2 `courier_stop` tells the in-between session | Resolved (#509), code variant | `tellParent` tells the parent for `interrupted`, and for `idle` when the target owes (`src/tree/stop.ts:160-166`), with `idleStoppedNotice` (`src/tree/text.ts:371-376`). Description `src/tree/tools.ts:204-205`, reference `docs/reference.md:516-519`. |
| F3 refusals wait for a report that may not come | Partly open (#508) | Of the three cases: silent child, said (`src/tree/text.ts:181`, `:188`, silentNotice `:466`); child still finishing its turn, said ("and its turn has ended", `:180`, `:187`); reported child with a live subtree, not said: `check` still counts every ancestor of a live session (`src/tree/limits.ts:45-48`) and `live()` words it "is running or has not reported yet" (`text.ts:176`), which such a child is neither. And the condition now named wakes nobody (Z-1). |
| F4 `REJECTED` refuser | Resolved (#508) | `src/person/text.ts:42`; reference `docs/reference.md:452-453`. Consistent with `refusedText` (`:44-46`). |
| F5 `courier_answer` vs question notice | Resolved (#508) | `src/person/tools.ts:67-69` now matches `questionNotice` (`src/person/text.ts:188`) and `passedNote` (`:255-258`). |
| F6 "still reaches you at once" lists | Resolved in both places (#508) | `spawnText` `src/tree/text.ts:267-271`, `group` description `src/tree/tools.ts:55-56`: same items, same top/below split. |
| F7 check-in duplication, "only", line 42 | Resolved, one drift left | Skill check-in clause cut (`src/skill.ts:37`); `courier_later` gets the "long task or batch" trigger and "one for the ungrouped sessions" (`src/scheduling/tools.ts:27-29`), as does `courier_spawn` (`src/tree/tools.ts:140-142`); reference "mostly" (`docs/reference.md:246`), step 3 cut (`:263`), check-in moved to `:579-580`; skill line 41-42 parenthetical added. Left: `laterText` still says "If what it checks on reports first, cancel it then" (`src/scheduling/text.ts:5`), against "when its last report arrives" (Z-2); the line 42 parenthetical reads as a replacement (Z-3). |
| C-2 (waits holds back reminder and silent notice) | Holds | `src/tree/nudge.ts:17-30`, used by `reportSilent` `src/tree/events.ts:157`. |
| K-3 first half (pending check-in holds back reminder) | Holds, by design | unchanged. |
| C-3 (native child of a sub-orchestrator) | Holds, decided in #484 | `src/person/events.ts:18`. |
| C-4 (subagent inside a tree as root) | Holds | documented, unchanged. |
| C-7, K-8 (`courier_recall`/`courier_note` top-only wording) | Holds, advice | `src/memory/tools.ts` unchanged. |
| C-8 (root's split rule only in the skill) | Holds, by design | skill line 17-22, CLAUDE.md. |
| C-9..C-14, K-6, Z-6, Z-9 | Hold | covered at the moment of use, or decided in #489. |
| Z-5 (partial/failed only in the skill) | Holds, declined by owner | not raised. |

## Part B: the current text set

Severity: **major**, a model is likely to act wrongly or stall; **minor**, a gap or claim that
misleads with lower stakes; **nit**, wording.

### Z-1 (minor): the refusals and the skill name a slot-freeing event that wakes nobody; a reported child with a live subtree is not named

- `childrenRefusal` and `totalRefusal` (`yours > 0`): "end your turn and start it once one of them
  has reported and its turn has ended" (`src/tree/text.ts:180`, `:187`). A child's turn ending after
  its report sends the parent nothing: the report was the wake (`send`), `report.ended` is false
  after a report (`src/tree/report.ts:33`), so `live()` keeps it `running` until the turn ends
  (`src/tree/limits.ts:19`), and no event wakes the parent when it does.
- The skill's rolling mode, "start the next as each report frees a slot" (`src/skill.ts:27`), and the
  reference (`docs/reference.md:258`) invite a spawn on the report's own turn, which races the
  child's closing reply. Refused, the parent follows the refusal and ends its turn. With other own
  children live, a later report retries it (delay only). With none (the reporter was its last live
  child, `maxChildren` reached by reporters still finishing, or `totalRefusal` with `yours` = 1),
  nothing wakes it: a sub-orchestrator is rescued by its report reminder, the root stalls unless a
  check-in is pending.
- The F3 residue: a reported child whose own sessions still run counts (`limits.ts:45-48`) until
  they all settle, and their reports wake it, not the caller; no refusal or notice says so, and the
  count's wording "running or has not reported yet" (`text.ts:176`) excludes it.

Why: the text tells the model to wait for something it will never be told about. Placement: code,
in `live()`, do not count a child as `running` once it has reported (non-blocked) since its prompt,
so "once one has reported" is true at the report's own turn; then the refusals drop "and its turn
has ended". For the subtree case, one clause in both refusals: "a session that reported still
counts while sessions it started are live". Unit test in `test/limits.test.ts`, e2e next to the
limit scenarios.

### Z-2 (nit): `laterText` keeps the old cancel trigger

- `laterText` (own): "If what it checks on reports first, cancel it then" (`src/scheduling/text.ts:3-5`).
- `courier_spawn` and `courier_later`: "cancel each when its last report arrives" (`src/tree/tools.ts:141-142`, `src/scheduling/tools.ts:28-29`); `courier_cancel`: "a check-in whose reports arrived" (`:46`).
- For a group or the ungrouped check-in, "reports first" can be read as the first report.

Placement: `laterText`: "Once the last report it covers arrives, cancel it with courier_cancel."

### Z-3 (nit): the skill's upward parenthetical reads as replacing, not adding

- Skill: "courier_send it at once, only to the sessions it affects (below the root, to the session
  that started you as your brief says)" (`src/skill.ts:41-42`).
- The reference says it "includes the parent" (`docs/reference.md:265-266`); the brief sends a
  finding up and has the parent pass it on (`src/tree/text.ts:21-24`), so a sub-orchestrator should
  also tell its own affected children. "Only ... (below the root, to the session that started you)"
  can be read as "below the root, only up".

Placement: "(below the root, also to the session that started you, as your brief says)".

### Checked, not findings

- Limit wording across `childrenRefusal`, `totalRefusal`, `silentNotice` (`text.ts:466`),
  `idleStoppedNotice` (`:374`) and `IDLE_STOPPED` (`:326-328`): all say a session owing a report
  counts until it reports or its parent drops it with `courier_cleanup`. `courier_cleanup`'s
  description names that use only for a group member (`src/tree/tools.ts:221-223`), but every text
  that leads a model there carries it at that moment.
- A silent isolated child with uncommitted work is `kept` by `courier_cleanup` and still counts;
  `cleanupText` (`text.ts:308`) says to commit or pass `force` at that moment.
- `REJECTED`, `refusedText`, `answerText` and the reference agree on who refuses and that the child
  carries on.
- "Still reaches you at once": `spawnText`, the `group` schema and `courier_spawn`'s description
  agree; a stop notice also arrives at once and is not listed, which leads to no wrong action.
- The reference's skill section: the numbered list matches the skill after #508; "mostly" is
  accurate (line 37 repeats `spawnText`); "the tool descriptions carry ... check-ins" holds.
- `idleStoppedNotice` offers `courier_send` to resume a session an ancestor stopped, while
  `stoppedNotice` says carry on without it; both match the `courier_stop` description ("can be
  woken again"), a choice for the parent, not a contradiction.
