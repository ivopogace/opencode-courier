# Tools by role

*   **Author:** Ivo Pogace
*   **Status:** Agreed, not implemented
*   **Date:** 2026-11-15

--------------------------------------------------------------------------------

## Overview

opencode-courier offers eight tools: `courier_spawn`, `courier_send`, `courier_tree`,
`courier_stop`, `courier_cleanup`, `courier_answer`, `courier_later` and `courier_cancel`. Every
session is offered all eight, with one exception: a session that cannot start sessions is not
offered `courier_spawn`.

This design extends that one exception. A session that cannot start sessions is also not offered
`courier_stop`, `courier_cleanup` and `courier_answer`, because every call it could make to them
is refused. Its requests carry four courier tools where they carry seven today, 4,099 characters
fewer per request. Every other session keeps all eight. No model-facing string changes.

It is Alternative T of [Shrinking opencode-courier](shrinking-opencode-courier.md), whose terms
this document uses. The plugin is pinned to OpenCode 2.3.0, and "the host" below means OpenCode.

### Roles

The plugin gives a session one of five places in a tree, from its stored list of children
(`roleOf` in `src/tree/context.ts`):

| Role | What it is | May start sessions |
|---|---|---|
| Top, nothing started | A session the person started, with no child yet. Every ordinary session with the plugin loaded is one. | Yes |
| Top | Depth 0: it started sessions and nothing started it. | Yes |
| Sub-orchestrator | A spawned session at a depth below `maxDepth`. With the default `maxDepth` of 5, every child in a tree one to four levels deep is one, whether or not it splits its task. | Yes |
| Deepest level | A spawned session at depth `maxDepth`. Its role line calls it a leaf. | No |
| OpenCode subagent in a tree | A session the host's `subagent` tool started from a session that is in a tree. It has no brief and no role line. | No |

"A session that cannot start sessions" below means the last two rows. The code treats them as
one case, `leaf`.

## The Problem

Every request a session makes carries the name, description and input schema of each tool it is
offered. A session that cannot start sessions has no children, so three of the seven courier
tools it is offered can only fail for it, and their text is in each of its requests all the same.

The issue leaves four points open: which tools each role sees, which strings name a tool a role
does not see, what happens when a session's role changes, and how large the saving is. This
document answers the four; the measurement is under "The saving, measured".

## Goals

*   A session that cannot start sessions is offered exactly `courier_send`, `courier_tree`,
    `courier_later` and `courier_cancel` of the courier's tools.
*   Every other session is offered all eight, on every request, before and after its first spawn.
*   No call that succeeds today is refused or missing, outside the one case under "Risks and
    Mitigations".
*   No model-facing string changes, and no string tells a session to call a tool it is not
    offered.
*   A session's tool list changes at no moment at which it does not change today.

## Non-Goals

*   Hiding a tool from a top session or a sub-orchestrator. "Alternatives Considered" gives the
    reason for each.
*   Shortening a tool description or a schema. That saves in every role, changes what a model
    reads, and is a design of its own.
*   Changing the tools of the host's compaction request, which carries a session's whole tool
    list, `courier_spawn` included, as today.
*   Changing `courier_cancel`, `native` as a per-spawn choice, or the typed-text copy. All three
    stay as they are; "Native children and the typed-text copy" says how the rule meets the last
    two.
*   A second mechanism. The rule uses the statement that hides `courier_spawn` today.

## Open Questions

None.

## Critical User Journeys (CUJs)

### CUJ 1: A session at the deepest level

*   **Given**: `maxDepth: 2`, a top session, a child and a grandchild.
*   **When**: The grandchild does its task and reports.
*   **Then**: Each of its requests lists `courier_send`, `courier_tree`, `courier_later` and
    `courier_cancel` and no other courier tool. Its brief, its role line and the reminder name
    only tools from that list. The child and the top session list all eight.

### CUJ 2: A call to a hidden tool

*   **Given**: The grandchild of CUJ 1, whose transcript or whose model's habit leads it to call
    `courier_stop`.
*   **When**: It makes the call.
*   **Then**: The host answers "Tool is not available for this request: courier_stop", as it does
    for `courier_spawn` today, and the turn goes on.

### CUJ 3: A fork of a session at the deepest level

