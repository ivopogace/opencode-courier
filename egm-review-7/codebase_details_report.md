# Codebase-details report, round 5

**Reviewer:** `egm:egm-codebase-details`. **Read:** `CLAUDE.md`, the round-4 report, `src/skill.ts`, `src/tree/text.ts`, `src/kernel/protocol.ts`, `src/tree/tools.ts`, and `src/tree/{limits,report,events,send,wake,stop,forget}.ts`; `docs/reference.md:145-174`, `:255-292`. Not opened: `src/person/text.ts`, `src/scheduling/text.ts`, `src/memory/text.ts` (untouched by #535, not on the limits path). Line numbers on 13c1b70. Nothing was run.

## 1. R4-F1

Resolved by #535. `childrenRefusal` (`src/tree/text.ts:184`) and `totalRefusal` with `yours > 0` (`:191`) carry the answer route at the moment of use; `docs/reference.md:150-152` matches; `test/limits.test.ts` and the snapshot cover the text.

## 2. The new refusal text against the code

- The parent's answer: a `courier_send` to its own child drops any status (`src/tree/send.ts:52-57`) and goes out as `{source, from}` (`:42`), so `kindOf` gives `from:<parent>` (`src/tree/events.ts:93-94`). `ownAfterReport` exempts only a message from the receiver's own child (`:99-100`), so `notePrompt` records a prompt (`:126`).
- Counted while the answer waits: `noteSent` records the wake before the tool returns (`src/tree/send.ts:46`, `src/tree/wake.ts:43-54`); `waitsInInbox(..., {stalled:false})` makes the child live (`src/tree/limits.ts:22`). Between delivery and the prompt note, `reportOf` still says `blocked` (`src/tree/report.ts:35`, `limits.ts:23`). No gap.
- Counted while it runs or owes: `owes` after the prompt (`report.ts:28,32`).
- A done, partial or failed report frees the slot: `reportedAt` (`report.ts:36`), `inTurn` (`limits.ts:19-20`). A second `blocked` keeps it counted and wakes the caller with the same remedy.
- A failed or interrupted turn frees it (`ended`, `report.ts:34`, `limits.ts:20`).
- `yours` includes blocked children (`limits.ts:47-56`, `:59`, passed at `:61`), so the `yours === 0` branch (`text.ts:189-190`) never fires while one of the caller's is blocked.
- Counted sessions that never report: one that reported while its own child is live (declined earlier); a silent or idle-stopped owing child (`stillCounts` names `courier_cleanup`, `text.ts:180`); a reservation (an in-flight spawn, `limits.ts:58-59`); a stalled answer (host fault, shown in the panel). The one left is C-1.

## 3. "start the next as each report frees a slot" (`src/skill.ts:27`)

False only for `blocked` (`report.ts:35-36`, `limits.ts:23`); the refusal met at that moment and section 4 (`skill.ts:50`) carry the remedy. Nothing to raise.

## 4. Findings

### C-1 (minor): a blocked child the caller stopped still counts, but the refusal's only routes for it are to answer it or wait

- `courier_stop` on an idle child settles nothing; only an interrupted turn is settled (`src/tree/stop.ts:106-109`). The `stopped` note (`:92`) is not read by `live`. The child's last report stays `blocked` (`report.ts:35`), so it stays in `mine` (`limits.ts:23`, `:51-52`, `:59`) until `courier_cleanup` removes its roster entry (`src/tree/forget.ts:17-19`).
- Texts at that moment: the caller gets no notice for its own child (`src/tree/tools.ts:203-204`, `src/tree/stop.ts:70`); the stop result's idle line names only "one that owed a report" (`text.ts:330-332`); the refusal lists the child as blocked and says to answer it (`:184`, `:191`); `stillCounts` names `courier_cleanup` only for "one whose turn ended without a report" (`:180`), which a blocked child is not. The skill tells the caller to `courier_stop` parts when a message breaks the split (`skill.ts:43-44`).
- Scenario: `maxChildren` 2; X is blocked; a finding shows X's part was split wrongly; the caller stops X and starts a corrected part; refused. Answering X wakes the work just stopped; waiting waits on a report X will not send. "Do this part yourself" and section 5's cleanup line (`skill.ts:57`) keep it from being a sure stall.
- The gap predates #535; #535 makes it sharper by pointing the model at blocked children.
- Fix: in `stillCounts`, "and a blocked one counts until it reports again or ${whoDrops} it with courier_cleanup"; or in the remedy, "answer any of them that is blocked, or drop with courier_cleanup one you no longer need". Reference, snapshot, unit test, sandbox real-model re-run.

## 5. Other claims checked

`docs/reference.md:159-166` (liveness) matches `live()`/`check()`; `:172` ("counts from the moment courier_send to it returns") matches `send.ts:46`; `spawnText`'s group paragraph (`text.ts:272-276`) matches `send.ts:22`, `:47`.

## Totals

Blocking 0, major 0, minor 1 (C-1), nit 0.
