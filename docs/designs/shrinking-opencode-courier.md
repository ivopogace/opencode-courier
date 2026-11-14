# Shrinking opencode-courier

*   **Author:** Ivo Pogace
*   **Status:** Proposed
*   **Date:** 2026-11-14

--------------------------------------------------------------------------------

## Overview

opencode-courier is an OpenCode V2 plugin that lets one session start others, end its turn, and be
woken when they report. It has grown to 11 model-facing tools, five server options, a terminal
part with a tree panel and four commands, a memory of earlier trees, scheduled messages, a relay for a child's
permission requests and questions, and two kinds of child session.

This design removes the parts that have no known user, that another part already covers, or
that only serve a host older than the pinned one. The tool list goes from 11 to 8 and the options
from five to three, in one breaking release, 0.17.0. It adds no feature. The plugin is pinned to OpenCode 2.3.0, and "the host" below means OpenCode.

### The tools today

| Tool | What it does | After this design |
|---|---|---|
| `courier_spawn` | Starts a child session on a task and returns at once. | Kept |
| `courier_send` | Sends a message to a session and wakes it if it is idle. With a status it is a child's report to the session that started it. | Kept |
| `courier_tree` | Lists every session under a session, with each one's state. | Kept |
| `courier_children` | Lists only the sessions a session started itself. | Removed |
| `courier_stop` | Stops a session and everything under it. | Kept |
| `courier_cleanup` | Removes an isolated child's git worktree and forgets the child. | Kept |
| `courier_answer` | Lets the top session propose an answer to a child's permission request, or pass on the person's answer to a child's question. | Kept |
| `courier_later` | Schedules a message for a session at a later time. | Kept |
| `courier_cancel` | Drops a scheduled message. | Kept |
| `courier_recall` | Reads what earlier trees in the project did. | Removed |
| `courier_note` | Writes a one-line lesson about the current tree. | Removed |

### Terms used here

*   **Tree, parent, child, top session.** A session that starts others is their parent; the
    sessions it starts are its children. The whole set is a tree, and the session the person
    started is its top.
*   **Report and status.** A child's `courier_send` to its parent with one of four statuses:
    `done`, `partial`, `blocked` or `failed`. A message without a status is progress.
*   **Wake.** A message that starts a new turn in an idle session. A wake is *missed* when the
    message arrives and no turn starts; the plugin sends it once more and then marks the session
    `stalled`.
*   **Brief and role line.** The brief is the text a child gets with its task: who started it and
    how to report. The role line is the part of a session's instructions that says what it is in
    the tree and what it may start.
*   **State lines.** One line per child in a parent's instructions, giving that child's state,
    kept current so the parent need not call a listing tool.
*   **Instruction entry.** A named piece of text the plugin attaches to a session's system
    prompt through the host. The host interface for this is called the instructions port below;
    it exists from OpenCode 2.2.0 on. Where an entry cannot be used, the plugin adds the same
    text to each request as a system part, through a hook that runs before every request. That
    is the fallback path: it serves a session whose entry could not be written, a fork, and a
    top session before its first spawn.
*   **Roster.** The stored list of each session's children.
*   **Notice.** A message the plugin itself sends to a session, for example that a child failed
    or ended without a report.
*   **Reminder.** When a child is about to end its turn without having reported, the plugin
    reminds it once, in the same turn. If it still does not report, its parent gets a notice. The
    code calls this the nudge. Together with the missed-wake retry and `stalled`, these are the
    liveness rules: how the plugin notices that a session went quiet.
*   **The `courier-orchestrate` skill.** A text the plugin offers to every session through
    OpenCode's skill list. It tells a model when to split a task and how to check and merge the
    parts. A real-model run can deny it, to see what a model does without it.
*   **Isolated child.** A child started with `isolate: true`. It runs in a git worktree and on a
    branch of its own.
*   **Standalone and native children.** A standalone child is an ordinary top-level OpenCode
    session that the plugin tracks as a child. A native child is created with the parent's id as
    its host-level parent, which makes it a subagent in OpenCode's own terms: OpenCode lists it
    under the parent, shows its permission prompts in the parent's view, and writes its own
    message into the parent when the child's turn ends. An isolated child cannot be native. The
    `nativeChildren` option makes every non-isolated child native unless its spawn says
    otherwise; it is off by default. OpenCode also has a `subagent` tool of its own, which a
    model calls directly and which the plugin does not control.
*   **Join group.** Children started with the same `group` name. A member's report is *held*
    in storage and not delivered when it is sent. Once every member has reported and the
    parent's turn has ended, the group is *released*: the parent gets all the reports in one
    message and one wake.
*   **`finding`.** A parameter of a report: a sentence or two that other parts of the job need.
    Inside a group it is delivered to the parent at once, ahead of the held report.
*   **Memory.** After a tree finishes, the plugin stores a record of it for the project: its
    parts, their outcomes and cost. `courier_recall` reads those records in a later tree,
    `courier_note` adds a one-line lesson to the current tree's record, and the `lessons`
    instruction entry puts the project's lessons into the prompt of each session that may start
    others. `/courier memory` shows the records in the terminal.
*   **Check-in.** A message a session schedules for itself with `courier_later`, to look at its
    children again in case their reports never come.
*   **Typed-text copy.** When the person types into a child's own session, the plugin sends a
    copy of the text to each session above that child.
*   **Fork notice.** A message to a session that was forked from one in a tree, saying that the
    children it reads about belong to the original.
*   **Footer, tree panel, `/asks`.** The terminal part: a one-line summary under the prompt, a
    panel that draws the tree (`/courier tree`), and a dialog of every permission request and
    question waiting on the person.
*   **Hub and tick.** OpenCode loads one copy of the plugin per project folder, and after an
    update an old and a new copy side by side. The hub is the state they share in one process.
    The tick is the hub's timer, every 15 seconds, which runs the periodic jobs.
*   **Scripted model and real model.** The live test suite runs against a mock model that
    replies from a script. The real-model checks run ten scenarios against an actual model and
    score each run with a checker.

## The Problem

Four costs grow with the plugin's size.

1. **Each OpenCode release costs work.** The plugin is pinned to one host version. Every bump
   means re-checking each behaviour that rests on something the host does not promise. The file
   that tracks those behaviours, `docs/maintainers/plugin-api-notes.md`, has 692 lines.
2. **Every request carries text for features the session may not use.** A session that may
   start others gets 11 tool descriptions and schemas and a role line on every request, and a
   parent also gets one state line per child. A session at the deepest level gets eight of the
   tools. Every session is offered the skill and pays for its text once it loads it. In the real-model checks, a call to a listing tool after a spawn
   already counts as a failure, yet two listing tools are offered.
3. **Parts of it duplicate each other.** `courier_children` returns a subset of `courier_tree`.
   `/courier stop` does what the `s` key in the panel does. Outside a join group, the `finding`
   parameter does what a message without a status already does; inside one, it exists to get
   past the held report.
4. **The README has more to list, and one part of it is out of date.** It lists five options, 11
   tools and four terminal commands (`/courier tree`, `/courier stop`, `/courier memory` and
   `/asks`), and its account of the host's `subagent` tool describes that tool as it was, not as
   it is in 2.3.0.

This design addresses the second, third and fourth costs, and only a small part of the first.
The longest section of that notes file is the one on native children, which stay here (see
Non-Goals).

No usage data exists for any feature. The evidence is what the author uses, what the test
scenarios exercise, and what the repository's issues show. The author does not use memory, join
groups or the `nativeChildren` option outside the README demo and the tests, and no issue from
anyone else mentions them.

The author requires two features to stay. The `/courier tree` panel is the only view of a whole
tree, and it is where the person opens a session, stops one or sees what waits on them. Isolated
worktrees (`isolate: true` with `courier_cleanup`) are the only way two children can edit the
same files at once. Courier's own spawn and wake cannot be replaced by OpenCode's subagents while
isolated worktrees stay (Alternative A), so the cuts come from around them.

