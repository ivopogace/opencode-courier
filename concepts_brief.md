# Shrinking opencode-courier to what OpenCode 2.3.0 cannot do

* **Author:** Ivo Pogace
* **Date:** 2026-11-13

## Overview

opencode-courier has 11 model-facing tools, five server options, a terminal panel, tree memory,
scheduling, an ask relay and two ways to create a child session. The owner wants to cut it down for
four reasons: the work each OpenCode release costs, the size of what models see, overlap with the
host, and adoption.

The starting hypothesis was: protect only the `/courier tree` panel and isolated worktrees, let
OpenCode's own `subagent` tool or native child sessions replace courier's spawn and inbox wake, make
memory, the ask relay and join groups justify themselves, and add nothing new unless a gap shows.
Breaking changes are allowed, and only the pinned host (2.3.0) needs support.

Seven independent reviewers read the repository against that hypothesis. All seven rejected the
central replacement. Six of them proposed the opposite cut: keep courier's own spawn, send and wake,
and remove the native-child path, groups, memory, the model-side ask relay and `courier_children`.
That takes the tool list from 11 to 5: `courier_spawn`, `courier_send`, `courier_tree`,
`courier_stop`, `courier_cleanup`.

## Analysis

### Why the wake cannot be replaced while worktrees are protected

OpenCode creates a session with a location or a parent, never both
(`docs/maintainers/plugin-api-notes.md`, "Native `parentID`"). The host `subagent` tool always sets a
parent. An isolated child therefore cannot be a host subagent: it gets no host report at its turn
end and appears in no parent's ask view. Protecting worktrees keeps spawn, send, the roster, the
inbox wake and some ask path alive. Replacing only the non-isolated path leaves two kinds of child
and two report protocols, which is more to maintain, not less.

A parent that had only host subagents would also lose: depth beyond 1 without a config change,
statuses and the branch name in a report, messages from a child before its turn ends, spawn limits,
children that outlive the parent's deletion, one wake per report, and the retry for a lost wake. It
would gain three things: `/goal` waits for host subagents, asks show in the root's view, and a child
cannot end silently.

### The per-feature verdicts

| Feature | Verdict | Agreement | Note |
|---|---|---|---|
| `courier_spawn` | Keep | 7 of 7 | One reviewer keeps it only for isolated children |
| `isolate`, `courier_cleanup` | Keep | protected | |
| `native`, `nativeChildren` | Remove | 6 of 7 | Costs an extra parent turn per child turn; `opencode run` can stall; needs its own role line |
| `group` and the `finding` field | Remove | 7 of 7 | No part of the skill tells a session to group; `finding` only exists to pass a held report |
| `agent`, `model`, `variant`, `title` | Keep | 6 or 7 of 7 | `title` saves little either way |
| `courier_send` and its four statuses | Keep | 7 of 7 | The host report carries only the last text and a state |
| `queue` on `courier_send` | Remove | 3, low confidence | No scenario uses it |
| `courier_children` | Merge into `courier_tree` | 7 of 7 | A call after a spawn already counts as polling in the real-model checks |
| `courier_tree`, `courier_stop` | Keep | 7 of 7 | Both share code with the panel |
| `courier_answer` and the `question` tool wrap | Remove | 7 of 7, conditional | Depends on whether headless use is supported |
| `/asks`, the footer count, the panel's "waiting on you" | Keep | 7 of 7 | A standalone child's asks show in no host view |
| `courier_later`, `courier_cancel` | Split | 3 remove, 4 keep in some form | See below |
| Memory (two tools, the option, `/courier memory`, the `lessons` entry) | Remove | 6 of 7 | About 1,560 source lines; no result shows what recall is worth |
| `maxDepth`, `maxTotal` | Keep | 7 of 7 | |
| `maxChildren` | Split | 2 remove, 2 keep, 3 undecided | Could fold into `maxTotal` |
| `/courier stop` | Remove | 6 of 7 | The panel's `s` key does the same |
| Missed-wake retries, `stalled` | Keep | 7 of 7 | A lost wake is silent on the host |
| The unreported-child reminder | Keep | 7 of 7 | It backs the status check every scenario runs |
| Per-child state lines in the parent's prompt | Keep | 7 of 7 | No with-and-without measurement exists |
| Fork notices | Split | 4 keep, 3 lean remove | Small, but rests on an experimental, untyped hook |
| Restart survival | Keep | 7 of 7 | A by-product of the stored roster |
| The `courier-orchestrate` skill | Keep, shortened | 7 of 7 | Two scenarios pass 3 of 3 with the skill denied, in fewer requests |
| Fallbacks for hosts older than 2.3.0 | Remove first | 7 of 7 | Small: 60 to 100 source lines |
| New features | None | 7 of 7 | |

