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
  child, down to the part each one edits. Usual collisions here: the end of the
  `tool.transform` callback in `src/index.ts`, the expected tool list in `test/plugin.test.ts`,
  README's Tools table and "How children reach you" list, `docs/reference.md`, the scenario
  blocks before the summary in `e2e/run.sh`, and the branches of `decide()` in
  `e2e/mock-model.mjs`.
- **Hold** an issue that needs something only the owner has: an API key, an account, a decision
  to publish or spend. Say what is needed instead of spawning.
- Keep a roster in the scratchpad (issue, session id, branch, PR, state, the owner's decisions
  and merge go verbatim with their time). Read it first on every check-in; it outlives a
  compaction. If it is lost, rebuild it from the repo's PRs and `list_sessions`, matching the
  wave tag yourself.

## 2. Spawn

`create_session` per issue: `source_url` the repo, `outcome_branch` `issue-<N>-<slug>`, title
`opencode-courier #<N>: <scope>`, tags `opencode-courier`, `wave-<K>`, `issue:<N>`, and the prompt
from `references/child-prompt.md` with every bracket filled. Put in the prompt what the owner has
already decided for that issue so the child does not ask again. Never `permission_mode: plan`: no
one is there to approve the plan.

## 3. Monitor without polling

- Children send their turn-end block to `@parent`, which wakes the orchestrator. That is the
  main signal; end your turn to wait for it.
- Safety net: one `send_later` check-in 30 minutes out (or the owner's cadence), re-armed first
  thing in every check-in while a child is still working. Never `CronCreate`: it lives in the
  container's memory and dies when an idle container is reclaimed.
- Read a child with `get_session` (`status_bucket`) and `list_events` with `kinds: ["result"]`;
  an unfiltered page overflows the tool result.
- A check-in where nothing changed says nothing to the owner.

## 4. Decisions

- `NEEDS USER DECISION` on something the code, README or CLAUDE.md settles: decide, cite it, send
  it back to the child.
- Anything that changes how the owner runs or exposes the plugin, costs money, or publishes: the
  owner's. Relay it with the child's options and recommendation; record the answer verbatim in the
  roster and send it to the child.
- `BLOCKED` on something outside the session (a denied host, a missing secret, GitHub access):
  tell the owner what to change, and where.

## 5. Merge

**The go.** Merging needs the owner's go in a real message ("merge them when they're green"). It
carries through later check-ins for the PRs it covers; record it in the roster. Without one, ask
once per batch in the reply that presents the PRs.

**The bar**, checked on the PR's current head sha, never from a child's summary:

- every check run on that sha concluded `success` (both CI jobs: unit and live e2e);
- the PR body has `Closes #<N>`, and the child reports a `code-review` round at high effort with
  its findings resolved; a behaviour change after that round gets another round;
- you read the diff yourself: scope matches the issue, tools follow CLAUDE.md's rules, new
  behaviour has unit tests and an e2e scenario, README is updated.

**The loop**, one PR at a time, dependencies first, then readiness:

1. If the PR is behind `main`, `update_pull_request_branch` (a server-side merge, never a rebase),
   tell its child to `git pull` before any further push, and wait for CI on the new head. A real
   conflict goes back to the child: it merges `origin/main` and keeps both sides.
2. Squash-merge with `expectedHeadSha`, commit title `<PR title> (#<PR>)`.
3. Tell every child still in flight that `main` moved, and which shared files changed.
4. Spawn whatever was waiting on the merged issue.

## 6. Close-out

- After each merge, tell the child it is merged and done; confirm the issue reads closed.
- When the whole wave is merged: delete the pending safety-net check-in, check `main`'s CI on the
  last merge (a run still going gets one `send_later`, never a wait in the turn), and give the
  owner a short summary. Archive the child sessions once the owner has seen it.

## Taking over a running wave

Children report to the session that spawned them. A new orchestrator session takes over by
rebuilding the roster (PRs plus `list_sessions` filtered by the wave tag), then sending each child
in flight: "From now on report to session `<new session id>` instead of `@parent`." It deletes the
old session's pending check-in if it can, and arms its own.