## Goals

*   The model-facing tool list is exactly `courier_spawn`, `courier_send`, `courier_tree`,
    `courier_stop`, `courier_cleanup`, `courier_answer`, `courier_later` and `courier_cancel`.
*   Removed: memory (`courier_recall`, `courier_note`, the `memory` option, `/courier memory`, the
    `lessons` instruction entry), join groups (the `group` parameter) and the `finding`
    parameter, `courier_children` as a separate tool, `/courier stop`, the `queue` parameter of
    `courier_send`, the `nativeChildren` option, and the paths listed under "Hosts older than
    2.3.0".
*   Kept: `courier_spawn` with `isolate`, `agent`, `model`, `variant`, `title` and `native`; the
    four report statuses (`done`, `partial`, `blocked`, `failed`); `courier_cancel`; the
    typed-text copy; the tree panel, the footer and `/asks`; missed-wake retries and `stalled`;
    the reminder; the state lines; fork notices; survival of a restart; `courier_spawn` hidden
    from a session at the deepest level; `maxDepth`, `maxChildren` and `maxTotal`, with their
    defaults unchanged. Two things change in what is kept. Group names and group standing leave
    `courier_tree`'s output, the state lines, the panel rows, the footer and the `/asks` rows.
    The kinds of text named under "Model-facing text that changes" lose their mentions of
    removed tools and groups.
*   The server options are `maxDepth`, `maxChildren` and `maxTotal`. The README's tools table
    names the eight tools above, and its terminal list has `/courier tree` and `/asks` only.
*   The README states the difference from the host's `subagent` tool as it is on 2.3.0.
*   `docs/maintainers/plugin-api-notes.md` loses every sentence that names a removed tool,
    parameter, option, stored key or the release of a group, and gains none. Examples are the
    sentence on sealing a group, the `lessons` entry and the two memory tools. The note that a
    declined permission prompt records no turn end stays: the group release relied on that
    behaviour, and so does the check for whether a session's turn is running.
*   The character count of all tool descriptions and schemas is lower on the integration
    branch than on main by at least the size of the three removed tools and the three removed
    parameters.
*   The real-model check is run on main and on the integration branch, and its numbers are in
    the pull request that takes the branch to main.
*   A scheduled message that is pending when the plugin is updated is still delivered.
*   Each removed option that is present in the config, whatever its value, is reported in one
    log line at load. The lines go at the next breaking release.
*   After the last removal step, no model-facing string and no tool description contains a
    removed name. "Model-facing text that changes" lists the names, and a test checks them.

## Non-Goals

*   Replacing courier's spawn, send or wake with host subagents or native children.
*   Deciding whether `native` stays. It stays as a per-spawn choice here. Its removal would take
    out the longest list of host behaviours in the maintainer notes, and is left to a design of
    its own.
*   Removing `courier_cancel` or the typed-text copy. Both were weighed and are under
    "Alternatives Considered".
*   Any new behaviour beyond the log line for a removed option, including the two under "Future
    Improvements".
*   Migrating a running tree's group or memory state across the update. The release notes say to
    let running trees finish first; "Sessions that exist at the update" lists what such a
    tree meets.
*   Support for a host other than the pinned one. A different host gets one log line and the
    plugin loads, as today.
*   Usage telemetry.
*   Deleting stored keys. A removed feature's stored data is left in place and no longer read.
*   Exporting memory records before memory is removed.
*   Shortening the `courier-orchestrate` skill beyond the sentences that describe removed
    features.

## Open Questions

None.

## Critical User Journeys (CUJs)

### CUJ 1: A parent fans out and is woken by each report

*   **Given**: OpenCode 2.3.0 with the plugin, a session with a task of three independent parts.
*   **When**: The session calls `courier_spawn` three times and ends its turn; each child calls
    `courier_send` with a status when it finishes.
*   **Then**: Each report that reaches the parent while it is idle starts a new turn; one that
    arrives while a turn runs is read in that turn. Reports are read in the order they arrive.
    The tree panel shows three child rows marked `✓`. The parent calls no listing tool.

### CUJ 2: A tree is running while the plugin is updated

*   **Given**: A tree started on the release before this one. One child has reported into group
    `pair` and its report is held; the other member still runs. The parent has a check-in
    scheduled with `courier_later`. The person updates without waiting for the tree to finish,
    against the release notes.
*   **When**: OpenCode loads the new plugin version.
*   **Then**: The held report is not delivered. The tree panel and `courier_tree` show that child
    as reported, and the person reads its text by opening the child. The second child's report
    is delivered alone, as soon as it is sent, if its `courier_send` runs in the new copy of the
    plugin; if it runs in the old copy, which stays loaded for a time, it is held too. The
    check-in is delivered at its time. No key of a removed feature is deleted.

### CUJ 3: A config that still sets a removed option

*   **Given**: A global config whose courier entry sets `memory`, `nativeChildren` and
    `maxChildren: 5`.
*   **When**: OpenCode starts with the new version.
*   **Then**: The plugin loads and logs one line for each of the two removed options, saying it
    is not read and, for `nativeChildren`, what to do. `maxChildren` applies as before. A child is native only when its
    spawn passes `native: true`.

### CUJ 4: A model that still passes a removed parameter

*   **Given**: A session whose transcript holds the earlier brief and skill text, which tell it
    to use `group` and `finding`.
*   **When**: It calls `courier_spawn` with `group`, or `courier_send` with `finding` or `queue`.
*   **Then**: When the call runs in the new copy of the plugin, OpenCode drops the parameter
    before the tool runs, and no error is raised. Without
    `group`, the child's report is delivered alone and not held. Without `finding`, the report
    carries no finding line. Without `queue`, the message is delivered at once.

## Technical Plan (Architecture)

### What the plugin is after the plan

```text
                         src/index.ts  (composition root)
        ┌───────────────────────┼───────────────────────────┐
        │                       │                           │
     tree/                   person/                   scheduling/
  spawn, send, tree,      permission relay,          courier_later
  stop, cleanup           question relay, forms      courier_cancel
  roster, reports,        courier_answer             (due job)
  state lines,            /asks inbox
  missed wakes, reminder,      │
  typed-text copy,             └── imports tree/
  fork notice, panel

  platform/  hub, scheduler tick, event stream, storage helpers   (unchanged)
  kernel/    protocol envelope, tool helpers                      (unchanged)

  removed:   memory/ (whole module), tree/group.ts
```

Three of the four feature modules stay. `memory/` goes whole. Inside `tree/`, the group file
goes; every other file stays, several of them smaller. No module gains a dependency on another.

The scheduler keeps two of its three periodic jobs: delivering scheduled messages that are due,
and re-sending a message that did not wake its session. The job that released complete groups is
removed. The three interfaces the server offers the terminal part become two: the one for the
memory view goes, and the tree and summary ones lose their group fields.

### The tool surface

| Tool | Change |
|---|---|
| `courier_spawn` | Loses `group`. `native` stays; its description no longer names the `nativeChildren` option. The description loses its group sentences. |
| `courier_send` | Loses `finding` and `queue`. Every message is delivered as an unqueued one is today. The description loses the group and finding sentences. |
| `courier_tree` | Its output loses each session's group and group standing. Its description stops referring to `courier_children`. |
| `courier_stop`, `courier_cleanup` | Descriptions lose their group sentences and name `courier_tree` where they named `courier_children`. |
| `courier_later` | Unchanged in input and behaviour. Its description loses "one per group". |
| `courier_answer`, `courier_cancel` | Unchanged. |
| `courier_children`, `courier_recall`, `courier_note` | Removed. |

Today a message is delivered in one of two ways. Steered, the default, the target reads it at its
next step, after the tool call it is running returns. Queued, with `queue: true`, the target
reads it only after its current turn has ended. `queue` goes as a part with no known user: the
author does not pass it, no issue mentions it and no test scenario relies on it. Its own
description is the only text that tells a model when to use it.