*   **Given**: The grandchild of CUJ 1, forked by the person.
*   **When**: The fork makes its first request.
*   **Then**: The fork is a top session with nothing started and lists all eight tools. Its system
    prompt is the grandchild's, byte for byte, and the fork notice is appended after the copied
    messages, as today.

### CUJ 4: An OpenCode subagent in a tree

*   **Given**: A child that calls the host's `subagent` tool.
*   **When**: The subagent makes a request.
*   **Then**: It lists the same four courier tools as CUJ 1, and no role line.

### CUJ 5: A top session's first spawn

*   **Given**: A session the person started, with all eight tools.
*   **When**: It calls `courier_spawn` for the first time.
*   **Then**: Its next request lists the same eight tools. Its role arrives as one instruction
    update, as today, and the cached prefix holds.

## Technical Plan (Architecture)

### The rule per role

`courier_stop`, `courier_cleanup` and `courier_answer` act on sessions the caller started, or on
sessions under those. A session that cannot start sessions has none, so every call it could make
to the three is refused, for as long as it keeps its place in the tree. They are hidden where
`courier_spawn` is.

| Tool | Top, nothing started | Top | Sub-orchestrator | Cannot start sessions |
|---|---|---|---|---|
| `courier_spawn` | Offered | Offered | Offered | Hidden, as today |
| `courier_send` | Offered | Offered | Offered | Offered |
| `courier_tree` | Offered | Offered | Offered | Offered |
| `courier_stop` | Offered | Offered | Offered | **Hidden** |
| `courier_cleanup` | Offered | Offered | Offered | **Hidden** |
| `courier_answer` | Offered | Offered | Offered | **Hidden** |
| `courier_later` | Offered | Offered | Offered | Offered |
| `courier_cancel` | Offered | Offered | Offered | Offered |

Why each hidden tool is of no use to a session that cannot start sessions, checked against the
code:

*   **`courier_spawn`** is hidden today. At `maxDepth` the tool itself refuses the call, with the
    depth refusal (`admit` in `src/tree/limits.ts`). For an OpenCode subagent the tool has no
    refusal: the hook hides it because a subagent answers its parent's tool call and starts no
    tree of its own.
*   **`courier_stop`** refuses a target that was not started with `courier_spawn`, and a caller
    that is not in the line of sessions that started the target (`stop` in `src/tree/stop.ts`).
    A session that cannot spawn is in no such line, its own included, and a subagent it started
    with the host's tool was not started with `courier_spawn`.
*   **`courier_cleanup`** takes a session the caller started itself and refuses any other
    (`cleanup` in `src/tree/cleanup.ts`). A session that cannot spawn started none.
*   **`courier_answer`** refuses every caller but the top of the line of sessions that started
    the asking one, for permission requests and questions alike (`answeringTop` in
    `src/tree/roster.ts`). A session that cannot spawn is at the top of no line.

Why each offered tool stays:

*   **`courier_send`** is how the session reports.
*   **`courier_later` and `courier_cancel`** are what its brief tells it to use when it waits for
    something outside the tree.
*   **`courier_tree`** succeeds for it. It lists the subagents the session started with the host's
    tool, marked `subagent: true`, and with a `sessionID` it lists any session's subtree, since
    the tool checks no relation between caller and target (`tree` in `src/tree/subtree.ts`).
    Nothing tells a session at the deepest level to call it; Alternative C weighs hiding it for
    that reason.

Why the other roles keep all eight:

*   **A top session with nothing started** cannot use `courier_stop`, `courier_cleanup` or
    `courier_answer` until it spawns. Hiding them until then would change its tool list at its
    first spawn (Alternative B).
*   **A top session** can use all eight.
*   **A sub-orchestrator** can use seven. `courier_answer` refuses it while its parent lists it
    as a child (Alternative A).

### The mechanism

OpenCode runs the plugin's `context` hook before every model request of every session, with that
request's tool map, and the hook may delete entries from the map
(`docs/maintainers/plugin-api-notes.md`, "Tools"). `shapeContext` in `src/tree/context.ts` reads
the session's role and deletes `courier_spawn` for a session that cannot start sessions. So the
mechanism is per session and per request already, and the design adds three names to that one
deletion.

