# EGM round 2: courier-orchestrate on main

**Target:** `SKILL_DESCRIPTION` and `SKILL_CONTENT` in `src/skill.ts` at `origin/main` 476df67 (after #507, #508, #509), rendered as `courier-orchestrate.SKILL.md` in this folder (37 lines, 697 words with front matter). Read together with `childBrief`, `rolePart` and the notices in `src/tree/text.ts`, `src/kernel/protocol.ts`, the tool descriptions (`src/*/tools.ts`) and `src/person/text.ts`, `src/scheduling/text.ts`, `src/memory/text.ts`.

**Baseline:** round 1, `egm-review-3/` on `origin/claude/egm-check-3` (closed draft PR #498), findings F1-F7 filed as #500-#506.

**Date:** 2026-11-07. Nothing was run against a model, real or mock. The sandbox real-model batch at 476df67 had not reported when this was written; its failed checks are not in here.

## How it was run

Three reviewers in parallel, then one synthesis pass in the main context. The `egm:*` agent types were not available in this session, so the reviewers ran as general-purpose agents briefed in the EGM roles.

- **Comprehension (goldfish)**, `comprehension_report.md`: only the rendered skill and `test/__snapshots__/notices.test.ts.snap`, no source. 22 events across the root, a sub-orchestrator, leaves, the limits, `courier_stop` and the relay.
- **Codebase details**, `codebase_details_report.md`: every claim against the code, hardest on #507-#509.
- **Zoom out**, `zoom_out_report.md`: status of each baseline item (part A), then conflicts and the reference's accounting (part B).

The synthesis re-read the code for every finding kept below; line numbers are on 476df67.

## Verdict

The round-1 fixes hold and none introduced a contradiction with the code: F1, F2, F4, F5 and F6 are resolved; F7 is resolved but for a nit (R2-F5); F3 is partly open (R2-F1). What remains is small and sits in the wording #508 and #509 added:

- The limit refusals now name "its turn has ended" as the moment to retry, an event that wakes nobody, and still leave out the reported child whose sessions below it run (R2-F1).
- `courier_stop` does not tell the parent of an idle target that sent `blocked`, though the description's "still owed it a report" reads as covering it (R2-F2).
- The skill's new parenthetical on where a change goes can read as "below the root, only upward" (R2-F3).
- #507's exemption covers every message a session scheduled for itself, not only check-ins (R2-F4); `laterText` keeps the old cancel trigger (R2-F5).

## 1. The baseline's items

| Item | Status on 476df67 |
| --- | --- |
| F1 / #500 (own check-in after a report) | Resolved by #507: `kindOf` treats a courier synthetic with `scheduled` set and `from === sessionID` as the session's own (`src/tree/events.ts:85-90`), exempt in `notePrompt` once reported (`:110`); `deliverDue` sets both (`src/scheduling/later.ts:106-108`). Wider than a check-in: R2-F4. |
| F2 / #501 (`courier_stop` and an idle target) | Resolved by #509, the code variant: `tellParent` (`src/tree/stop.ts:160-166`) with `idleStoppedNotice` (`src/tree/text.ts:371-376`); description `src/tree/tools.ts:205`. The `blocked` edge: R2-F2. |
| F3 / #502 (refusals wait for a report that may not come) | Partly open after #508. The silent child is now said (`src/tree/text.ts:181`, `:188`, `silentNotice` `:466`). "Still finishing its turn" is said as "and its turn has ended", which wakes nobody; the reported child with a live subtree is not said. R2-F1. |
| F4 / #503 (`REJECTED`) | Resolved by #508 (`src/person/text.ts:42`); used only at `src/person/permission.ts:162` and `src/person/tui.tsx:265`. |
| F5 / #504 (`courier_answer` and questions) | Resolved by #508 (`src/person/tools.ts:67-69`), in line with `questionNotice` and `passedNote`. |
| F6 / #505 ("still reaches you at once") | Resolved by #508 in both places (`src/tree/text.ts:267-271`, `src/tree/tools.ts:55-56`); every item listed bypasses the hold in code (`send.ts` blocked, `events.ts:57` failure, `events.ts:166` silent end, `person/events.ts:19` asks at the top). |
| F7 / #506 (check-in rule, "only", line 42) | Resolved by #508: the skill's check-in clause is cut, `courier_spawn`/`courier_later` share the trigger, the reference says "mostly" (`docs/reference.md:246`). Left: `laterText` (R2-F5) and the new parenthetical (R2-F3). |
| Baseline section 3 (C-2, K-3 first half, C-3, C-4, C-7/K-8, C-8, C-9..C-14, K-6, Z-6, Z-9, Z-5) | Still hold as judged; the code they rest on is unchanged. Z-5 was declined by the owner. |

## 2. Findings, each confirmed against the code

Severity: **major**, a model is likely to act wrongly or stall; **minor**, a gap or claim that misleads with lower stakes; **nit**, wording.

### R2-F1 (minor): the limit refusals name a retry moment that wakes nobody, and miss the reported child with live sessions below it

Raw: Z-1, K-2, C-2, C-9 (and the F3 residue).

- `childrenRefusal`: "end your turn and start it once one of them has reported and its turn has ended"; `totalRefusal` (`mine > 0`): "try again once one of the sessions you started has reported and its turn has ended" (`src/tree/text.ts:178-189`).
- A report reaches the parent at once (`courier_send` steers, `src/tree/send.ts:43`), while the reporter's turn is still on. After a report `ended` is false (`src/tree/report.ts:33`), so `live` counts the reporter as running until that turn ends (`src/tree/limits.ts:19`). The end of the turn sends the parent nothing. The skill's rolling mode, "start the next as each report frees a slot" (`src/skill.ts:26-27`), invites the spawn in the very turn the report starts. Refused, the parent ends its turn as told; if the reporter was its last running session, nothing wakes it. A sub-orchestrator is rescued by its report reminder; the root waits for the person. Example: the root's one child A, a sub-orchestrator whose sessions fill `maxTotal`, reports; the root spawns the next part at once and gets `totalRefusal(…, mine 1)`.
- `check` counts every ancestor of a live session (`src/tree/limits.ts:45-48`), so a child that reported while a session under it runs or ended silently keeps counting. Neither refusal says so, and the count's own wording, "is running or has not reported yet" (`src/tree/text.ts:176`), excludes it (and literally includes a failed one, which does not count). `courier_cleanup` of that child does free the slot (its entry goes, cutting its subtree from `tree`, `limits.ts:42-43`).

**Placement:** preferably code: in `live`, stop counting a child as running once it has sent a non-blocked report since its prompt; then the refusals say "once one of them has reported". Either way, add to both refusals: "a session that reported still counts while sessions it started are live, and one that ended without a report counts until you drop it with courier_cleanup", and change `live()`'s text to "is running or still owes you a report". Unit tests in `test/limits.test.ts`; e2e: spawn at the limit in the turn a report starts.

### R2-F2 (minor): `courier_stop` does not tell the parent of an idle target that sent `blocked`

Raw: K-1.

- Description: the session between "is [told], when the target was running or still owed it a report" (`src/tree/tools.ts:205`).
- A `blocked` report is recorded as `settled` by report (`src/tree/send.ts:64-72`), so `reportOf` gives `owes: false` (`src/tree/report.ts:27-31`; only `reportedSincePrompt` excludes `blocked`, `:15`), and `tellParent` tells no one for an idle target that does not owe (`src/tree/stop.ts:164-165`). The brief treats a blocked child as still owing its one report ("send status blocked …, then end your turn and wait for its answer", `src/tree/text.ts:16-17`).
- Root R, sub-orchestrator P, child C: C sends `blocked` to P, P passes the ask up, R decides to drop that part and stops C. P is not told, later sends C its decision with `courier_send`, and C carries on with the stopped part.

**Placement:** in `tellParent`, also tell the parent when the target is idle and its last status is `blocked` (with `stoppedNotice` or a variant); or reword the description to "when the target was running or had not sent its final report". Unit test in `test/stop.test.ts`.

### R2-F3 (minor): the skill's parenthetical on where a change goes reads as "below the root, only upward"

Raw: K-5, Z-3, C-3.

- Skill: "courier_send it at once, only to the sessions it affects (below the root, to the session that started you as your brief says)" (`src/skill.ts:41-42`).
- The brief sends a finding up "at once" from a leaf, and from a sub-orchestrator only a child's finding "when it reaches past your own part" (`src/tree/text.ts:21-24`); for one inside its part, the sub-orchestrator, as a parent, passes it to its own affected children, and only the skill says that to a parent. The reference has it right: "which below the root includes the parent" (`docs/reference.md:265-266`).
- A sub-orchestrator that reads the parenthetical as replacing "the sessions it affects" sends a change between two of its own children up to its parent and never tells the affected child.

**Placement:** `src/skill.ts:41-42`: "only to the sessions it affects, and, below the root, also to the session that started you when it reaches past your part, as your brief says".

### R2-F4 (nit): #507 exempts every message a session scheduled for itself, not only check-ins

Raw: K-4.

- `kindOf` exempts any courier synthetic with `scheduled` set and `from === sessionID` (`src/tree/events.ts:88`); `deliverDue` sets both on every `courier_later` delivery (`src/scheduling/later.ts:106-108`). The reference says "a check-in it scheduled for itself" (`docs/reference.md:390-396`).
- A child schedules "in 10 minutes, re-run the flaky test and report", reports `done`, and ends without a report after the message wakes it: no reminder and no silent notice, against the brief's "if you end your turn without a report, the parent is told so" (`src/tree/text.ts:19-20`).
- Holds: a message the parent scheduled for the child (`from` = parent) makes it owe again; after `blocked` the child's own check-in still does (`report.ts:15`).

**Placement:** either exempt only items scheduled before the report (`createdAt` before `settled.at`), or say "a message it scheduled for itself" in `docs/reference.md:391`. Unit test in `test/watch.test.ts` if the code changes.

### R2-F5 (nit): `laterText` keeps the old cancel trigger

Raw: Z-2, C-10.

- `laterText` (own): "If what it checks on reports first, cancel it then with courier_cancel." (`src/scheduling/text.ts:3-5`). `courier_spawn` and `courier_later` now say "cancel each when its last report arrives" (`src/tree/tools.ts:140-142`, `src/scheduling/tools.ts:27-29`). For a group or ungrouped check-in, "reports first" reads as the first report.

**Placement:** "Once the last report it covers arrives, cancel it with courier_cancel."

## 3. Checked and not carried forward

- **C-1,** `childrenRefusal` with every counted child silent and idle: each silent end already brought a `silentNotice` with the cleanup route, and the refusal itself names it.
- **C-4,** a person's refusal without a reason in the native prompt ends the root's turn: stated where it happens (`permissionNotice`, `src/person/text.ts:77`, `settledNote` `:91`), pre-dates #508 and the person who refused is at the root.
- **C-5,** "once one of them has reported" for a grouped batch: no wrong action; the group delivery wakes the parent.
- **C-6,** `silentNotice`'s cleanup clause order: a replacement refused at the limit gets the refusal, which names cleanup.
- **C-7,** `idleStoppedNotice` and the stopped subtree: it says "together with the sessions under it" (`src/tree/text.ts:373`).
- **C-8, K-7,** `stoppedNotice` offers no resume and can follow a `done` report: the parent's choice; the `courier_stop` description says a stopped session can be woken.
- **K-3,** `courier_cleanup` keeps an isolated worktree with uncommitted work, so the slot stays: the `kept` result tells the model to commit or pass `force` (`src/tree/text.ts:308`), which then drops it.
- **K-6,** "a session between you and the target" is only the target's parent: "a session", singular, and that parent is between; a `failed` or `gone` outcome tells no one, without a wrong action.

## Severity totals

| Reviewer | Major | Minor | Nit |
| --- | --- | --- | --- |
| Comprehension | 4 | 2 | 4 |
| Codebase details | 0 | 4 | 3 |
| Zoom out | 0 | 1 | 2 |
| **Consolidated** | **0** | **3** (R2-F1, R2-F2, R2-F3) | **2** (R2-F4, R2-F5) |

R2-F3 and R2-F5 change model-facing strings and need a sandbox real-model re-run; R2-F1 and R2-F2 (code variants) and R2-F4 (if the code changes) need unit and e2e tests.