A spawn that passes both `isolate: true` and `native: true` is refused with a message, as today.

Removing the `finding` parameter does not remove the behaviour it stood for outside a group. A
spawned session's brief already tells it to send what other parts need to its parent at once,
with `courier_send` without a status. That rule stays.

A session at the deepest level is not offered `courier_spawn`, as today. The two memory tools,
which were hidden from it the same way, no longer exist.

### Model-facing text that changes

The tool descriptions are not the only text a model reads. Six kinds of text name a removed tool,
a join group or the `finding` parameter today: the role line, the brief, the state lines, the
results and errors of the tools, the notices the plugin sends to a parent, and the
`courier-orchestrate` skill. Each loses those mentions, and every session in every real-model
scenario receives at least one of them. The implementation plan lists the strings one by one.

Two strings are reworded, not just shortened:

*   The refusal a session gets at the tree-wide limit when none of its own children counts says
    today that "only reports already held for a group can still wake you". It becomes "no report
    is still due to you".
*   The brief's rule on what other parts need keeps its first half, "send it to the parent at
    once with `courier_send` without a status", and loses the half about the `finding` parameter.

A list of strings built by search can miss one. So the last removal step adds a test over every
model-facing string and tool description. It fails if any contains one of the removed names:
`courier_children`, `courier_recall`, `courier_note`, `nativeChildren`, `lessons`, "join group",
or `finding` or `queue` as a parameter name. The test, not a list, is what shows the removal is
complete. It does not forbid the plain word "finding", which the brief and the skill still use
for what one part learns that others need.

### Options

| Option | Change |
|---|---|
| `maxDepth`, `maxChildren`, `maxTotal` | Unchanged, defaults 5, 5 and 30. |
| `memory` | Removed. |
| `nativeChildren` | Removed. A child is native only when its spawn passes `native: true`. |

A removed option that is present in the config is not read, whatever its value. At load the
plugin logs one line for it, through the path that logs an option with a bad value today. For
`nativeChildren` the line says the option is not read and that a spawn asks for a native child with `native: true`. That option
changed how a kept feature behaves: with it on, a user's non-isolated children were native, and
after the update they are standalone, so their permission prompts move from OpenCode's view to
`/asks` and they leave OpenCode's subagent tab. For `memory` the line says the option and the
feature are gone.

Today, when a native child's turn ends, OpenCode writes a message of its own into the parent,
beside the child's courier report. A parent that may have native children carries one sentence
in its role line saying what that message is, so it does not take it for the report. With the
option on, every session that can start others gets that sentence. With the option gone, a
parent gets it at its first `native: true` spawn. That path exists today for the option-off case
and becomes the only one.

### What the README says about the host's `subagent` tool

The README says today that the host's tool "hands back a child's final answer" and that courier
is for more than that. On 2.3.0 the host's tool also runs its child in the background, wakes an
idle parent when the child's turn ends, and shows a subagent's permission prompts in the top
session's view. The README is corrected to say so, and to name what courier adds on top: a
message from a child before its turn ends, a status and a branch name in its report, a child in
a git worktree of its own, more than one level of children without a host config change, and a
standalone child's permission request or question reaching the person through the top session.

### Stored data

Every key stays as it is in storage; a removed feature's keys are no longer read.

| Key | After the plan |
|---|---|
| `roster/`, `roster-by-child/`, `report/`, `wake/`, `later/`, `question/`, `typed/`, `scheduler/owner` | Unchanged. A roster entry's `group` field is ignored. |
| `group/<parent>/<name>/<session>` | Not written, not read. |
| `memory/…` | Not written, not read. |

### Sessions that exist at the update

No code migrates a removed feature's state. A tree that used no join group keeps running at the
update: later reports arrive, scheduled messages fire and the stored list of children stays. A
tree with a join group can stop in part, as listed below. The release notes say to let running
trees finish first; OpenCode does not show release notes when it updates a plugin, so a person
may read that advice only afterwards.

What such a tree meets:

*   **A report held in a join group stays in storage, undelivered.** The new version has no group
    code. The child's state line, `courier_tree` and the panel show it as reported, since that
    comes from the report keys, not the group keys. Its text is in the child's own session, and
    a message to the child asking it to report again brings it to the parent.
*   **A group whose members have all reported, but which was not yet released, never wakes its
    parent.** No message is waiting for the parent, so no row shows `stalled`. A parent that is
    itself a child still owes its own report, so it keeps a slot in its own parent's
    `maxChildren` and in the tree's `maxTotal`. With a person watching, they see every child as
    reported and the parent idle, and have to prompt the parent. In an unattended tree, or where
    the parent is itself a child, nothing prompts it and that part of the tree stops.
*   **The old copy of the plugin can hold more.** OpenCode keeps the old copy loaded beside the
    new one for a time this design does not bound. A `courier_send` that runs in it can hold one
    more report, and a `courier_spawn` with `group` that runs in it can start a group that
    nothing releases. Both end as the cases above.
*   **A parameter the tools dropped is ignored**, as CUJ 4 describes. The text of a `finding` is
    lost, and nothing tells the model.

One leftover reaches further than running trees. A session that may start others, in a project
where `courier_note` had written a lesson, got a `lessons` instruction entry. The entry survives
compactions and forks and names `courier_recall`. Such a session keeps it after the update,
including the top session of a finished tree that the person goes on using, and a call to the
tool fails as unknown. Nothing removes the entry: that would be code to migrate a removed
feature's state, which this design does not write.

A scheduled message is different: `courier_later` stays, so a pending message is delivered as
before.

The terminal part and the server part ship in one package, but a terminal that was open before
the update still runs the old terminal part. Its memory view calls an interface the new server no
longer registers, and shows its existing error for a failed call. Its tree panel and footer read
group fields that are no longer sent, and show no group.

### Hosts older than 2.3.0

Removed, because it serves only an older host:

*   The branch that decides whether a session runs when the host gives no `busy` time (it arrived
    in 2.2.2), and the matching branch in the re-send logic. A session that has not run since its
    host was upgraded has an `idle` time and no `busy` time; after the change the plugin reads it
    as idle, which is correct.

Kept, although they look like fallbacks:

*   Every check for a missing instructions port. Without the port a spawn falls back to adding
    the role as a system part. Removing the check would make that spawn fail instead, after its
    session and worktree exist, and the maintainer notes say the port's location in the host API
    may move in a later release.
*   The guard around registering the `experimental.idle` and `fork` hooks. Both are experimental
    on 2.3.0 and may be absent in a later host.
*   The system-part path itself. It also serves a fork, a session whose instruction entry could
    not be written and a top session that has not spawned yet.
*   The plugin's own filter that drops an event of a type it did not ask for. A host that ignores
    the filter it is given may be a newer one.

The version check at load keeps its one log line. The "server part loads on any V2 host from 2.0.4
on" claim in the README and the reference is replaced by the pinned version alone.

### The real-model check

The check compares real-model runs of the plugin before and after the removals. It informs the
decision to release; it does not make it. Five runs per scenario cannot tell a small drop from
chance, and the repository's own floor for a claim about how models behave is five finished runs
on each of two models. So the numbers are reported and the author decides.

*   **When.** Once, when every step is merged into the integration branch. The steps do not
    touch main, so main's head is the "before" and the branch's head is the "after", and both can
    be run in the same days.
*   **What.** All ten scenarios, five finished runs each, on each side. A run that ends on a
    provider limit is repeated. The two sides are run in turn, scenario by scenario, so that a
    change in the model or its load falls on both.
*   **Model.** One model, whichever of the two available ones can be reached: a self-hosted one,
    or a free cloud one with a daily request limit. Both sides use it.
*   **Settings.** The harness defaults on both sides: no memory record seeded beforehand, native
    children not turned on, the `courier-orchestrate` skill offered.
