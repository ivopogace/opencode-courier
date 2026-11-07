# EGM round 2: codebase details report

Base: origin/main 476df67. Focus: what changed since 2cb1aa9 (#507, #508, #509). Every finding below
was checked against the code; none needs a model run.

## Findings

### K-1 (minor): a stopped idle child that sent `blocked` is "still owing" to the model but not to the code, so its parent is not told

- Text: `src/tree/tools.ts:205` (courier_stop): "a session between you and the target is, when the
  target was running or still owed it a report." Also `docs/reference.md` §stop: "was `idle` and
  still owed a report".
- Code: `src/tree/send.ts:68-72` writes `settled` with `by: "report"` for every status, `blocked`
  included. `src/tree/report.ts:27-31` gives `owes = !done`, so a child that sent `blocked` has
  `owes: false`. `src/tree/stop.ts:164-165` tells the parent only when `report?.owes`.
- Scenario: R → P → C. C sends `blocked` to P and goes idle to wait for the answer. P passes the ask
  up to R, and R decides to `courier_stop` C. P is not told. P still sees C waiting on its answer
  and later sends the decision with `courier_send`, which wakes C, so the stop is undone without R
  knowing. The briefs and the skill treat `blocked` as "not the final report" (childBrief:17-18),
  so a model reads the description as covering this case.
- Fix: in `stop.ts` `tellParent`, also tell the parent when `lastStatus(...) === "blocked"`, using the
  plain `stoppedNotice` (a blocked child does not count toward the limits, per `limits.ts:220`).
  Or reword the description to "had not reported".

### K-2 (minor): the refusals say a reported child stops counting once its turn ends, but a reported child with a live session under it still counts

- Text: `src/tree/text.ts:180` "start it once one of them has reported and its turn has ended", and
  `:187` (maxTotal) says the same. The silent notice, `:466`, says "Until it reports, it counts".
- Code: `src/tree/limits.ts:244-247` puts into `active` every live entry and also all of its
  ancestors (`chains.get(...).map(above => above.parentID)`). So a child that reported counts for
  as long as any descendant is live: running, owing a report after a silent end, or holding a
  waiting inbox item.
- Scenario: P (maxChildren 2) has two sub-orchestrators. Both report `partial` while one
  grandchild under each has ended silently and still owes. P ends its turn, waits for a report,
  and is refused again in its next turn: neither child will ever "report" again. The text gives
  the cleanup way out only for "a session that ended without a report". P's own children did
  report, so P does not see that the way out applies to them. `courier_cleanup` of the child does
  free it: `forget.ts:29` removes the child's entry, which cuts the grandchildren off from `top` at
  `limits.ts:242`.
- Fix: in `childrenRefusal`/`totalRefusal`, add "...or while a session under it is still running or
  owes a report", in the same clause as the cleanup way out.

### K-3 (minor): "drop it with courier_cleanup" does not drop an isolated child that left work in its worktree

- Text: `src/tree/text.ts:181`, `:188` (refusals), `:466` (silentNotice), `:375` (idleStoppedNotice)
  and `:327-328` (IDLE_STOPPED) all say the child counts "until you drop it with courier_cleanup".
- Code: `src/tree/cleanup.ts:72-81`. If the worktree has uncommitted changes or commits on no
  branch, cleanup returns `kept` and never calls `forget()`. The entry stays, and the child still
  `owes`, so it keeps counting (`limits.ts:220`).
- Scenario: a child that ends silently in the middle of its work typically has uncommitted edits in
  its worktree. The parent follows the refusal and calls `courier_cleanup` to free the slot, gets
  `kept`, and the slot stays taken. The `kept` text (`text.ts:308`) offers to commit or use `force`,
  but it does not say the session still counts. A model may think the slot was freed and retry.
- Fix: put one clause in `cleanupText`'s `kept` branch: "It is still on your courier_children list
  and counts toward your limits until it is dropped."

### K-4 (minor): #507 exempts every message a session scheduled for itself, not only check-ins

- Text: `src/tree/text.ts:19-20` (childBrief): "if you end your turn without a report, the parent
  is told so." `docs/reference.md:390-394` speaks of "a check-in it scheduled for itself".
- Code: `src/tree/events.ts:88`: `ownCheckIn = typeof metadata.scheduled === "string" && metadata.from === sessionID`.
  That holds for any `courier_later` message the session scheduled for itself
  (`src/scheduling/later.ts:108` sets `from: due.from, scheduled: due.id`). After a non-blocked
  report, `events.ts:110` skips `prompted`, so the woken turn gets no reminder
  (`owedUnwaited` false), no silent notice, and no longer counts once it ends.
- Scenario: a child schedules "in 10 minutes, re-run the flaky integration test and report the
  result", then reports `done` early. The message wakes it, it re-runs the test, finds a failure
  and ends without reporting. The parent is never told. What childBrief says about ending without
  a report does not hold here.
- Fix: in code, treat it as OWN only when the item was scheduled before the report (`createdAt` <
  `settled.at`). Or accept the behaviour and say it in `laterText`'s own branch ("a message you
  scheduled for yourself, arriving after your report, does not make you owe another"), and in
  reference.md say "a message", not "a check-in".
- Verified as holding: a check-in the parent scheduled for the child has `from` = parent, so it is
  not OWN and makes the child owe again, as reference.md says. After a `blocked` report, the
  child's own check-in still makes it owe (`report.ts:15` excludes blocked).

### K-5 (nit): the skill's new parenthetical sends every change to the parent, but the brief sends only what reaches past the session's own part

- Text: `src/skill.ts:40-42`: "courier_send it at once, only to the sessions it affects (below the
  root, to the session that started you as your brief says)".