Steering (text typed into a child is passed up the tree) was missing from the feature list. Two
real-model scenarios depend on it. It needs a verdict.

### Where the hypothesis was wrong on facts

- **Scheduling does not overlap the host on a stock 2.3.0.** Host schedules sit behind a feature
  flag that is off in release builds, a plugin cannot reach them, and spawned sessions are denied
  them. The choice is keep or remove, not replace. `courier_later` is the only cover for a failure
  while the server is down and for resuming after a rate limit.
- **The tool count is 11.** A twelfth exists only if the wrapped host `question` tool is counted.
- **"No evidence of use" cannot be settled from the repository.** There is no telemetry. The owner's
  local memory records are the only instrument. The ask relay has passing scenarios, and the README
  demo is built on a join group.
- **The README's stated difference from the host is out of date.** It says the host tool hands back
  a child's final answer; the maintainer notes say every `subagent` call runs in the background and
  each turn end wakes an idle parent.

### Where the success measures are weak

- The pass-rate measure has no baseline. The current tables are one batch on OpenCode 2.2.6, one
  model, mostly three runs. The document's own floor is five runs on each of two models. "Weaker
  model" is not defined anywhere.
- Removing the ask relay deletes two passing scenarios, which changes what is counted rather than
  the rate. The scenario set must be fixed before rates are compared.
- The largest source cuts barely shorten `plugin-api-notes.md`: memory has no section there. The
  whole plan removes an estimated 110 to 130 of its 692 lines.
- Tool count hides schema size, and skill length can be met by moving text elsewhere.
- Measures the harness already reports would be harder to game: uncached input tokens per request
  and requests per run, with source lines and model-facing characters beside them.

### Contradictions and how to resolve them

- **Fewer tools against pass rate.** Remove the tools that are themselves failure paths. A listing
  call after a spawn is scored as polling, and the state lines already push that information.
- **A shorter skill against rules weak models need.** Move each rule to the moment it applies: put
  "merge the branch, then `courier_cleanup`" in the report that carries a branch, and "finish, do the
  rest, or replace" in partial and failed reports. The cost is one sentence per report.
- **Cutting unproven features against no usage data.** Read the owner's memory records first. Then
  hide a feature for one release and run the harness before deleting its code.
- **Removing stateful features against sessions already running.** Old and new copies of the plugin
  share one hub. A copy without the group or schedule jobs strands held reports and pending
  messages. Each stateful cut takes two releases: the first removes the tools and delivers what is
  held, the second removes the jobs. Old storage keys are left in place, so a rollback still works.
- **Removing the model-side ask relay against a blocked child going unseen.** Keep a one-line notice
  to the parent that a child waits on the person, plus `/asks`, the footer count and the panel mark.
  "Asks reach you" then holds only in the terminal.

### The ideal final result

One kind of child, one report protocol, five tools, and a panel. Host subagents stay the host's and
are read into the tree, which the plugin already does. Nothing a model can call is a way to poll.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * Run a baseline real-model batch on 2.3.0 before any cut.
  * Remove memory, the fallbacks for older hosts, groups with `finding`, the `nativeChildren`
    option, and `courier_children` as a separate tool.
  * Keep `native` as a per-spawn choice.
  * Remove `courier_cancel`, steering, `/courier stop`, the `queue` parameter and `maxChildren`.
  * Keep `courier_answer`, `courier_later` and fork notices.
  * Correct the README's description of the host `subagent` tool.
  * Replace or extend the success measures with tokens per request and requests per run.
* **Out-of-Scope Non-Goals:**
  * Replacing courier's spawn and wake with host subagents or native children.
  * New features.
  * Support for any host other than the pinned one.
  * Telemetry.
  * Deleting stored keys on load.

## Alternatives Weighed

- **Full replacement by the host `subagent` tool or native children.** Rejected by author's review:
  an isolated child cannot have a parent, and depth, statuses and mid-run messages are lost.
- **Hybrid: native for non-isolated children, courier for isolated ones.** Rejected by six
  reviewers: two report protocols and doubled notices and panel paths. One reviewer holds it is the
  realistic end state. This is the main open disagreement.
- **A worktree tool beside the host `subagent`.** Rejected: nothing shows a subagent can be placed
  in another directory, and permission requests are kept per location.
- **Always isolate, host subagents for the rest.** Rejected: every scenario gains a merge step.
- **Only drop the older-host fallbacks.** Kept as the first step; too small to be the plan.
- **Options that unregister tools as the end state.** Rejected: the code and tests stay. Accepted
  as a one-release measuring step.
- **Two plugins, a core and extras.** Rejected: the work per pin bump stays or doubles.
- **Host schedules in place of `courier_later`.** Rejected: off in release builds and out of a
  plugin's reach.