*   **One checker for both sides.** The checkers are not narrowed in this design. Every way a
    run of main could pass stays accepted: a report held in a group, a finding sent ahead, a
    look through `courier_children`, the top session's one `courier_recall`. A run of the branch
    cannot take those ways, because the tools and parameters are gone. So the branch's checkers
    score both sides.
*   **What is reported.** Per scenario, for each side: passes of five, median requests per run
    and median uncached input tokens per request, and how many runs used a group, a finding or
    `courier_recall`. The character count of all tool descriptions and schemas is taken on each
    side too.
*   **A closer look.** A scenario with two or more fewer passes on the branch is run again, ten
    runs on each side. If the branch again has two or more fewer, the drop is taken as real.
*   **The decision.** The author decides whether to release, and the pull request to main
    carries the numbers and the reason. For a drop taken as real there are three courses: find
    the step by running the scenario at each step's merge commit, and reword what that step
    changed; restore the feature that step removed; or release with the drop stated in the
    release notes. A branch run that costs more is expected where the run of main used a group,
    since a group gives one parent turn for several reports.

Before step 1, one run of `fanout` and one of `recursive` are made at main. They show that a
model can be reached and the harness works on 2.3.0, and they block nothing.

The ten scenarios:

| Scenario | What it checks |
|---|---|
| `fanout` | A parent starts two children and replies with both results. |
| `permission` | A child's permission request reaches the person and is answered. |
| `question` | A child's question reaches the person and the answer comes back. |
| `recursive` | A top session splits a job two levels deep and combines the parts. |
| `recursive-fault` | One part reports `partial`; its parent has it finished. |
| `recursive-staged` | One part must be done before the others start. |
| `recursive-finding` | The person types a correction into one part; it must reach the other parts. It uses the typed-text copy, which stays. |
| `recursive-conflict` | The person's typed words contradict a part's task; the checker reads how the sessions above treat them. |
| `discovery` | One part learns a value the other two need; it must reach them through the parent. This is the scenario the removal of `finding` and groups bears on most. |
| `review` | A change is made, reviewed by another session and fixed. |

Each pull request that changes a model-facing string also carries one `e2e/real-model.sh` run in
its body, as the repository's rules require. That run is information for the reviewer of the pull
request and is not part of this check.

### Order of work

Steps 1 to 5 are one pull request each, with its unit tests, its live scenario changes and its
part of `docs/reference.md`. They merge into an integration branch, not into main, so main stays
releasable for a fix while the work is under way.

```text
 1  memory removed                                        ┐
 2  the branches for a host without a busy time removed   │
 3  small cuts: courier_children, /courier stop,          │  pull requests into the
    queue, the nativeChildren option; the README's        │  integration branch, in order
    account of the host's subagent tool corrected         │
 4  groups and finding removed                            │
 5  README demo recorded again, without a group           ┘
    the real-model check: main against the branch; the author decides
    one pull request from the integration branch to main, then release 0.17.0 (breaking)
 6  the checkers lose the allowances no run can use any more
```

Steps 1 to 4 do not depend on each other's behaviour: any one of them could ship alone. They do
edit the same files. All four touch the composition root and the spawn code, and steps 1, 3 and 4
touch the model-facing strings and their snapshot. So they merge in the order 1, 2, 3, 4, each
rebased on the one before. Step 5 depends on step 4 and merges before the check, so the README
never shows a join group the plugin does not have. Step 6 follows the release as an ordinary pull
request to main.

If OpenCode releases a version while the branch is open, main takes the pin bump as usual and
the branch takes main. The check runs after that, so both sides are on the same host version.

## Risks and Mitigations

| Risk | Effect | Mitigation or acceptance |
|---|---|---|
| A report is held in a group at the update | Its text is not delivered; in an unattended tree a parent whose group was complete is never woken | Accepted. The text is in the child's session, and a message asking the child to report again delivers it. The release notes say to let running trees finish, though a person may read them only after updating. |
| The old copy of the plugin holds a report or starts a group after the update | The same as the row above | Accepted, for the time the old copy stays loaded. |
| A rollback after the update | A group that was complete before the update is released late, at the old version's first tick. A group with a member that reported under the new version is never released, and its name stays taken. | Accepted. The rollback is not tested. |
| A session keeps a `lessons` entry that names `courier_recall` | A call to the tool fails as unknown | Accepted. Only a session in a project where `courier_note` wrote a lesson has the entry. The release notes mention it. |
| A user has `nativeChildren` set to `true` | Their non-isolated children become standalone: prompts move to `/asks`, children leave OpenCode's subagent tab | One line in the server log at load. A person using only the terminal does not see that log; the release notes say to ask for a native child in the prompt or in the project's instructions. |
| The shortened text makes a model behave worse | A real-model scenario passes less often | The real-model check reports it, and a drop of two or more is run again at ten against ten before the author decides. The check is weak by design: five runs on one model. |
| No model can be reached when the check is due | The release has no numbers | The release waits. |
| A session with an old brief passes `finding` | The text is dropped and nobody is told | Accepted, as part of not migrating running trees. |
| A parent that used a group now gets a wake per report | Up to one parent turn per report for a fan-in, each a full-context request | Accepted. No user of groups is known. The release notes state it. |
| A session that called `courier_children` calls `courier_tree` | A longer listing: up to `maxTotal` sessions where the other returned its own children | Accepted. The state lines already give a parent its children without a call. |
| Memory records and held reports stay in storage | Titles, lessons and report text remain on disk, and the command that could delete a memory record is gone | Accepted. The release notes name the key prefixes and say that the plugin offers no command to remove them. |
| Security | None expected: no new input, permission, stored secret or network path | None needed. |

## Alternatives Considered

The author made each rejection below.

### Alternative A: Replace spawn and wake with the host `subagent` tool or native children

*   **Pros**: Removes spawn, send and the wake, which no other alternative does. OpenCode shows
    the children in its own subagent tab, shows their asks in the top session's view, and its
    `/goal` command, which keeps a session working until a goal is met, waits for them. A child
    cannot end silently.
*   **Cons**: OpenCode creates a session with a directory or a parent, never both, so a child in
    its own worktree cannot be a subagent. Depth beyond one level needs a host config change.
    Reports lose their status and their branch name. A child cannot message its parent before its
    turn ends. Spawn limits cannot be enforced. A lost wake is not retried.
*   **Reason for Rejection**: Two children could no longer edit the same files at once, which is
    one of the two features that must stay.

### Alternative B: Remove `native` in this design

*   **Pros**: One kind of child, one report path, one case in the panel. No extra parent turn per
    child turn. `opencode run`, the command that runs one prompt and exits, cannot hang waiting
    on a native child. The longest list of host behaviours in the maintainer notes goes, which is
    most of the first cost this design names.
*   **Cons**: Loses OpenCode's own "Subagent finished" line in the parent's transcript and the
    subagent tab, which the author uses. No reviewer has examined what the removal touches.
*   **Reason for Rejection**: It removes a feature the author uses, and what it touches has not
    been worked out. It gets a design of its own. Only the `nativeChildren`
    option goes here.

### Alternative C: Native for every non-isolated child, standalone only for isolated ones

*   **Pros**: Every child that can be a host subagent is one.
*   **Cons**: Two report paths stay permanently, and the choice between them follows a host
    limitation, not anything the user chose. Each native child turn costs every native level
    above it a turn.
*   **Reason for Rejection**: It makes the extra parent turn the default for every user, where
    today only a spawn that asks for a native child pays it.

### Alternative D: A worktree tool beside the host `subagent` tool

*   **Pros**: The plugin would shrink to worktree handling and a panel.
*   **Cons**: As Alternative A says, the host creates a session with a directory or a parent,
    so a subagent cannot be placed in a worktree. Permission requests are kept per location.
*   **Reason for Rejection**: The host does not allow it, and it removes mid-run messages and
    statuses as Alternative A does.

### Alternative E: Isolate every child, host subagents for the rest

