# Codebase-details review: courier-orchestrate and the texts it relies on

Base: origin/main 15b9314. Skill lines are those of `egm-review-2/courier-orchestrate.SKILL.md`.
Severity: blocker = a text tells the model something false that makes it act wrongly; major; nit.
No blocker found.

## Findings

### K-1 (major) "You are told" about permissions and questions is false for a sub-orchestrator

- Claims: `courier_spawn` description, "you are told if its turn fails or ends without a report
  instead, it waits for a permission or it asks a question" (`src/tree/tools.ts:134-135`);
  `group` description, "A blocked report, a question, a permission request or a failed turn still
  reaches you at once" (`src/tree/tools.ts:55`); `spawnText`, "a blocked report, a question or a
  failed turn still reaches you at once" (`src/tree/text.ts:259-260`).
- Code: every permission notice, question notice and form notice goes to `topOf(chain)`, the top
  of the courier lineage, never to the parent (`src/person/events.ts:18-30`, `src/person/ports.ts:30`,
  `src/person/question/relay.ts:113-117`, `src/person/form.ts:30`). `courier_answer` refuses any
  caller that is not the top (`src/tree/roster.ts:50-57`). A sub-orchestrator gets no notice about
  its own children's asks. Failure and silent notices do go to the parent (`src/tree/events.ts:58`,
  `:153`), so only the permission and question parts are wrong.
- Effect: at depth 1 parent and top are the same session, so this is true there. A
  sub-orchestrator is told it will hear of something it never hears of. That is mostly harmless,
  since nothing asks it to act, but it is the only description a sub-orchestrator has of where its
  children's asks go.
- Fix: "you are told if its turn fails or ends without a report; its permission requests and
  questions go to the top session of the tree" (spawn), and drop "a question, a permission request"
  from the group description and `spawnText`, or add "(at the top of the tree)".

### K-2 (major) The brief misstates where a child's question goes

- Claim: `childBrief`, "use your question tool; it reaches them through the session that started
  you" (`src/tree/text.ts:26`).
- Code: the question is relayed to `chain.at(-1).parentID`, the top (`src/person/question/relay.ts:113`).
  The starting session is not involved and not told (`relay.ts`, `answer.ts:23`). This is true only
  at depth 1.
- Fix: "it reaches them through the session at the top of the tree."

### K-3 (major) The check-in is never cancelled for you

- Claim: skill line 23, "One courier_later check-in per group, cancelled when its reports arrive."
- Code: nothing cancels a check-in automatically. A report or a group release cancels nothing
  (`src/tree/send.ts`, `src/tree/group.ts:102-150`: no scheduling call). `courier_stop` cancels
  only messages scheduled *for the stopped sessions* (`src/tree/stop.ts:90-98`,
  `cancelScheduled(sessionID)`), not the parent's own check-in on them. The tool texts say the
  model must cancel it: "courier_cancel it when it does" (`src/tree/tools.ts:139`), "cancel it with
  courier_cancel if the child reports first" (`src/scheduling/tools.ts:28`, `src/scheduling/text.ts:5`).
- Effect: the skill's passive voice reads as automatic. The model may skip `courier_cancel`, and a
  stale check-in then wakes a finished root. This is also a duplicate that disagrees in tone. A small
  side point: the skill says "per group", while the spawn description says "For long tasks".
- Fix: "One courier_later check-in per group; courier_cancel it when the group's reports arrive. A
  courier_stop does not cancel it."

### K-4 (major) A partial report gets no guidance

- The brief defines `partial` ("say what is left and why", `src/tree/text.ts:15`), but nothing tells
  the parent what to do with one. Skill line 29 covers only blocked. An ungrouped report arrives as a
  bare envelope (`src/tree/send.ts:36`). The only text is the group notice's generic line, "message
  one with courier_send if it has more to do" (`src/tree/text.ts:485`). The shrink's premise ("cut
  rules arrive at the moment of use") does not hold for this one: no text carries it.
- Fix (skill §4): "A partial report: send the rest back with courier_send, start a part for it, or
  do it yourself; a blocked report: …"

### K-5 (nit) The skill list is the same only for skills that are global or committed

- Claim: skill line 18, "it sees the same list, not your choice."
- Code and text: an isolated child runs in a worktree from the last commit. Per the `isolate`
  description it "sees only committed files and project skills" (`src/tree/tools.ts:34-36`;
  `spawn.ts:86-87`), so a project skill that is uncommitted or new is missing. A child started with
  another `agent` (`spawn.ts:96`) may also have other `skill` permissions.