`tree/` owns `courier_stop` and `courier_cleanup` and names them itself. `courier_answer` belongs
to `person/`, which `tree/` may not import, so the composition root passes that one name to the
hook through its ports.

A role, once read, is kept in memory per plugin instance, for up to 1,000 sessions. A spawn
drops or rewrites the kept role of the session that spawned, and the role of a subagent whose
parent is in no tree is read on every request. That is unchanged.

### The saving, measured

**Method.** A script registers the eight tools through the three `add…Tools` functions with a
collecting editor, as `test/notices.test.ts` does, and renders each input schema with
`Schema.toJsonSchemaDocument(input, { onExcessProperty: "error" })`, the closed form the host
sends. Per tool it counts the characters of the name, the description and the schema as compact
JSON. It was run at commit `bb6a062`. The script is not in the repository.

The count is of the courier's own tools. It leaves out what a provider's wire format adds around
each tool, and the host's own tools and system prompt, which are the larger part of a request and
which this design does not touch. Tokens are estimated at four characters each.

| Tool | Description | Schema | Total with name |
|---|---|---|---|
| `courier_spawn` | 820 | 2,076 | 2,909 |
| `courier_send` | 626 | 1,505 | 2,143 |
| `courier_tree` | 534 | 192 | 738 |
| `courier_stop` | 641 | 503 | 1,156 |
| `courier_cleanup` | 492 | 357 | 864 |
| `courier_answer` | 1,002 | 1,063 | 2,079 |
| `courier_later` | 403 | 616 | 1,032 |
| `courier_cancel` | 152 | 149 | 315 |
| All eight | 4,670 | 6,461 | 11,236 |

Per request, per role:

| Role | Today | Under the design | Saving |
|---|---|---|---|
| Top, nothing started | 11,236 (8 tools) | 11,236 (8 tools) | None |
| Top | 11,236 (8 tools) | 11,236 (8 tools) | None |
| Sub-orchestrator | 11,236 (8 tools) | 11,236 (8 tools) | None |
| Cannot start sessions | 8,327 (7 tools) | 4,228 (4 tools) | 4,099, or 49%, about 1,000 tokens |

What the variants left out would add:

| Variant | Role it changes | Per request | Saving |
|---|---|---|---|
| Alternative A: no `courier_answer` below the top | Sub-orchestrator | 9,157 (7 tools) | 2,079, or 19%, about 520 tokens |
| Alternative C: no `courier_tree` either | Cannot start sessions | 3,490 (3 tools) | 738 more, 58% in all |
| Alternative B: three tools hidden until the first spawn | Top, nothing started | 7,137 (5 tools) | 4,099, or 36% |

Two things bound what the numbers are worth:

*   **Who is in the role.** With the default `maxDepth` of 5, a tree has a session at the deepest
    level only when it is five levels deep. The sessions the saving reaches on default settings
    are OpenCode subagents inside a tree. With `maxDepth` set to 1, every child is in the role;
    with 2, every child of a child. How many sessions that is in use is not known: the plugin has no usage
    data.
*   **What a saved character costs.** The tool list is at the front of a request. On a provider
    with a prompt cache it is read at the cached price after a session's first request. On a
    model with no cache, a self-hosted one for example, it is paid in full on every request and
    takes its share of the context window.

### Model-facing strings that name a tool

The strings were read file by file: `src/tree/text.ts`, `src/person/text.ts`,
`src/scheduling/text.ts`, `src/kernel/protocol.ts`, `src/skill.ts`, the eight tool descriptions
and schemas, and the error texts in `src/tree/stop.ts`, `src/tree/cleanup.ts`,
`src/tree/roster.ts`, `src/tree/spawn.ts` and `src/person/permission.ts`.

The design draws one line. A string must not tell a session to call a tool it is not offered. A
string may name such a tool to describe what another session does. Under that line no string
changes.

What a session that cannot start sessions reads, and what each string names:

| String | Names | Hidden from the reader | What the design does |
|---|---|---|---|
| The brief at the deepest level (`childBrief`) | `courier_send`, `courier_later`, `courier_cancel` | None | Nothing |
| The leaf role line (`rolePart`) | `courier_send` | None | Nothing |
| The reminder before a turn ends without a report (`reportReminder`) | `courier_send` | None | Nothing |
| The results of `courier_send`, `courier_later` and `courier_cancel` | `courier_cancel` | None | Nothing |
| A dismissed or cut-off question of its own (`DISMISSED`, `cutOffAnswer`) | `courier_send` | None | Nothing |
| The description of `courier_tree` | `courier_spawn`, as what started the listed sessions | `courier_spawn`, as today | Nothing: it describes the listing |
| The empty result of `courier_tree`, "No sessions started with courier_spawn." | `courier_spawn` | `courier_spawn`, as today | Nothing: it describes the listing |
| The description of `courier_cancel`, "Nothing else cancels it but courier_stop of the session it is for." | `courier_stop` | `courier_stop`, new | Nothing: a session above it makes that call |
| The skill's description in the skill list | `courier_spawn` | `courier_spawn`, as today | Nothing: it says when to load the skill |
| The `courier-orchestrate` skill, if the session loads it | `courier_spawn`, `courier_send`, `courier_stop`, `courier_cleanup` | `courier_spawn` as today; `courier_stop` and `courier_cleanup`, new | Nothing: its first paragraph says "If courier_spawn is not among your tools, you cannot split: do the task yourself", and the two names are in the sections on running a split |

Strings that name a hidden tool and do not reach such a session:

| String | Names | Who reads it |
|---|---|---|
| The descriptions and schemas of `courier_spawn`, `courier_stop`, `courier_cleanup` and `courier_answer`, and their results (`spawnText`, `stopText`, `cleanupText`, `answerText`) | Each other and themselves | A session that is offered the tool |
| The errors those tools raise (the depth and limit refusals, "is not above", "is not a child of", "cannot answer them", "courier_answer grants no standing rule") | The tool called | The caller, which was offered the tool |
| The brief below `maxDepth` and the three other role lines | `courier_spawn`, `courier_tree` | Sessions that may start sessions |
| The state lines (`standingEntry`) | `courier_spawn`, `courier_tree` | A session with children |
| The notices about a child: failed, ended without a report, stopped, typed text (`failureNotice`, `silentNotice`, the three stopped notices, `typedNotice`) | `courier_spawn`, `courier_send`, `courier_stop`, `courier_cleanup`, `courier_later` | The child's parent, or for typed text the sessions above it |
| The sentence on the host's turn-end message (`HOST_REPORTS`) | `courier_spawn`, `courier_send`, `courier_cleanup` | A parent with a native child |
| The permission, question and form notices and their settled notices (`permissionNotice`, `questionNotice`, `nativeQuestionNotice`, `formNotice`, `permissionSettledNotice`) | `courier_answer`, `courier_spawn`, `courier_send` | The top of the asking session's line |
| The notes added to a question tool's result (`unlinkedNote`, `passedNote`, `withdrawnText`) | `courier_answer`, `courier_send` | The top session whose question call it was |
| The fork notice (`forkNotice`) | `courier_send`, `courier_spawn`, `courier_tree` | The fork, a top session |

One string reaches a session at the deepest level only when another plugin puts `courier_spawn`
back into its tool map and the session calls it: the depth refusal, which names `courier_send`.
The live suite's `depth` group does this with its probe plugin. An OpenCode subagent that got the
tool back the same way would not be refused: `courier_spawn` reads the caller's depth from its
entry in the tree, and a subagent has none. It would then be a session with a child of its own,
which this design does not cover.

The last table bears on Alternative A too: every string that names `courier_answer` goes to a
top session or to the tool's caller, so hiding the tool from sub-orchestrators would change no
string either.

### When a session's role changes

A provider's prompt cache holds a request's prefix, and the tool list is in that prefix. A
request whose tool list differs from the session's last one is read without the cache, once, and
later requests are cached again. CLAUDE.md's rule is that a role change leaves the cached prefix
alone: a session's role arrives as an instruction entry before its first prompt, or as one
instruction update appended to the transcript. So the test for this design is whether it adds a
moment at which a tool list changes. It adds none. Each moment below exists today for
`courier_spawn`; the design changes how many names move, not when.