*   **Pros**: One courier path, for isolated children only.
*   **Cons**: Every split gains a merge step, including the ones that only read or that write
    files the parent reads directly.
*   **Reason for Rejection**: It adds a merge step to every split that does not need isolation,
    to remove one path.

### Alternative F: Only remove the paths for older hosts

*   **Pros**: No behaviour changes for anyone on 2.3.0. No real-model risk.
*   **Cons**: Removes a few dozen source lines and changes nothing a model sees.
*   **Reason for Rejection**: As the whole plan it touches only part of the first of the four
    costs. Kept as step 2.

### Alternative G: Options that turn features off, with the code kept

*   **Pros**: Nothing breaks. A user who wants memory or groups turns them back on.
*   **Cons**: The code, its tests and its host notes stay, so the cost per OpenCode release does
    not drop. More options to explain.
*   **Reason for Rejection**: None of the four costs falls: the code is still there to maintain
    and there are more options to document.

### Alternative H: Two plugins, a core and extras

*   **Pros**: The core is small; memory and scheduling live elsewhere.
*   **Cons**: Both share the hub and the pin, so each OpenCode release costs the same work or
    twice the work. Two packages to install and version.
*   **Reason for Rejection**: The work per OpenCode release stays the same or doubles.

### Alternative I: Remove `courier_cancel`

*   **Pros**: One tool fewer.
*   **Cons**: Without it a stale check-in fires and costs its session one full-context turn. How
    often that happens is not measured. The two automatic rules that could replace the tool each
    drop a check-in that is still wanted. Cancelling when the last child settles removes the
    watch on a `blocked` or `partial` child that goes back to work. Skipping a check-in when no
    child owes a report skips one that watches something outside the tree. Nothing shows that
    models leave the tool unused.
*   **Reason for Rejection**: No automatic rule replaces the tool, and its cost against a stale
    turn is unmeasured.
### Alternative J: Remove scheduling, or use OpenCode's schedules for it

*   **Pros**: Two tools and a periodic job fewer.
*   **Cons**: Nothing follows up a child whose failure went unseen while the server was down, or
    one paused by a rate limit. The scheduler stays anyway, for missed wakes. Host schedules are
    behind a feature flag that is off in release builds, a plugin cannot reach them, and
    `courier_stop` cannot cancel one.
*   **Reason for Rejection**: Host schedules are not available on a stock 2.3.0, and a scheduled
    check-in is the only cover for a server that stopped.

### Alternative K: Remove the typed-text copy

*   **Pros**: About 130 source lines, a stored key and four host behaviours a pin bump re-checks
    only for this.
*   **Cons**: Every session above the child gets the person's words today. Without the copy, the
    child must judge whether to send them up and its parent whether to pass them on, and a child
    that acts and tells nobody leaves no sign. One of the two real-model scenarios that cover it
    checks the wording of the copied text, so it would lose its subject.
*   **Reason for Rejection**: It swaps a mechanism for a model's judgement, with no check that
    would show a failure.

### Alternative L: Soften the update for running trees

*   **Pros**: A tree that is mid-run at the update keeps the text of a held report or of a
    `finding`, or its parent is at least told. The ways weighed: a periodic job that delivers
    held reports for one more release; a single delivery at load; a `finding` parameter kept
    declared for one more release; a log line at load naming parents with held reports; a notice
    to each such parent.
*   **Cons**: The first three are new code for a removed feature, each with its own test and a
    second release to remove it. A log line reaches nobody in the unattended case, which is the
    one it would be for. A notice to the parent that carries the held text is delivery under
    another name, and one without the text tells a model to go and read sessions it has no tool
    to read.
*   **Reason for Rejection**: Each costs code that outlives its feature, for a feature with no
    known user, against one release-note line.

### Alternative M: Remove the `maxChildren` option

*   **Pros**: One option fewer.
*   **Cons**: The per-session limit moves from 5 to 30 for every user. One session can take every
    slot in the tree, and no real-model scenario starts more than three children, so the
    real-model check would not show it. None of the four costs names the option.
*   **Reason for Rejection**: The option limits what one session can start, and removing it
    changes that limit for every user with no cost it would reduce.

### Alternative N: One `courier` tool with a mode parameter

*   **Pros**: One tool description where there are eight.
*   **Cons**: One tool with several modes needs an input that is one of several shapes. The
    host's handling of such inputs is recorded in `docs/maintainers/plugin-api-notes.md`, under
    "Tools", as error-prone: its input repair, which drops parameters a tool does not declare,
    cannot tell which shape was meant.
*   **Reason for Rejection**: It lowers the count and takes on an input shape the host handles
    badly.

### Alternative O: Delete the `courier-orchestrate` skill

*   **Pros**: The shortest model-facing surface. `recursive` and `recursive-fault` each passed 3
    of 3 runs with the skill denied, in fewer requests than with it offered.
*   **Cons**: `recursive-finding`, `discovery` and `review` have never been run with the skill
    denied. Only the skill tells a top session to pass a finding on to the parts it affects,
    and those are the scenarios that check it.
*   **Reason for Rejection**: Unmeasured for the three scenarios whose checks rest on text only
    the skill carries.

### Alternative P: Treat a child's turn end as its report and drop the statuses

*   **Pros**: No reminder to an unreported child, and less brief and skill text.
*   **Cons**: `blocked` and `partial` cannot be told apart from `done`.
*   **Reason for Rejection**: The reminder and every real-model checker depend on the statuses.

### Alternative Q: Add usage telemetry before cutting anything

*   **Pros**: The cuts would rest on data, not on the absence of it.
*   **Cons**: No infrastructure exists for it, and it needs a privacy decision from every user.
*   **Reason for Rejection**: It needs infrastructure and consent the plugin does not have. This
    design decides from the author's use and the issue tracker instead, as The Problem states.

### Alternative R: Delete a removed feature's stored keys at load

*   **Pros**: No dead data in storage.
*   **Cons**: A rollback to the previous release finds its data gone.
*   **Reason for Rejection**: A rollback would lose every memory record and held report, and the
    storage rule in the architecture document is that a key is never changed or removed under a
    running version.

### Alternative S: Gate every step on its own real-model batch

*   **Pros**: A drop is tied to one step immediately.
*   **Cons**: Five batches of 50 runs or more. The steps ship in one release anyway.
*   **Reason for Rejection**: Five times the runs for the same release decision. One batch
    informs the release, and a scenario is run per step only when it shows a drop taken as real.

### Alternative T: Offer each session only the tools it can use

*   **Pros**: A session at the deepest level has no children, so of the eight tools only
    `courier_send`, `courier_later` and `courier_cancel` are of use to it, and `courier_answer`
    works only from the top. Hiding the rest would take four more descriptions out of every
    request such a session makes, beyond `courier_spawn`, which the plugin already hides from
    it through the same hook.
*   **Cons**: It is an addition: a rule per role, test cases per role, and every string that
    names a hidden tool has to be checked per role. A fork of a deepest-level session becomes a
    top session and its tool list changes. The saving is not measured.
*   **Reason for Rejection**: Not rejected on merit. It is new behaviour with its own test
    matrix, and the removals here neither need it nor block it. It is the first follow-up.

### Alternative U: Warn about removed options for one release, then remove them

*   **Pros**: A user who set `nativeChildren` or `memory` sees a warning while the option still
    works.
*   **Cons**: A second release, and the code for both options and their features stays until it.
*   **Reason for Rejection**: No one is known to set either option outside the demo and the
    tests, and a log line at load in the release that removes them tells such a user the same
    thing.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Rollout and rollback.** The release is 0.17.0, a breaking 0.x minor release. Its notes list
    every removed tool, parameter, option and command, name the storage key prefixes left
    behind, and say to let running trees finish before updating. What takes each one's place:
    for `courier_children`, `courier_tree`; for `/courier stop`, the `s` key in the tree panel;
    for `finding`, a message to the parent without a status; for `nativeChildren`,
    `native: true` on a spawn; for memory and `queue`, nothing; for join groups, nothing: a
    parent gets up to one turn per report. A rollback finds every stored key in the shape the old
    version wrote, since none changed shape and none was deleted. The rollback itself is not
    tested; "Risks and Mitigations" lists what to expect.
