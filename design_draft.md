# Shrinking opencode-courier

*   **Author:** Ivo Pogace
*   **Status:** Draft
*   **Date:** 2026-11-14

--------------------------------------------------------------------------------

## Overview

opencode-courier is an OpenCode V2 plugin that lets one session start others, end its turn, and be
woken when they report. It has grown to 11 model-facing tools, five server options, a terminal
panel with four commands, a memory of earlier trees, scheduled messages, a relay for a child's
permission requests and questions, and two kinds of child session.

This design removes the parts that nobody is known to use or that a smaller mechanism already
covers, and keeps the parts OpenCode 2.3.0 cannot do itself. The tool list goes from 11 to 7. The
work is a series of small releases, each measured against a baseline taken before the first one.

The plan adds one thing: a readable line in the parent's transcript when a standalone child
reports, where a raw session id shows today.

## The Problem

Four costs grow with the plugin's size.

1. **Each OpenCode release costs work.** The plugin is pinned to one host version. Every bump
   means re-checking each behaviour that rests on something the host does not promise. The file
   that tracks those behaviours, `docs/maintainers/plugin-api-notes.md`, has 692 lines.
2. **Models see too much.** Every session gets 11 tool descriptions and schemas, a skill, a role
   line and per-child state lines. A weaker model has more to misread, and every request pays for
   the text. In the real-model checks, a call to a listing tool after a spawn already counts as a
   failure, yet two listing tools are offered.
3. **Parts of it duplicate each other.** `courier_children` returns a subset of `courier_tree`.
   `/courier stop` does what the `s` key in the panel does. The `finding` field exists only to get
   past a held group report. Text typed into a child is copied up the tree, though the child can
   send it up itself when asked.
4. **It is hard to explain.** The README needs five claims to say what the plugin is for, and one
   of them describes the host's `subagent` tool as it was, not as it is in 2.3.0.

No usage data exists for any feature. The only evidence is what the owner uses, what the scripted
and real-model scenarios exercise, and what the repository's issues show. Memory, join groups and
the `nativeChildren` option have none of the three from anyone but the owner's own tests.

The first idea was to replace courier's spawn and wake with OpenCode's own subagents. That does
not work: OpenCode creates a session with its own directory or with a parent, never both, so a
child in its own git worktree cannot be a host subagent. Isolated worktrees are one of the two
features the owner will not give up. Spawn, send and the wake therefore stay, and the cuts come
from around them.

## Goals

*   The model-facing tool list is exactly `courier_spawn`, `courier_send`, `courier_tree`,
    `courier_stop`, `courier_cleanup`, `courier_answer` and `courier_later`.
*   Removed: memory (two tools, the `memory` option, `/courier memory`, the `lessons` entry), join
    groups and the `finding` field, the copy of typed text up the tree, `courier_cancel`,
    `courier_children` as a separate tool, `/courier stop`, the `queue` parameter of
    `courier_send`, the `maxChildren` and `nativeChildren` options, and every code path that only
    serves a host older than 2.3.0.
*   Kept unchanged in behaviour: `courier_spawn` with `isolate`, `agent`, `model`, `variant`,
    `title` and `native`; the four report statuses; the tree panel, the footer and `/asks`;
    missed-wake retries and `stalled`; the reminder to a child that has not reported; the
    per-child state lines; fork notices; survival of a restart; `maxDepth` and `maxTotal` at their
    defaults.
*   A baseline real-model batch on OpenCode 2.3.0 exists before the first removal: every scenario,
    five runs on each of two models.
*   After each removal, the scenarios that still apply pass at the baseline's rate or higher on
    both models. A removal that lowers a rate is reverted or reworked before the next one starts.
*   Uncached input tokens per request and requests per run, as the harness reports them, are no
    higher than the baseline's.
*   A session that holds a group report or a scheduled message when the plugin is updated still
    gets it delivered.
*   A child's report, failure, silent end and ask show the child's title in the parent's
    transcript, where a raw session id shows today.
*   The README states the difference from the host's `subagent` tool as it is on 2.3.0.

## Non-Goals

*   Replacing courier's spawn, send or wake with host subagents or native children.
*   Making every child one kind. `native` stays as a per-spawn choice, so two kinds of child and
    their two report paths remain.
*   Any other new feature.
*   Support for a host other than the pinned one. A different host gets one log line and the
    plugin loads, as today.
*   Usage telemetry.
*   Deleting stored keys. A removed feature's stored data is left in place and no longer read, so
    an older plugin version still works after a rollback.
*   Exporting memory records before memory is removed.
*   Shortening the `courier-orchestrate` skill beyond the sentences that describe removed
    features.

## Open Questions

*   **Is a message's `description` shown to the model?** The transcript line for a courier
    message is the `description` the plugin passes with it. If OpenCode also puts it in the
    model's context, changing it is a model-facing change and needs a real-model run.
*   **`ctrl+x k` during a question**: does the key open the asks dialog while a question is
    showing? If not, that is a bug with its own issue, outside this design.
*   **The README demo**: it shows a join group and must be recorded again after groups go. It
    cannot be recorded on the owner's machine.
*   **Native child in a plugin-made worktree**: unverified. A yes would reopen the replacement
    this design rejects. Checked at each pin bump.
*   **Steering's worth**: whether the two scenarios that use the automatic copy still pass when
    the person asks the child to tell its parent. The removal waits on that measurement.

## Critical User Journeys (CUJs)

### CUJ 1: A parent fans out and is woken by each report

*   **Given**: OpenCode 2.3.0 with the plugin, a session with a task of three independent parts.
*   **When**: The session calls `courier_spawn` three times and ends its turn; each child calls
    `courier_send` with a status when it finishes.
*   **Then**: The parent gets one new turn per report, in the order the reports arrive. Its
    transcript shows one line per report with the child's title and status. The tree panel shows
    three rows marked `✓`. The parent called no listing tool.

### CUJ 2: Parallel edits in worktrees

*   **Given**: A git project with a clean working tree.
*   **When**: A parent starts two children with `isolate: true`; each commits on its branch
    `courier/<session id>` and reports `done` with the branch in its artifacts; the parent merges
    both and calls `courier_cleanup` for each.
*   **Then**: Both worktrees are removed, both branches are merged, and the roster holds neither
    child.

### CUJ 3: A tree is running while the plugin is updated

*   **Given**: A tree started on the release before groups are removed. One child has reported
    into group `pair` and its report is held; the other member still runs. The parent has a
    check-in scheduled with `courier_later`.
*   **When**: OpenCode loads the new plugin version beside the old one.
*   **Then**: At the next scheduler tick the parent is woken with the held report in one message.
    The second child's report arrives by itself when it comes. When it has arrived, the parent's
    check-in is removed and never fires. No stored key was deleted except the delivered group
    entries and the removed check-in.

### CUJ 4: A check-in on a long-running child

*   **Given**: A parent with one child that will run for an hour.
*   **When**: The parent calls `courier_later` for itself with a 30-minute delay and ends its
    turn. The server is stopped after 10 minutes and started again after 40.
*   **Then**: The check-in is delivered once, after the restart. If the child had reported before
    the 30 minutes were up, the check-in would have been removed at that report.