- Fix: "it sees the same list (an isolated part only the committed project skills), not your choice."

### K-6 (nit) "Branch merged" does not fit a non-isolated part

- Claim: skill line 19, "starts once that one's branch is merged into your checkout."
- Code: only an isolated child gets a branch and the isolation rule (`src/tree/text.ts:28`,
  `spawn.ts:145`). A non-isolated child edits the shared checkout and has no branch.
- Fix: "starts once that one has reported and, if isolated, its branch is merged into your checkout."

### K-7 (nit) Cleanup is not only for isolated sessions

- Claim: skill line 33, "courier_cleanup the isolated sessions you are done with."
- Code: an idle session that was stopped, or one that went silent, keeps owing a report
  (`report.ts:26` `owes`). It counts toward the limits (`limits.ts:21`) and holds its group until
  `courier_cleanup` drops it, whether or not it is isolated (`IDLE_STOPPED`, `text.ts:315-317`;
  `silentNotice`, `text.ts:446-450`). The stop result and the silent notice say this when it happens,
  so the skill is incomplete rather than wrong. Line 25 tells the model to courier_stop parts but
  says nothing about the cleanup that frees them.
- Fix: optional; "then courier_cleanup the isolated sessions, and any part you stopped or no longer
  need a report from."

### K-8 (nit) The root's role line never goes back to `rolePart(null)`

- At the first spawn, `nameBoth` writes `rolePart(0)` into the root's `role` entry and caches
  `{depth:0, entry:true}` (`spawn.ts:177-181`). Nothing ever removes the entry or resets the cache.
  After every child is cleaned up and the server restarts, `roleOf` gets depth null
  (`context.ts:34`), but the baseline's role line matches `ROLE_LINE` and nothing is pushed
  (`context.ts:22`). The root therefore keeps "root orchestrator…" for every later task.
  `rolePart(0)` carries no split rule, no `ONE_PART_LINE` and no `courier_recall` prompt
  (`text.ts:83-88`), so for a second task in the same root the skill is the only source of the root
  rule and the 1-part form (skill line 12). It says "Load the … skill if it is not in your context",
  which covers this. This is by design (`docs/reference.md:244`), but `courier_recall` is never
  suggested again for a later task.

### K-9 (nit) `courier_recall` claims a fact that holds only for some roles

- Claim: "a session another session started reads none" (`src/memory/tools.ts:36`).
- Code: only a leaf or a subagent loses `courier_recall` (`src/index.ts:167` `hiddenFromLeaf`,
  `context.ts:20`), and `recall` refuses no one (`src/memory/recall.ts:53-57`). Sub-orchestrators
  also get the `lessons` entry, which says "courier_recall has the records" (`src/memory/text.ts:134`,
  written to them at `spawn.ts:176`).
- Fix: "a session another session started need not read them: the root weighed them before it split."

### K-10 (nit) `courier_answer` does not say that only the top may call it

- `src/person/tools.ts:60-61` says "a session you started … (or one started from it)". The code
  admits only the top (`roster.ts:54-57`). Because only the top receives notices this rarely misleads,
  but with K-1 a sub-orchestrator could try it. Fix: "… that waits on it; only the top session of the
  tree, which gets the notice, can pass it on."

### K-11 (nit) The relay texts assume a person is in the top's session

- `permissionAsk` (`src/person/text.ts:73-77`) and `questionNotice` (`:186`) say the person decides
  in OpenCode's prompt or the question tool in the top's session. That holds only in the TUI or the
  paired app. Under `opencode run` without `--auto`, or with a bare API client, the prompt is
  rejected or waits unseen. Only the `native` description says so (`src/tree/tools.ts:44-45`;
  `docs/reference.md:679,687-689`). Skill line 24 ("follow them") inherits this. It is acceptable as
  long as reference.md carries the caveat. Optionally add one clause to `permissionAsk`.

### K-12 (nit) Skill line 8: who lacks `courier_spawn`, and what they are told

- A leaf (depth ≥ maxDepth) loses `courier_spawn`, `courier_recall` and `courier_note`
  (`context.ts:19-20`) and is told twice: by the brief (`text.ts:51-52`) and by its role
  (`text.ts:94-96`). An OpenCode subagent of a session in a tree (`context.ts:39-41`) loses the same
  tools and gets **no** role or other text (`context.ts:21`). Line 8 is its only statement, and it
  applies only if it loads the skill. That is fine.