*   **Token cost.** Fewer tool description and schema characters per request; the goal states
    the floor. Two places may cost more: a fan-in that used a group, which now gets up to one
    parent turn per report, and a call to `courier_tree` where `courier_children` was called.
*   **Privacy.** Real-model results are published without the self-hosted model's name, address
    or provider id.

--------------------------------------------------------------------------------

## Future Improvements

*   **Tools by role**, as Alternative T describes.
*   **A child's title in the transcript.** The line a parent's transcript shows for a courier
    message is built from the sender's session id, for example `Message from ses_…`. The plugin
    sets that line itself and has the child's title at that point. The line does not reach the
    model: this was checked on OpenCode 2.3.0 with the scripted model. Showing the title changes
    that one line, in the server part. It bears on `native`: the author keeps native children
    for the readable "Subagent finished" line OpenCode writes for them, which a standalone child
    lacks today.
*   **`native`, `courier_cancel` and the typed-text copy** are each open to a design of their
    own, with the real-model check's numbers in hand.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

**This plan is not ready to implement from.** A review against the code found it wrong in three
ways that block, and it has not been corrected:

*   **The file lists are not exact.** About fifteen files that must change are missing, among
    them `test/notices.test.ts` in steps 3 and 4, `src/tree/index.ts` and `src/tree/standing.ts`
    in step 1, and `e2e/mock-model.mjs` in step 5. About twenty listed files need no change.
*   **Step 2 breaks tests it does not list and does not state the new rule.** Most unit fixtures
    mark a running session through the fallback that step removes, in `test/limits.test.ts`,
    `test/subtree.test.ts`, `test/panel.test.ts`, `test/summary.test.ts` and
    `test/courier.test.ts`. Dropping step 2 is the likely answer.
*   **Step 3.3 is wrong about `listChildren`.** The state lines do not use it. Its one caller is
    the `courier_children` tool, so it is removed with the tool.

The plan also leaves out text an implementer would have to write: the final wording of about ten
reworded tool descriptions and strings, the two log lines for a removed option, and how the
removed-name test collects the strings it checks. In the live suite, replacing `courier_children`
with `courier_tree` changes the shape about 25 checks read, and several kept suite groups use a
join group as their vehicle.

Each step's exact file list and final strings are to be settled when that step is taken up,
against the code as it then is. What follows is the outline to start from.

The file lists come from a search of every tracked file for each feature's names, not from
reading every file. A listed file mentions the feature; the implementer confirms each needs the
change. Steps 1 to 5 are one pull request each, into the integration branch the order of work
describes. A file that several steps touch is listed under each of
them, with that step's change. Every step also updates `test/__snapshots__/notices.test.ts.snap`
and, where the terminal part changes, `test/__snapshots__/tui.test.tsx.snap`, by running
`bun test --update-snapshots` after its text changes; they are not repeated below.

### Target Files to Create/Modify

### Model-facing strings, by step

These are the strings found by a search of `src/tree/text.ts`, `src/tree/cleanup.ts`,
`src/tree/tui.tsx` and `src/skill.ts`. The test that step 4 adds is the check that none was
missed.

| String | Who reads it | What changes | Step |
|---|---|---|---|
| The top session's role line | The top session | Loses the instruction to call `courier_recall` once before splitting | 1 |
| The `lessons` instruction entry | A session that may start others | No longer written | 1 |
| The brief's rule on splitting | Every child that may start others | Loses `courier_children` from "do not poll with …" (step 3) and the sentence on what a group name is for (step 4) | 3, 4 |
| The brief's rule on reporting | Every child | Loses the sentences on putting what other parts need in `finding`, and that a finding passes a held report | 4 |
| The native sentence in a role line | A parent with a native child | Loses its clause on waiting for a group's reports | 4 |
| The state-lines header and its overflow line | Every parent | `courier_children` becomes `courier_tree` in both; "a group's reports" goes | 3, 4 |
| Each state line | Every parent | Loses the child's group and its standing in it | 4 |
| The result of `courier_spawn` | The caller | "not on your `courier_children` list" names `courier_tree`; the text on a held report goes | 3, 4 |
| The result of `courier_send` | The caller | Loses the text on a report held with a group and on a finding sent ahead | 4 |
| The result of `courier_cleanup` and `courier_stop`, and the `courier_cleanup` error for a session that is not the caller's child | The caller | `courier_children` becomes `courier_tree`; the text on dropping a member from a group goes | 3, 4 |
| The refusal at the tree-wide limit, for a session none of whose own children counts | The caller | "only reports already held for a group can still wake you" becomes "no report is still due to you" | 4 |
| The failure notice, the ended-without-a-report notice, and the two notices about a stopped child | A parent | Lose their sentences on the child's join group | 4 |
| The fork notice | A forked session | "`courier_children` lists none of them" names `courier_tree` | 3 |
| The notice of a finding sent ahead, the notice of a complete group, the list of reports held so far | A parent | Removed whole | 4 |
| The `courier-orchestrate` skill | A session that loads it | Loses the advice to call `courier_note` (step 1), the group rule and the sentence on a finding sent ahead (step 4) | 1, 4 |
| The panel's confirmation before forgetting a row | The person | "this tree and `courier_children`" loses the tool name | 3 |

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
    sweep of old records that ran once at load, the listing of model context windows that only memory used, the `entries` port
    and the two tool names passed as `hiddenFromLeaf`. The teardown no longer touches memory
    state. Where option problems are logged at load, one line is logged when the `memory` option
    is present in the config, saying the option and the feature are gone.

#### 1.3 `src/rpc.ts`, `src/tui.tsx` (Modify)

*   **Type / Scope**: RPC and terminal entrypoints.
*   **Proposed Changes**: Drop the re-export of the memory RPC contract and the registration of
    the memory view and its `/courier memory` command.

#### 1.4 `src/tree/spawn.ts`, `src/tree/ports.ts`, `src/tree/context.ts` (Modify)

*   **Type / Scope**: Tree module.
*   **Proposed Changes**: `spawn.ts` stops putting the `lessons` instruction entry. `ports.ts`
    loses the `entries` and `hiddenFromLeaf` ports. In `context.ts` the statement that removes
    tools from a session at the deepest level keeps removing `courier_spawn` and stops reading
    the extra names. Nothing removes a `lessons` entry an existing session carries.

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
    memory tools and that a `memory` option present in the config is not read and is logged once. `imports.test.ts` drops the rules for
    `memory/`. `store.test.ts` drops the pinned memory keys. `fork.test.ts`, `events.test.ts`,
    `limits.test.ts` and `tui.test.tsx` drop their memory and lessons cases; `limits.test.ts`
    keeps the case that a session at the deepest level is not offered `courier_spawn`.
    `notices.test.ts` drops `memory/text.ts` from its list.

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
*   **Proposed Changes**: `real-model.sh` loses the seeding of a record and its `COURIER_SEED`
    switch. The checkers and the table script are not changed: they keep the recall columns and
    the allowance for the top session's one `courier_recall`, as "The real-model check"
    requires, until step 6.

#### 1.11 `test/real-model-recursive.test.ts`, `test/real-model-review.test.ts`, `test/real-model-table.test.ts`, `test/fixtures/real-model/pass-a/summary.json`, `test/fixtures/real-model/fail-b/summary.json` (Modify)

*   **Type / Scope**: Tests of the real-model checkers.
*   **Proposed Changes**: Only the cases that seed a record go. The recall and lesson fields
    stay until step 6, since the checkers still report them for runs of main.