### CUJ 5: The person steers a child

*   **Given**: A running tree; the person opens a child from the tree panel.
*   **When**: The person types "the API key is in `.env.local`, tell your parent".
*   **Then**: The child reads the text in its own session and sends it to its parent with
    `courier_send` without a status. The parent wakes on that message. The plugin itself copies
    nothing to the sessions above.

### CUJ 6: A child asks for permission

*   **Given**: A standalone child that runs a shell command the rules mark `ask`.
*   **When**: The request is raised.
*   **Then**: The footer counts one session waiting on the person, the panel row shows `●` with
    the request, `/asks` lists it, and the top session's model is told and may propose an answer
    with `courier_answer`. This is as today.

## Technical Plan (Architecture)

### What the plugin is after the plan

```text
                         src/index.ts  (composition root)
        ┌───────────────────────┼───────────────────────────┐
        │                       │                           │
     tree/                   person/                   scheduling/
  spawn, send, tree,      permission relay,          courier_later
  stop, cleanup           question relay, forms      (tool + due job)
  roster, reports,        courier_answer             dropCheckIns(session)
  standing lines,         /asks inbox                      ▲
  missed wakes, nudge,         │                           │ port, wired in index.ts
  fork notice, panel           └── imports tree/           │
        │                                                  │
        └── when a parent's last child settles ────────────┘

  platform/  hub, scheduler tick, event stream, storage helpers   (unchanged)
  kernel/    protocol envelope, tool helpers                      (unchanged)

  removed:   memory/ (whole module), tree/group.ts, tree/relay.ts
```

Three of the four feature modules stay. `memory/` goes whole. Inside `tree/`, the group file and
the typed-text relay file go; every other file stays, most of them smaller.

The scheduler keeps two tick jobs in the end state: `dueJob` (scheduled messages) and
`wakeMissed` (re-sending a message that did not wake its session). `deliverReleased` is replaced
by a smaller drain job for a period, then removed.

### The tool surface

| Tool | Change |
|---|---|
| `courier_spawn` | Loses `group`. `native` stays; its description no longer names the `nativeChildren` option. The description loses the group sentence and the instruction to call `courier_cancel`. |
| `courier_send` | Loses `finding` and `queue`. Every message is delivered with `steer`, as an unqueued one is today. The description loses the group and finding sentences. |
| `courier_tree` | Unchanged in output. Its description stops referring to `courier_children`. |
| `courier_stop`, `courier_cleanup` | Descriptions lose their group sentences and mention `courier_tree` where they named `courier_children`. |
| `courier_answer` | Unchanged. |
| `courier_later` | Unchanged in input. Its result no longer tells the model to keep the id for `courier_cancel`. |
| `courier_children`, `courier_cancel`, `courier_recall`, `courier_note` | Removed. |

OpenCode's input repair deletes a parameter a tool does not declare, without an error. A model
that still passes `group`, `finding` or `queue` after the change gets the plain behaviour: a child
that reports by itself, a report without a finding line, a steered message. Nothing fails, and
nothing tells the model. The baseline comparison is the check that this does not lower a pass rate.

### Options

| Option | Change |
|---|---|
| `maxDepth`, `maxTotal` | Unchanged, defaults 5 and 30. |
| `maxChildren` | Removed. The per-session count check in `tree/limits.ts` goes; the tree-wide `maxTotal` check stays. |
| `memory` | Removed. |
| `nativeChildren` | Removed. A child is native only when its spawn passes `native: true`. |

A removed option that is still set in a user's config is ignored without a message, as the
`webhook` option is today. The role line that tells a parent what OpenCode's own turn-end message
is, which the option used to add for every session, is now added only at a parent's first
`native: true` spawn. That path exists today for the option-off case and becomes the only one.

### Stored data

Every key stays as it is in storage; a removed feature's keys are no longer read.

| Key | After the plan |
|---|---|
| `roster/`, `roster-by-child/`, `report/`, `wake/`, `later/`, `question/`, `scheduler/owner` | Unchanged. A roster entry's `group` field is ignored. |
| `group/<parent>/<name>/<session>` | Read only by the drain job, which removes an entry once its report is delivered. Not read after the drain job is removed. |
| `typed/<session>/<inbox id>` | Not written, not read. |
| `memory/…` | Not written, not read. |

The load-time prune (`pruneExpired`) stops cleaning `typed/` entries, since nothing writes them.

### Draining held group reports

Old and new copies of the plugin share one hub in a process, and the scheduler tick runs the code
of the copy loaded last. A new copy with no group code would leave a held report in storage for
good. So groups go in two steps.

*   **Step one.** `group` and `finding` leave the tool schemas. `spawn` no longer joins a group and
    `send` no longer holds a report. `deliverReleased` is replaced by a drain job on the same tick.
    At each tick it reads every `group/` entry, and for each parent and group name that has at
    least one held report it sends the parent one message with those reports, in the wording a
    released group uses today, then removes the delivered entries and the entries of members that
    never reported. It does not wait for the group to be complete or for the parent's turn to end.
    It claims each group in the hub's shared claim set under the key a release uses today, so an
    old copy running the old job and a new copy running the drain do not both deliver.
*   **Step two.** The drain job, `tree/group.ts`, the group store and the group wording are
    deleted. This ships in the first release after the next plugin API pin bump, so the drain is
    in at least one full release cycle.

The drain runs on every tick, not once at load, because an old copy that is still running a tree
can hold a new report after the new copy has loaded. A user who updates from a version before step
one straight to a version after step two keeps any held report in storage, undelivered. The
parent's state lines and `courier_tree` still show that child as reported.

This choice was made by the drafting session at the author's request ("you decide on best
practice"), over a one-time sweep at load and over no delivery at all.

### Dropping check-ins without `courier_cancel`

`tree/standing.ts` already recomputes a parent's children on every event that moves one: a
report, a failed turn, a silent end, a stop, a cleanup, a deletion. That is the one place that
knows when the last child a parent waits on has settled.

`tree/` may not import `scheduling/`. So `index.ts` gives `tree/` a port, `dropCheckIns`, as it
gives `courier_stop` the `cancelScheduled` port today. When a standing sync finds that the parent
has at least one child and none of them still owes a report, it calls the port with the parent's
session id. The port removes every `later/` entry whose sender and target are both that session.

Rules that follow from this:

*   A message a session scheduled for another session is never dropped this way.
*   A message a session scheduled for itself for any other purpose is dropped too, once its last
    child settles. `courier_later`'s description says so.
*   A session with no children keeps its messages: there is no settle event.
*   A check-in scheduled after the last child settled stays until it fires.
*   `courier_stop` keeps cancelling the messages of every session it stops.

The standing sync runs through the hub in whichever copy handles the event, so the port is
optional on the ports type and skipped when an older copy's ports lack it.

### Typed text stays in the child

`tree/relay.ts` is deleted, with the two calls into it from `tree/events.ts`, the `typed/` store
functions and the notice wording. Text typed into a spawned session is an ordinary prompt to that
session and nothing else. The sentence in the `courier-orchestrate` skill that tells a parent what
the copied text is goes with it. No wording is added to tell a child to pass typed text on: the
person asks for that in their own words.