- An OpenCode subagent of a session in no tree, including a root that has not spawned yet, keeps
  `courier_spawn` and gets `rolePart(null)` (`context.ts:39`, the role is not cached). If it spawns,
  its own tree's relays go to the subagent session. Once its parent spawns, it loses `courier_spawn`,
  but its children still route to it. This is documented (`docs/reference.md:715-719`). There is no
  text issue; it is listed because the brief asked.

### K-13 (nit) The trigger in the description is narrower than the roles'

- The description (line 3) says to load the skill when deciding on a task with 2 or more parts. The
  sub-orchestrator role says to load it "Before you decide whether to split", unconditionally
  (`text.ts:91`), and `rolePart(0)` says "if it is not in your context" (`text.ts:87`). They do not
  contradict each other, but the role makes every sub-orchestrator load the skill, including for a
  small task. `rolePart(null)` matches the description (`text.ts:77`).

### K-14 (nit) A status sent sideways is not dropped

- `courier_send`: "A message to a session you started carries no status: one given is dropped"
  (`tools.ts:154-155`). The code drops the status only when the target is *below* the sender
  (`send.ts:56-62`). Sent to a sibling or the grandparent, the status is carried as an attribute but
  recorded as no report (`send.ts:64-67`), so the real parent later gets a silent notice. `send` puts
  no limit on the target at all (`send.ts:17-33`). Skill line 25 ("only to the sessions it affects")
  is therefore guidance, not a rule the tool enforces. That is fine.

## Claims verified TRUE

| Claim | Evidence |
|---|---|
| A report frees a slot (line 16) | `send.ts:72` settles the report; `limits.ts:19-21`: not live once settled and the turn has ended |
| A held group report frees its slot before release | Hold happens after settle (`send.ts:20-22`); `live` ignores group state |
| A failed or interrupted turn frees a slot; a silent end does not (`silentNotice` "counts toward your limits") | `events.ts:40,111` settle; nothing settles on a silent end, so `owes` stays true |
| A live grandchild keeps its ancestors counted | `limits.ts:45-47` |
| `childBranch` = `courier/<full session id>`, created by the child (`git switch -c`) | `text.ts:8,39`; `spawn.ts:145` |
| Cleanup removes the worktree, not the branch, and keeps unbranched commits | `cleanup.ts:26-46`; `keepReason` `text.ts:360-367` |
| Merging `courier/<id>` works from any checkout (same repository) | Worktrees share refs; `spawn.ts:86-87` |
| Relays go to the top only; the middle never gets them (line 24 "At the top") | `person/events.ts:20`; `relay.ts:113`; `roster.ts:53-56` |
| A native child of the top: the top is told not to answer (`nativePermission`) | `person/events.ts:18`; `text.ts:80-84`; `domain.ts:144-150` |
| A native child of a sub-orchestrator: the top gets the normal relay | `nativeRootOf` is not the top, so `permissionAsk` is used |
| A sub-orchestrator's own question reaches the person (line 29) | It has a lineage, so `relay.ts:105-117` relays it to the top |
| `courier_note` only at the root, which is always the top | `note.ts:22-24` refuses any session with a lineage; the root has none |
| Line 12: "below the root, never one session for the whole task" matches the brief | `text.ts:57-59` |
| `ONE_PART_LINE` only in `rolePart(null)` and the skill | `protocol.ts:11-13`; `text.ts:81` |
| `failureNotice`: the group no longer waits, and a late report joins it | `events.ts:42-43`; `send.ts:84-85` (only `dropped` is excluded) |
| `silentNotice` "does nothing more on its own" is sent only when nothing is pending | `nudge.ts:16-29` (awaited children, a complete group, outside waits) |
| `reportReminder` comes once, then the parent is told | `nudge.ts:39`; `events.ts:138-163` |
| `groupNotice` lists members without a report and why | `text.ts:470-486`; `group.ts:139` |
| A blocked report bypasses the group | `send.ts:22,47` `unholdForBlocked` |
| `IDLE_STOPPED`: a stopped idle session still owes a report and counts | `stop.ts:110` settles only interrupted ones |
| `courier_stop` reaches any descendant and cancels their scheduled messages | `tools.ts:102,199-200`; `stop.ts:90-98` |