#### 1.12 `README.md`, `docs/reference.md`, `docs/maintainers/architecture.md`, `docs/maintainers/plugin-api-notes.md`, `docs/maintainers/real-model.md`, `CLAUDE.md`, `.claude/skills/opencode-release/SKILL.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: README: remove the `memory` option row, the recall and note row of the
    tools table, `/courier memory` and the memory sentence. Reference: remove the Memory section
    and its links. Architecture: remove the memory bullets and the `lessons` entry, and replace
    the three `memory/` storage rows with one sentence that releases up to 0.16.4 wrote those
    keys and nothing reads them. Plugin-api-notes: remove the note on the memory view's select
    rows. Real-model: remove "Seeding a record". `CLAUDE.md`: remove `memory/` from the layout
    and the import rule. The release skill: remove its memory mention.

### Step 2: the branches for a host without a `busy` time

#### 2.1 `src/tree/domain.ts`, `src/tree/running.ts`, `src/tree/wake.ts` (Modify)

*   **Type / Scope**: Session-state logic.
*   **Proposed Changes**: Remove the branch that decides whether a session runs when `time.busy`
    is absent, and the matching branch in the re-send logic. A session with `idle` set and no
    `busy` reads as idle. No check for a missing instructions port is touched, in any file.

#### 2.2 `test/limits.test.ts`, `test/watch.test.ts`, `test/wake.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: Remove the cases that read a running session from `updated` when `busy`
    is absent. One case stays and changes its expectation: a session with `idle` and no `busy`
    reads as idle. The cases for a missing instructions port stay as they are.

#### 2.3 `README.md`, `docs/reference.md`, `docs/maintainers/architecture.md`, `docs/maintainers/plugin-api-notes.md`, `e2e/run.sh` (Modify)

*   **Type / Scope**: Documentation and the live suite.
*   **Proposed Changes**: Replace "the server part loads on any V2 host from 2.0.4 on" with the
    pinned version alone, and say a different host gets one log line. Remove the sentences and
    notes about a host before 2.2.2 and its missing `busy` time. `run.sh` drops any check that
    names that case.

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
*   **Proposed Changes**: Remove `childrenText`. `status.ts` keeps `listChildren`, which the state
    lines use, and loses what only the tool's output needed. Notices in `cleanup.ts` and
    `standing.ts` name `courier_tree`.

#### 3.4 `src/index.ts`, `src/tree/domain.ts`, `src/tree/index.ts`, `src/tree/ports.ts`, `src/tree/spawn.ts`, `src/tree/context.ts` (Modify)

*   **Type / Scope**: The `nativeChildren` option.
*   **Proposed Changes**: `readNativeChildren` no longer yields a setting. It returns a problem
    string when the option is present in the config, and `index.ts` logs it at load with the
    other option problems. The two port fields go. In `spawn.ts` a child is native when `native` is `true` and it is
    not isolated, and the role line about OpenCode's turn-end message is put at a parent's first
    native spawn only. In `context.ts` that line is added only for a session that has a native
    child.

#### 3.5 `src/tree/tui.tsx` (Modify)

*   **Type / Scope**: Terminal part.
*   **Proposed Changes**: Remove the `/courier stop` command branch and its part of the usage
    line. The `s` key in the panel is unchanged.

#### 3.6 `test/courier.test.ts`, `test/cleanup.test.ts`, `test/fork.test.ts`, `test/limits.test.ts`, `test/plugin.test.ts`, `test/standing.test.ts`, `test/summary.test.ts`, `test/tui.test.tsx`, `test/real-model.test.ts`, `test/real-model-discovery.test.ts`, `test/real-model-recursive.test.ts`, `test/real-model-review.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: Remove the cases for `courier_children`, `queue`, the `nativeChildren`
    option and `/courier stop`. Add: a `nativeChildren` option present in the config is not read and is logged once; a child is native
    only with `native: true`; a `queue` a model passes is ignored. The checker tests keep "a
    listing call after a spawn is polling" for both listing tool names.

#### 3.7 `e2e/run.sh`, `e2e/mock-model.mjs`, `e2e/tui.sh`, `e2e/real-model.sh`, `e2e/real-model.mjs`, `e2e/real-model-recursive.mjs`, `e2e/real-model-discovery.mjs`, `e2e/real-model-review.mjs`, `e2e/real-model-permission.mjs`, `e2e/real-model-question.mjs`, `test/e2e-shards.test.ts` (Modify)

*   **Type / Scope**: Live suite and real-model harness.
*   **Proposed Changes**: `run.sh`: the `native` and `spawn-native` groups stop turning the option
    on and rely on the mock passing `native: true`; calls to `courier_children` become
    `courier_tree`. The mock drops the `native: false` pins that existed only because the option
    stayed on for later groups. `tui.sh` drops the `/courier stop` checks. `real-model.sh` loses
    `COURIER_NATIVE`; the permission and question checkers lose their branch for it. The native
    variants of those two scenarios are no longer run with a real model; the live suite covers
    native children. The
    checkers are not changed: their rule that a listing call after a spawn is polling keeps
    naming both `courier_tree` and `courier_children`.

#### 3.8 `README.md`, `docs/reference.md`, `docs/maintainers/architecture.md`, `docs/maintainers/development.md`, `docs/maintainers/plugin-api-notes.md`, `docs/maintainers/real-model.md`, `CLAUDE.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: README: options table without `nativeChildren`, tools table without
    `courier_children`, terminal list without `/courier stop`, and the opening of "Why courier"
    corrected to say the host tool also runs in the background and wakes an idle parent at a
    child's turn end. Reference: the same removals, `queue` removed from `courier_send`, native
    children described as a per-spawn choice. Architecture and `CLAUDE.md`: the `role` entry's
    native line is put at a first native spawn, with no option. Development and real-model: no
    `COURIER_NATIVE`.

### Step 4: groups and `finding`

#### 4.1 `src/tree/group.ts` (Delete), `test/group.test.ts` (Delete)

*   **Type / Scope**: The group use case and its test.
*   **Proposed Changes**: Delete.

#### 4.2 `src/tree/tools.ts` (Modify)

*   **Type / Scope**: Tool definitions.
*   **Proposed Changes**: Remove `group` from the spawn schema and `finding` from the send schema.
    Remove the group and finding sentences from the descriptions of `courier_spawn`,
    `courier_send` and `courier_cleanup`. `courier_spawn` keeps its advice to schedule a
    check-in and to cancel it, without "one per group".

#### 4.3 `src/tree/spawn.ts`, `src/tree/send.ts` (Modify)

*   **Type / Scope**: Spawn and send use cases.
*   **Proposed Changes**: `spawn.ts` no longer joins a child to a group or stores `group` on its
    roster entry. `send.ts` loses the holding of a report, the early delivery of a finding and
    the release of a held report on `blocked`; every report is delivered at once.

#### 4.4 `src/index.ts`, `src/tree/index.ts` (Modify)

*   **Type / Scope**: Composition root and module surface.
*   **Proposed Changes**: The tick jobs are `dueJob` and `wakeMissed`. `deliverReleased` is no
    longer exported. The hub version constant is not changed.

#### 4.5 `src/tree/domain.ts`, `src/tree/ports.ts`, `src/tree/store.ts`, `src/tree/roster.ts` (Modify)

*   **Type / Scope**: Tree types and storage.
*   **Proposed Changes**: Delete the held-report and membership types, the group ports, the group
    store and its key prefix. A roster entry's `group` field stays in the type as optional, for
    entries written earlier, and is never written or read.

#### 4.6 `src/tree/standing.ts`, `src/tree/status.ts`, `src/tree/summary.ts`, `src/tree/panel.ts`, `src/tree/rpc.ts`, `src/tree/rpc-handlers.ts`, `src/tree/tui.tsx` (Modify)

*   **Type / Scope**: State lines, listings and the terminal part.
*   **Proposed Changes**: Remove each child's group and group standing from the state lines, the
    tree listing, the summary, the panel rows and the footer. The summary and tree RPCs lose
    their group fields; the terminal part of the same release does not read them.