The question relay in `person/` is a different mechanism and is not touched.

### Titles in the transcript

The line a parent's transcript shows for a courier message is the `description` the plugin passes
when it enqueues the message. Today it is built from the session id: `Message from ses_…`,
`Session ses_… failed`, `Session ses_… ended without a report`, `Session ses_… asks for
permission`. The plugin has the child's title in its roster entry at each of these points.

The descriptions change to carry the title and, for a report, the status:

| Today | After |
|---|---|
| `Message from ses_…` (a report) | `<title> reported <status>` |
| `Message from ses_…` (no status, from a child) | `<title> sent progress` |
| `Message from ses_…` (from a parent, or a session not in the roster) | `Message from <title or id>` |
| `Session ses_… failed` | `<title> failed` |
| `Session ses_… ended without a report` | `<title> ended without a report` |
| `Session ses_… asks for permission`, `… no longer asks …`, the two form lines | The same wording with the title |

The envelope inside the message, which the model reads, keeps the session id: the model needs the
id to call `courier_send`, `courier_stop` and `courier_answer`. A title is clipped to 60
characters in a description.

This is a change to the server part only. It was found while drafting: the brief assumed the line
was OpenCode's and that a terminal API might be needed.

### Hosts older than 2.3.0

Removed, because each serves only an older host:

*   The optional `instructions` port (keyed session instructions arrived in 2.2.0). It becomes a
    required port; the cast in `index.ts` and the optional chaining in `spawn.ts`, `standing.ts`
    and `fork.ts` go.
*   The branch in `tree/domain.ts` and `tree/running.ts` that decides whether a session runs when
    `time.busy` is absent (it arrived in 2.2.2), and the matching branch in `tree/wake.ts`.

Kept, although they look like fallbacks:

*   The `try`/`catch` around registering the `experimental.idle` and `fork` hooks. Both hooks are
    experimental on 2.3.0 and may be absent in a later host.
*   The path in `tree/context.ts` that adds the role as a system part. It also serves a fork, a
    failed instruction put and a top session that has not spawned yet.
*   Optional ports that cover an older copy of the plugin in the same process, as opposed to an
    older host. The hub's version rule depends on them.

The version check at load keeps its one log line. The "server part loads on any V2 host from 2.0.4
on" claim in the README and the reference is replaced by the pinned version alone.

### Order of work

Each step is one pull request with its unit tests, its live scenario changes and its part of
`docs/reference.md`. A step that changes a model-facing string comes with a real-model run of the
scenarios it touches, five runs on each of the two baseline models; the whole suite runs once
when the last step is merged.

```text
 0  baseline batch on 2.3.0 (no code change)            ── gate for everything below
 1  memory removed                                       ┐
 2  older-host paths removed                             │
 3  small cuts: courier_children, /courier stop,         │  release A (0.17.0, breaking)
    queue, maxChildren, nativeChildren                   │
 4  groups step one: parameters gone, drain job          │
 5  courier_cancel gone, check-ins dropped by settle     │
 6  titles in the transcript                             ┘
 7  steering removed, after its two scenarios are        ── release B
    rewritten and pass at the baseline's rate
 8  groups step two: drain job gone                      ── first release after the next pin bump
 9  README demo recorded again, without a group          ── with release A if it can be recorded,
                                                            else as soon as it can
```

Steps 1 to 6 are independent of each other except that 3 and 4 both edit the tool descriptions in
`tree/tools.ts` and the snapshot in `test/notices.test.ts`, so they merge one after the other.
Step 5 depends on nothing in step 4.

## Alternatives Considered

### Alternative A: Replace spawn and wake with the host `subagent` tool or native children

*   **Pros**: The largest cut. OpenCode shows the children in its own subagent tab, shows their
    asks in the top session's view, and `/goal` waits for them. A child cannot end silently.
*   **Cons**: OpenCode creates a session with a directory or a parent, never both, so a child in
    its own worktree cannot be a subagent. Depth beyond one level needs a host config change.
    Reports lose their status and their branch name. A child cannot message its parent before its
    turn ends. Spawn limits cannot be enforced. A lost wake is not retried.
*   **Reason for Rejection**: Rejected by author: isolated worktrees are protected, and they rule
    this out. Checked again at each pin bump, in case the host lets a session have both a
    worktree and a parent.

### Alternative B: One kind of child, standalone only (remove `native`)

*   **Pros**: One report path, one set of notices, one case in the panel. No extra parent turn per
    child turn. `opencode run` cannot stall on a native child. Six of seven reviewers proposed it.
*   **Cons**: Loses OpenCode's own "Subagent finished" line in the parent's transcript and the
    subagent tab, which the author uses.
*   **Reason for Rejection**: Rejected by author: the author prefers what a native child shows in
    the terminal. Only the `nativeChildren` option goes. The title change in this design closes
    part of the gap, so this alternative is weighed again once that has shipped.

### Alternative C: Native for every non-isolated child, standalone only for isolated ones

*   **Pros**: Every child that can be a host subagent is one. One reviewer held this is where the
    plugin ends up.
*   **Cons**: Two report paths stay for good, and the choice between them follows a host
    limitation, not anything the user chose. Each native child turn costs every native level
    above it a turn.
*   **Reason for Rejection**: Rejected by author: native stays an opt-in per spawn, off unless
    asked for.

### Alternative D: A worktree tool beside the host `subagent` tool

*   **Pros**: The plugin would shrink to worktree handling and a panel.
*   **Cons**: Nothing in the host shows that a subagent can be placed in another directory, and
    permission requests are kept per location.
*   **Reason for Rejection**: Rejected by author: unverified, and it removes mid-run messages and
    statuses as Alternative A does.

### Alternative E: Isolate every child, host subagents for the rest

*   **Pros**: One courier path, for isolated children only.
*   **Cons**: Every split gains a merge step, including the ones that only read or that write
    files the parent reads directly.
*   **Reason for Rejection**: Rejected by author: it makes the common case slower to remove a
    path.

### Alternative F: Only remove the paths for older hosts

*   **Pros**: No behaviour changes for anyone on 2.3.0. No real-model risk.
*   **Cons**: About 60 to 100 source lines. It changes nothing a model sees.
*   **Reason for Rejection**: Rejected by author as the whole plan: too small. Kept as step 2.

### Alternative G: Options that turn features off, with the code kept

*   **Pros**: Nothing breaks. A user who wants memory or groups turns them back on.
*   **Cons**: The code, its tests and its host-trap notes stay, so the cost per OpenCode release
    does not drop. More options to explain.
*   **Reason for Rejection**: Rejected by author: the aim is less code, not hidden code.

### Alternative H: Two plugins, a core and extras

*   **Pros**: The core is small; memory and scheduling live elsewhere.
*   **Cons**: Both share the hub and the pin, so each OpenCode release costs the same work or
    twice the work. Two packages to install and version.
*   **Reason for Rejection**: Rejected by author: it moves the cost, it does not remove it.

### Alternative I: OpenCode's schedules in place of `courier_later`

