# EGM round 6: courier-orchestrate on main

**Target:** `SKILL_DESCRIPTION` and `SKILL_CONTENT` in `src/skill.ts` at `origin/main` 8a3f054 (after #538), rendered as `courier-orchestrate.SKILL.md` in this folder (unchanged since round 3; #538 changed only `src/tree/text.ts:180`). Read together with `childBrief`, `rolePart` and the notices and refusals in `src/tree/text.ts`, `src/kernel/protocol.ts`, the tool descriptions (`src/*/tools.ts`) and the other `src/**/text.ts`.

**Baseline:** round 5, `egm-review-7/` on `origin/egm-round-5` (closed draft PR #536), finding R5-F1.

**Date:** 2026-11-08. Nothing was run against a model, real or mock.

## How it was run

Three reviewers in parallel, then one synthesis pass in the main context, which re-read the code for every item kept or dropped below. Line numbers are on 8a3f054.

- **Comprehension (goldfish)**, `egm:egm-comprehension`, `comprehension_report.md`: only the rendered skill and `test/__snapshots__/notices.test.ts.snap`. No findings.
- **Codebase details**, `egm:egm-codebase-details`, `codebase_details_report.md`: every claim of the changed `stillCounts` against the code, then the skill and the tree tool descriptions. Three raw items (C-1 to C-3).
- **Zoom out**, `egm:egm-zoom-out`, `zoom_out_report.md`: baseline status, the two refusals as a whole, the reference's account of the skill. One docs-only nit (Z-1).

## Verdict

R5-F1 is resolved by #538. Every claim of the new `stillCounts` sentence holds in the code: a blocked child counts while idle, stopped by its parent or by an ancestor, answered and running, and with the answer in its inbox; it stops counting on its next done, partial or failed report, on a failure or interruption, or when `courier_cleanup` drops its entry. Read as a whole, the two refusals state one rule: the remedy sentence says what to do with a blocked child (answer it, then wait for a report) and `stillCounts` says how long it counts and the other way out (`courier_cleanup`). No text a model reads states it otherwise. No raw item clears the bar.

**No findings.**

## 1. The baseline's items

| Item | Status on 8a3f054 |
| --- | --- |
| R5-F1 (a blocked child the caller stopped still counts, and the refusals offered only answering it or waiting for its report) | Resolved by #538. `stillCounts` (`src/tree/text.ts:179-180`), carried by `childrenRefusal` (`:185`) and by `totalRefusal`'s `yours > 0` branch (`:192`), says "one that is blocked ... counts until it reports or you drop it with courier_cleanup". A caller whose own child is blocked always gets that branch, since a blocked child is in `mine` (`src/tree/limits.ts:22`, `:51-52`, `:59`). The code agrees: an idle stop writes no settled note (`src/tree/stop.ts:106-109`), so `reportOf` keeps `blocked` (`src/tree/report.ts:35`) until a new report or until `forgetChild` removes the roster entry (`src/tree/forget.ts:17-19`). `docs/reference.md:168-169` matches; `test/limits.test.ts:769-774` and the snapshot cover it. In R5-F1's scenario the refusal now names the route that frees the slot. |

## 2. Findings, each confirmed against the code

Severity: **blocking**, the skill cannot be used as is; **major**, a model is likely to act wrongly or stall; **minor**, a gap or claim that misleads with lower stakes; **nit**, wording.

No findings.

## 3. Checked and not carried forward

- **C-1, a `kept` cleanup drops nothing** (codebase details, raised as major): true in the code. `src/tree/cleanup.ts:32-40` returns `kept` before `forget()`, so the roster entry stays, the session still counts and a member that has not reported still holds its group, while the tool description says "Either way, one in a join group that has not reported is dropped from it" (`src/tree/tools.ts:221-222`). It is round 2's K-3 (`egm-review-4/`, section 3, on `origin/claude/egm-round-2`), declined there, so not re-raised. #538 adds a second route into it (the refusal's "drop it with courier_cleanup"), but the result in front of the model at that moment, "Kept the worktree ... Commit or branch what you want to keep, or call courier_cleanup again with force: true" (`src/tree/text.ts:311-312`), says nothing was removed and how to finish. For the owner's judgment only: K-3's rationale says committing "then drops it"; in the code only a second `courier_cleanup` call does, and neither the result nor the "Either way" sentence says so.
- **C-2, `docs/reference.md:172` "A child counts from the moment `courier_send` to it returns"** (codebase details, raised as minor): misread. The sentence is about a message sent to an existing child: `courier_send` queues it in the child's inbox, `waitsInInbox` makes it live (`src/tree/limits.ts:22`), so a spawn in the same step counts it. A spawn's own reservation is the next sentence's subject. Not model-facing either way.
- **C-3, a session stops counting when an ancestor's entry is dropped or the session is deleted** (codebase details, nit): true (`src/tree/limits.ts:14`, `:18`, `:44-45`; `src/tree/domain.ts:137-141`), but every such case frees room the refusal does not name; no model acts on a false limit.
- **Z-1, `docs/reference.md:279-280` points to the stopping section for which stopped sessions still count, and that section (`:518-521`) names only an idle one that owed its report** (zoom out, nit): docs only, not model-facing; it mirrors `IDLE_STOPPED` (`src/tree/text.ts:330-332`), round 4's declined stop-text item. The limits section (`:168-169`) has the blocked case.
- **"A session also counts while one it started is live" read with "live" covering blocked** (comprehension and zoom out): the refusal names running, blocked and owing separately and the code adds ancestors only for "live" (`src/tree/limits.ts:49-53`, `docs/reference.md:163-164`). The worst reading overcounts and leads to the same remedy. Predates #538.
- **"counts until it reports" for a child whose last report is the `blocked` one** (comprehension and zoom out): read as "reports again" it is right (`src/tree/report.ts:35`, `src/tree/limits.ts:23`); reading the blocked report as the freeing one is round 5's self-correcting G-1.
- **`whoDrops` "its parent drops" in `totalRefusal` for sessions the caller did not start:** shown only when `yours > 0` (`src/tree/text.ts:189-193`); the only action it asks concerns the caller's own children; for the others it is a true statement that asks nothing.
- **The brief and role lines' "running at once" against the refusals' wider count, a turn ended by a dismissed question read as interrupted, "still owe a report" read as covering failed sessions** (comprehension): the refusal states the full rule at the moment of use and the remedy is the same under every reading.
- **Earlier declined items** (section 3 of `egm-review-4/` through `egm-review-7/`; `waits` and the silent notice; partial and failed reports in the skill only; `blockedStoppedNotice` and the limits): not re-raised.

## Severity totals

| Reviewer | Blocking | Major | Minor | Nit |
| --- | --- | --- | --- | --- |
| Comprehension | 0 | 0 | 0 | 0 |
| Codebase details | 0 | 1 | 1 | 1 |
| Zoom out | 0 | 0 | 0 | 1 |
| **Consolidated** | **0** | **0** | **0** | **0** |

No model-facing string changes are proposed, so no real-model re-run is needed.