#### 4.7 `src/tree/cleanup.ts`, `src/tree/forget.ts`, `src/tree/nudge.ts`, `src/tree/events.ts`, `src/tree/stop.ts`, `src/tree/wake.ts` (Modify)

*   **Type / Scope**: Tree use cases.
*   **Proposed Changes**: Remove every branch that takes a member out of its group or checks
    whether a group became complete: on cleanup, on forgetting a deleted child, on a reminder, on
    a failed or silent end, on a stop.

#### 4.8 `src/tree/text.ts`, `src/skill.ts`, `src/scheduling/tools.ts`, `src/person/rpc.ts`, `src/person/rpc-handlers.ts`, `src/person/tui.tsx` (Modify)

*   **Type / Scope**: Model-facing strings and the asks inbox.
*   **Proposed Changes**: `text.ts` loses all group wording, the finding-ahead wording and the
    brief's sentence that a report's finding reaches the parent ahead of a held report. The
    brief's rule to send what other parts need to the parent without a status stays. The skill
    loses its group rule and its sentences on the `finding` parameter; "pass what a report says
    on to the parts it changes" stays. `courier_later`'s description loses "one per group". The
    asks inbox drops the group a waiting session belongs to.

#### 4.9 `test/courier.test.ts`, `test/cleanup.test.ts`, `test/hub.test.ts`, `test/inbox.test.tsx`, `test/limits.test.ts`, `test/nudge.test.ts`, `test/panel.test.ts`, `test/person-rpc.test.ts`, `test/plugin.test.ts`, `test/roster.test.ts`, `test/standing.test.ts`, `test/stop.test.ts`, `test/store.test.ts`, `test/summary.test.ts`, `test/tui.test.tsx`, `test/watch.test.ts`, `test/real-model-discovery.test.ts`, `test/real-model-recursive.test.ts`, `test/real-model-review.test.ts`, `test/real-model-table.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: Remove the group and finding cases. `courier.test.ts` adds: a `group` or
    `finding` passed by a model is ignored and the child's report is delivered alone.
    `test/notices.test.ts` adds the check that no model-facing string and no tool description
    contains a removed name, as "Model-facing text that changes" lists them. `store.test.ts` adds:
    a `group/` entry in storage is not read and not removed.

#### 4.10 `e2e/run.sh`, `e2e/mock-model.mjs`, `e2e/tui.sh`, `test/e2e-shards.test.ts` (Modify)

*   **Type / Scope**: Live suite.
*   **Proposed Changes**: Remove the `reports-groups`, `finding`, `finding-up` and
    `decline-seal` groups. The `reports` group adds a spawn that passes `group` and checks the
    child's report arrives by itself. The mock's other scenarios lose their `group` arguments.
    `tui.sh`'s first scenario runs two ungrouped children; its footer and row checks lose the
    group text.

#### 4.11 `e2e/real-model.sh`, `e2e/real-model.mjs`, `e2e/real-model-recursive.mjs`, `e2e/real-model-recursive-release.mjs`, `e2e/real-model-discovery.mjs`, `e2e/real-model-review.mjs`, `script/real-model-table.ts` (Modify)

*   **Type / Scope**: Real-model harness.
*   **Proposed Changes**: No checker changes in this step. Every allowance for a held report, a
    finding sent ahead or a look at a held report stays, so one checker scores main and
    the integration branch. Only what the harness can no longer set is removed from
    `real-model.sh`. Step 6 removes the allowances no run can use any more.

#### 4.12 `README.md`, `docs/reference.md`, `docs/maintainers/architecture.md`, `docs/maintainers/development.md`, `docs/maintainers/plugin-api-notes.md`, `docs/maintainers/real-model.md`, `CLAUDE.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: README: no join group in "Why courier", "How it works", the tools row or
    the footer example. Reference: the "Join groups" section and every link to it go.
    Architecture: the `group/` row is replaced by one sentence that releases up to 0.16.4 wrote
    the key and nothing reads it. Plugin-api-notes: the note on reading a decline from the
    transcript goes. `CLAUDE.md`: "groups" leaves the layout line.

### Step 5: the demo

#### 5.1 `script/record-gif.sh`, `script/demo-lib.sh`, `script/render-gif.py`, `docs/demo.gif`, `README.md` (Modify)

*   **Type / Scope**: Demo recording.
*   **Proposed Changes**: The demo shows a top session with two sessions under it that each
    run two workers. Those two sessions report one by one, with no group. The GIF is
    recorded again in a cloud session, since it cannot be recorded on the author's machine, and
    the README caption and alt text describe what it shows. This pull request merges before the
    release is cut.

### Step 6: the checkers, after the release

#### 6.1 `e2e/real-model.mjs`, `e2e/real-model-recursive.mjs`, `e2e/real-model-recursive-release.mjs`, `e2e/real-model-discovery.mjs`, `e2e/real-model-review.mjs`, `script/real-model-table.ts`, `test/real-model.test.ts`, `test/real-model-recursive.test.ts`, `test/real-model-discovery.test.ts`, `test/real-model-review.test.ts`, `test/real-model-table.test.ts`, `test/fixtures/real-model/pass-a/summary.json`, `test/fixtures/real-model/fail-b/summary.json` (Modify)

*   **Type / Scope**: Real-model checkers and their tests.
*   **Proposed Changes**: Once 0.17.0 is released and `real-model.md` holds its tables, remove
    what no run can use any more: the allowances for a report held in a group, a finding sent
    ahead, a look through `courier_children` and the top session's `courier_recall`, with the
    notes and table columns for groups, findings, recall calls and lesson reads. This is one
    pull request to main and changes no plugin code.

### The release

#### R.1 `package.json`, `README.md`, `docs/reference.md`, `docs/maintainers/real-model.md` (Modify)

*   **Type / Scope**: Version, the generated compatibility tables and the result tables.
*   **Proposed Changes**: After the author has decided on the real-model check's numbers, one pull
    request takes the integration branch to main and the version becomes 0.17.0.
    The version tables are regenerated by `script/compat-table.ts`, never edited by hand. The
    tables in `real-model.md` are replaced by the branch's side of the real-model check, and its
    "Running it" text describes the check as this design does. The release follows
    `docs/maintainers/releasing.md`. Its notes list every removed tool, parameter, option and
    command with what to do in its place, and say to let running trees finish before updating.

### Verification Plan

*   **Compilation/Build**: `bun run typecheck` and `bun run build` on every step.
*   **Unit Tests**: `bun test`; `bun test --update-snapshots` after a text change, with the
    snapshot diff read in review. `test/imports.test.ts` and `test/links.test.ts` must pass after
    each deleted file and each removed doc section.
*   **Static Analysis & Linting**: `bun script/compat-table.ts --check`; the SonarCloud job in CI.
*   **Test Coverage Requirement**: No numeric bar. Every changed behaviour has a unit test and a
    live scenario, as `CLAUDE.md` requires.
*   **E2E/Integration**: `npm run test:e2e` in four shards and `e2e/tui.sh`, both in CI on every
    pull request; `e2e/two-servers.sh` on step 4, because that step removes one of the
    scheduler's periodic jobs and the script checks that two servers on one data directory do
    not deliver a message twice.
*   **Real model**: Main against the integration branch, reported and decided as "The
    real-model check" says. Steps 1, 3 and 4 change model-facing strings, so each of their pull
    requests carries one `e2e/real-model.sh` run in its body.
*   **Counts**: The characters of all tool descriptions and schemas on the integration branch
    against main, taken with the real-model check.
*   **Manual check**: With a config that sets `memory`, `nativeChildren` and `maxChildren`, the
    plugin loads and logs one line for each of the first two, a sixth live child of one session is refused (the default limit is five), and a
    child is native only when its spawn asks.

--------------------------------------------------------------------------------

*Drafted with EGM*