*   **Pros**: One tool and a tick job fewer.
*   **Cons**: Host schedules are behind a feature flag that is off in release builds. A plugin
    cannot reach them. A firing carries no sender, does not wait for a running turn to end, and
    `courier_stop` cannot cancel it.
*   **Reason for Rejection**: Rejected by author: not available on a stock 2.3.0.

### Alternative J: Remove scheduling altogether

*   **Pros**: Two tools fewer, and `scheduling/` goes.
*   **Cons**: Nothing follows up a child while the server is down or after a rate limit pauses it.
    The scheduler tick stays anyway, for missed wakes.
*   **Reason for Rejection**: Rejected by author: `courier_later` stays, only `courier_cancel`
    goes.

### Alternative K: Drop a session's check-ins when it sends its own final report

*   **Pros**: The rule is local to the session that scheduled the message.
*   **Cons**: The top session never reports, and it is the main user of check-ins, so its
    check-ins would always fire.
*   **Reason for Rejection**: Rejected by author: the drop happens when the session's last child
    settles.

### Alternative L: No automatic drop of check-ins

*   **Pros**: No new rule. A message scheduled for another purpose is never removed by surprise.
*   **Cons**: A stale check-in wakes its parent for one turn with nothing to do, a full-context
    request each time.
*   **Reason for Rejection**: Rejected by author: the drop on the last child's settle was chosen.

### Alternative M: Remove groups in one release with a one-time delivery at load

*   **Pros**: One release. No job stays behind.
*   **Cons**: An old copy of the plugin still running in the process can hold a report after the
    sweep has run. That report waits until the next server start.
*   **Reason for Rejection**: Rejected by author, who left the choice to the drafting session: a
    job on every tick covers the old copy, at the cost of a second step.

### Alternative N: Remove groups in one release and deliver nothing

*   **Pros**: The least code and no second step.
*   **Cons**: A tree that is mid-run at the update loses the text of its held reports; a person
    has to open each child to read it.
*   **Reason for Rejection**: Rejected by author, who left the choice to the drafting session:
    finished work should not go unseen when a small job prevents it.

### Alternative O: Keep the automatic copy of typed text up the tree

*   **Pros**: A person who forgets to say "tell your parent" is still covered. Two real-model
    scenarios pass with it today.
*   **Cons**: About 130 source lines, a stored key, and a notice that every session above the
    child receives whether the text concerns it or not.
*   **Reason for Rejection**: Rejected by author: a child can send the text up itself when asked.
    The removal waits on the two scenarios passing in their rewritten form.

### Alternative P: One `courier` tool with a mode parameter

*   **Pros**: One tool description where there are seven.
*   **Cons**: A closed schema with a union of inputs is a known trap on the host, and a weaker
    model fills flat tools more reliably.
*   **Reason for Rejection**: Rejected by author: it lowers the count and raises the error rate.

### Alternative Q: Delete the `courier-orchestrate` skill

*   **Pros**: The shortest model-facing surface. Two recursive scenarios pass 3 of 3 with the
    skill denied, in fewer requests.
*   **Cons**: Three scenarios have never been run with the skill denied. Only the skill tells a
    top session to pass a finding on to the parts it affects.
*   **Reason for Rejection**: Rejected by author for now: unmeasured.

### Alternative R: Treat a child's turn end as its report and drop the statuses

*   **Pros**: No reminder to an unreported child, and much less wording.
*   **Cons**: `blocked` and `partial` cannot be told apart from `done`. Every real-model checker
    assumes statuses.
*   **Reason for Rejection**: Rejected by author: the statuses drive the liveness rules.

### Alternative S: Add usage telemetry before cutting anything

*   **Pros**: The cuts would rest on data, not on the absence of it.
*   **Cons**: No infrastructure exists for it, and it is a privacy decision for every user.
*   **Reason for Rejection**: Rejected by author: out of proportion for this plugin.

### Alternative T: Delete a removed feature's stored keys at load

*   **Pros**: No dead data in storage.
*   **Cons**: A rollback to the previous release finds its data gone.
*   **Reason for Rejection**: Rejected by author: keys are left in place and no longer read.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Rollout and rollback.** Release A is a breaking 0.x minor release. Its notes list every
    removed tool, parameter, option and command. Rolling back to the release before it works,
    because no stored key changed shape and none was deleted except delivered group entries and
    dropped check-ins. Memory records written before release A are still there after a rollback.
*   **Token cost.** The goal is fewer model-facing characters per request. The transcript titles
    add none to the model's context if `description` is not shown to the model; that is an open
    question above.
*   **Privacy.** Real-model results are published without the self-hosted model's name, address
    or provider id.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

The file lists come from a search of every tracked file for each feature's names. Each step is one
pull request. A file that several steps touch is listed under each of them, with that step's
change. Every step also updates `test/__snapshots__/notices.test.ts.snap` and, where the terminal
part changes, `test/__snapshots__/tui.test.tsx.snap`, by running `bun test --update-snapshots`
after its text changes; they are not repeated below.

### Target Files to Create/Modify

### Step 0: the baseline

#### 0.1 `docs/maintainers/real-model.md` (Modify)

*   **Type / Scope**: Maintainer documentation.
*   **Proposed Changes**: Replace every results table with one batch run on OpenCode 2.3.0 at the
    commit before step 1: all ten scenarios (`fanout`, `recursive`, `recursive-fault`,
    `recursive-staged`, `recursive-finding`, `recursive-conflict`, `discovery`, `review`,
    `permission`, `question`), five runs each, on two models, described as "a self-hosted model"
    and by the cloud model's public name. Each row gives passes of five, requests per run and
    uncached input tokens per request. The "Running it" text names the two models as the floor
    for every later comparison. No source file changes in this step.

### Step 1: memory

#### 1.1 `src/memory/` (Delete, 17 files)

*   **Type / Scope**: TypeScript module: `domain.ts`, `events.ts`, `forget.ts`, `index.ts`,
    `lessons.ts`, `note.ts`, `pin.ts`, `ports.ts`, `recall.ts`, `record.ts`, `rpc-handlers.ts`,
    `rpc.ts`, `store.ts`, `sweep.ts`, `text.ts`, `tools.ts`, `tui.tsx`.
*   **Proposed Changes**: Delete the module. It holds `courier_recall`, `courier_note`, the tree
    records, the `lessons` text and the memory view.

#### 1.2 `src/index.ts` (Modify)

*   **Type / Scope**: Composition root.
*   **Proposed Changes**: Remove the memory import, the `memory` shared state, `readMemory`, the
    memory ports, `addMemoryTools`, `registerMemoryRpc`, `memoryEvents` in the event modules, the
    record sweep, the listing of model context windows that only memory used, the `entries` port
    and the two tool names passed as `hiddenFromLeaf`. The teardown no longer touches memory
    state.

#### 1.3 `src/rpc.ts`, `src/tui.tsx` (Modify)

*   **Type / Scope**: RPC and terminal entrypoints.
*   **Proposed Changes**: Drop the re-export of the memory RPC contract and the registration of
    the memory view and its `/courier memory` command.

#### 1.4 `src/tree/spawn.ts`, `src/tree/ports.ts`, `src/tree/context.ts`, `src/tree/fork.ts` (Modify)

