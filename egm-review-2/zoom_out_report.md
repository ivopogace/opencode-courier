# EGM re-check, zoom out: the shrunk courier-orchestrate skill (origin/main 15b9314)

Skill lines are `egm-review-2/courier-orchestrate.SKILL.md` lines. Old ids are from
`origin/claude/magical-cori-8g4cjl:egm-review/consolidated_review_report.md`. Every status was checked
against the current files, not only the PR bodies.

## Part A: status of the old action items

Totals: **41 resolved, 3 open (M6, M17, N5), 4 no longer applicable (M15, N2, N3, N4).**

| id | old finding | status | evidence |
| --- | --- | --- | --- |
| B1 | relay/courier_answer told to every session | resolved | #475: skill 24 "At the top, a permission request or question from below arrives with its own instructions"; courier_answer not named (test/notices.test.ts:68). But see Z-1: the tool texts now say the same false thing |
| B2 | "own prompts relayed nowhere" | resolved | #475: cut; not-contain list notices.test.ts:68 |
| B3 | "leave native off" vs nativeChildren | resolved | #475 cut; #473 host caveat in `native` description src/tree/tools.ts:42-47; docs/reference.md:670 "with `native: false` when the option is on" |
| B4 | failed turn "does not count" | resolved | #475 cut; #469 failureNotice `belowLine` src/tree/text.ts:395-415; limits.ts `liveBelow` |
| B5 | root role line names no limits | resolved | #475 cut the line |
| M1 | restates notices/descriptions | resolved | #475: skill 1,517 to 653 words; old 29, 34, 46-51 gone |
| M2 | split rule duplicated | resolved | skill 12 defers to the brief, keeps the root's rule (justified: rolePart(0) text.ts:83-88 has no rule) |
| M3 | leaf guard line 7 | resolved | old line 7 gone; skill 8 keeps only "if courier_spawn is not among your tools" (the #463 subagent has no role line) |
| M4 | "whole job that delivers itself" | resolved | gone everywhere; skill 19 "once that one's branch is merged" |
| M5 | permission-rule matching claims | resolved | skill 18 "how to check it"; advice to the person at docs/reference.md:270-272 |
| M6 | "may split further"; "same list" false for isolated | **open** (residue) | split clause gone, but skill 18 still says "it sees the same list", while `isolate` now says it "sees only committed files and project skills" (tools.ts:35). Z-6 |
| M7 | forced waves | resolved | skill 16 "start waves, each its own group, or leave them ungrouped" |
| M8 | check-in unbounded | resolved | skill 23 "One courier_later check-in per group, cancelled when its reports arrive" (wording conflicts with courier_spawn's, Z-5) |
| M9 | two stages vs three | resolved | stage list gone from skill; brief has three (text.ts:57-59) |
| M10 | partial has no exit | resolved as recommended | only the blocked clause kept (skill 29). Leaves no guidance for an ungrouped partial, Z-4 |
| M11 | description timing | resolved | skill 3 "Load it when you decide whether to split"; sub-orchestrator line "Before you decide whether to split" text.ts:91 |
| M12 | relay under "End your turn" | resolved (dissolved) | one sentence, skill 24; notices carry the rest |
| M13 | split-line delimiters | resolved | #473 backticks, src/kernel/protocol.ts:8-11 |
| M14 | idle stopped member stays counted | resolved | #473 `IDLE_STOPPED` text.ts:315-317,334 |
| M15 | progress after compaction | n.a. | section cut; the review's fallback (standing entry, git) is what remains, no text wanted |
| M16 | passing-on bullet unclear | resolved | skill 25 rewritten; upward half dropped. That drop opens Z-3 |
| M17 | "is a playbook's" jargon | **open** | skill 8 still "…is a playbook's: if a skill for that is listed to you" |
| M18 | long bullets | resolved | skill bullets are one or two rules each |
| N1 | model/variant advice | resolved | cut; reference.md:142-143 points at the description |
| N2 | lockfiles vs "no two parts edit" | n.a. | review said "nowhere" is acceptable |
| N3 | reader of edited files | n.a. | review said "nowhere" is acceptable |
| N4 | cleanup leaves branches | n.a. | sentence cut; nothing prescribed for the skill |
| N5 | root/top, part/session naming | **open** | skill 12, 37 say "root", skill 24 "the top" for the same session; "part" and "session" still alternate (16-19) |
| N6 | "one line of your reply" read as pre-spawn turn | resolved | "before you start" gone (skill 12) |
| N7 | wake list incomplete | resolved | list cut |
| N8 | refusal/tree caveats | resolved | section cut; refusals text.ts:170-182 |
| N9 | note "at the top" vs tool | resolved | #472: memory/note.ts:24 refuses below; description memory/tools.ts:66; skill 37 "At the root" |
| P1 | dirty-parent warning only for isolated parent | resolved | #468: spawn.ts:85,119-128; tools.ts:34-36; text.ts:253 |
| P2 | failure notice silent on live sessions below | resolved | #469: text.ts:395-415, events.ts:48 |
| P3 | OpenCode subagent gets root line | resolved | #470: context.ts:18-21,39-40 |
| P4 | courier_note below the top | resolved | #472 (see N9) |
| P5 | native host caveat | resolved | #473: tools.ts:44-45 |
| P6 | "not in a loop" in refusals | resolved | #473: text.ts:178,182 |
| P7 | group unsealed after plain decline | resolved | #471: group.ts:124-125; events.ts sealGroups |
| P8 | delimit split forms | resolved | #473: protocol.ts:8-11 |
| P9 | idle-stop result | resolved | #473 (see M14) |
| P10 | depth-0 line lacks skill pointer | resolved | #473: text.ts:87 |
| D1 | CLAUDE.md reason | resolved | CLAUDE.md:69-71 "the root has no brief, its role line loses the rule at its first spawn, and a brief can be compacted away": matches skill 12 |
| D2 | permission-rule advice to docs | resolved | reference.md:270-272 |
| D3 | decline trap documented | resolved | fixed in plugin (P7); plugin-api-notes.md:160-166 |
| D4 | reference "what the skill adds" | resolved, with nits | reference.md:228-282 rewritten; inaccuracies in Z-7 |
| D5 | test assertions move | resolved | notices.test.ts:68 not-contain list; snapshot regenerated |
| D6 | real-model re-run | resolved | real-model.md:173, row at 6c767f4 (no `src/` diff to 15b9314) |

## Part B: does each claimed new home carry the rule?

Checked and holding, no finding:
- **Failed child**, including a failed sub-orchestrator at the top: `failureNotice` names live sessions
  below, says they still count, drops "start a replacement" (text.ts:395-415). A sub-orchestrator gets
  the same notice for its own leaf.
- **Silent child**: `silentNotice` (text.ts:436-453) gives the options, the limit, and how to drop a group member.
- **Refused spawn**: maxChildren/maxTotal say do it yourself or wait, "not in a loop" (text.ts:176-182).
  The depth refusal reaches no one in practice (a leaf has no courier_spawn, context.ts:19).
- **Verifying first-hand**: brief text.ts:63-64, rolePart(0) text.ts:86, skill 29.
- **courier_recall**: rolePart(null) text.ts:78 plus its description memory/tools.ts:35-40, which also forbids it below the root.
- **courier_note**: description memory/tools.ts:58-67, refusal memory/text.ts:106-108, skill 37 for when to write it.
- **Root after the role line switches**: rolePart(0) text.ts:87 sends it back to the skill after a compaction.
  The skill carries the root's split rule and `ROOT_SPLIT_LINE` for a second wave (skill 12). Skill denied: see Z-8.
- **Model/variant, native, isolate, stop, tree**: the descriptions carry what the cut lines said.

### Z-1 (major): a sub-orchestrator is told it will hear of its children's permission requests and questions; it never does

- **Rule:** permission requests and questions from any depth go only to the top. courier_answer from
  anyone else is refused (person/events.ts:14-20 `topOf`; tree/roster.ts:50-58).
- **Old skill:** line 27 put them in the wake list and line 29 told every session to answer them (B1).
- **Claimed home:** "the permission and question notices, which go to the top only."
- **What reaches a depth-1 model:** the notices never reach it, but three texts tell it the opposite:
  - the courier_spawn description, tools.ts:134-135: "you are told if its turn fails … it waits for a permission or it asks a question";
  - the `group` description, tools.ts:55: "A blocked report, a question, a permission request or a failed turn still reaches you at once";
  - spawnText, text.ts:258-260: "a blocked report, a question or a failed turn still reaches you at once".
  Skill 24 ("At the top, …") implies the opposite, without saying where they go. So the depth-1 session
  has a contradiction and no fact. Its standing entry shows a child that waits on the person as
  "working" (text.ts:124-125). On its check-in it may poke, replace or courier_stop a child that is only waiting on the person.
- **The old B1 now sits in the tool texts.** The skill fix removed it from the skill only.
- **Placement:**
  - spawnText knows the parent. For a parent below the top, render "a blocked report or a failed
    turn still reaches you at once; its permission requests and questions go to the top session,
    <id>, and while it waits on one, it shows as working".
  - In the static descriptions (tools.ts:55, 134-135), qualify the clause: "(at the top of the tree; below it, they go to the top)".
  - Optionally add one clause to the sub-orchestrator role line (text.ts:89-93). It is written once
    at the start, so the prompt cache is safe.

### Z-2 (nit): a depth-2 child believes its question goes through its parent

- **Brief, text.ts:26:** "use your question tool; it reaches them through the session that started
  you." At depth 2 or more, it actually reaches the person through the top. The depth-1 session never
  sees the question or the answer.
- **The answer reaches no one else either.** It returns as a tool result, so the brief's
  "person writes in your session" rule (text.ts:24-25) does not fire. The person's decision then
  reaches neither the depth-1 session nor the siblings, unless the top passes it on (skill 25 covers the top, loosely).
- **Placement:** childBrief knows the depth. At depth 2 or more, write "through the session at the
  top of the tree". Add: "if the answer changes what other parts need, send it to the session that started you without a status."

### Z-3 (major): passing a finding or the person's word upward through a sub-orchestrator is gone

- **Rule:** a finding or the person's word that may affect parts beyond the receiver's own subtree goes up.
- **Old skill:** line 30 "Send it up too, without a status, when your parent's other parts need it."
- **Claimed home:** "upward half of passing a message on: brief."
- **What reaches the model:** the brief (text.ts:21-25) covers only what the session itself *finds*,
  and what the person writes *in its own session* outside an envelope. Skill 25 passes a message from
  below "only to the sessions it affects": downward, among the session's own children. Take a depth-1
  session that receives from its depth-2 child a wrong shared-API assumption, or "the person told me
  X", which the brief calls "for the whole job". No text tells it to send that on to the top.
  reference.md:511-514 describes only the one-level case. The chain child → parent → siblings holds
  one level down. Depth 2 → depth 1 → top breaks at depth 1.
- **Placement:** skill 25, one clause: "and, without a status, to the session that started you when
  it is the person's word or may touch parts beyond yours." Or, in the brief, change "If you find
  something" to "If you find, or a session you started sends you, something …". The brief reaches only the sessions that need it, which favours the brief.

### Z-4 (nit): nothing tells a parent what to do with an ungrouped partial or failed-status report

- **Old skill:** line 34 "partial: … have the session finish it …, or do it yourself. failed: … try
  again, start a replacement, or carry on."
- **Claimed home:** "brief; group notice; failureNotice, silentNotice." None of them carries it:
  - The brief tells the *child* how to report (text.ts:14-16).
  - failureNotice and silentNotice cover a failed *turn* and a silent end, not `status="failed"` or `"partial"`.
  - Only the group notice says anything, generically: "message one with courier_send if it has more to do" (text.ts:485).
  - An ungrouped report, as in the skill's own overflow mode (skill 16), arrives as a bare envelope (send.ts:36).
- Skill 37 ("done only when every part is verified and integrated") implies the work is not finished, and says no more.
- **Placement:** skill 29, about 20 words: "A partial report: have it finish with courier_send, or do the rest
  yourself; a failed one: have it retry, start a replacement, or carry on without it."

### Z-5 (nit): two check-in rules

- Skill 23 says one check-in "per group", always.
- courier_spawn's description (tools.ts:138-139) says check-ins are "for long tasks", one per session
  ("in case it never reports, … when it does").
- **Placement:** align the description to "one check-in per group, or per session started outside a group".

### Z-6 (nit): "it sees the same list" (M6 residue)

- Skill 18 conflicts with the `isolate` description (tools.ts:35): an isolated part sees only committed project skills.
- **Placement:** "it sees the same list (an isolated part, only the committed project skills), not your choice". Or cut the clause after "listed to you".

### Z-7 (nit): docs/reference.md's skill section overstates what the other texts carry

- **reference.md:262-266:** "Without the skill, the brief and the role part still carry … the one
  group, no polling, … verifying." For the root, neither rolePart(null) nor rolePart(0) carries the
  one group or no polling. Only courier_spawn's description and spawnText do.
- **"The skill alone adds":** the list omits four things the skill alone says:
  - the person's-word rule (skill 25);
  - several whole jobs are that many parts (skill 12);
  - answering a blocked report through the person (skill 29);
  - when the root writes its lesson (skill 37).
- **CLAUDE.md:69-71** matches the skill (D1).
- **Placement:** fix the two sentences in reference.md.

### Z-8 (nit): a root with the skill denied loses the split rule at its first spawn

- rolePart(0) (text.ts:83-88) only says to load the skill. With `skill` denied (a scenario real-model.md:172 runs), a second wave has no split rule and no split-line forms.
- **Placement:** the depth-0 entry is written once, at the first spawn, so adding `ROOT_SPLIT_LINE` there costs no prompt cache. Or accept it and say so in reference.md:228-282.

### Z-9 (nit): wording left from the old review

- M17's jargon ("is a playbook's", skill 8) is still there.
- N5's root/top mix: skill 12 and 37 say "root", skill 24 says "top" for the same session.
- **Placement:** use "At the root" in skill 24. Write skill 8 as M17 proposed.

### Conflicting statements across the skill and the texts, summarised

1. Z-1: the skill (24) says the relay is the top's; three tool texts promise it to every parent.
2. Z-5: the check-in scope.
3. Z-6: which skills an isolated part sees.
4. Z-3, in effect: the brief promises a child that its parent "passes it on to the sessions it
   affects" (text.ts:22-23). The skill passes it on only downward, and only one level.

No other contradiction was found:
- split rule and forms: brief, role lines and skill agree through the protocol.ts constants;
- courier_note: "top" in the tool, "root" in the skill, the same session;
- verification;
- refusals.
