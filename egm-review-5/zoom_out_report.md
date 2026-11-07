# EGM round 3, zoom-out review: courier-orchestrate at origin/main 2dacfe4

Reviewer: `egm:egm-zoom-out`. Read: `src/skill.ts` (and the rendered `courier-orchestrate.SKILL.md`), `src/tree/text.ts`, `src/tree/{limits,report,events,stop,send,group}.ts`, `src/tree/tools.ts`, `src/scheduling/text.ts`, `docs/reference.md`, the round-2 reports and the diff since 476df67. Nothing was run.

## A. Status of the round-2 findings

| Item | Status | Evidence |
| --- | --- | --- |
| R2-F1 | Resolved (#518), in code | `inTurn` (`src/tree/limits.ts:19-20`), `reportedAt` (`src/tree/report.ts:35`); refusals "once one of them has reported" (`src/tree/text.ts:184`, `:191`); `stillCounts` (`:179-180`); "still owes a report" (`:177`). Rare residue: Z-1. |
| R2-F2 | Resolved (#517) | `tellParent` and `blockedStoppedNotice` (`src/tree/stop.ts:166-168`, `src/tree/text.ts:382-387`); description `src/tree/tools.ts:205`; reference `docs/reference.md:521-525`. Group gap: Z-2. |
| R2-F3 | Resolved (#516) | `src/skill.ts:41-44`, matching reference `:269-272`. Scope drift: Z-3. |
| R2-F4 | Resolved (#517), in code | `scheduledAt` (`src/scheduling/later.ts:108`); `ownAfterReport` (`src/tree/events.ts:94-98`, `src/tree/report.ts:16`); reference `:395-401`. |
| R2-F5 | Resolved (#516) | `src/scheduling/text.ts:4-5`. |

## B. Findings

### Z-1 (minor): "try again once one has reported" can leave the caller with nothing to wake it

- `stillCounts`: "A session that reported still counts while sessions it started are live" (`src/tree/text.ts:180`); the refusals say to retry "once one of the sessions you started has reported" (`:184`, `:191`).
- Such a child's slot frees when its subtree settles. An ungrouped grandchild's report prompts it again and it reports again (`notePrompt`, `src/tree/events.ts:118-121`). A group release does not, since the child already reported since its prompt and the release is exempt (`events.ts:89`, `:95`; reference `:395-399`): the caller is never woken.
- Needs a child that reported before its own group was released, against the brief (`text.ts:66-67`). Rare.
- Placement: add "and it does not tell you when they finish: check with courier_children before you try again", or stop exempting the release when the report came before the group was complete. Unit test in `test/limits.test.ts`.

### Z-2 (minor): `blockedStoppedNotice` does not say the session holds back its join group

- A `blocked` member's held report is removed and the group waits for it (`unholdForBlocked`, `src/tree/group.ts:92-98`; reference `:343`). Stopping does not change that.
- `idleStoppedNotice` says "holds back its join group if it is in one" (`text.ts:378`); `blockedStoppedNotice` does not (`:385-386`), nor the reference (`:523-525`). A parent that obeys "Do not send it that answer" and does not clean up leaves the group's other reports held.
- Placement: add "it holds back its join group if it is in one, until you drop it with courier_cleanup"; in `docs/reference.md:523-525` move the group clause into the part covering both cases. Snapshot and `test/stop.test.ts`.

### Z-3 (nit): the skill sends the person's words up only when they change other parts; the brief says always

- Skill: "When a message changes what other parts need (...), courier_send it ... also to the session that started you when it reaches past your part or carries the person's words, as your brief says" (`src/skill.ts:40-43`). Brief: unconditional (`src/tree/text.ts:25-27`); reference "always" (`docs/reference.md:197`).
- Placement: drop "or carries the person's words", or "and the person's words always, as your brief says"; match reference item 3 (`:270-271`).

### Z-4 (nit): the reference lists the person's word under both "the brief carries" and "the skill alone adds"

- `docs/reference.md:282-284` vs `:288-290`. With #521 only two things are the skill's alone: passing a message down or sideways, and the root's rule on the person's word.
- Placement: `:289`, "passing findings and the person's word on to the sessions they affect, and, at the root, not judging or undoing the person's word".

## Checked, no finding

- The skill's person's-word sentence and the brief's new clause (`skill.ts:45-46`, `text.ts:28`) say the same thing; the skill's copy is the root's only source.
- Section 2's rolling mode agrees with the new refusals (`skill.ts:27`, `limits.ts:19`).
- `stillCounts`' "you drop" / "its parent drops" are right for the two refusals; `yours === 0`'s "none ... counts" matches `mine` (`limits.ts:52`).
- The `courier_stop` clause (`tools.ts:205`) matches `tellParent`.
- `blockedStoppedNotice` and the skill's section 4 do not conflict: the notice is specific and arrives when it applies.
- The reference's liveness and refusal text (`reference.md:148-171`) matches `live()`, `check()` and the strings.
- No retry text still says "its turn has ended".