*   **Type / Scope**: Tree module.
*   **Proposed Changes**: `spawn.ts` stops putting the `lessons` instruction entry. `ports.ts`
    loses the `entries` and `hiddenFromLeaf` ports. `context.ts` loses the code that hides tools
    from a leaf, and where it lists a session's instruction entries it removes a `lessons` entry
    it finds, so a session started before the update stops being told about tools that are gone.
    `fork.ts` removes `lessons` from a fork along with `role` and `standing`.

#### 1.5 `src/tree/text.ts`, `src/skill.ts` (Modify)

*   **Type / Scope**: Model-facing strings.
*   **Proposed Changes**: Remove every sentence that names `courier_recall`, `courier_note` or
    lessons from the role text and the skill.

#### 1.6 `test/memory.test.ts`, `test/memory-rpc.test.ts`, `test/memory-view.test.tsx`, `test/pin.test.ts` (Delete)

*   **Type / Scope**: Unit tests of the deleted module.
*   **Proposed Changes**: Delete.

#### 1.7 `test/plugin.test.ts`, `test/imports.test.ts`, `test/store.test.ts`, `test/fork.test.ts`, `test/events.test.ts`, `test/limits.test.ts`, `test/tui.test.tsx`, `test/notices.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: `plugin.test.ts` asserts the registered tools no longer include the two
    memory tools and that a `memory` option is ignored. `imports.test.ts` drops the rules for
    `memory/`. `store.test.ts` drops the pinned memory keys. `fork.test.ts` expects `lessons`
    removed from a fork. `events.test.ts`, `limits.test.ts` and `tui.test.tsx` drop their memory
    cases. `notices.test.ts` drops `memory/text.ts` from its list. A new case in the `context`
    tests covers the removal of a stale `lessons` entry.

#### 1.8 `e2e/run.sh`, `e2e/mock-model.mjs`, `e2e/tui.sh`, `e2e/probe-plugin/index.js`, `test/e2e-shards.test.ts` (Modify)

*   **Type / Scope**: Live suite.
*   **Proposed Changes**: Remove the `memory` group and its entry in `SUITE`, the lessons checks in
    the `entries` group, the mock's memory replies, the memory-view checks in `tui.sh` and the
    probe's memory hooks. `e2e-shards.test.ts` follows the new `SUITE` counts.

#### 1.9 `e2e/real-model-seed.json`, `e2e/real-model-seed-lesson.json`, `e2e/real-model-seed-lesson-halves.json` (Delete)

*   **Type / Scope**: Real-model fixtures for seeding a record.
*   **Proposed Changes**: Delete.

#### 1.10 `e2e/real-model.sh`, `e2e/real-model-recursive.mjs`, `e2e/real-model-discovery.mjs`, `e2e/real-model-review.mjs`, `script/real-model-table.ts` (Modify)

*   **Type / Scope**: Real-model harness.
*   **Proposed Changes**: Remove the seeding of a record and the checks and table columns for
    recall calls and lesson reads.

#### 1.11 `test/real-model-recursive.test.ts`, `test/real-model-review.test.ts`, `test/real-model-table.test.ts`, `test/fixtures/real-model/pass-a/summary.json`, `test/fixtures/real-model/fail-b/summary.json` (Modify)

*   **Type / Scope**: Tests of the real-model checkers.
*   **Proposed Changes**: Drop the recall and lesson fields and their cases.

#### 1.12 `README.md`, `docs/reference.md`, `docs/maintainers/architecture.md`, `docs/maintainers/plugin-api-notes.md`, `docs/maintainers/real-model.md`, `CLAUDE.md`, `.claude/skills/opencode-release/SKILL.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: README: remove the `memory` option row, the recall and note row of the
    tools table, `/courier memory` and the memory sentence. Reference: remove the Memory section
    and its links. Architecture: remove the memory bullets and the `lessons` entry, and replace
    the three `memory/` storage rows with one sentence that releases up to 0.16.4 wrote those
    keys and nothing reads them now. Real-model: remove "Seeding a record". `CLAUDE.md`: remove
    `memory/` from the layout and the import rule. The release skill: remove its memory mention.

### Step 2: paths for older hosts

#### 2.1 `src/index.ts`, `src/tree/ports.ts`, `src/tree/spawn.ts`, `src/tree/standing.ts`, `src/tree/fork.ts` (Modify)

*   **Type / Scope**: Composition root and tree module.
*   **Proposed Changes**: The `instructions` port is required on a host context: the cast in
    `index.ts` goes and the three files call it without checking for it. It stays optional on the
    hub member type, because an older copy of the plugin in the same process may lack it.

#### 2.2 `src/tree/domain.ts`, `src/tree/running.ts`, `src/tree/wake.ts` (Modify)

*   **Type / Scope**: Session-state logic.
*   **Proposed Changes**: Remove the branch that decides whether a session runs when `time.busy`
    is absent, and the matching branch in the re-send logic.

#### 2.3 `test/limits.test.ts`, `test/standing.test.ts`, `test/watch.test.ts`, `test/wake.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: Remove the cases for a host without `instructions` and for a session
    without `busy`.

#### 2.4 `README.md`, `docs/reference.md`, `docs/maintainers/architecture.md`, `docs/maintainers/plugin-api-notes.md`, `e2e/run.sh` (Modify)

*   **Type / Scope**: Documentation and a live-suite comment-free assertion.
*   **Proposed Changes**: Replace "the server part loads on any V2 host from 2.0.4 on" with the
    pinned version alone, and say a different host gets one log line. Remove the sentences about
    hosts before 2.2.0 and 2.2.2. `run.sh` drops any check that names an older host.

### Step 3: the small cuts

#### 3.1 `src/tree/tools.ts` (Modify)

*   **Type / Scope**: Tool definitions.
*   **Proposed Changes**: Remove the `courier_children` tool and its input schema. Remove `queue`
    from the send schema. `native`'s description no longer names the `nativeChildren` option.
    Every description that named `courier_children` names `courier_tree`.

#### 3.2 `src/tree/send.ts` (Modify)

*   **Type / Scope**: Send use case.
*   **Proposed Changes**: Remove `queue` from the input type; delivery is always `steer`.

#### 3.3 `src/tree/text.ts`, `src/tree/status.ts`, `src/tree/cleanup.ts`, `src/tree/standing.ts` (Modify)

*   **Type / Scope**: Tree module.
*   **Proposed Changes**: Remove `childrenText` and the refusal text for `maxChildren`; the role
    text states only the tree-wide limit. `status.ts` keeps `listChildren`, which the state lines
    use, and loses what only the tool's output needed. Notices in `cleanup.ts` and `standing.ts`
    name `courier_tree`.

#### 3.4 `src/tree/domain.ts`, `src/tree/limits.ts`, `src/tree/index.ts` (Modify)

*   **Type / Scope**: Limits and options.
*   **Proposed Changes**: `Limits` and its defaults lose `maxChildren`; `readLimits` ignores the
    option. `limits.ts` loses the per-session check. `readNativeChildren` is deleted and its
    export removed.