- **One `courier` tool with a mode.** Rejected: closed schemas with unions are a known host trap.
- **Deleting the skill.** Rejected for now: three scenarios are unmeasured with the skill denied.
- **Treating a turn end as the report and dropping statuses.** Not adopted: it loses `blocked` and
  `partial` and invalidates every real-model checker.
- **Adding telemetry first.** Rejected: no infrastructure, and a privacy decision.

## Key Decisions & Staging for Next Steps

Decided during ideation:

- Breaking changes ship in a 0.x minor release.
- Only the pinned host is supported.
- No new feature is planned.
- The spawn and inbox wake stays; the owner confirmed this reversal of the starting hypothesis. It
  is re-checked at each pin bump: if the host lets a session have both a worktree and a parent, full
  replacement is weighed again.
- `native` stays as a per-spawn choice and the `nativeChildren` option goes, so a child is
  standalone unless its spawn asks otherwise. The owner decided this after the comparison under
  "Open for the owner", against the six reviewers who wanted one kind of child. Two kinds of child
  and their two report paths stay.
- A standalone child's report shows a raw session id in the parent's transcript. Showing its title
  there is the plan's one addition, if the terminal plugin API allows it; once it does, removing
  `native` is weighed again.

- `courier_answer` stays. The owner's reason: when a question is showing, `/asks` cannot be typed.
  The `ctrl+x k` key is a second way into the asks dialog; if it also fails while a question shows,
  that is a bug with its own issue.
- `courier_later` stays and `courier_cancel` goes. A pending message is dropped when its session
  sends its last report.
- Steering (the automatic copy of typed text to the sessions above) goes. A person who wants a
  parent told says so, and the child sends it with `courier_send` without a status. Gate: the two
  scenarios that use steering are rewritten that way and pass at the baseline's rate.
- `/courier stop`, the `queue` parameter of `courier_send` and the `maxChildren` option go.
  `maxDepth` and `maxTotal` bound a tree.
- Fork notices stay.
- The baseline runs on two models: the self-hosted one and a small cloud one, five runs each.
- `maxTotal` keeps its default of 30. With `maxChildren` gone, one session may start up to 30
  children; the owner accepts that.
- A host other than the pinned one gets a log line and the plugin loads, as today. With the
  older-host fallbacks gone, an older host may fail after loading; the log line names the supported
  version.
- The README keeps both audiences: deep trees, and parallel edits with a view.
- Every issue about native children was filed by the owner, so its removal needs a release note and
  no other notice.
- Memory goes without reading the local records first: the owner counts it as unproven.

The tool list after the plan has 7 entries, down from 11: `courier_spawn`, `courier_send`,
`courier_tree`, `courier_stop`, `courier_cleanup`, `courier_answer`, `courier_later`.

Proposed order, one pull request per step:

0. Baseline batch on 2.3.0: five runs on each of two named models, no code change.
1. Memory.
2. Older-host fallbacks, after checking each fallback's other callers.
3. Groups and `finding`: a release that delivers what is held, then the removal.
4. `courier_cancel`, with the automatic drop on a last report.
5. Steering, after its two scenarios are rewritten and measured.
6. The `nativeChildren` option; `native` stays.
7. A readable line for a standalone child's report, if the terminal plugin API allows it.
8. The small cuts: `courier_children` into `courier_tree`, `/courier stop`, `queue`, `maxChildren`.

The estimate for the whole plan is 2,900 to 3,200 of 10,547 source lines.

Open for the owner:

1. The README demo shows a join group. It has to be recorded again once groups go, and it cannot
   be recorded on the owner's machine.
2. Can a native child work in a plugin-made worktree by absolute path? Unverified; a yes would
   reopen the replacement. Checked at each pin bump.
3. Does `ctrl+x k` open the asks dialog while a question is showing?
4. The owner likes what a child spawned with `native: true` shows in the terminal. A comparison on
   OpenCode 2.3.0 with the scripted model, one parent with one child of each kind, showed:
   - The tree panel's rows are the same: `✓`, `idle · reported done`, the run time, the last tool
     and the cost. The native row adds only the word `native`.
   - In the parent's transcript both reports appear as `Message from ses_…`, with the raw session
     id. Only the native child adds a readable line, `Subagent finished · <title>`, written by
     OpenCode. That line comes with a third parent turn where the standalone child needs two.
   - Opened from the panel, the standalone child has its own tab and a prompt. The native child has
     no tab, and OpenCode's Subagents pane sat where the prompt is.
   - Under `opencode run`, the native child's permission request was rejected by the run itself;
     the standalone child's waited for the person.

   The part the owner likes is OpenCode's own, so `native` stays; the decision is under "Decided
   during ideation". Still open: whether the terminal plugin can show a readable line for a
   standalone child's report.

Limits of this review: no reviewer read every file in the four modules, so line counts are
estimates, and the installed host types are 2.2.6, so claims about 2.3.0 rest on the maintainer
notes.