- Brief: `src/tree/text.ts:21-24` sends the change to the parent and lets the parent pass it on.
  For a change from a session the sub-orchestrator started, the brief says to send it up only
  "when it reaches past your own part".
- Scenario: a sub-orchestrator learns from one of its children that a shared helper inside its own
  part behaves differently. The skill reads as "send it to the session that started you", where the
  brief means "send it to your affected children". reference.md:265-266 has it right ("includes
  the parent").
- Fix: "(below the root, also to the session that started you when it reaches past your part, as
  your brief says)".

### K-6 (nit): courier_stop names "a session between you and the target", but only the target's direct parent is told, and only for two outcomes

- Text: `src/tree/tools.ts:205`.
- Code: `src/tree/stop.ts:70` and `:173` tell only `target.parentID`. `stop.ts:163` tells nobody
  when the outcome is `failed` (the interrupt call threw, so the target may still be running) or
  `gone`.
- Scenario: caller R, then A, then B, then target T. Only B is told; A, which is also "between", is
  not.
- Fix: "the session that started the target is told, when ...".

### K-7 (nit): stoppedNotice says "start a replacement" to the parent of a target that had already reported

- Text: `src/tree/text.ts:368`: "It was not a failure and it will not report back. Carry on without
  it, or start a replacement if you still need what it was doing."
- Code: `stop.ts:162` sends this whenever the target's outcome is `interrupted`, including a target
  that reported `done` and was still finishing its turn. The courier_stop description matches
  ("running"), but the notice can lead the parent to replace a part that is done.
- Fix: in `tellParent`, use the `reportedSincePrompt` state to drop the replacement clause.
  Optional.

## Checked and holds

- #507: `deliverDue` sets `metadata.source = "courier"`, `from` (the scheduler) and `scheduled` (the
  id) (`later.ts:108`). `kindOf` reads exactly these. A group release sets `metadata.group`
  (`group.ts:149`).
- #507: a check-in the parent scheduled for the child makes the child owe again; a blocked report
  does not stop the child's own check-in from making it owe.
- #509: `owes` is read after the stop, but for an `idle` outcome nothing has changed it.
  `interrupt` writes `settled` only when `interrupted` (`stop.ts:108`), `silence` writes only the
  `stopped` note (`stop.ts:92`), and `reportOf` ignores `stopped`.
- #509: idleStoppedNotice "still counts toward maxChildren and maxTotal": `live()` is true on
  `owes` (`limits.ts:220`) and has no check for stopped.
- #509: idleStoppedNotice "holds back its join group": a member leaves only through
  failed/interrupted/deleted/dropped (`events.ts:44,127`, `forget.ts:28,36`). An idle stop fires no
  interrupted event, so the member stays `out`.
- #509: idleStoppedNotice "message it with courier_send to have it carry on": `send.ts` has no
  check for stopped. The parent's message is a plain synthetic item, so `notePrompt` re-prompts it
  and it owes again.
- #509: the target is always a store entry (`stop.ts:42-43`), never an OpenCode subagent. The told
  parent is never the caller (`stop.ts:70`), and so never the top.
- #509: a running target that had already reported is told (as "running"); an idle target that did
  not owe (it reported, failed or was interrupted) is not told. Both match the description.
- #508: a silent end writes no `settled` (only report/failed/interrupted do: `send.ts:72`,
  `events.ts:40,125`, `stop.ts:108`, `spawn.ts:148`), so it owes and counts until cleanup. Cleanup
  removes the entry (`forget.ts:29`), and its subtree leaves the tree count with it
  (`limits.ts:242`), apart from K-3.
- #508: a reported child counts while its turn runs (`limits.ts:218`, `ended` is false for a report),
  so "and its turn has ended" is correct, apart from K-2.
- #508: `REJECTED` is used only in `person/permission.ts:162` (the top's courier_answer reject without
  a message) and `person/tui.tsx:265` (the person in the asks inbox). "The person or the top session
  of the tree" covers both.
- #508: courier_answer's question wording matches `questionNotice` (`person/text.ts:186-188`),
  `passedNote` and `unlinkedNote`. A linked question tool call passes the answer on by itself
  (`relay.ts:236-244`).
- #508: each item that spawnText and the `group` description say bypasses the hold does so. A
  blocked report is not held and is steered (`send.ts:22,43,47`). A failure notice
  (`events.ts:57-63`) and a silent notice (`events.ts:166-171`) go straight to the parent. A
  question or permission notice goes straight to the top (`person/events.ts:19-28`, `relay.ts:50`).
- courier_later "up to ~15 seconds late": `TICK_MS = 15_000` (`platform/hub.ts:63`).
- courier_cancel "Nothing else cancels it but courier_stop of the session it is for": the only other
  caller of `cancelScheduled` is stop (`index.ts:152`, `stop.ts:94`).
- The check-in wording in courier_spawn, courier_later and laterText is consistent: one per group,
  one for the ungrouped sessions, cancelled at the last report.