#### 3.5 `src/index.ts`, `src/tree/ports.ts`, `src/tree/spawn.ts`, `src/tree/context.ts` (Modify)

*   **Type / Scope**: The `nativeChildren` option.
*   **Proposed Changes**: Remove the option's reading and the two port fields. In `spawn.ts` a
    child is native when `native` is `true` and it is not isolated, and the role line about
    OpenCode's turn-end message is put at a parent's first native spawn only. In `context.ts`
    that line is added only for a session that has a native child.

#### 3.6 `src/tree/tui.tsx` (Modify)

*   **Type / Scope**: Terminal part.
*   **Proposed Changes**: Remove the `/courier stop` command branch and its part of the usage
    line. The `s` key in the panel is unchanged.

#### 3.7 `test/courier.test.ts`, `test/cleanup.test.ts`, `test/fork.test.ts`, `test/limits.test.ts`, `test/plugin.test.ts`, `test/standing.test.ts`, `test/stop.test.ts`, `test/summary.test.ts`, `test/tui.test.tsx`, `test/real-model.test.ts`, `test/real-model-discovery.test.ts`, `test/real-model-recursive.test.ts`, `test/real-model-review.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: Remove the cases for `courier_children`, `queue`, `maxChildren`, the
    `nativeChildren` option and `/courier stop`. Add: a session may start more than five children
    up to `maxTotal`; a set `maxChildren` or `nativeChildren` option is ignored; a child is native
    only with `native: true`. The checker tests keep "a listing call after a spawn is polling"
    with `courier_tree` as the only listing tool.

#### 3.8 `e2e/run.sh`, `e2e/mock-model.mjs`, `e2e/tui.sh`, `e2e/real-model.sh`, `e2e/real-model.mjs`, `e2e/real-model-recursive.mjs`, `e2e/real-model-discovery.mjs`, `e2e/real-model-review.mjs`, `e2e/real-model-permission.mjs`, `e2e/real-model-question.mjs`, `test/e2e-shards.test.ts` (Modify)

*   **Type / Scope**: Live suite and real-model harness.
*   **Proposed Changes**: `run.sh`: the `rolling-slot` group is rewritten against `maxTotal`; the
    `native` and `spawn-native` groups stop turning the option on and rely on the mock passing
    `native: true`; calls to `courier_children` become `courier_tree`. The mock drops the
    `native: false` pins that existed only because the option stayed on for later groups.
    `tui.sh` drops the `/courier stop` checks. `real-model.sh` loses `COURIER_NATIVE`; the
    permission and question checkers lose their branch for it. The checkers' polling rule lists
    `courier_tree` only.

#### 3.9 `README.md`, `docs/reference.md`, `docs/maintainers/architecture.md`, `docs/maintainers/development.md`, `docs/maintainers/plugin-api-notes.md`, `docs/maintainers/real-model.md`, `CLAUDE.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: README: options table without `maxChildren` and `nativeChildren`, tools
    table without `courier_children`, terminal list without `/courier stop`, and the "Why
    courier" opening corrected to say the host tool also runs in the background and wakes an idle
    parent at a child's turn end. Reference: the same removals, `queue` removed from
    `courier_send`, native children described as a per-spawn choice. Architecture and
    `CLAUDE.md`: the `role` entry's native line is put at a first native spawn, with no option.
    Development and real-model: no `COURIER_NATIVE`.

### Step 4: groups, step one

#### 4.1 `src/tree/tools.ts` (Modify)

*   **Type / Scope**: Tool definitions.
*   **Proposed Changes**: Remove `group` from the spawn schema and `finding` from the send schema.
    Remove the group and finding sentences from the descriptions of `courier_spawn`,
    `courier_send` and `courier_cleanup`.

#### 4.2 `src/tree/spawn.ts`, `src/tree/send.ts` (Modify)

*   **Type / Scope**: Spawn and send use cases.
*   **Proposed Changes**: `spawn.ts` no longer joins a child to a group or stores `group` on its
    roster entry. `send.ts` loses the holding of a report, the early delivery of a finding and
    the release of a held report on `blocked`; every report is delivered at once.

#### 4.3 `src/tree/group.ts` (Modify)

*   **Type / Scope**: Group use case, reduced to the drain.
*   **Proposed Changes**: Keep one exported tick job, `drainHeld(ports, claimed)`: read every
    `group/` entry, group them by parent and name, and for each set with at least one held report
    not already claimed, claim it under `group:<parentID>/<name>`, send the parent one message
    with the held reports in today's group wording, remove the set's entries, sync the parent's
    state lines and release the claim. A set with no held report has its entries removed without
    a message. A parent that no longer exists has its set removed and one line logged. Everything
    else in the file is deleted.

#### 4.4 `src/index.ts`, `src/tree/index.ts` (Modify)

*   **Type / Scope**: Composition root and module surface.
*   **Proposed Changes**: The tick jobs are `dueJob`, `drainHeld`, `wakeMissed`.
    `deliverReleased` is no longer exported.

#### 4.5 `src/tree/domain.ts`, `src/tree/ports.ts`, `src/tree/store.ts`, `src/tree/roster.ts` (Modify)

*   **Type / Scope**: Tree types and storage.
*   **Proposed Changes**: Keep the held-report type and the group store's `all` and `remove`;
    delete membership standing, completeness, `put` and the per-parent reads. A roster entry's
    `group` field stays readable for old entries and is never written.

#### 4.6 `src/tree/standing.ts`, `src/tree/status.ts`, `src/tree/summary.ts`, `src/tree/panel.ts`, `src/tree/rpc.ts`, `src/tree/rpc-handlers.ts`, `src/tree/tui.tsx` (Modify)

*   **Type / Scope**: State lines, listings and the terminal part.
*   **Proposed Changes**: Remove each child's group and group standing from the state lines, the
    tree listing, the summary, the panel rows and the footer. The summary RPC keeps its `groups`
    field as an empty list, so an older terminal part reading a newer server does not fail.

#### 4.7 `src/tree/cleanup.ts`, `src/tree/forget.ts`, `src/tree/nudge.ts`, `src/tree/events.ts`, `src/tree/stop.ts`, `src/tree/wake.ts` (Modify)

*   **Type / Scope**: Tree use cases.
*   **Proposed Changes**: Remove every branch that takes a member out of its group or checks
    whether a group became complete: on cleanup, on forgetting a deleted child, on a reminder, on
    a failed or silent end, on a stop.

#### 4.8 `src/tree/text.ts`, `src/skill.ts`, `src/scheduling/tools.ts`, `src/person/rpc.ts`, `src/person/rpc-handlers.ts`, `src/person/tui.tsx` (Modify)

*   **Type / Scope**: Model-facing strings and the asks inbox.
*   **Proposed Changes**: `text.ts` keeps the wording of a delivered group, for the drain, and
    loses the held, out and finding wording. The skill loses its group rule and its finding
    sentence; "pass what a report says on to the parts it changes" stays, worded for a plain
    report. `courier_later`'s description loses "one per group". The asks inbox drops the group a
    waiting session belongs to.

#### 4.9 `test/group.test.ts` (Modify)