| Moment | Today | Under the design |
|---|---|---|
| A top session's first spawn | The tool list stays. The role arrives as one instruction update. | The same. |
| A sub-orchestrator's first child, or its first native child | The tool list stays. A native child adds one instruction update. | The same. |
| A session at the deepest level, while every session above it keeps its entry in the tree | Seven tools on every request, from its first. | Four tools on every request, from its first. |
| A session above one at the deepest level is dropped with `courier_cleanup`, or its entry expires | The line above the deepest one is cut there, so its depth reads smaller: it is a sub-orchestrator and gains `courier_spawn`, once its kept role is gone. | It gains four tools at once. |
| A fork of a session at the deepest level | The fork is a top session: eight tools where the original has seven, so its first request is read without the cache. | Eight where the original has four. The same single uncached request. |
| A fork of a sub-orchestrator or of a top session | Same tools as the original; the original's prefix holds as far as the host's own copy keeps it. | The same. |
| `maxDepth` set lower or higher in the config, then a restart | A session whose depth is on the other side of the new limit gains or loses `courier_spawn`. Its role entry keeps the text it was spawned with. | It gains or loses four tools at once. |
| A parent starts its first tree while a subagent of its own runs | The subagent was a top session with eight tools and becomes a subagent in a tree with seven. | Eight, then four. |
| A parent drops a deepest-level child with `courier_cleanup` | Once its kept role is gone, a standalone child has no entry in the tree and reads as a top session with nothing started, with eight tools. A native child still has its host parent and reads as an OpenCode subagent in a tree, with seven. | Eight for a standalone child. Four for a native one, as before the drop. |
| The host's compaction request | The whole tool list, `courier_spawn` included, since the host runs its `compaction` hook and not `context`. | The same: all eight. |
| The role cannot be read (a storage error) | The request goes out with every tool, and one log line. | The same. |

What a model sees in the one case that matters, the fork (CUJ 3): the copied transcript holds the
original's brief, which says it cannot start sessions, and calls only to tools the fork still has,
since a fork gains tools and loses none. The fork notice says "Here you are the top session of a
tree of your own, with no sessions started: the role and standing courier gave above are not
yours." The tool list agrees with the notice.

In the other direction, where a session loses tools because `maxDepth` was lowered, its
transcript can hold calls to a tool its list does not have. That is so today for
`courier_spawn`. How each provider takes such a transcript was not checked.

### What a model and a person lose and gain

*   **A model at the deepest level, or a subagent in a tree, gains** a shorter tool list: four
    courier tools, each of which can succeed for it. The three it loses could only return a
    refusal.
*   **It loses** nothing that works, with the one exception of a session that has children and
    then finds itself at the deepest level ("Risks and Mitigations").
*   **Every other model** sees no change.
*   **A person gains** nothing they can see: about 1,000 tokens less on each request of such a
    session, which matters most on a model with no prompt cache or a small context window.
*   **A person loses** nothing. The tree panel, the footer, `/asks` and what the top session is
    told are unchanged.

### Native children and the typed-text copy

*   **A native child** (`courier_spawn` with `native: true`) has an entry in the tree and a depth
    like any other child, so the rule applies to it by its depth: at `maxDepth` it is offered the
    four tools, above it all eight. It is not the fifth role. That role is a session the host's
    own `subagent` tool started, which has no entry in the tree. The sentence on the host's
    turn-end message reaches only a parent with a native child, which is offered every tool the
    sentence names.
*   **The typed-text copy** goes to the sessions above the one typed into and names no tool. A
    session that cannot start sessions has nothing below it, so it receives none.

## Risks and Mitigations

| Risk | Effect | Mitigation or acceptance |
|---|---|---|
| A session started children and is then at the deepest level, because `maxDepth` was lowered between two starts of the server | It cannot call `courier_stop` or `courier_cleanup` for its children, where today it can | Accepted. A session above it stops them with `courier_stop`, with `cleanup: true` for their worktrees, and the person stops them in the tree panel. The reference says so. |
| A model at the deepest level calls a hidden tool | The host answers that the tool is not available, and the turn goes on | None needed. Today the same call returns a refusal. |
| The saving reaches few sessions on default settings | The work buys little | Accepted. The work is one statement and the changes to four live groups. |
| Another plugin or an agent's config removes or restores a courier tool | The lists differ from the tables here | As today: the hook deletes names and adds none. |
| A later host runs the `context` hook differently, or converts tool schemas per step | The deletion stops working or costs more | The same exposure `courier_spawn` has today. The live suite's `depth` group fails at the pin bump. |
| Security | None expected: fewer tools offered, no new input, permission or stored key | None needed. |

