# EGM re-check 3, zoom out: courier-orchestrate and its texts at origin/main 6673992

Skill lines are lines of `src/skill.ts` (rendered as `egm-review-3/courier-orchestrate.SKILL.md`).
Baseline: `origin/claude/egm-recheck-skill:egm-review-2/` (F1-F6, raw C-/K-/Z- findings). Every
status below was checked against the current files, not the PR bodies. Nothing was run.

## Part A: status of the egm-review-2 items

Totals: **F1-F6 and every F6 sub-bullet resolved; M6, M17, N5 resolved; of the 13 "checked and not
carried forward" items, all still hold as judged (C-2 is now stronger after #493). Two raw residues
are still open: C-4's refusal text and C-5 (never carried forward or dismissed).**

| id | finding | status | evidence on current main |
| --- | --- | --- | --- |
| F1 | sub-orchestrator promised its children's asks | resolved (#484) | spawnText `belowTop` variant `src/tree/text.ts:262-268` (set at `src/tree/spawn.ts:80`); `courier_spawn` `src/tree/tools.ts:136`, `group` `:55-56` "(at the top of the tree; below it they go to the top)"; brief `src/tree/text.ts:28` "through the top session of the tree"; `courier_answer` `src/person/tools.ts:61-62` "Only the top session of a tree gets those notices and can answer". Residue: Z-8 |
| F2 | nothing passes a finding / the person's word up | resolved (#489) | brief `src/tree/text.ts:23-24` "Do the same with one a session you started sends you, when it reaches past your own part" and `:26-27` "The person's words a session you started passes you … send them on to the parent". Wording: Z-9 |
| F3 | maxTotal refusal with none of one's own running | resolved (#485) | `totalRefusal(…, yours)` `src/tree/text.ts:182-186`; `mine` passed at `src/tree/limits.ts:53` |
| F4 | check-in "cancelled" reads automatic; scope mismatch | resolved (#488) | skill:37-38 "courier_cancel it when its reports arrive"; `courier_spawn` `src/tree/tools.ts:140-142`; `courier_later` `src/scheduling/tools.ts:27-29`; `courier_cancel` `:46-47`. New duplication: Z-1, Z-2 |
| F5 | no guidance for partial / failed report | resolved (#490) | skill:50-51; reference `docs/reference.md:269-270`. Reach without the skill: Z-5 |
| F6 a | "it sees the same list" (M6) | resolved (#490) | skill:31 "(an isolated part sees only committed project skills)" |
| F6 b | "that one's branch", "Merge each reported branch" (C-12) | resolved (#490) | skill:32 "its branch, if isolated"; skill:55 "each isolated part's reported branch" |
| F6 c | cleanup read as isolated-only | resolved (#490) | skill:56 "each session you are done with, isolated or not" |
| F6 d | "is a playbook's" (M17) | resolved (#490) | skill:12-13 "… are not in this skill: if a skill for them is listed to you, load it too" |
| F6 e | root / top for one session (N5) | resolved (#490) | skill:17 defines "At the root, the top session of the tree"; skill:39, :60 "At the root" |
| F6 f | silentNotice no-reply clause (C-10) | resolved (#490) | `src/tree/text.ts:453-455`, no-reply variant drops "or to report if its last reply…" |
| F6 g | reference overstates the role lines; incomplete "skill alone" list (Z-7) | resolved (#490), new nits | `docs/reference.md:277-284`; accurate on the role lines and the brief. Remaining imprecision: Z-3, Z-4 |
| M6, M17, N5 | old open items | resolved (#490) | as F6 a, d, e |
| C-4 (part) | `REJECTED` "Refused by the session that started you" at depth ≥ 2 | still open | `src/person/text.ts:42`; see Z-8 |
| C-5 | verify an isolated part before merging: where | still open (nit; never carried or dismissed) | skill:49 "Open the files and run the project's checks yourself" precedes the merge at :55; mitigated by "run the checks once more" (:56) |
| C-2 | report reminder on a waiting sub-orchestrator | holds (not an issue) | `src/tree/nudge.ts:17-23`; #493 also suppresses it after a group delivery to a child that reported |
| K-8 / Z-8 | root with the skill denied loses the split rule | holds, by design | `rolePart(0)` `src/tree/text.ts:85-90` unchanged; CLAUDE.md rule |
| C-6 | "never hand that checking" vs review part | holds | `src/tree/text.ts:59-66` unchanged |
| C-8 | stopped grandchild, no reason given | holds | `stoppedNotice` `src/tree/text.ts:362-366`, `stopText` `:346` unchanged |
| C-9 | brief "one group" vs skill waves | holds | `src/tree/text.ts:63` vs skill:26-27; reconcilable |
| C-11 | legacy "from depth N" lessons | holds | by design |
| K-9 | `courier_recall` "reads none" | holds | `src/memory/tools.ts:36` unchanged |
| K-11 | relay assumes a person in the top's session | holds | caveat only in `native` `src/tree/tools.ts:44-45`; `src/person/text.ts:73` unchanged |
| K-12 | who lacks courier_spawn | holds | `src/tree/context.ts:18-21` unchanged |
| K-13 | description trigger narrower than the role line | holds | `src/skill.ts:5-6` vs `src/tree/text.ts:93` |
| K-14 | sideways status not dropped | holds | `src/tree/send.ts:55-66` unchanged |
| C-13 | subagent may courier_send its parent | holds | harmless |

## Part B: the current text set

Skill size: 658 → 705 words with front matter (+47, +7%). Every addition traces to F4-F6. Z-1 and
Z-3 name about 45 words that are now repeated by texts the model holds at the moment of use.

Checked and consistent, no finding:
- **#493 vs the report reminder.** No text tells a child it must report again after its group
  arrives, or tells a parent that such a child owes one. The brief says "exactly one report"
  (`src/tree/text.ts:14`). `groupNotice` (`:495`) says only "Check and integrate each one yourself".
  `sendText` for a held report says "Nothing more is needed from you for it" (`:290`). The standing
  entry shows "reported …; group … was delivered" (`:137`, `:149`). The brief's "if you end your turn
  without a report, the parent is told so" (`:20`) stays true for a child that has not reported.
- **Partial / failed handling.** The skill (skill:50-51), `groupNotice` (`text.ts:495`),
  `failureNotice` (`:419-422`) and `silentNotice` (`:454-455`) offer the same options (message it,
  replace it, carry on or do the rest) and do not conflict. One edge case: Z-6.
- **The relay after #484.** At the top: skill:39-40, notices and `courier_answer`. Below it:
  spawnText and the two descriptions say the asks go to the top. One omission: Z-7.
- **Reference accounting for the role lines and the brief** (`docs/reference.md:277-281`) matches
  `childBrief` (`text.ts:14-28`, `:52-67`), `rolePart(null)` / `rolePart(0)` (`:77-90`) and the
  tool descriptions.

### Z-1 (minor): the check-in rule is now in four texts, and the skill's copy adds nothing

- skill:37-38: "For a long task or batch, one courier_later check-in per group (per session when
  ungrouped); courier_cancel it when its reports arrive."
- The same rule is in `courier_spawn` (`src/tree/tools.ts:140-142`), `courier_later`
  (`src/scheduling/tools.ts:27-29`) and `courier_cancel` (`:46-47`). Every session that can spawn
  holds all three descriptions.
- There is drift between them. The skill and `courier_spawn` say "For a long task or batch".
  `courier_later` says "Use it as a safety net when you start sessions", with no condition.
- **Placement:**
  - Cut the clause from skill:37-38 and keep "Reply without calling more tools; reports and notices
    wake you."
  - Give `courier_later` the "for a long task or batch" condition, so that one rule reads the same in
    three places.
  - `docs/reference.md:261-263` then moves the check-in to the tool-description sentence (`:280`),
    which already lists it.

### Z-2 (nit): "per session when ungrouped" is heavy in the skill's own rolling mode

- skill:27 offers "leave them ungrouped and start the next as each report frees a slot". Read
  literally, skill:38 and the three descriptions then ask for one check-in per session: N
  `courier_later` ids to track and cancel one by one. "Its reports" (plural) does not fit a single
  session.
- **Placement:** in all the texts that keep the rule, write "one per group, or one for the ungrouped
  sessions, cancelled when the last of their reports arrives".

### Z-3 (minor): the reference says the skill holds only what no other text says; that is no longer true

- `docs/reference.md:244-246`: "It says only what no other text a model has at that moment says".
  Several skill clauses repeat texts the model holds at that moment:
  - the check-in (Z-1);
  - "Reply without calling more tools; reports and notices wake you" (skill:37), which matches
    `courier_spawn` (`tools.ts:138-140`) and `spawnText` (`text.ts:272-273`);
  - "(an isolated part sees only committed project skills)" (skill:31), which matches `isolate`
    (`tools.ts:34-35`);
  - "isolated or not" (skill:56), which matches `courier_cleanup` (`tools.ts:220-221`);
  - "never answer for the person" (skill:39-40), which matches `courier_answer`
    (`src/person/tools.ts:67-68`) and the question notice (`src/person/text.ts:186`).
- The "skill alone adds" list (`:282-284`) names "merging", which the `isolate` description
  (`tools.ts:36`, "merge that branch yourself") and the isolated brief (`text.ts:46`) also carry. Only
  the command, resolving conflicts and re-running the checks are skill-only.
- **Placement:** either cut the check-in and the root relay line (skill:39-40) from the skill, or
  soften `:244` to "It says little that other texts do not". Write "merging" as "how to merge".

### Z-4 (nit): "only to the sessions it affects" next to the brief's new upward rule

- skill:42: "courier_send it at once, only to the sessions it affects". For a sub-orchestrator with
  the skill loaded, "only" can read as excluding its parent. Since #489 the brief tells it to send
  such a message up when it reaches past its part (`text.ts:23-24`). The parent itself is not
  "affected"; its other parts are.
- `docs/reference.md:265-266` narrows the skill further: "goes on to the children it affects, and
  only to them". `:530-532`, in contrast, states the upward rule.
- **Placement:**
  - skill:42: "to the sessions it affects, and up as your brief says when it reaches past your part".
    Or drop "only".
  - reference:265-266: "to the sessions it affects".

### Z-5 (minor): partial / failed handling reaches only a session that loaded the skill

- skill:50-51 is the only text that says what a parent does with a `partial` or `failed` report. An
  ungrouped report arrives as a bare `<courier status="…">` envelope.
- `groupNotice` (`text.ts:495`) says only "message one with courier_send if it has more to do".
  `rolePart(0)` (`:88`) says "Check and integrate what each one reports yourself"; the brief
  (`:65-66`) says the same.
- Runs with the skill denied are a measured configuration (`docs/maintainers/real-model.md:190`,
  `:230`).
- **Placement:**
  - Add one clause to `groupNotice`: "a partial or failed one: have it finish or retry, do the rest
    yourself, or start a replacement".
  - Optionally add it to the brief's orchestrate bullet (`:63-66`) and to `rolePart(0)`, which is
    written once at the first spawn, so the prompt cache is safe.
  - The skill keeps its sentence for the ungrouped case.

### Z-6 (nit): "start a replacement" for a failed report ignores sessions still running below

- When a failed turn has live sessions below, `failureNotice` drops "start a replacement" and warns
  that they still count (`text.ts:403-408`, `:414`).
- The skill's failed-report sentence (skill:51) has no such caveat. A sub-orchestrator that reports
  `failed` while its own children still run leaves a subtree that keeps counting and editing. The
  brief makes this rare (report after integrating, `:65-66`).
- **Placement:** skill:51 "…or start a replacement (stop what it still runs first)". Or accept it.

### Z-7 (nit): at the top, grouped `spawnText` omits the permission request

- `text.ts:267` gives "a blocked report, a question or a failed turn still reaches you at once"
  when `belowTop` is unset.
- The `group` description lists the permission request too (`tools.ts:55-56`), and permission
  notices are not held by a group.
- **Placement:** "a blocked report, a question, a permission request or a failed turn".

### Z-8 (nit): `REJECTED` names the wrong refuser (C-4 residue)

- `src/person/text.ts:42`: "Refused by the session that started you."
- At depth ≥ 2 the refusal comes from the top session, through the person's decision. At any depth
  it can come from the person in the TUI dock (`src/person/tui.tsx:265`). A depth-2 child may then
  argue with its parent in a blocked report.
- **Placement:** "Refused by the person or the session at the top of the tree. Do without it, or
  report back why you cannot."

### Z-9 (nit): the brief's two new upward clauses: a leaf gets them, and one is hard to parse

- `childBrief` renders `text.ts:23-24` and `:26-27` at every depth. That includes a leaf, which
  cannot start sessions (`:53-54`).
- "Do the same with one a session you started sends you" relies on "one" meaning "something".
- **Placement:**
  - Render the two sentences only when `depth < limits.maxDepth`. The brief is fixed per session, so
    the prompt cache is safe.
  - Write "Do the same when a session you started sends you something that reaches past your own
    part."

Model-facing string changes (Z-1, Z-2, Z-4 to Z-9) need the sandbox real-model re-run and a
`real-model.md` row. Z-3 and the reference halves of Z-1 and Z-4 are docs only.