*   **Type / Scope**: Unit test.
*   **Proposed Changes**: Rewritten for `drainHeld`: a complete set is delivered once; an
    incomplete set is delivered with what is held; a set with nothing held is removed silently; a
    set claimed by another copy is skipped; a failed delivery keeps the entries for the next
    tick; a missing parent drops the set.

#### 4.10 `test/courier.test.ts`, `test/cleanup.test.ts`, `test/hub.test.ts`, `test/inbox.test.tsx`, `test/limits.test.ts`, `test/nudge.test.ts`, `test/panel.test.ts`, `test/person-rpc.test.ts`, `test/plugin.test.ts`, `test/roster.test.ts`, `test/standing.test.ts`, `test/stop.test.ts`, `test/store.test.ts`, `test/summary.test.ts`, `test/tui.test.tsx`, `test/watch.test.ts`, `test/real-model-discovery.test.ts`, `test/real-model-recursive.test.ts`, `test/real-model-review.test.ts`, `test/real-model-table.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: Remove the group and finding cases. `courier.test.ts` adds: a `group` or
    `finding` passed by a model is ignored and the child reports by itself. `hub.test.ts` covers
    an old copy's release job and a new copy's drain claiming the same set.

#### 4.11 `e2e/run.sh`, `e2e/mock-model.mjs`, `e2e/tui.sh`, `e2e/kv.ts`, `test/e2e-shards.test.ts` (Modify)

*   **Type / Scope**: Live suite.
*   **Proposed Changes**: Remove the `reports-groups`, `finding`, `finding-up` and
    `decline-seal` groups. Add a `group-drain` group: write a held report under `group/` with
    `kv.ts` before the server starts, start it, and check the parent is woken once with the
    report and the entry is gone. The mock's scenarios lose their `group` arguments. `tui.sh`'s
    first scenario runs two ungrouped children; its footer and row checks lose the group text.

#### 4.12 `e2e/real-model.sh`, `e2e/real-model.mjs`, `e2e/real-model-recursive.mjs`, `e2e/real-model-recursive-release.mjs`, `e2e/real-model-discovery.mjs`, `e2e/real-model-review.mjs`, `script/real-model-table.ts` (Modify)

*   **Type / Scope**: Real-model harness.
*   **Proposed Changes**: Remove the checks that a report was held or released with a group and
    that a finding went ahead. `discovery` and `recursive-finding` check instead that the report
    carrying the value reached the parent and that the parent passed it on.

#### 4.13 `README.md`, `docs/reference.md`, `docs/maintainers/architecture.md`, `docs/maintainers/development.md`, `docs/maintainers/plugin-api-notes.md`, `docs/maintainers/real-model.md`, `CLAUDE.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: README: no join group in "Why courier", "How it works", the tools row or
    the footer example; the demo caption is rewritten in step 9. Reference: the "Join groups"
    section is replaced by a short "Held group reports" section that says a report held by an
    earlier release is delivered at the next scheduler tick. Architecture: the `group/` row says
    it is read only to deliver what is held. Plugin-api-notes: the note on reading a decline from
    the transcript goes. `CLAUDE.md`: "groups" leaves the layout line.

### Step 5: `courier_cancel`

#### 5.1 `src/scheduling/tools.ts`, `src/scheduling/text.ts` (Modify)

*   **Type / Scope**: Scheduling tools and strings.
*   **Proposed Changes**: Remove the `courier_cancel` tool. `courier_later`'s description says a
    message a session schedules for itself is removed once the last session it started has
    reported, failed, ended or been stopped. Its result text no longer mentions an id to cancel.

#### 5.2 `src/scheduling/later.ts`, `src/scheduling/index.ts` (Modify)

*   **Type / Scope**: Scheduling use case.
*   **Proposed Changes**: Add `dropCheckIns(ports, sessionID)`: remove every pending entry whose
    `from` and `sessionID` both equal the given session, and return the removed ids. Export it.
    `cancel` stays, for `cancelScheduled`.

#### 5.3 `src/index.ts`, `src/tree/ports.ts`, `src/tree/standing.ts` (Modify)

*   **Type / Scope**: Composition root and state lines.
*   **Proposed Changes**: `index.ts` passes `dropCheckIns` to the tree's ports, bound to the
    scheduling ports. `ports.ts` declares it as an optional port. `standing.ts`, after it has
    computed a parent's children, calls it when the parent has at least one child and none owes
    a report; a failure is logged and does not fail the sync.

#### 5.4 `src/tree/tools.ts`, `src/tree/text.ts`, `src/tree/stop.ts` (Modify)

*   **Type / Scope**: Model-facing strings.
*   **Proposed Changes**: `courier_spawn`'s description says a check-in is removed when the last
    report arrives, in place of the instruction to cancel it. Notices that named
    `courier_cancel` lose the name.

#### 5.5 `test/later.test.ts`, `test/standing.test.ts`, `test/plugin.test.ts`, `test/hub.test.ts`, `test/fixtures/two-copies.ts`, `test/nudge.test.ts`, `test/panel.test.ts`, `test/stop.test.ts`, `test/watch.test.ts`, `test/imports.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: `later.test.ts`: the cancel-tool cases go; `dropCheckIns` removes only
    self-addressed entries. `standing.test.ts`: the port is called when the last child settles by
    each route (report, failure, silent end, stop, cleanup), not while one still owes, not for a
    session with no children, and not when the port is absent. The rest update fake ports and
    tool lists.

#### 5.6 `e2e/run.sh`, `e2e/mock-model.mjs`, `e2e/real-model.mjs`, `e2e/real-model-recursive.mjs`, `e2e/real-model-review.mjs`, `test/e2e-shards.test.ts` (Modify)

*   **Type / Scope**: Live suite and real-model harness.
*   **Proposed Changes**: The `later` group drops its cancel checks. The `own-checkin` group
    checks that a parent's check-in is gone from storage after its child's report and never
    arrives; it waits on the report, then reads the key once. The checkers stop expecting a
    `courier_cancel` call.

#### 5.7 `README.md`, `docs/reference.md`, `docs/maintainers/architecture.md`, `CLAUDE.md`, `docs/social-preview.py`, `docs/social-preview.png` (Modify)

*   **Type / Scope**: Documentation and the preview image.
*   **Proposed Changes**: Tools table and "Scheduled messages" without `courier_cancel`, with the
    drop rule and its side effect on other self-scheduled messages. The preview script's tool
    list is corrected and the image rendered again.

### Step 6: titles in the transcript

#### 6.1 `src/tree/text.ts` (Modify)

*   **Type / Scope**: Strings.
*   **Proposed Changes**: Add the description builders: `<title> reported <status>`, `<title> sent
    progress`, `Message from <title or id>`, `<title> failed`, `<title> ended without a report`.
    A title is clipped to 60 characters; a missing title falls back to the session id.

#### 6.2 `src/tree/send.ts`, `src/tree/events.ts`, `src/tree/nudge.ts` (Modify)

*   **Type / Scope**: Tree use cases.
*   **Proposed Changes**: Use the builders where a description is built from a session id today.
    `send.ts` reads the sender's roster entry, which it already has when the sender is a child of
    the target. The envelope text is unchanged.