## Alternatives Considered

### Alternative A: Also hide `courier_answer` from sub-orchestrators

*   **Pros**: It reaches the role most children have: 2,079 characters, 19%, off every request of
    every child below the top. `answeringTop` refuses every call a sub-orchestrator makes while
    its parent lists it. No string changes.
*   **Cons**: Two costs the recommended rule does not have. A fork of a sub-orchestrator becomes
    a top session and would gain `courier_answer`, so its first request would be read without
    the cache, where today its prefix is the original's. And a sub-orchestrator can become a top:
    when its parent drops it with `courier_cleanup`, or its entry expires, while it still has
    children, it is the top of their line, and their permission requests and questions are sent
    to it with a notice that says to call `courier_answer`. Its role is kept in memory per plugin
    instance, and the instance that drops it can be another one, so it would go on being read as
    a sub-orchestrator and would lack the tool the notice names. Fixing that means sharing the
    kept roles across instances through the hub, or reading the role from storage on every
    request. It also changes the tool list of every child in every real-model scenario.
*   **Reason for Rejection**: It needs a new mechanism for under a fifth of the characters the role
    carries, and adds a moment at which a tool list changes.

### Alternative B: Hide `courier_stop`, `courier_cleanup` and `courier_answer` from a top session until its first spawn

*   **Pros**: The largest population: every ordinary session with the plugin loaded, most of
    which never spawn. 4,099 characters, 36%, off each of their requests.
*   **Cons**: The tool list would change at the first spawn. The request after it would be read
    without the cache, with the whole conversation so far, in every tree, at the moment the
    plugin exists for.
*   **Reason for Rejection**: It breaks CLAUDE.md's rule that a role change leaves the cached
    prefix alone.

### Alternative C: Also hide `courier_tree` at the deepest level

*   **Pros**: 738 characters more; the list is the three tools the brief names.
*   **Cons**: The call succeeds there. A session at the deepest level may start subagents with
    the host's tool, and `courier_tree` is the courier's only listing of them.
*   **Reason for Rejection**: It removes a call that works, for 9% of what the role carries
    today.

### Alternative D: Deny the tools in the child's permission rules at spawn

*   **Pros**: The host drops a tool whose action a session's rules wholly deny, from every
    request, the compaction request included. The plugin already creates each child with a rule
    of that kind for the host's schedule tools.
*   **Cons**: A rule is fixed when the session is created. It cannot reach an OpenCode subagent,
    which the plugin does not create. Whether a fork copies the rules, and so keeps the deny as
    a top session, was not checked. `courier_spawn` would still be hidden by the hook, so one
    rule would have two mechanisms.
*   **Reason for Rejection**: It covers one of the two kinds of session the rule is for, through
    a second mechanism.

### Alternative E: Choose the tools from what a session has done, not from its place

*   **Pros**: The closest fit: `courier_cleanup` only while a session has a child,
    `courier_cancel` only while it has a message scheduled.
*   **Cons**: The tool list would change in the middle of a turn, each time at the cost of the
    cached prefix, and a model would see tools come and go.
*   **Reason for Rejection**: It gives up the prompt cache for a list that is already short.

### Alternative F: Shorten the descriptions and schemas

*   **Pros**: It saves in every role, the top included. `courier_spawn` alone is 2,909
    characters, of which its schema is 2,076.
*   **Cons**: Each description is what tells a model how to use the tool. Every shortened one is
    a changed model-facing string, with a real-model run behind it.
*   **Reason for Rejection**: Not rejected. It is a different change with a different risk, and
    it is under "Future Improvements".

### Alternative G: Close the idea

*   **Pros**: No work, no matrix. On default settings the saving reaches few sessions: a tree
    one to four levels deep has no session at the deepest level.
*   **Cons**: A session that cannot start sessions keeps carrying three tools that can only
    refuse it.
