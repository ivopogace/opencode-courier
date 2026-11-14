---
name: courier-wave
description: >-
  Orchestrate a wave of opencode-courier issues in Claude Code cloud child sessions: choose what
  runs in parallel and what waits, spawn one child per issue, monitor without polling, relay
  decisions, verify the merge bar first-hand, merge in order, close out. Load when the user asks
  to spawn child sessions for issues, run issues "in parallel" or "in sequence", or take over a
  running wave from another session.
---

# opencode-courier wave orchestration

The orchestrator writes no product code. Each child session takes one issue from branch to a
green PR; the orchestrator plans the wave, watches it, answers or relays questions, checks every
PR itself and merges.

## 1. Plan

- Read every open issue the wave covers, and `main`'s log.
- **Sequence** an issue after another when it builds on the other's code (its issue says "ties
  in with", or its design needs the other's storage or tools). Spawn it once the other is merged.
- **Parallel** is fine when issues only share files textually. Name the shared files to each
  child, down to the part each one edits. Usual collisions: the end of the `tool.transform`
  callback in `src/index.ts`, the expected tool list in `test/plugin.test.ts`, README's Tools
  and Options tables, `docs/reference.md`, the group functions in
  `e2e/run.sh` (name the group each child edits; a new group also goes into its `SUITE`), and
  the branches of `decide()` in `e2e/mock-model.mjs`.
- **Hold** an issue that needs something only the owner has: an API key, an account, a decision
  to publish or spend. Say what is needed instead of spawning.
- **Choose a model and an effort for each issue**, by section 2's table, and give the owner the
  choices with one line of reason each before spawning. A choice the owner names wins.
- Keep a roster in the scratchpad (issue, model, effort and the reason for both, session id,
  branch, PR, state, the owner's decisions and merge go verbatim with their time). Read it first on every check-in; it outlives a
  compaction. If it is lost, rebuild it from the repo's PRs and `list_sessions`, matching the
  wave tag yourself.

## 2. Model and effort

A child's model and effort follow from what its issue asks of it, not from its size in lines.
Read the issue and the code it names, then take the first row that fits:

| The issue | Model | Effort |
|---|---|---|
| Changes the hub, the scheduler's jobs, a storage key or what two loaded copies share; or crosses three or more modules; or leaves a design decision open | Fable 5.2 (`claude-fable-5-2`) | high |
| Has a settled design and touches several files of one or two modules, with tests and a live scenario; or rewords a model-facing string | Opus 5.5 (`claude-opus-5-5`) | high |
| Is mechanical with an exact list of files: documentation, a rename, a script, a recording, a one-file fix | Sonnet 5.5 (`claude-sonnet-5-5`) | medium |

What moves an issue one row up:

- its design calls its own file list unverified, so the child has to find the files;
- it changes the live suite beyond its own group: checks other groups read, the shard balance,
  the order of groups;
- it removes code other code may still call, so the child has to decide what became dead;
- it must work with a session or a stored value written by the release before it.

What keeps it where it is: many files of the same kind of change. A module deleted whole is
large and still mechanical.

Effort above high, and a model below Sonnet 5.5 for product code, are the owner's to name.

The reason goes in the roster in one line that names the row and what moved it, for example
"Opus 5.5, high: settled design, rewords tool descriptions; up one row for dead code after the
deletion". The same line goes to the owner with the plan.

A child that fails CI twice on the same failure, or reports `BLOCKED` on the work itself, is not
given a stronger model or more effort by the orchestrator: that changes what the wave costs.
Tell the owner what it is stuck on and propose the next row up, or the next effort level.

## 3. Spawn

First assign each issue to the owner on GitHub (`issue_write`, method `update`, `assignees`), and
note it in the roster. One already assigned to someone else is not reassigned or spawned: tell the
owner who has it. An issue the wave drops unmerged is unassigned.

Then `create_session` per issue: `source_url` the repo, `outcome_branch` `issue-<N>-<slug>`, title
`opencode-courier #<N>: <scope>`, tags `opencode-courier`, `wave-<K>`, `issue:<N>`, the `model` and
the effort chosen for the issue, and the prompt from `references/child-prompt.md` with every bracket
filled, including what the owner has already decided for that issue. Never `permission_mode: plan`:
no one is there to approve the plan.

## 4. Monitor without polling

- Children send their turn-end block to `@parent`, which wakes the orchestrator. End your turn to
  wait for it.
- Safety net: one `send_later` check-in 30 minutes out (or the owner's cadence), re-armed first
  thing in every check-in while a child is still working. Never `CronCreate`: it lives in the
  container's memory and dies when an idle container is reclaimed.
- Read a child with `get_session` (`status_bucket`) and `list_events` with `kinds: ["result"]`;
  an unfiltered page overflows the tool result.
- A check-in where nothing changed says nothing to the owner.

## 5. Decisions

- `NEEDS USER DECISION` on something the code, README or CLAUDE.md settles: decide, cite it, send
  it back to the child.
- Anything that changes how the owner runs or exposes the plugin, costs money, or publishes: the
  owner's. Relay it with the child's options and recommendation; record the answer verbatim in the
  roster and send it to the child.
- `BLOCKED` on something outside the session (a denied host, a missing secret, GitHub access):
  tell the owner what to change, and where.

## 6. Merge

**The go.** Merging needs the owner's go in a real message ("merge them when they're green"). It
carries through later check-ins for the PRs it covers; record it in the roster. Without one, ask
once per batch in the reply that presents the PRs.

**The bar**, checked on the PR's current head sha, never from a child's summary:

- every check run on that sha concluded `success`, or `skipped` for the live-suite jobs a
  documentation-only PR skips and for the `Claude review` jobs; the required `Live test against OpenCode V2` gate passed;
- the PR body has `Closes #<N>`, and the child reports a round of the code review plugin
  (`code-review:code-review`, which `.claude/settings.json` enables for every child) with its
  findings resolved: its READY TO MERGE names the sha reviewed, the findings and how each was
  resolved, or why the plugin stopped at its first step (then read the diff with that in mind); a
  behaviour change after that round gets another round;
- you read the diff yourself: scope matches the issue, tools follow CLAUDE.md's rules, new
  behaviour has unit tests and an e2e scenario, README.md and `docs/reference.md` are updated.

**The loop**, one PR at a time, dependencies first, then readiness:

1. If the PR is behind `main`, `update_pull_request_branch` (a server-side merge, never a rebase),
   tell its child to `git pull` before any further push, and wait for CI on the new head. A real
   conflict goes back to the child: it merges `origin/main` and keeps both sides.
2. Squash-merge with `expectedHeadSha`, commit title `<PR title> (#<PR>)`.
3. Tell every child still in flight that `main` moved, and which shared files changed.
4. Spawn whatever was waiting on the merged issue.

## 7. Close-out

- After each merge, tell the child it is merged and done; confirm the issue reads closed.
- When the whole wave is merged: delete the pending safety-net check-in, check `main`'s CI on the
  last merge (a run still going gets one `send_later`, never a wait in the turn), and give the
  owner a short summary, with the model and effort each issue ran on and whether either was
  raised. Archive the child sessions once the owner has seen it.

## Taking over a running wave

Children report to the session that spawned them. A new orchestrator session takes over by
rebuilding the roster (PRs plus `list_sessions` filtered by the wave tag), then sending each child
in flight: "From now on report to session `<new session id>` instead of `@parent`." It deletes the
old session's pending check-in if it can, and arms its own.
