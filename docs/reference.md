# Behaviour reference

How the plugin behaves beyond the happy path: what a child runs on, how deep and wide a tree of
sessions may grow, how a child's report, a group's reports, and its failures, silent turns,
permission requests and questions reach the session that started it, what is kept and for how long,
and what the webhook receiver does with a delivery. The [README](../README.md) has the short version.

## The OpenCode version

Each release of the plugin is built and tested against one OpenCode V2 version, the exact
`@opencode/plugin` version pinned in its `package.json` (the README's [Supported OpenCode
version](../README.md#supported-opencode-version) table). The end-to-end suite runs on that version
with every change, and once more on the newest `@opencode/cli` release, where a failure is a warning
rather than a red build, so a host release that breaks the plugin shows up in CI first.

Nothing in OpenCode checks the version: `opencode plugin add` installs the plugin on any V2 host,
and the loader warns about nothing. The plugin loads on hosts from 2.0.4 on, and fails to load on
2.0.0 to 2.0.3, which lack a domain the plugin API gained in 2.0.4. On a newer host, tools may still
break. The terminal part relies on the host to provide its UI modules and is tested on OpenCode
2.0.28 only; the server part works as before on older V2 hosts from 2.0.4 on.

When the running OpenCode reports a version other than the pinned one, the plugin writes one line
to the server log (`opencode serve --print-logs` shows it) when it loads:

```
opencode-courier 0.2.0 was built and tested against OpenCode 2.0.22; this server is 2.0.30 (channel beta). Its tools may fail: see the Supported OpenCode version table in the README, https://github.com/ivopogace/opencode-courier#supported-opencode-version
```

That is all it does: the plugin loads and registers its tools as usual, since the other version may
well be compatible, and no tool result mentions it. The line is written once per load, so once per
project location, never per tool call. An older server, a development build of OpenCode and one
whose plugin context reports no version at all get the line too. Check yours with
`opencode --version`.

## Updating the plugin

Install the plugin by name, without a version (`opencode plugin add opencode-courier`). OpenCode
only checks plugins for updates when their entry is not an exact version: `opencode-courier` (or a
tag or range such as `opencode-courier@latest` or `opencode-courier@^0.2.0`) is checked against npm,
but `opencode-courier@0.2.1` counts as fixed, and `opencode plugin check`, `opencode plugin update`
and *check for updates* (ctrl+r) in the TUI's `/plugins` dialog never offer it a newer release. If
your entry carries an exact version, replace it with the name and restart OpenCode:

```bash
opencode plugin remove opencode-courier@0.2.1   # the entry exactly as it appears in plugins
opencode plugin add opencode-courier
```

Then `opencode plugin check` lists `courier` with `(update available)` when a newer release exists,
and `opencode plugin update` installs it. If an unpinned entry still shows no update after a release,
the check itself may have failed: OpenCode treats a failed check as "no update" and only writes the
warning `failed to check plugin update` to its log (`~/.local/share/opencode/log/`). The check uses
your npm configuration, so look at the registry and proxy settings in your `.npmrc`.

After an update OpenCode loads the new copy next to the old one until the old one unloads; while both
run, each scheduled message, released group, notice and question still goes out once.

## The tools

Each tool's parameters, `?` marking an optional one; the sections below say how each behaves.

| Tool | Parameters | Does |
|---|---|---|
| `courier_spawn` | `task`, `title?`, `agent?`, `isolate?`, `group?` | Creates a session on the parent's [model](#the-childs-model), optionally in its own git worktree (`isolate: true`; from an isolated session it starts at that session's HEAD, [nested isolation](#nested-isolation)), sends it the task plus a brief naming the parent, how to report back and when to split the task further, and returns at once. With a `group`, its report is held with the [join group](#join-groups)'s. Refused past the [limits](#session-trees-and-their-limits). |
| `courier_send` | `sessionID`, `message`, `status?`, `artifacts?`, `queue?` | Delivers a message to a session, signed with the sender's id, waking it if idle: steered into its running turn, or, with `queue: true`, after the turn ends. From a child to its parent, a `status` makes it the child's [report](#a-childs-report), with its `artifacts` (`branch`, `commits`, `files`, `checks`) listed in the body; from a member of a join group, a `done`, `partial` or `failed` report is held with the group instead, and the result says so. |
| `courier_status` | `sessionID` | One look at a session: the outcome of its last turn, how long it has been idle, its last reply and the permission requests and questions it waits on (`pending`). For check-ins, not for waiting. |
| `courier_children` | `sessionID?` | Lists the sessions this one (or `sessionID`) started with `courier_spawn`, each with what `courier_status` reports plus its directory, whether it is isolated, when it was started and, for one started in a group, the group and its [report's standing](#join-groups). |
| `courier_tree` | `sessionID?` | Lists the [whole tree](#seeing-and-stopping-a-subtree) under this session (or `sessionID`), depth first, each with what `courier_children` shows plus its depth, its parent and its report state. Cut at `maxTotal` sessions. |
| `courier_stop` | `sessionID`, `cleanup?` | [Stops](#seeing-and-stopping-a-subtree) a session started from this one, directly or through others, and every session under it, deepest first, and cancels the `courier_later` messages scheduled for them; `cleanup: true` also removes their worktrees by `courier_cleanup`'s rules. |
| `courier_cleanup` | `sessionID`, `force?` | Removes the git worktree of a child started with `isolate: true` and drops the child from `courier_children`; a worktree with uncommitted changes or commits on no branch, tag or remote is kept and listed unless `force: true` ([worktree cleanup](#worktree-cleanup)). A child without a worktree is only forgotten; either way a join group member that has not reported is [dropped from its group](#join-groups). |
| `courier_answer` | `sessionID`, `requestID`, `reply?`, `message?`, `answers?` | Passes the person's answer to a [permission request](#a-child-that-asks-for-permission) (`reply`: `once`, `always` or `reject`, with an optional `message`) or a [question](#a-child-that-asks-a-question) (`answers`) that a session started from this one waits on. |
| `courier_later` | `message`, `sessionID?`, `delayMinutes?` or `at?` | Schedules a message for a session (this one by default) in `delayMinutes` (a number, or a string of one) or `at` an ISO 8601 time, and returns its id. When due it is delivered like `courier_send`, queued behind any running turn and waking the session if idle ([scheduled messages](#scheduled-messages)). |
| `courier_cancel` | `id` | Drops a message scheduled with `courier_later`, e.g. because the child it was waiting for reported first. |
| `courier_subscribe` | `topic`, `sessionID?` | Subscribes a session (this one by default) to [webhook](#webhooks) deliveries for a topic: `owner/repo`, `owner/repo#12` (one pull request or issue) or a name for `/hook/<name>`. Each matching delivery arrives as a message, queued behind any running turn and waking the session if idle. |
| `courier_unsubscribe` | `sessionID?`, `topic?` | Drops one topic, or all of a session's when `topic` is omitted, e.g. once its pull request is merged. |

## The child's model

A child runs on the model its parent is using, not on OpenCode's default, so a parent you moved to
another model starts children that can reach theirs too. The exception is a child given an `agent`
that names a model of its own: that agent's model is kept. If the parent's model cannot be looked
up, the child is started anyway, on OpenCode's default.

## Native child sessions

Off by default. With `"nativeChildren": true` in the plugin's `options`, next to the
[limits](#session-trees-and-their-limits), `courier_spawn` creates a child started without `isolate`
with OpenCode's own `parentID`, the calling session, instead of a location; the child takes its
parent's location, which is the directory it would have run in anyway. Like the limits, the option
is read by the instance of the location the calling session runs in, so set it once, in the global
config; a value other than `true` or `false` is not used, and the server log says so when the plugin
loads.

```jsonc
{
  "plugins": [{ "package": "opencode-courier", "options": { "nativeChildren": true } }]
}
```

The child still carries `metadata.courier.parentID`, and the courier's own lineage (the limits, the
roles, the relays, `courier_children`, `courier_tree`, the status entry) still reads the
[roster](#roster), which notes the child as native. An isolated child
is created as before: OpenCode takes a location or a `parentID`, never both, and an isolated child
needs its worktree's location, so for OpenCode it is a session of its own. A child started without
`isolate` by an isolated child is a native child of that one, so a tree with isolated children shows
in OpenCode's UIs as several trees, split at each isolated child; `courier_tree` shows the whole.

**What it is for.** OpenCode's own UIs treat a session's native children as its family, as they do
the sessions of OpenCode's `subagent` tool:

- the TUI's view of a session that has no `parentID` lists the permission requests and forms of
  every session under it, and answers them there; its subagent tab lists the children, its footer
  counts the running ones, and the session's cost includes theirs;
- the request dock of the paired web, desktop or mobile app shows and answers the permission
  requests, questions and forms of the open session and every session under it (read in OpenCode's
  source; not tried on a device).

So a grandchild's ask can be answered from the top session's view, on a phone too, without a model in
between.

**What changes with it**, each covered by the live suite where it can be:

1. **Deleting a session deletes its native children**, and theirs, as OpenCode deletes a subagent's
   session with its parent; their isolated children are left. The plugin forgets each deleted child
   as it does any [deleted child](#worktree-cleanup). `courier_cleanup` and `courier_stop` never
   delete a session.
2. **What providers see.** A native child's model requests carry its parent's id as the
   cache-routing id (`x-session-affinity`, `X-Session-Id`, `x-opencode-session` and the
   `promptCacheKey`), where a child without the option carries its own, plus two headers naming the
   parent (`x-opencode-parent-session-id`, `x-parent-session-id`). OpenCode's GitHub Copilot provider
   sends `X-Interaction-Type: conversation-subagent` and `x-initiator: agent` for such a session
   instead of `conversation-agent`, which Copilot meters differently from requests a person makes;
   the plugin was not tried on Copilot.
3. **Permissions.** OpenCode gives a session created with a `parentID` and no ruleset its parent's
   session-level ruleset (what an API client or the TUI's tools set on a session, merged after the
   agent's). The courier passes an empty ruleset, so a child runs on its agent's rules alone, as
   without the option: the option changes where a child's asks are shown, not what it may do
   without asking. A rule saved with `always` is the project's, and applies to every session
   either way.
4. **Where asks are answered.** A native child leaves the TUI's session lists: it is reached from
   its parent's subagent tab or by id, and left with "Go to parent session". Its own view in the TUI
   lists none of its permission requests or forms; the view of the top of its native tree does, that
   is the session at the top of the courier's tree, or the isolated session nearest above it. The
   notice of a [form](#a-child-that-shows-a-form) names that session.
5. **Who else answers.** Whatever answers the asks of a session's family now answers the courier's
   native children's too: the TUI's `autoaccept` permission mode, in the open top session's view,
   approves their requests once, and `opencode run`, while it runs a turn of the top session, takes
   them for its own subagents', approving their requests once with `--auto`, rejecting them without
   it, and cancelling their questions and forms.
6. **Cost.** The TUI's cost of a session includes its native children's.

**Questions: asked once, in OpenCode's own form.** A native child's question is not passed up to be
asked again. While the child's question call waits, OpenCode shows its form in the view of the top of
its native tree; when that is the top session, the one the question would be relayed to, the plugin
tells the top session's model with a notice marked `shown="native"`, which lists the questions and
says that OpenCode shows them to the person in its own session, that they answer there, and that it
is not to ask them itself; and the top session's question tool is not linked to that question, so
even a model that asks anyway passes nothing on. The person answers the child's form, in the TUI's
view of the top session or the paired app's dock; the child carries on in the same turn, and the top
session is told once it is settled (`answered="elsewhere"`, *answered by the person*), as when they
answer it in the asks inbox. `courier_answer` still answers it, which withdraws the child's form, for
a person who gives the answer in the chat instead. Once the child's call is cut off (its turn
stopped, a restart), its form is gone, and the question is relayed as without the option, the top
session's question tool linked to it again. A question of a native child under an isolated session
shows in that session's view, not the top's, so it is relayed and linked as without the option, as is
every question of an isolated child.

**Permission requests: asked once, in OpenCode's own prompt.** A native child's permission request
whose native root is the top session is not put to the person by the model. OpenCode shows it in the
top session's view as its own permission prompt, bound to that request, and on the paired app's dock;
the plugin tells the top session's model with a notice marked `shown="native"`, which says so, tells
it not to ask the person, with its question tool or in its reply, nor to decide, and to tell them in
one line at most and end its turn, and still lists the choices for `courier_answer`, for a person who
asks the model to answer for them. Once the person answers in OpenCode's prompt, the model is told it
is settled (`answered="<reply>"`). Approval stays with the host's prompt, which a model cannot answer
for the person; a model that ignores the notice and asks anyway does no more than without the option,
and the first answer counts. A native child under an isolated session, an isolated child, and every
child with the option off get the notice as without the option.

Turn the option on only where the person sees OpenCode's own prompts and forms: the TUI, or the
paired app. A client that shows none, a bare API client, leaves a native child's questions and
permission requests without a prompt (and `opencode run` answers them itself, as above);
`courier_answer` is the fallback, and `courier_status` lists them under `pending`.

## Session trees and their limits

Any spawned session can call `courier_spawn` too, so sessions form a tree: the session nobody
spawned is its top, at depth 0, the sessions it starts are at depth 1, theirs at depth 2, and so on.
Three options bound the tree, each a positive integer, read from the plugin's `options` next to
`webhook`:

| Option | Default | |
|---|---|---|
| `maxDepth` | `3` | The deepest a spawned session may be. A session at this depth cannot start sessions. |
| `maxChildren` | `5` | How many of the sessions one session started may be live at once. |
| `maxTotal` | `20` | How many spawned sessions may be live at once in one tree, anywhere in it; the top session is not counted. |

```jsonc
{
  "plugins": [{ "package": "opencode-courier", "options": { "maxDepth": 2, "maxChildren": 3 } }]
}
```

Each location's instance reads its own options, and a spawn is checked by the instance of the
location the calling session runs in, so set them once, in the global config. A fourth option,
`nativeChildren`, decides how children are created: [Native child sessions](#native-child-sessions).
A value that is not a positive integer is not used: that limit keeps its default, and the server log
says so when the plugin loads. Like every option, a changed limit applies once OpenCode loads the
plugin again.

**`courier_spawn` enforces them.** Before it creates anything, it works out the calling session's
depth and tree from the [roster](#roster) and refuses, with an error naming the limit and what to do
instead (do the work yourself, or end the turn and try again once a child has reported), when the
child would be deeper than `maxDepth`, or when `maxChildren` or `maxTotal` sessions are already
live. A session is live while its turn runs, while it [owes its parent a
report](#a-child-that-ends-without-a-report), or while a session below it is live. Its turn runs
from its creation until it ends, and again while a message keeps it busy. It owes a report from the
moment its task or a message reaches it ([not what the person types in it](#a-child-that-ends-without-a-report))
until it reports to its parent with `courier_send`, or its turn fails or is interrupted, so a child
that ends its turn without reporting keeps counting until it does; a session that has split its task
and ended its turn to wait for its children owes one too. A session that has reported since anything
last reached it counts only while its turn still runs; one whose turn failed or was interrupted since,
or that has reported and finished its turn, with nothing live below it, does not count. One OpenCode
no longer knows does not count, whatever it owes. For a session spawned by a release of the plugin
that kept no report state, or whose state cannot be read, the session counts while its turn runs.

The checks run one at a time in the process, and a spawn under way counts until its child is on the
roster, so several `courier_spawn` calls made at once cannot get past a limit together, whichever
locations or copies of the plugin make them; two servers on one data directory do not see each
other's spawns under way. A failed roster read refuses the spawn, failing closed, while a failed
look-up of a session counts it as not running. Depth is read from the roster, so a session whose
roster entry could not be written, or was dropped after 14 days, starts its children as if it were
the top of a tree.

**The brief says when to split.** A spawned session is told its depth and the limits. Below
`maxDepth` it is given a rule: split the task when it has 2 or more independent, substantial parts
touching separate files or areas, one session per part; do it itself when it is small, sequential or
tightly coupled, and never start exactly one session; and say which in one line of its reply,
`split: no, because …; considered: <the parts you weighed>` or `split: <n> parts: …`, so that a
transcript tells a reasoned decision to do the task itself from one never made, and a reviewer can
see which parts were weighed. A session that splits orchestrates: it ends its turn while its children
work, checks and integrates each part itself, never handing that checking to another session, and
sends its parent one combined report. At `maxDepth` it is told to do the task itself. Every spawned
session is told how to [report](#a-childs-report): once, with a status and its artifacts, and with
`blocked` and a concrete ask when it needs a decision from its parent.

**A `context` hook names the role on every model request.** For a spawned session the plugin adds
one system part, `opencode-courier role: …`, naming its role and depth: `sub-orchestrator` below
`maxDepth`, with the limits, and `leaf` at it, which is told it cannot start sessions. A leaf's
request also goes without `courier_spawn` in its tool list, so its model does not try it. The hook
is guidance and `courier_spawn` the guarantee: another plugin's hook can put the tool back, and the
call is still refused.

A session nobody spawned that has started none gets one part too, `opencode-courier role: root, no
sessions started yet`, which is a pointer rather than a role: before a task that touches several
files or areas, load the `courier-orchestrate` skill and decide whether to split it across sessions,
doing it itself being fine, and say which in one line of the reply (`split: no, because …;
considered: <the parts you weighed>` or `split: <n> parts: …`). The
[skill's description](#the-courier-orchestrate-skill) alone fires only once a model already takes its
task for a big one; the pointer reaches it before it starts working, and asks for the decision to be
visible either way. A request without `courier_spawn` in its tool list, from a session whose agent
does not have the courier tools or one another plugin's hook stripped them from, gets no pointer,
since the session could not act on it. From the request after its first spawn on, the session gets a
`root orchestrator` part with the limits instead.

Every part the hook adds begins with the same `opencode-courier role:` prefix, and the hook adds none
when one is there already, so a second copy of the plugin loaded next to it does not add its own.
Each part is the same on every request of its session, so a session's prompt changes once, at its
first spawn, and the provider's prompt cache holds otherwise. A child spawned by a release before the
roster's reverse index is taken, until the plugin next loads, for a session nobody spawned, and is
pointed to the skill as a root, which its brief, naming its depth, contradicts; `courier_spawn` still
enforces the limits.

## The courier-orchestrate skill

The tools make a tree of sessions possible; the skill is the playbook for using them. The plugin
registers one OpenCode skill, `courier-orchestrate`, in every location it loads in, so it is listed
among the available skills of every session there, with a description saying when to load it: at the
start of any implementation task that may have independent parts, or when a session was started by
one, to decide whether to split the task across sessions and state the decision. It triggers on the
task's shape, not on the conclusion that the task is big, which a model working alone on one issue
never reaches; a session nobody spawned is also pointed to the skill by [the context
hook](#session-trees-and-their-limits) before it starts. A model loads it with OpenCode's `skill`
tool, which asks the `skill` permission for `courier-orchestrate` like any skill (a spawned session's
request is relayed to its parent as any other); a person activates it from the TUI's `/skills`
dialog, which attaches its text to the next prompt. How OpenCode lists, loads and injects a skill:
[plugin-api-notes.md](maintainers/plugin-api-notes.md#skills).

Its text is short and model-facing. It names no limits (the role part and the brief give the
session's own) and says, in order: decide whether to split or do, by [the brief's
rule](#session-trees-and-their-limits), never starting exactly one session. An implementation task
with one tightly coupled core usually still has independent parts: its e2e scenario, its
documentation, sometimes a second test file, and a review of the core by a session with fresh
context, which reads the committed diff against the task and the repository's rules and reports its
findings (`isolate: false`, it edits nothing). The skill asks the session to weigh each of them, to do
the core itself first and commit it, so that the names and texts the other parts depend on are fixed,
then, if 2 or more remain, to start one session per remaining part in one group. Then it says which
in one line of the reply before starting, `split: no, because …; considered: <the parts you weighed>`
or `split: <n> parts: …`; plan the parts so that no two edit the same files, each task complete
enough to be done without the orchestrator; start them with one `courier_spawn` per part, all in one
[join group](#join-groups), `isolate: true` where parts edit files in parallel; end the turn, without
polling; read each [report](#a-childs-report) by its status and artifacts, and what to do on `done`,
`partial`, `blocked` and `failed`; verify first-hand, never through another session (a review
session's findings are a report to act on, while running the checks stays the orchestrator's),
running checks through the project's scripts (`bun run <script>`, `npm run <script>`) rather than
`./node_modules/.bin/<tool>`, so that one permission rule covers them, since the orchestrating
session's own permission prompts are relayed nowhere and each one stalls the whole tree; integrate by
merging each reported branch, then `courier_cleanup`; report upward with one status for the whole, or
reply to the person at the top. Then what to do when a part goes wrong: a [failed
turn](#a-child-that-fails) or a [silent end](#a-child-that-ends-without-a-report), a `courier_spawn`
refused by a limit (do the part, or wait for a report; never retry in a loop), losing track (one
`courier_tree`), and a subtree to abandon (`courier_stop`). The real-model smoke test's [recursive
scenario](maintainers/real-model.md#recursive-orchestration) is where the text is tried against free
models.

## A child's report

A child reports with `courier_send` to the session that started it, giving a `status`: `done`,
`partial` (some of the task is left; the report says what and why), `blocked` (it needs a decision
from its parent, and the report carries a concrete ask) or `failed`. The brief tells it to send
exactly one such report when it finishes, to send `blocked` rather than end quietly when it needs
its parent, and that a message without a status is progress, not its report. `courier_send` carries
the status as an attribute of the envelope the parent reads, `<courier from="<child>"
status="done">`, and in the delivered message's metadata (`status`), so the receiving model, and
[join groups](#join-groups), can branch on it without parsing prose. A status that is none of the
four is refused, since OpenCode does not check a tool's schema
([plugin-api-notes.md](maintainers/plugin-api-notes.md#tools)); `null` counts as none.

With the status, a report may list `artifacts`: `branch`, a string, `commits` and `files`, lists of
strings, and `checks`, a list of `{ command, result }`. They go in the message body after the text,
in one fixed layout, so a parent finds them in the same place in every report:

```
<courier from="ses_child" status="done">
Fixed the total in checkout.

Artifacts:
- branch: fix/checkout
- commits: abc1234 Fix the total
- files: src/checkout.ts, test/checkout.test.ts
- checks:
  - bun test: 412 passed
  - bun run typecheck: clean
</courier>
```

A field that is empty or not of its type is left out, and a check without a command too; nothing is
listed when no artifact is given.

**A status settles the report; a message without one is progress.** A message with a status from a
child to its parent settles the child's report, whatever the status: `blocked` too, since the parent
has been told and must act. A message from the child to its parent without a status is noted as
progress and settles nothing, so a child that sends "halfway there" and then ends its turn without a
report is [told to its parent](#a-child-that-ends-without-a-report), and the notice says that its
last message had no status. The tool's result tells the child which it was: a report, with the usual
line on ending its turn, or progress, with what a report needs. A message to any session but the
parent is neither. A child an earlier release of the plugin briefed was never told about statuses, so
its messages without one count as its report, as before. The plugin acts on no status beyond settling
the report; what each one means is for the parent's model.

## Join groups

Each report wakes the parent separately, so a parent with five children takes five turns, each
re-reading its context, and in a tree that compounds at every level. A join group has the parent
woken once instead: `courier_spawn` takes an optional `group`, a name scoped to the calling session,
and the reports of the sessions started with the same name are held by the plugin until every one of
them has reported and the parent's turn that started them has ended, then delivered in one message. A
name is 1 to 60 letters, digits, dots, dashes or underscores (`reviews`, `phase-1`); any other is
refused before anything is started, and `null` counts as none. `courier_spawn`'s result says the
child's report is held with the group.

**What is held, and what is not.** A report with status `done`, `partial` or `failed` from a member
to its parent is held, with its status, text and artifacts, and nothing is delivered; its result
tells the child so, with how many members have reported, so the child does not take it for a failed
delivery. A held report still settles the child's report as any report does: the child stops [owing
one](#a-child-that-ends-without-a-report), stops counting against the
[limits](#session-trees-and-their-limits) once its turn has ended, and gets no notice of a silent end.
Everything the parent needs now passes through at once, as for a child in no group: a `blocked`
report (the member stays out, and reports again once it has its answer), progress (a message without
a status), a failed turn, a turn ended without a report, a permission request, a question and a form.
A member that reports twice has its later report held in place of the earlier.

**The release.** Once every member has a held report, or has left (below), and the parent's turn that
started the last of them has ended, the group is released. A turn ends when it succeeds, fails or is
interrupted, but not when a shutdown stops it, which the next start resumes. So a member that reports
while that turn is still running, even before its siblings are started, waits for them, and the
parent is woken once, by the group, not once per batch of members it started in that turn. The
parent gets one message, waking it if it is idle, wrapped in `<courier from="<members>"
group="<name>" reports="<n>">`, `from` listing the sessions whose reports it carries, comma-separated.
The body names the group and counts the reports by status, and the members without one, then lists
every report in the order the members joined, each as `[i/n] <sessionID> "<title>": <status>`
followed by its text and its artifacts in [the fixed layout](#a-childs-report), and after them the
members that left without a report. The message's metadata carries `group`, `reports` and `from` (the
same comma-separated list). The held reports are then dropped, and the group with them: the name is
free again, and a `courier_spawn` with it starts a new group, with only the sessions started since. A
session started into a group that is still open joins it, and the release waits for it too. A
member's report after the release, as when the parent sends it more to do, is delivered on its own,
as a report of a child in no group.

**A member that leaves.** A member leaves the group without a report, and the group no longer waits
for it, when its turn [fails](#a-child-that-fails) or is interrupted (by the person, or by OpenCode
after an hour without activity; not by a shutdown, which the next start resumes), when its task could
not be handed over as it was started, when OpenCode deletes its session, or when the parent drops it
with `courier_cleanup` (below). The group is then released once its other members have reported and
the parent's turn has ended, the message naming who left and why. The parent hears of each as of a
child in no group: a failed turn at once, in a notice with a line naming the group (and the group's
message does not overtake that notice, unless a scheduler tick falls in the moment between the two),
a task not handed over as `courier_spawn`'s error, an interruption or a deletion only in the group's
message, and a drop in `courier_cleanup`'s result and the group's message. A group whose every member
left is dropped unsent: the parent was told of each failed turn and did the rest.

A member that reports after all before the release rejoins with its report, and one whose report
comes in while the group's message is going out keeps it, for the next delivery. A member that has
reported keeps its held report whatever happens to its turn after, unless its next word to the parent
is a `blocked` report: that passes through, and the stale held report is dropped, so the member is out
again until it reports. A held report outlives the member's [roster](#roster) entry: a member whose
entry expires after 14 days goes from its group with no trace when it has not reported, and otherwise
stays until the group is released. A member that [ends its turn without a
report](#a-child-that-ends-without-a-report) is still out, as a child in no group would still owe its
report: the silent-end notice says the group's other reports are held until it reports, or until the
parent drops it, and `courier_children` shows it. A report that cannot be held, the storage failing as
`courier_send` runs, is delivered on its own, and the member dropped from the group, which releases
without it.

**Dropping a member.** A member that will not report holds every other member's report back: one that
ended its turn without a report, one whose failure or interruption the plugin missed (its watcher was
resubscribing, or the server was down), or one the parent has given up on. The parent drops it with
`courier_cleanup { sessionID }`, which [forgets the child](#worktree-cleanup), removing its worktree
first if it is isolated (one whose worktree is kept for its work is not dropped). A member still out
is first marked as left, then its roster entry and report state go; with the parent's turn ended, its
held reports reach it at once, in one message that names the member under "Without a report" (`you
dropped it with courier_cleanup`), and the result of `courier_cleanup` says it was dropped from the
group (`group` in its metadata). A member whose report is held, or that already left, keeps it and is
not named as dropped. A dropped member that reports after all, before or after the release, is
delivered on its own, as a child in no group: the parent is no longer waiting on it, so its report is
neither held nor noted, and no group is opened again for it. If its membership cannot be read,
`courier_cleanup` fails before it forgets anything, and can be called again. A dropped child is off
the roster, so it no longer counts toward the [limits](#session-trees-and-their-limits), and the
plugin no longer tells the parent of its failures or silent ends.

**The parent waits.** A session [waits](#a-child-that-ends-without-a-report) on a group as on any
children: while a member still owes it a report it has not been told about, and, once the group is
complete, for the message about to be delivered. So a sub-orchestrator that has split its task into a
group and ended its turn is not reported to its own parent as having ended without a report, until
the group's message has reached it and it ends a turn without reporting; one told that a member ended
without a report, which ends its turn without acting on it, is reported, as it would be for a child in
no group.

**`courier_children`** lists, for a child started in a group, `group: { name, report }`, with `report`
one of `held`, `out`, `failed`, `interrupted`, `deleted` (it left), `released` (the group has been
delivered, or the child joined an earlier one of that name) or `unknown` (its membership could not be
read). A child whose group could not be joined when it was started is recorded in no group, and
`courier_spawn`'s result says so: its report comes on its own.

**Delivery.** The scheduler that delivers `courier_later` messages delivers released groups too, at
each tick, and at once when the parent's turn ends with a group complete, or a report, a failure, an
interruption, a deletion or a drop completes a group whose parent's turn has ended; so once its turn
has ended, the parent waits no longer than for a plain report (with [two
servers](#two-servers-on-one-data-directory) on one data directory, up to a tick longer). Each release
is delivered once, and dropped only after the message has been delivered: a delivery that fails is
logged and tried again at the next tick, while a crash between the delivery and the drop delivers it
again after a restart. Held reports live in the plugin's storage, so a restart loses none. A group
whose parent OpenCode no longer knows is dropped unsent. The group's message is a message like any
other, steered into the parent's running turn or starting one, whatever `queue` the members'
`courier_send` calls gave: it makes a spawned parent owe a report, and a report of its own settles
that.

## A child that fails

A child reports with `courier_send`, which it cannot do when its turn fails: the model is not
available to the account, the credentials are missing, the provider is down. The plugin follows
OpenCode's events, and for every failed turn of a spawned session it sends the parent a message from
that child, marked `failed="<error type>"`, with the child's title and the error, waking the parent if
it is idle. The parent then decides: message the child to have it try again, start a replacement, or
carry on without it.

Every failed turn of a child is reported, also one that fails after the child has reported. A turn
that was interrupted is not a failure and is not reported, and neither is a failure that happens while
the OpenCode server is down or the plugin is not loaded; a `courier_later` check-in still covers
those.

## A child that ends without a report

A child's turn can also end without failing and without a `courier_send` to its parent: its model
replied in text and stopped, or took its task for done. The parent would wait for a report that never
comes, and in a tree, every session above it with it. So the plugin keeps, for each spawned session,
whether it owes its parent a report: from the moment its task or a message delivered through OpenCode's
inbox reaches it (a message from any session, a scheduled message, a webhook delivery, or one of the
plugin's notices) until it calls `courier_send` with its parent's id and a [status](#a-childs-report),
or its turn fails or is interrupted. Only a message to the session that started it, with a status, is
a report; one without a status is progress, and one to a sibling, or to the session at the top, is
neither, since the parent is the one waiting for it.

What the person types in the child's own session, and a compaction or move of it, is between the
person and the child: it does not make the child owe a report, so a child that has reported and then
answers the person is not told to its parent. The plugin tells these apart by the type OpenCode gives
each item as it enters the inbox (`user`, `synthetic`, `compaction` or `move`), remembered for the last
1000 items of spawned sessions, since the delivery does not carry it. A delivery whose item it did not
see enter, such as one queued before a restart, counts as a message, so the parent is told rather than
left waiting. The task, which `courier_spawn` hands over as a prompt like the person's, is noted by
`courier_spawn` itself, just before it hands it over, and settled as failed if handing it over fails.

When a turn of a spawned session ends without failing while it owes a report, the plugin sends its
parent a message from that child, marked `ended="without-report"`, with the child's title and its last
reply as `courier_status` gives it (at most 2000 characters), waking the parent if it is idle. When the
child has messaged the parent without a status since its last prompt, the notice says so: that message
was progress, not the report. The parent decides: message the child with `courier_send` to have it
carry on, or to report if its last reply is what it needed, or start a replacement. Until the child
reports, it counts toward the [limits](#session-trees-and-their-limits). One notice is sent per turn's
end, however many instances and copies of the plugin see it; if it cannot be delivered, the parent is
taken to be still waiting for the child, as if it had not been told.

A turn that ends while the child waits is not reported. It waits while a session it started owes it a
report that it has not been told about, as a session that has split its task ends its turn to wait for
its children; while it has a permission request or a question pending; and while a `courier_later`
message for it is pending, or it has subscribed to a webhook topic since its last prompt, either of
which wakes it. A subscription made before the last prompt is not waiting, since it outlives the
delivery it was made for: once a delivery has come and the child has ended its turn again without
reporting, its parent is told. Once its children have reported, failed or been interrupted, or it has
been told that they ended without a report, a turn of it that ends without a report of its own is
reported. A turn stopped by OpenCode's shutdown resumes on the next start and does not count as
interrupted; one stopped otherwise (by the person, or by OpenCode after an hour without activity)
settles the report and is not told.

The state is kept in the plugin's storage, so a restart does not lose it. It goes with the child's
roster entry, and when OpenCode deletes the session, so its parent no longer waits for it; deleting a
session drops that of the sessions it started too, whose reports can no longer be delivered.

What the plugin cannot see, it cannot judge: a prompt delivered while the server is down or the plugin
not loaded leaves the earlier one in place, so a turn after it that ends without a report may not be
told, and a `courier_send` whose note could not be written is taken for no report, and for no
progress. A prompt the person types, a compaction someone asks for (OpenCode's compact command) or a
move of the session, which OpenCode delivers like a message, counts as one only when the plugin did
not see it enter the inbox; the compactions OpenCode makes on its own as the context fills never do.

## A child that asks for permission

When a child's tool call needs an approval (a permission rule with `"effect": "ask"`, or no rule for
it), OpenCode holds the call until someone answers in the child's session, which the person working
in the parent's session does not see. For a spawned session the plugin sends the parent a message
from that child, marked `asks="permission"` and `request="<id>"`, waking the parent if it is idle. The
message says what the child asks for (the action, such as `shell` or `edit`, and its resources, such
as the command or the paths), lists the choices OpenCode's own prompt offers, and tells the parent to
ask the person rather than decide:

- `once`: allow this request only;
- `always`: allow it and save the rule for the project; offered only when the request says what to
  save, as in OpenCode's prompt;
- `reject`: refuse it, with a reason if the person gives one.

The parent asks you, with its question tool if it has one, and calls
`courier_answer { sessionID, requestID, reply, message? }` with your choice. The plugin passes it on,
and the child carries on. With [`nativeChildren`](#native-child-sessions) on, a native child's request
is answered in OpenCode's own prompt in the top session's view instead, and the parent is told not to
ask you.

A request of a child's child goes to the session at the top, the one you started the first child from,
and so on down any number of levels, since that is where you are; the message names the session that
started the asking one. Only that top session can answer it. A session started with `courier_spawn`
cannot answer what its own children ask, so it cannot get around a rule that makes it ask by starting
a child to do the job and approving it.

OpenCode ends the child's turn when a request is rejected without a message, and the child would then
never report back. So `courier_answer` always sends a message with a rejection, the person's reason or
a default one; the child's call fails and it carries on, and can report. The child's model is told
that the call could not be run, not the reason.

A request can also be answered without the parent: in the child's own session (for a [native
child](#native-child-sessions), in the view of the top of its native tree), or along with another
answer (an `always` that covers it, or a rejection, which rejects the session's other pending requests
as well). For a request the parent was told about, the plugin then sends it a short message marked
`answered="<reply>"` saying the request is settled, so it does not pass on a stale question; after a
rejection, the message adds that the child may have stopped, and that `courier_send` gets it going
again. A `courier_answer` that comes later anyway passes nothing on and says so. The TUI's [asks
inbox](#the-asks-inbox) answers through OpenCode's reply too, so the parent hears the same.

`courier_status` and `courier_children` list the requests a session waits on under `pending`, so a
parent that has lost the message, after a compaction for example, can still find them. Whenever the
plugin starts following OpenCode's events again, after loading or after its event stream broke, it
also relays the requests that spawned sessions already wait on, so one asked in the gap is not missed.

## A child that shows a form

OpenCode asks some things through forms of its own rather than a permission request or the question
tool, and shows them in the child's session only. The one a child meets most is web search: the first
`websearch` call made while no search provider has been chosen shows a "Web Search" form (allow search
through the providers OpenCode has, choose another provider, or disable web search), and a second one,
"Choose a web search provider", if the person picks another. The plugin cannot pass such a form on or
answer it, since the plugin API has no way to answer or withdraw a form; only the person can, in the
child's session.

So for a form of a spawned session the plugin sends the session at the top, the one its permission
requests go to, a message from that child marked `asks="form"`, `form="<id>"` and, when the form says
what it is for, `kind="<kind>"` (`kind="websearch.provider"` for web search), waking it if it is idle.
The message gives the form's title, its fields and their choices, and says that neither the parent
nor `courier_answer` can answer it, only the person, in that child's session, or, for a [native
child](#native-child-sessions), in the session whose view OpenCode shows it in, which the message
names: the parent should tell you, not choose for you. A form of a child's child goes to the top
session, naming the session that started the asking one, as with a permission request.

For web search the message adds what OpenCode does next. It waits for the choice at most a minute;
then the child's search fails with "Web search cancelled", and the child carries on without it. The
choice is kept for every session (OpenCode stores it globally), so once it is made, in any session, no
session is asked again: you can answer in the child's session, run one web search in your own session
and answer there, or pick the provider under OpenCode's "Third-party search" setting.

Once a form the parent was told about is answered, or withdrawn unanswered (dismissed, given up on
after OpenCode's minute, or cut off with the child's turn), the plugin sends a short message marked
`settled="answered"` or `settled="cancelled"` and `form="<id>"`, so the parent does not send you to a
form that is gone. The TUI's [asks inbox](#the-asks-inbox) lists and answers such forms, and the
parent hears the same.

The question tool's forms are not told this way: [the question relay](#a-child-that-asks-a-question)
passes every question of a spawned session on. Forms of sessions the plugin did not spawn are ignored,
among them MCP servers' requests for input, which OpenCode does not attach to a session. The plugin
cannot list the forms a session shows, so `courier_status` does not report them; a form shown while
the plugin was not following OpenCode's events is not told, and one settled then, or across a server
restart, is not told settled.

## A child that asks a question

A child that calls OpenCode's question tool shows its question in its own session only. The plugin
wraps that tool, and once the question of a spawned session is on screen, it sends the session at the
top, the one its permission requests go to, a message from that child marked `asks="question"` and
`request="question_<id>"`, waking it if it is idle. The message lists the questions and their options,
gives them again as one line of JSON in the question tool's own input shape, and tells the parent to
ask the person, with its question tool and exactly those questions, rather than answer.

When the parent asks you the same questions with the same options, the two are linked: what you pick
in the parent's session is passed to the child's waiting call, which returns it as if you had answered
there, and the child carries on in the same turn. The parent's tool result says so. Only the same
wording links (spacing and case aside; the options may come in any order), so a question of the
parent's own with the same yes-or-no choices never answers a child's; when a waiting question has the
same choices, the parent's tool result says the answers were not passed on and names the request. A
parent that asked you some other way, in text or reworded, calls
`courier_answer { sessionID, requestID, answers }`: one entry per question, in order, each the label
you chose or the text you gave, or a list of labels where a question allows several. As with
permission requests, only the session at the top can answer. Answers to one question are passed on one
at a time, and once: a second waits for the first, and is told the question no longer waits once the
first got through.

The question stays in the child's session too, and you can answer it there instead. Whichever answer
comes first counts, and the other side's question is withdrawn:

- answered or dismissed in the child's session: the parent's open question disappears and its tool
  result says why, or, with none open, the parent gets a short message marked `answered="elsewhere"`
  or `answered="dismissed"` (or `answered="failed"`, when the child's question call failed, which ends
  its turn too). A dismissal there ends the child's turn, as OpenCode's question tool does, and the
  message says to `courier_send` it if it should carry on;
- answered in the parent's session: the child's question disappears;
- dismissed in the parent's session: the parent's turn ends, as OpenCode's tool does, and the child's
  call returns that you dismissed the question, so the child carries on without the answer and can
  report;
- answered with `courier_answer` while the parent's question is open (a parent that asks you and calls
  `courier_answer` in the same step): the parent's question disappears, and its tool result names the
  answers that went to the child.

A dismissal on either side reaches the other about two seconds later: OpenCode withdraws open
questions the same way when it shuts down, and the plugin waits that long to tell the two apart.

A question whose call is cut off stays answerable. When the child's turn is stopped (interrupted, or by
OpenCode itself, which stops every turn in a project location after 60 minutes without activity there),
or the server restarts or closes the project, the question is gone from the screen. The plugin keeps it
in its storage, sends the parent a message marked `stopped="true"`, or `restarted="true"` when the
plugin is next loaded, with the questions, and passes the answer on as a message to the child, which
wakes it. If the parent is asking you at that moment, your answer goes that way without a new message.
Stored questions are dropped after 14 days, once the child is off its parent's roster, or beyond the
100 newest.

`courier_status` and `courier_children` list a session's questions under `pending`, with
`type: "question"`, the questions, and `stopped: true` for one that was cut off. With
[`nativeChildren`](#native-child-sessions) on, a native child's question is not linked: the person
answers it in OpenCode's own form, shown in the top session's view, and the top session is only told.

A question is relayed only once OpenCode's permission check for it has passed: a child whose agent may
not ask questions (OpenCode's `general` agent, or a `question` rule with `"effect": "deny"`) is refused
as before, and the parent hears nothing. The child brief tells children to use the question tool when
the person must decide; a child can still send its question with `courier_send` instead, and the
parent then passes your answer back with `courier_send`. The TUI's [asks inbox](#the-asks-inbox)
answers a question as `courier_answer` does; the top session hears it as a question settled without
it, *answered by the person*, whether or not the child is native.

## Roster

`courier_spawn` records each child under its parent in the plugin's storage, so a parent that has lost
track after a compaction or a server restart can call `courier_children` to find them again. A child
that can no longer be looked up is still listed, with the error instead of its state. The roster is
also where a session's depth and tree are read from, for the [limits](#session-trees-and-their-limits).
Whether a child [owes its parent a report](#a-child-that-ends-without-a-report), and its place in a
[join group](#join-groups), are kept next to it, and dropped with its entry. Entries are dropped 14 days
after the child was started, when that parent's roster is read or the plugin is next loaded, except
isolated children whose worktree is still there (see [Worktree cleanup](#worktree-cleanup)). Loading
the plugin also removes, best-effort, report state whose session has no entry left, as a cleanup that
failed part-way leaves it. If the roster cannot be written, the child still gets its task and
`courier_spawn` says it is not on the list.

## Seeing and stopping a subtree

**`courier_tree`** lists the sessions under the calling session, or under `sessionID`: those it
started with `courier_spawn`, and those they started, and so on, at most `maxTotal` sessions; past
that the result says `truncated` and the number, and `courier_tree` on one of the listed sessions lists
what is under it. The result is flat, in the order a tree is drawn (each session followed by what it
started, siblings oldest first). Each entry is what `courier_children` shows (`sessionID`, `title`,
`outcome`, `lastText`, `pending`, `directory`, `isolated`, `created`, and `group: { name, report }` for a
member of a join group) plus:

- `parentID` and `depth`: 1 for a child of the session the tree is read from;
- `report`, when its report state is known: `owes` (it has been prompted since it last reported,
  failed or was interrupted), `progressed` (it messaged its parent without a status since its last
  prompt), `ended` (its turn failed or was interrupted since) and `status` (the status of its last
  report: `done`, `partial`, `blocked` or `failed`).

Anyone can read any session's tree, as with `courier_children`.

**`courier_stop { sessionID, cleanup? }`** stops a session and every session under it:

1. Only a session above the target may stop it: the calling session must be one of the sessions that
   started the target, directly or through others, as for [`courier_answer`](#a-child-that-asks-for-permission),
   so a session cannot stop itself, a sibling or a parent, and one `courier_spawn` did not start cannot
   be stopped.
2. Every session in the subtree is marked stopped and the `courier_later` messages scheduled *for*
   them are cancelled, before any interrupt, so nothing scheduled wakes a session that has just been
   stopped. Messages they scheduled for other sessions, and webhook subscriptions, are left alone.
3. They are interrupted level by level, deepest first, the level's sessions at once. A session that
   does not run is not an error: its entry says `idle` and nothing else happens to it; one OpenCode no
   longer knows says `gone`, and one whose interrupt failed says `failed` with the error and may still
   run, while the others are stopped regardless. The subtree is then read again, up to three times, for
   a session one of them started meanwhile.
4. With `cleanup: true`, the worktrees of the stopped sessions that ran in one of their own are removed
   deepest first by the rules of [`courier_cleanup`](#worktree-cleanup), without `force`: one with
   uncommitted changes or commits on no branch is kept and listed in the result, and one that fails is
   listed with its error.

The result lists every session stopped, deepest first, with its outcome, the ids of the messages
cancelled, and the worktrees.

**Who is told.** An interrupt settles the session's report and takes a member out of its join group
(the release message names it as interrupted). The failure and the silent-end notices stay quiet for a
session stopped since its last prompt: a session prompted again after a stop is judged as any other.

- The calling session is not told of what it stopped.
- The parent of the target is told once, `ended="stopped"`, when it is not the caller, that is when
  there is a session between the caller and the target. The notice says it was stopped by a session
  above, and is not a failure. It is not sent when the target did not run, as nothing was stopped.
- Sessions under the target are not told: their parents are stopped too, and a notice would wake them.

A stopped session is not forgotten: it stays on the roster and in `courier_tree`, can be messaged with
`courier_send` (which prompts it again, and it owes a report again) and is removed by `courier_cleanup`.
A session of the subtree that a running turn of its own starts between the first look and the last
cannot be stopped.

## In the terminal

The package has three entrypoints: the server plugin (`opencode-courier`), a TUI part
(`opencode-courier/tui`) and its RPC contract (`opencode-courier/rpc`). The server runs only the server
plugin and lists the others as features in `GET /api/plugin` (`features: { server: true, tui: true,
rpc: true }`); the TUI loads the TUI part for a plugin with that feature. The TUI part is a view and a
shortcut: courier without a TUI attached, as under `opencode serve`, `opencode service` or the paired
app, behaves the same. What it does, answering an ask or stopping a session, goes through the same
paths as `courier_answer` and `courier_stop`, so a model sees only what those would tell it.

**The status entry.** In the prompt's footer, for the open session:

```
courier 2 running · 1 waiting on you · 1 idle · group pair 1/2
```

It counts the sessions under the open session, those it started with `courier_spawn` and those they
started, at most `maxTotal` as `courier_tree` reads them (past that, `first <maxTotal> counted`), each by
what it does:

- `waiting on you`: it waits on a permission request or a question, those `courier_status` lists as
  `pending`, which go to the person at the top of its tree;
- `running`: its turn runs, or something reached it after its last turn ended, and it waits on no
  request;
- `idle`: neither, whether it has reported or waits for a message.

A session OpenCode no longer knows is not counted. Then, for each join group of the open session's own
children still open, `group <name> <reported>/<members>`: the members whose report is held out of those
that have not left (a group of a grandchild's is its parent's to wait on, and not shown). A part that is
zero is left out; the entry shows nothing on the home screen, where there is no session, for a session
that started none, and when the RPC fails, as on a server without it. It asks again 250 ms after the
first of the events that may change it (a session created or deleted, a turn started or ended, a
permission request asked or answered, a form created or settled, a message delivered), once per burst.
A server that cannot register the RPC logs `courier rpc: not registered` and loads the rest as before.

**The tree panel.** `/courier tree` (or *Courier session tree* in the command palette) opens a panel
beside the open session (fullscreen when the session is too narrow to split): `courier_tree` for people.
It reads the sessions under the open session as `courier_tree` does, at most `maxTotal` (past that,
`first <maxTotal> shown`), in the order a tree is drawn, two spaces deeper per level:

```
courier tree  [█████░░░░░] 1/2 reported
▸ Report back to your parent.  idle · reported done · group pair held
    ran 12s · last courier_send 3s ago · $0.00
  CHILD-ASKS  waiting on you · owes a report · group pair out
    asks permission: shell echo courier-asks
↑↓ select · enter open · s stop · r refresh · f fullscreen · q close
```

Each row's first line is the session's title, then what it does (`running`, `waiting on you`, `idle`, or
`failed` and `interrupted` for an idle one whose last turn ended so, `gone` for one OpenCode no longer
knows), its report since its last prompt (`owes a report`, `reported <status>` once it sent one, held
with its group or delivered, `ended without a report` when its turn failed or was interrupted; nothing
for a session spawned before report notes were kept), its join group's standing (`group <name> held`,
`out`, how it left, or `released`), and `isolated`. Under it:

- an **orchestrator**, any session with children among the rows, and the panel's own session in the
  header, gets a bar of the parts reported: its children whose report arrived out of the children it
  started;
- a session **waiting on the person** gets one line per request: `asks permission: <action>
  <resources>` or `asks: <its first question>`;
- a **leaf** gets its activity: how long it ran (from its creation to the end of its last turn, or to
  now while it runs), its last tool call and how long ago it was made, and what it has cost so far; a
  `gone` one gets none.

There is no progress a session reports of itself: a bar counts only reports courier noted. The panel
asks again a second after the first of a burst of the status entry's events and of a tool call, a usage
update or a rename, and redraws its times every second. Its keys, while it has the keyboard (it takes it
when it opens; `<leader>left` and `<leader>right` move it between the session and the panel): `↑`/`k` and
`↓`/`j` move the selection, `enter` opens the selected session, `s` stops it, `r` asks again, `f` toggles
fullscreen and `q` closes the panel. Opening a session leaves the panel with the session it was opened in.

**Stopping from the TUI.** `s` in the panel, or `/courier stop <session>` in the prompt (`/courier stop`
alone lists the open session's tree to pick from), asks the person to confirm with the session's title
and how many sessions are under it, then stops it with the open session as the caller: the same stop as
`courier_stop`, so only a session under the open one can be stopped, deepest first, its scheduled
messages cancelled and its failure and silent-turn notices kept quiet, and the target's parent, when its
turn was interrupted, is told with the usual notice unless it is the open session itself (the person is
there to tell it). A toast says how many sessions were stopped and interrupted and how many scheduled
messages were cancelled, or why the stop was refused. `/courier` with anything else shows its usage.

**Attention.** A join group's reports released to a session call for attention, with a notification
when the terminal is not focused and the `done` sound; a child's report to its parent (a message with a
status) plays the `subagent_done` sound, without a notification. A report held with its group sounds
once, with its group's release. Each delivery is notified once per TUI.

**The RPC.** `courier`, registered by every instance at its location as the tools are, through the same
use cases as `courier_tree`, `courier_children` and `courier_stop`; the roster is one store for every
location. Its contract is `treeRpc` from `opencode-courier/rpc`, for a client's `client.rpc(treeRpc)`.
The TUI asks at the open session's own location (where the plugin is loaded), else the TUI's, else the
server's default one. Over HTTP:

```
POST /api/rpc/courier/summary?directory=<location> {"input":{"sessionID":"ses_…"}}
{"output":{"running":0,"waiting":1,"idle":1,"groups":[{"name":"pair","reported":1,"members":2}]}}
```

- `summary {sessionID}`: the status entry's counts, with `truncated: <maxTotal>` when the subtree was
  cut. An input without a `sessionID` is refused as `rpc.invalid_input`.
- `tree {sessionID}`: the panel's rows. Each row: `sessionID`, `parentID`, `title`, `depth` (a child of
  the session asked is at 1), `state` (`running`, `waiting`, `idle` or `gone`), `outcome` of its last
  turn, `report` (`state`: `owed`, `reported` or `ended`, with the report's `status` once reported, and
  `progressed`), `group` (`name`, `standing`), `isolated`, `created`, `idle` (when its last turn ended, if
  it is not running), `cost` in US dollars, `tool` (its last tool call's `name` and `at`, when it ran) and
  `waits` (`{type: "permission", action, resources}` or `{type: "question", question}`); times in epoch
  milliseconds. `truncated` as for the summary.
- `stop {sessionID, by}`: `courier_stop` for `sessionID`, called from `by`, which must be above it;
  answers `{stopped: [{sessionID, title, outcome}], cancelled: <count>}`, deepest first, or fails with
  the declared error `refused` and `courier_stop`'s message.

### The asks inbox

Every permission request, question and form waiting on the person anywhere in the open session's courier
tree, answered in the TUI's dialogs with no model in between. It is opened by the command `courier.asks`:
its key `<leader>k` (`ctrl+x k` by default), the slash command `/asks`, the command palette ("Courier:
what waits on you"), or a click on the footer's entry while it shows `waiting on you`. With no session
open it says so; with nothing waiting, "Nothing in this courier tree waits on you."

**What it lists.** The tree is courier's own, read from the roster, not OpenCode's `parentID`: from the
top of the open session's lineage down, so every session of a tree, the root or a grandchild, lists the
same, at most `maxTotal` sessions as `courier_tree` reads them. It lists the tree's permission requests
and questions as `courier_status` lists them (`pending`), and each session's forms, leaving out the
question tool's own forms, which are listed as their questions. One line per ask, oldest first (in the
order the inbox first saw them, and in the tree's order among those seen together):

```
Waiting on you (2)
  Permission: shell echo courier-asks         Root › Fix the bug › Write tests   depth 2 · group pair
  Question: Greeting: Which greeting?         Root › Fix the bug                 depth 1
```

A question whose call was cut off says `cut off, answered by message`. Searching filters the list.

**Answering.** Choosing an ask opens its dialog; `esc` goes back to the list, which is read again after
each answer and closes once nothing is left.

- A permission request: `Allow once`, `Always allow` (only when the request has something to save, which
  it names), `Reject`, or `Reject with a reason…`, which asks for the reason. It goes through OpenCode's
  own reply, which settles it; a rejection always carries a message, the person's reason or
  `courier_answer`'s default, so the child's call fails and it carries on rather than ending its turn.
  The session told about the request then gets [one settled notice](#a-child-that-asks-for-permission)
  (`answered="once"`, …) and no second ask, as for a reply in the child's own session.
- A form: each field it shows in turn (hidden ones and those whose `when` fails on the answers so far are
  skipped): a choice for one with options (and an answer of the person's own where the field allows it),
  a yes or no for a boolean, several choices for a multiselect, typed text or a number otherwise; an
  optional field can be skipped. The answer goes through OpenCode's own form reply, and the session told
  about the form gets [its settled notice](#a-child-that-shows-a-form). A form that opens a page (an
  `external` field) is left to its own session.
- A question: each of its questions in turn, one choice, several (toggled, then `Done`) where it allows
  them, or `Type your own answer…`. The answers are passed on as `courier_answer` does: as the result of
  the call that waits on it, or as a message when that call was cut off. The top session then hears it
  once, [as a question settled without it](#a-child-that-asks-a-question), *answered by the person*: if
  its own question call asking the person the same is open, that call is withdrawn with `answered by the
  person (…)`; otherwise, if it was told about the question, it gets the settled notice
  (`answered="elsewhere"`, `was answered by the person (…)`), for every child, native or not. A later
  `courier_answer` for it passes nothing on. Answers that do not fit the question come back as a message
  in the TUI, and nothing is passed on.

**Attention.** 250 ms after the first of a burst of permission requests and forms, the TUI reads the open
session's tree and plays, for each ask it has not sounded before, OpenCode's `permission` sound for a
permission request and its `question` sound for a question or a form, with a notification (the ask and
where it comes from) when the terminal is not focused. OpenCode's own TUI sounds for every request and
form it sees as well.

**The RPC.** `courier-person`, registered by every instance next to `courier`; its contract is
`personRpc` from `opencode-courier/rpc`:

```
POST /api/rpc/courier-person/asks?directory=<location> {"input":{"sessionID":"ses_…"}}
{"output":{"top":"ses_…","sessions":[{"sessionID":"ses_…","title":"Fix the bug","parentID":"ses_…","depth":1}],
  "permissions":[{"sessionID":"ses_…","requestID":"per_…","action":"shell","resources":["echo hi"],"save":["echo *"]}],
  "questions":[{"sessionID":"ses_…","requestID":"question_…","questions":[…],"stopped":true}]}}
POST /api/rpc/courier-person/answer?directory=<location> {"input":{"sessionID":"ses_…","requestID":"question_…","answers":[["Hi"]]}}
{"output":{"answered":true,"by":"result"}}
```

`sessions` has `group` for a member of a join group, the output `truncated: <maxTotal>` when the tree was
cut. `answer` gives `{"answered": false}` for a question that no longer waits, and `problem` with the
reason when the answers do not fit. Forms are not in `asks`: the TUI lists them itself
(`GET /api/session/:id/form`).

## Worktree cleanup

An isolated child works in a git worktree under OpenCode's data directory
(`…/opencode/worktree/<project>/<name>`, on a detached HEAD), and nothing removes it on its own. When
the parent has what it needs from the child, it calls `courier_cleanup { sessionID }`, which removes the
worktree and drops the child from `courier_children`. A child started without `isolate` ran in the
parent's directory and has no worktree: `courier_cleanup` only forgets it (outcome `forgotten`),
dropping its roster entry and report state, and, for a member of a join group that has not reported,
[dropping it from the group](#join-groups). `courier_cleanup` never deletes a session. Deleting one in
OpenCode (the TUI, the app or `DELETE /api/session/<id>`) drops its report state and groups, and the
report state of the sessions it started; its roster entry stays, listed with the error, until its 14
days are up. With [`nativeChildren`](#native-child-sessions) on, it also deletes the session's native
children, and theirs, which are forgotten the same way.

### Nested isolation

A root session's isolated child starts from the project's last commit, as above. When the session
calling `courier_spawn` with `isolate: true` is itself an isolated child on the roster, the new worktree
starts from the commit **the parent's worktree is on now**, so a sub-orchestrator hands its committed
work down; that commit is the child's recorded base. Uncommitted work is not handed down: the brief of an
isolated session tells it to commit before it spawns, and when the parent's worktree has uncommitted
changes `courier_spawn` says so in its result (the spawn goes on).

- A parent whose roster entry could not be indexed (see [the roster](#roster)) is taken for a root, and
  its children start from the project.
- If the parent's HEAD cannot be read (git missing, the worktree gone), `courier_spawn` fails and starts
  nothing: starting from the project instead would give the child code without the parent's work,
  unannounced. The error says to start it without `isolate`.
- Every isolated child is told to commit its work on a branch named `courier/<its session ID>` (it
  starts on a detached HEAD, so it creates it) and to name that branch in `artifacts.branch` of its
  report. The branch is in the shared repository, so the parent merges it into its own worktree, which
  is the parent's to do. `courier_cleanup` counts the branch like any other: the commits on it are not
  "on no branch", and the commits a worktree was made from never count.
- How OpenCode makes a worktree from a commit: [plugin API
  notes](maintainers/plugin-api-notes.md#creating-a-worktree-from-a-given-commit).

The worktree is kept, and the result says why, when it holds work that would otherwise be lost:

- uncommitted changes, untracked files included (ignored files, such as `node_modules`, are not work and
  go with the worktree);
- commits that are on no branch, tag or remote-tracking ref, which is where a child's commits on its
  detached HEAD end up. A commit on a branch survives the removal, so it does not count, and neither do
  commits the worktree was made from (`courier_spawn` records that commit), such as a parent's own
  unbranched work when an isolated child spawns isolated children of its own.

The result lists up to 50 changed paths (an untracked directory counts once) and 50 commits. Commit or
branch what you want to keep (`git -C <worktree> branch <name>` keeps its commits), or call
`courier_cleanup` again with `force: true` to discard it; `force` also removes a worktree git can no
longer read. A worktree whose directory is already gone is just dropped from the list; git forgets its
registration on its next `git worktree prune` or `git gc`.

The plugin reads a worktree's state by running git itself, which it looks for in its usual install
locations and never through `PATH`, so a writable directory early in `PATH` cannot put another program
in its place: `/usr/bin/git`, `/usr/local/bin/git`, `/opt/homebrew/bin/git` and
`/run/current-system/sw/bin/git` (NixOS and nix-darwin), or on Windows `C:\Program Files\Git\cmd\git.exe`
and its `(x86)` twin. Git installed anywhere else is named by the environment variable
`OPENCODE_COURIER_GIT`, an absolute path, set for the OpenCode server. Without a git, `courier_cleanup`
refuses with a message naming the places it looked, unless `force` is set, and `courier_spawn` records
no commit.

Cleanup is explicit only. A child reporting back does not mean the parent has merged, reviewed or even
read its work, and the parent may still send it more to do in the same worktree, so the plugin never
removes one on its own. Isolated children whose worktree still exists are kept on `courier_children`
past the 14 days, so they can still be found and cleaned up.

`courier_cleanup` cannot tell whether the child is still running, so call it after the child has
reported. It works on the calling session's own children.

## Scheduled messages

Pending `courier_later` messages are kept in the plugin's storage, and the plugin checks for due ones
every 15 seconds, so a message can arrive up to about 15 seconds late. Within one OpenCode server,
however many projects have the plugin loaded, one scheduler delivers, so each message arrives once.

They survive a server restart. After a start, OpenCode loads plugins for a project the first time that
project is used, so messages that fell due while it was down are delivered then, not at the moment the
server comes back. A crash between delivering a message and forgetting it can deliver it twice after the
restart; a lost check-in would be worse.

## Two servers on one data directory

Two OpenCode servers on one data directory, such as `opencode serve` next to the background server of
`opencode service`, share the plugin's storage (the roster, pending `courier_later` messages, stored
questions) but not its memory. So:

- **A `courier_later` message, and a released [join group](#join-groups), is delivered by one server.**
  The servers agree through the storage on which one's scheduler delivers; when it stops gracefully,
  another takes over at its next tick, and after a crash or a stall within about 75 seconds, so the
  messages due meanwhile arrive late, not lost. The storage has no compare-and-set, so a message
  delivered twice is rare rather than impossible. A release of the plugin from before this (0.2.2 and
  earlier) delivers on its own schedule beside it. The members' reports are held in the shared storage
  from whichever server runs them, and the delivering server sends the group at once when the last
  report is held, or the parent's turn ends, on that server, or at its next tick otherwise.
- **A child's permission request, its failed turn and its turn without a report are told to the parent
  once**, by the server that runs the child's turn: the one that handled the `courier_spawn`, or the
  latest message, that started it. Whether a child owes a report compares the times of both servers'
  clocks, so they should be one machine's.
- **`courier_answer` passes an answer on only from a turn on that same server.** Pending requests live
  in the memory of the process running the child, and the plugin API offers no channel between servers.
  From the other server it finds no request pending and says so: the request was answered some other
  way, or the session stopped waiting, or it waits in another OpenCode server on the same data
  directory, where the person has to answer it, in the child's session. `courier_status` likewise lists
  only the requests waiting on its own server.

Where you can, run one OpenCode server per data directory, or point a second one at another
(`XDG_DATA_HOME`).

## Webhooks

The receiver is off unless the plugin has a `webhook` option ([the README](../README.md#webhooks) has
the entry). Put it in the **global** config, since there is one receiver per OpenCode server. From a
local clone, `package` is the path to its `dist` directory. `"webhook": true` takes every default. If
the option is given more than once, for example in a project's config as well, the first location to
load wins, and the others log that their settings are ignored.

| Option | Default | |
|---|---|---|
| `port` | `4097` | Port to listen on. |
| `host` | `127.0.0.1` | Address to bind. Only this machine can reach the default. |
| `secretFile` | | File holding the shared secret (`~` is expanded). |
| `secretEnv` | `COURIER_WEBHOOK_SECRET` | Environment variable holding it, when there is no `secretFile`. |
| `maxBytes` | `1048576` | Largest body accepted. |

The secret is never read from `opencode.json` itself (a `secret` key is refused), so the config can be
committed. Make one with `openssl rand -hex 32 > ~/.config/opencode/courier-webhook-secret` and
`chmod 600` it. A file is the safer choice with `opencode service start`, whose environment may not be
your shell's. Without a usable secret the receiver does not start, and the server log says why.

On GitHub, add a webhook to the repository (Settings → Webhooks) with content type `application/json`,
the same secret, and the events you want (pull request reviews, review comments, issue comments, pull
requests, check suites or workflow runs). GitHub must reach the receiver, and by default it only
listens on `127.0.0.1`: forward a public URL to it with a tunnel you trust (`cloudflared tunnel --url
http://127.0.0.1:4097`, `ngrok http 4097`, or `smee --url https://smee.io/<channel> --target
http://127.0.0.1:4097/github`, which needs no inbound port at all) and use `<public URL>/github` as the
payload URL. Whatever you expose, only signed deliveries are acted on.

The receiver starts when OpenCode loads the plugin, which after a server start happens the first time a
project is used. Until then deliveries fail; GitHub does not retry them on its own, but lists them under
Recent Deliveries with a Redeliver button.

Once it runs, `courier_subscribe` ties a session to a topic, and the plugin turns deliveries into
messages for the subscribed sessions, each queued behind any running turn and waking the session if
idle:

- `POST /github` takes GitHub webhook deliveries. A pull request review, a review comment, a comment, a
  pull request or issue being opened, reopened, closed (or merged) or marked ready for review, or a
  completed check run, check suite or workflow run on a pull request goes to the sessions subscribed to
  `owner/repo#N` and to `owner/repo`; anything else with a repository (a push, a release) goes to
  `owner/repo` only. Pings, CI runs that have not completed, and other pull request and issue actions
  (pushes to the branch, edits, labels, assignments, review requests) wake nobody.
- `POST /hook/<name>` takes anything else, for sessions subscribed to `<name>`. A JSON body's `text`,
  `summary` or `message` field is delivered, otherwise the body itself.

Every delivery must carry an `X-Hub-Signature-256` header: `sha256=` followed by exactly 64 hex digits,
the HMAC-SHA256 under the shared secret. For GitHub that is of the raw body, as GitHub sends it. For
`/hook/<name>` it is of the name, a newline and the body, so a captured delivery cannot be sent to
another topic:

```bash
sig=$(printf '%s\n%s' deploys "$body" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)
curl -X POST -H "x-hub-signature-256: sha256=$sig" --data-binary "$body" http://127.0.0.1:4097/hook/deploys
```

A missing or wrong signature gets `401`, and the body is not parsed. The check is constant-time. Bodies
over 1 MiB (`maxBytes`) get `413`. A delivered event gets `202`, with the number of sessions it reached,
which can be 0. The digests of the last 1000 accepted deliveries are remembered in memory, and a delivery
already accepted gets `200 already delivered`. One that reached nobody because every delivery to a
session failed is forgotten again, so it can be retried. That stops replays of a captured delivery, and
it also means a GitHub Redeliver of a delivery that already arrived is ignored. Redelivering one that
failed works. Generic senders that post the same text twice should add something unique, such as a
timestamp, to the body.

The subscribed sessions are sent their messages at once, so a session slow to take one holds up none of
the others. A session that OpenCode no longer knows loses its subscriptions the next time a delivery for
it fails, and `courier_subscribe` refuses a session id that does not exist.

A session sees a short summary (event, repository and number, who, state or conclusion, link, and at
most 1500 characters of a review or comment body), wrapped in `<courier from="github" event="...">` and
followed by a note that it is outside text, to be treated as data. Review and comment bodies are written
by whoever can comment on the repository, so subscribe sessions only to repositories whose commenters
you trust with your agent's attention. The server log gets one line per delivery (event, delivery id,
number of sessions), never the payload or the secret.

GitHub does not report check suites on pull requests from forks, so CI results for those reach
`owner/repo` subscribers only. There is no GitHub event for a merge conflict.
