# EGM round 5: courier-orchestrate on main

**Target:** `SKILL_DESCRIPTION` and `SKILL_CONTENT` in `src/skill.ts` at `origin/main` 13c1b70 (after #535), rendered as `courier-orchestrate.SKILL.md` in this folder (unchanged since round 3). Read together with `childBrief`, `rolePart` and the notices and refusals in `src/tree/text.ts`, `src/kernel/protocol.ts`, the tool descriptions (`src/*/tools.ts`) and the other `src/**/text.ts`.

**Baseline:** round 4, `egm-review-6/` on `origin/egm-round-4` (closed draft PR #533), finding R4-F1.

**Date:** 2026-11-08. Nothing was run against a model, real or mock.

## How it was run

Three reviewers in parallel, then one synthesis pass in the main context, which re-read the code for every item kept or dropped below. Line numbers are on 13c1b70.

- **Comprehension (goldfish)**, `egm:egm-comprehension`, `comprehension_report.md`: only the rendered skill and `test/__snapshots__/notices.test.ts.snap`. One minor (G-1), two nits (G-2, G-3).
- **Codebase details**, `egm:egm-codebase-details`, `codebase_details_report.md`: every claim of the new refusal text against the code. One minor (C-1).
- **Zoom out**, `egm:egm-zoom-out`, `zoom_out_report.md`: baseline status, duplicates, the reference's accounting. No findings.

## Verdict

R4-F1 is resolved by #535. Every claim the new refusal clause makes holds in the code: an answered blocked child counts while the answer waits in its inbox and while it runs (`src/tree/limits.ts:22`, `src/tree/report.ts:28,32`), its next done, partial or failed report frees the slot (`report.ts:36`, `limits.ts:19-20`), and `yours` includes blocked children, so the `yours === 0` branch never hides the clause (`limits.ts:51-52`, `:59`, `:61`). The skill's "start the next as each report frees a slot" (`src/skill.ts:27`) is literally false only for `blocked`, and the refusal met at that moment now carries the remedy. One minor finding remains, on a case the new clause routes wrongly: a blocked child the caller has stopped (R5-F1).

## 1. The baseline's items

| Item | Status on 13c1b70 |
| --- | --- |
| R4-F1 (the limit refusals count a blocked child but only offer waiting for a report) | Resolved by #535: "answer any of them that is blocked, end your turn and start it once one of them has reported" (`src/tree/text.ts:184`) and "answer any session you started that is blocked, end your turn and try again once one of them has reported" (`:191`); `docs/reference.md:150-152` matches; `test/limits.test.ts` and the snapshot cover it. In R4-F1's scenario the refused root is told to answer A and B; each answer re-prompts the child (`src/tree/send.ts:42`, `src/tree/events.ts:99-100`, `:126`) and its next report wakes the root. |

## 2. Findings, each confirmed against the code

Severity: **blocking**, the skill cannot be used as is; **major**, a model is likely to act wrongly or stall; **minor**, a gap or claim that misleads with lower stakes; **nit**, wording.

### R5-F1 (minor): a blocked child the caller stopped still counts, and the refusal's only routes for it are to answer it or to wait for its report

Raw: C-1.

- The code: `courier_stop` on an idle child settles nothing; only an interrupted turn is settled (`src/tree/stop.ts:106-109`), and the `stopped` note it writes (`:92`) is not read by `live` (`src/tree/limits.ts:10-24`). An idle child whose last report is `blocked` keeps `blocked` from `reportOf` (`src/tree/report.ts:35`), so it stays in the caller's `mine` (`limits.ts:23`, `:51-52`, `:59`) until `courier_cleanup` removes its roster entry (`src/tree/forget.ts:17-19`). It will send no report: it waits on an answer, and the caller stopped it so as not to give one.
- What the caller reads at that moment:
  - `courier_stop`'s result: no notice for its own child (`src/tree/stop.ts:70`, "you are not told of what you stopped", `src/tree/tools.ts:204`), and the idle line names only "one that owed a report still owes it ... counts toward maxChildren and maxTotal until ... courier_cleanup" (`src/tree/text.ts:330-332`). A blocked child did not owe one.
  - The refusal, on the next spawn: X is counted as "blocked", the routes are "answer any of them that is blocked" or "end your turn and start it once one of them has reported" (`src/tree/text.ts:184`, `:191`), and `stillCounts` names `courier_cleanup` only for "one whose turn ended without a report" (`:180`), which X is not.
  - The skill sends the caller down this path: "if it breaks the split, courier_stop those parts or send them a corrected task" (`src/skill.ts:43-44`).
- Scenario: `maxChildren` 2, ungrouped. Child X sends `blocked`; meanwhile a sibling's finding shows X's part was split wrongly. The caller stops X and starts a corrected part; the spawn is refused. The refusal's answer route wakes the work it just stopped; its wait route waits on a report X will never send. If X and the other counted child are both in that state, nothing ends the wait. "Do this part yourself" is still offered, and section 5's "courier_cleanup each session you are done with" (`src/skill.ts:57`) is in context, so a stall is possible, not certain.
- Why it is carried although round 4 declined "stopText's idle-stopped line names only the owing case": that item was declined because the stop texts leave the limits to the refusals. Since #535 the refusal speaks to blocked children directly, and for a stopped one it names the two routes that do not free the slot and leaves out the one that does. The gap predates #535; #535 makes a model more likely to follow it.

**Placement:** `src/tree/text.ts:179-180`, `stillCounts`: after the silent-session clause, add "and a blocked one counts until it reports again or ${whoDrops} it with courier_cleanup", which both refusals carry. A narrower alternative in the remedy at `:184` and `:191`: "answer any of them that is blocked, or drop with courier_cleanup one you no longer need, ...". `docs/reference.md:150-152` and the liveness list's blocked item (`:163-164`) to match; snapshot update; a unit test in `test/limits.test.ts` with an idle blocked child stopped and still counted, the refusal naming cleanup; an e2e assertion on the refusal text; a sandbox real-model re-run (model-facing string). Leave `IDLE_STOPPED` (`:330-332`) to the declined item.

## 3. Checked and not carried forward

- **G-1, a blocked report read as satisfying "once one of them has reported"** (comprehension): a model woken by a `blocked` report answers it and may spawn again; the spawn is refused once more with the same text, which lists blocked among what counts. One self-correcting refused call, no stall; section 4's blocked handling is the rule in front of it when the report arrives.
- **G-2, a slot freed by a failure or `courier_cleanup` rather than a report:** the refusal's last sentence says a failed or interrupted session does not count; the failure notice offers "start a replacement" (`src/tree/text.ts`, `failureNotice`); worst case lost parallelism.
- **G-3, `totalRefusal`'s "one of them" after "sessions in this session tree":** the preceding "answer any session you started" fixes the referent, and the caller wakes only on its own sessions' reports either way.
- **The skill's "start the next as each report frees a slot" (`src/skill.ts:27`, `docs/reference.md:264`) and `blocked`:** false only for a blocked report; section 4 (`src/skill.ts:50`) applies when one arrives and the refusal carries the remedy if a spawn is tried. A rule another text carries at the moment of use.
- **The reference's "The skill alone adds ... answering a blocked, partial or failed report" (`docs/reference.md:290-292`):** the refusals now say it too, but only at a limit; without a refusal the skill is still the only text. Not a wrong claim.
- **A stalled answer to a blocked child keeping it counted:** a host fault, shown to the person in the tree panel (`src/tree/wake.ts:114-115`).
- **A reservation in `gate.reserved` counted in `mine`** (`src/tree/limits.ts:58-59`): an in-flight spawn of the same caller, which becomes a child that reports.
- **Earlier declined items** (section 3 of `egm-review-4/`, `egm-review-5/`, `egm-review-6/`; `waits` and the silent notice; partial and failed reports in the skill only; `blockedStoppedNotice` and the limits): not re-raised. R5-F1 does not re-raise the stop-text item: its placement is the refusal.

## Severity totals

| Reviewer | Blocking | Major | Minor | Nit |
| --- | --- | --- | --- | --- |
| Comprehension | 0 | 0 | 1 | 2 |
| Codebase details | 0 | 0 | 1 | 0 |
| Zoom out | 0 | 0 | 0 | 0 |
| **Consolidated** | **0** | **0** | **1** (R5-F1) | **0** |

R5-F1 changes a model-facing string and needs a sandbox real-model re-run.
