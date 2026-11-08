# Zoom out report, round 6

Reviewer: `egm:egm-zoom-out`. Read `src/skill.ts`, `src/tree/text.ts`, `src/kernel/protocol.ts`, `src/tree/limits.ts`, `docs/reference.md` (limits, the skill section, stopping), the round-5 report, `test/limits.test.ts`, `test/stop.test.ts`.

## R5-F1: resolved by #538

`stillCounts` (`src/tree/text.ts:179-180`) names a blocked child as counting until it reports or is dropped with `courier_cleanup`; both refusals carry it (`:185`, `:192`, the `yours > 0` branch, which a caller with its own blocked child always gets: `limits.ts:51-52`, `:59`). `docs/reference.md:168-169` adds "even one its parent stopped". `test/limits.test.ts:769-774` covers an idle blocked child with the refusal naming cleanup; `:1200`, `:1203` pin the strings. In R5-F1's scenario the refusal now offers the route that frees the slot.

## The refusals as a whole

No rule stated twice in conflicting ways. The remedy sentence (answer a blocked child, wait for a report) and `stillCounts` (it counts until it reports or is dropped) are two halves of one rule. `blockedStoppedNotice` (`text.ts:384-390`), to a parent whose child an ancestor stopped, says not to send the answer and offers cleanup; the refusal's answer route is one option among several. `IDLE_STOPPED` (`text.ts:330-332`) is the declined stop-text item. The reference's account of the skill (`docs/reference.md:252-292`) still matches `SKILL_CONTENT`.

## Raw items

- **Z-1 (nit, docs only):** `docs/reference.md:279-280` points to the stopping section for "which stopped ones still count", but that section (`:518-521`) names only an idle one that owed its report; the stopped blocked child is stated only in the limits section (`:168-169`). Not model-facing.

No findings at blocking, major or minor.