*   **Reason for Rejection**: The rule costs one statement and no string, and no cheaper
    variant exists.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Rollout and rollback.** Not a breaking change: no tool, parameter or option is removed, and
    no call that succeeds today fails, outside the accepted case of a lowered `maxDepth`. It
    ships in an ordinary release, with one line in its notes, when the author decides. While an
    old and a new copy of the plugin are loaded side by side, a session's requests can carry
    seven tools from one copy and four from the other, each change costing one uncached request.
    A rollback restores the seven.
*   **Token cost.** 4,099 characters fewer on each request of a session that cannot start
    sessions. No request grows.
*   **Privacy.** Real-model results are not published.

--------------------------------------------------------------------------------

## Future Improvements

*   **`courier_answer` at the top only**, as Alternative A describes, if the kept roles come to be
    shared across plugin instances for another reason.
*   **Shorter descriptions and schemas**, as Alternative F describes.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

One pull request. The file list comes from reading the files named, not from a search; the
implementer confirms each against the code as it then is.

### Target Files to Create/Modify

#### 1 `src/tree/context.ts`, `src/tree/ports.ts`, `src/index.ts` (Modify)

*   **Type / Scope**: The `context` hook and its ports.
*   **Proposed Changes**: Where `shapeContext` deletes `courier_spawn` for a session that cannot
    start sessions, it also deletes `courier_stop`, `courier_cleanup` and the names in a new
    `ContextPorts` field. `src/index.ts` passes `courier_answer` in that field. The check that
    reads `courier_spawn`'s absence to leave a session without a role line is unchanged.

#### 2 `test/limits.test.ts`, `test/plugin.test.ts`, `test/notices.test.ts` (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**: `limits.test.ts`: the case "hides courier_spawn at maxDepth and keeps
    it above" runs with all eight tools in the map and expects the four at the deepest level and
    the eight above it and at the top; the fork case expects the original to lack the four
    hidden tools and the fork to have them; a new case does the same for an OpenCode subagent in
    a tree. `plugin.test.ts`: the hook registered by the plugin hides `courier_answer`, which
    shows that the composition root passes the name. `notices.test.ts`: the brief at `maxDepth`,
    the leaf role line and the reminder name no tool outside the four.

#### 3 `e2e/run.sh`, `e2e/mock-model.mjs`, `test/e2e-shards.test.ts` (Modify)

*   **Type / Scope**: Live suite.
*   **Proposed Changes**: Four groups check the tool list a request carried, from the mock
    model's log and the probe's. `depth`: every request of a session at the deepest level has
    exactly the four, and one that calls `courier_stop` is told the tool is not available.
    `role-entry`: the same after a compaction. `fork`: the fork of such a session has all
    eight, with the system prompt byte for byte. `subagent-role`: the subagent has the four and
    the child above it has all eight. `SUITE` and `e2e-shards.test.ts` follow the new counts.

#### 4 `docs/reference.md`, `docs/maintainers/plugin-api-notes.md`, `README.md` (Modify)

*   **Type / Scope**: Documentation.
*   **Proposed Changes**: Reference: "Session trees and their limits" and "OpenCode's subagents"
    name the four tools such a session is offered, where they name `courier_spawn` alone, and
    "Options" says under `maxDepth` what a lowered limit means for a session that has children.
    Plugin-api-notes: the sentences on a fork of a leaf and on a leaf's compaction request name
    the tools. README: the tools table says which tools a session that cannot start sessions is
    offered, in one line.

### Verification Plan

*   **Compilation/Build**: `bun run typecheck` and `bun run build`.
*   **Unit Tests**: the three files above; `bun test --update-snapshots` changes no snapshot,
    since no string changes, and a changed snapshot is a finding.
*   **E2E/Integration**: `npm run test:e2e` in four shards, in CI.
*   **Real model**: No model-facing string changes, so the rule on re-running
    `e2e/real-model.sh` does not apply. None of the ten scenarios sets `maxDepth`, and none
    builds a tree five levels deep, so no scenario has a session at the deepest level. The
    change bears on a run only where a session in a tree calls the host's `subagent` tool. One
    run of `recursive` after the merge shows that nothing else moved; its result goes to the
    author only.
*   **Counts**: the script of "The saving, measured", run on the branch: 4,228 characters for a
    session that cannot start sessions, 11,236 for every other.