#### 6.3 `src/person/text.ts`, `src/person/events.ts`, `src/person/form.ts` (Modify)

*   **Type / Scope**: Person module.
*   **Proposed Changes**: The four descriptions for a permission request and a form carry the
    child's title, read through `tree/index.ts`.

#### 6.4 `test/courier.test.ts`, `test/limits.test.ts`, `test/store.test.ts`, `test/wake.test.ts`, `test/tui.test.tsx`, `test/person.test.ts`, `test/permission.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: Expect the new descriptions; add a clipped title and a missing title.

#### 6.5 `e2e/run.sh`, `e2e/tui.sh`, `e2e/real-model.mjs`, `e2e/real-model-recursive.mjs`, `e2e/real-model-discovery.mjs`, `e2e/real-model-review.mjs`, `e2e/real-model-permission.mjs`, `e2e/real-model-question.mjs`, `script/record-gif.sh` (Modify)

*   **Type / Scope**: Live suite, real-model harness and the demo script.
*   **Proposed Changes**: Every match on `Message from ses_` or `Session ses_` in a description
    follows the new wording. `tui.sh` adds a check that the parent's view shows `<title> reported
    done`.

#### 6.6 `docs/reference.md`, `docs/maintainers/plugin-api-notes.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: The reference states what each transcript line reads. The notes record
    whether a message's `description` reaches the model, once checked.

### Step 7: steering

#### 7.1 `src/tree/relay.ts` (Delete)

*   **Type / Scope**: The copy of typed text up the tree.
*   **Proposed Changes**: Delete.

#### 7.2 `src/tree/events.ts`, `src/tree/ports.ts`, `src/tree/store.ts`, `src/tree/roster.ts`, `src/tree/text.ts`, `src/skill.ts` (Modify)

*   **Type / Scope**: Tree module and the skill.
*   **Proposed Changes**: `events.ts` loses the two calls into the relay. The child store loses
    its `typed` functions and prefix, and `roster.ts` loses the prune of orphaned typed entries.
    `text.ts` loses the typed-text notice. The skill loses the sentence that explains it.

#### 7.3 `test/watch.test.ts`, `test/store.test.ts`, `test/inbox.test.tsx`, `test/imports.test.ts`, `test/tui.test.tsx`, `test/real-model-recursive.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: Remove the relay cases and the pinned `typed/` key. `watch.test.ts` adds:
    a prompt typed into a spawned session enqueues nothing for the sessions above it.

#### 7.4 `e2e/run.sh`, `e2e/tui.sh`, `e2e/two-servers.sh`, `e2e/real-model.sh`, `e2e/real-model-recursive.mjs`, `e2e/real-model-recursive-release.mjs`, `test/e2e-shards.test.ts` (Modify)

*   **Type / Scope**: Live suite and real-model harness.
*   **Proposed Changes**: The `person-up` and `person-message` groups are replaced by one group in
    which the typed text asks the child to tell its parent and the parent is woken by the child's
    `courier_send`. `recursive-finding` and `recursive-conflict` type the same request into the
    child and check the parent passed it on. `two-servers.sh` and `tui.sh` drop what they assert
    about copied text.

#### 7.5 `README.md`, `docs/reference.md`, `docs/maintainers/architecture.md`, `docs/maintainers/development.md`, `docs/maintainers/plugin-api-notes.md`, `docs/maintainers/real-model.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: The README tip and the reference's "Steering a running tree" say: type
    into the child and ask it to tell its parent. Architecture: the `typed/` row goes, with one
    sentence that earlier releases wrote the key. Real-model: the two scenarios' descriptions and
    their new rows.

### Step 8: groups, step two

#### 8.1 `src/tree/group.ts` (Delete), `test/group.test.ts` (Delete)

*   **Type / Scope**: The drain job and its test.
*   **Proposed Changes**: Delete.

#### 8.2 `src/index.ts`, `src/tree/index.ts`, `src/tree/domain.ts`, `src/tree/ports.ts`, `src/tree/store.ts`, `src/tree/text.ts`, `src/tree/rpc.ts` (Modify)

*   **Type / Scope**: What the drain kept alive.
*   **Proposed Changes**: Two tick jobs remain. The held-report type, the group store, the group
    prefix, the delivered-group wording and the summary's empty `groups` field are removed.

#### 8.3 `test/hub.test.ts`, `test/store.test.ts`, `test/summary.test.ts`, `e2e/run.sh`, `test/e2e-shards.test.ts` (Modify)

*   **Type / Scope**: Tests.
*   **Proposed Changes**: Remove the drain cases and the `group-drain` live group.

#### 8.4 `docs/reference.md`, `docs/maintainers/architecture.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: Remove "Held group reports". The storage table's `group/` row becomes
    one sentence that earlier releases wrote the key and nothing reads it.

### Step 9: the demo

#### 9.1 `script/record-gif.sh`, `script/demo-lib.sh`, `script/render-gif.py`, `docs/demo.gif`, `README.md` (Modify)

*   **Type / Scope**: Demo recording.
*   **Proposed Changes**: The demo's two leads report one by one, with no group. The GIF is
    recorded again and the README caption and alt text describe what it shows.

### Releases

#### R.1 `package.json`, `README.md`, `docs/reference.md` (Modify)

*   **Type / Scope**: Version and the generated compatibility tables.
*   **Proposed Changes**: Release A sets the version to 0.17.0 after steps 1 to 6; release B
    follows step 7; step 8 ships in the first release after the next pin bump. The version tables
    are regenerated by `script/compat-table.ts`, never edited by hand. Each release follows
    `docs/maintainers/releasing.md`, and release A's notes list every removed tool, parameter,
    option and command with what to do in its place.

### Verification Plan

*   **Compilation/Build**: `bun run typecheck` and `bun run build` on every step.
*   **Unit Tests**: `bun test`; `bun test --update-snapshots` after a text change, with the
    snapshot diff read in review. `test/imports.test.ts` and `test/links.test.ts` must pass after
    each deleted file and each removed doc section.
*   **Static Analysis & Linting**: `bun script/compat-table.ts --check`; the SonarCloud job in CI.
*   **Test Coverage Requirement**: No numeric bar. Every changed behaviour has a unit test and a
    live scenario, as `CLAUDE.md` requires.
*   **E2E/Integration**: `npm run test:e2e` in four shards and `e2e/tui.sh`, both in CI on every
    pull request; `e2e/two-servers.sh` on steps 4, 5 and 7.
*   **Real model**: `e2e/real-model.sh` in the sandbox. Step 0 runs all ten scenarios, five runs
    each on both models. Each later step that changes a model-facing string runs the scenarios it
    touches, five runs each on both models, and puts the result in its pull request. After step 7
    the whole suite runs once and replaces the tables in `real-model.md`.
*   **Pass criteria**: For each scenario and model, passes of five are no lower than the
    baseline's. Requests per run and uncached input tokens per request are no higher than the
    baseline's mean. A step that misses is not merged.
*   **Manual check**: After step 6, one parent with one native and one standalone child in the
    terminal: both rows show `✓` in the panel and both reports show the child's title in the
    parent's transcript.

--------------------------------------------------------------------------------

*Drafted with EGM*
