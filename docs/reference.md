# Behaviour reference

How the plugin behaves beyond the happy path: what a child runs on, how deep and wide a tree of
sessions may grow, how a child's report, or a group's reports, and its failures, silent turns, permission requests and questions reach the
session that started it, what is kept where and for how long, and what the webhook receiver does with a delivery.
The [README](../README.md) has the short version.

## The OpenCode version

Each release of the plugin is built and tested against one OpenCode V2 version, the exact
`@opencode/plugin` version pinned in its `package.json` (the README's [Supported OpenCode
version](../README.md#supported-opencode-version) table). The end-to-end suite runs on that version
with every change, and once more on the newest `@opencode/cli` release, where a failure is a warning
rather than a red build, so a host release that breaks the plugin shows up in CI first.

Nothing in OpenCode checks the version: `opencode plugin add` installs the plugin on any V2 host,
and the loader warns about nothing. The plugin loads on hosts from 2.0.4 on, and fails to load on
2.0.0 to 2.0.3, which lack a domain the plugin API gained in 2.0.4. On a newer host, tools may still
break; [plugin-api-notes.md](plugin-api-notes.md) lists what each pinned version needed working
around.

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
[roster](#roster), whose entry for the child says `native: true`. An isolated child is created as
before: OpenCode takes a location or a `parentID`, never both, and an isolated child needs its
worktree's location, so for OpenCode it is a session of its own. A child started without `isolate`
by an isolated child is a native child of that one, so a tree with isolated children shows in
OpenCode's UIs as several trees, split at each isolated child; `courier_tree` shows the whole.

**What it is for.** OpenCode's own UIs treat a session's native children as its family, as they do
the sessions of OpenCode's `subagent` tool:

- the TUI's view of a session that has no `parentID` lists the permission requests and forms of
  every session under it, and answers them there; its subagent tab lists the children, its footer
  counts the running ones, and the session's cost includes theirs;
- the request dock of the paired web, desktop or mobile app shows and answers the permission
  requests, questions and forms of the open session and every session under it. Read in OpenCode's
  source (`packages/app/src/session/requests/session-request-tree.ts`); not tried on a device.

So a grandchild's ask can be answered from the top session's view, on a phone too, without a model in
between.

**What changes with it**, each covered by the live suite where it can be:

1. **Deleting a session deletes its native children**, and theirs, as OpenCode deletes a subagent's
   session with its parent; their isolated children are left. Each deletion is a `session.deleted`,
   so the plugin forgets each deleted child as it does any: its report state and join
   group membership; its roster entry stays, listed with the error, until its 14 days are up, as for
   any [deleted child](#worktree-cleanup). `courier_cleanup` and `courier_stop` never delete a session.
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
   its parent's subagent tab or by id, and left with "Go to parent session". Its own
   view in the TUI lists none of its permission requests or forms; the view of the top of its native
   tree does, that is the session at the top of the courier's tree, or the isolated session nearest
   above it. The notice of a [form](#a-child-that-shows-a-form) names that session. The courier still
   tells the top session's model of every request and question, which the person answers in
   OpenCode's own prompt or form there: both below.
5. **Who else answers.** Whatever answers the asks of a session's family now answers the courier's
   native children's too: the TUI's `autoaccept` permission mode, in the open top session's view,
   approves their requests once, and `opencode run`, while it runs a turn of the top session, takes
   them for its own subagents', approving their requests once with `--auto`, rejecting them without
   it, and cancelling their questions and forms. The live suite drives such sessions through the API
   for that reason.
6. **Cost.** The TUI's cost of a session includes its native children's.

**Questions: asked once, in OpenCode's own form.** By the owner's decision on #146, a native
child's question is not passed up to be asked again. While the child's question call waits, OpenCode
shows its form in the view of the top of its native tree; when that is the top session, the one the
question would be relayed to, the plugin tells the top session's model with a notice marked
`shown="native"`, which lists the questions and says that OpenCode shows them to the person in its
own session, that they answer there, and that it is not to ask them itself; and the top session's
question tool is not linked to that question, so even a model that asks anyway passes nothing on.
The person answers the child's form, in the TUI's view of the top session or the paired app's dock;
the child carries on in the same turn, and the top session is told once it is settled
(`answered="elsewhere"`, *answered by the person*), as when they answer it in the asks inbox. `courier_answer` still
answers it, which withdraws the child's form, for a person who gives the answer in the chat instead.
Once the child's call is cut off (its turn stopped, a restart), its form is gone, and the question
is relayed as without the option, the top session's question tool linked to it again. A question of
a native child under an isolated session shows in that session's view, not the top's, so it is
relayed and linked as without the option, as is every question of an isolated child.

Turn the option on only where the person sees OpenCode's own prompts and forms: the TUI, or the
paired app. A client that shows none, a bare API client, leaves a native child's questions and
permission requests without a prompt (and `opencode run` answers them itself, as above);
`courier_answer` is the fallback, and `courier_status` lists them under `pending`.

**Permission requests: asked once, in OpenCode's own prompt.** By the decision on #146 (option B of
three: leave the double ask, tell the model not to ask, or link the model's question to the request
as questions once were), a native child's permission request whose native root is the top session
is not put to the person by the model. OpenCode shows it in the top session's view as its own
permission prompt, bound to that request, and on the paired app's dock; the plugin tells the top
session's model with a notice marked `shown="native"`, which says so, tells it not to ask the
person, with its question tool or in its reply, nor to decide, and to tell them in one line at most
and end its turn, and still lists the choices for `courier_answer`, for a person who asks the model
to answer for them. Once the person answers in OpenCode's prompt, the model is told it is settled
(`answered="<reply>"`). Approval stays with the host's prompt, which a model cannot answer for the
person; a model that ignores the notice and asks anyway does no more than without the decision, and
the first answer counts. A native child under an isolated session, an isolated child, and every
child with the option off get the notice as without the option. Seen with the stand-in model in the
TUI and the live suite, and with a real model (`docs/real-model.md`).

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
moment its task or a message reaches it ([not what the person types in it](#a-child-that-ends-without-a-report)) until it reports to its parent with `courier_send`, or its
turn fails or is interrupted, so a child that ends its turn without reporting keeps counting until
it does; a session that has split its task and ended its turn to wait for its children owes one too.
A session that has reported since anything last reached it counts only while its turn still runs;
one whose turn failed or was interrupted since, or that has reported and finished its turn, with
nothing live below it, does not count. One OpenCode no longer knows (`session.get` says it was not
found) does not count, whatever it owes. Whether a session owes a report is read from the plugin's
storage; when that is not known, for a session spawned by a release of the plugin that kept no such
state, or cannot be read, the session counts while its turn runs, and a `session.get` that fails
otherwise counts it as not running.

Each check reads the whole roster once, to find the calling session's tree, and looks up every
session in that tree with `session.get` and its report keys. The checks run one at a time in the process,
and a spawn under way counts until its child is on the roster, so several `courier_spawn` calls made
at once cannot get past a limit together, whichever locations or copies of the plugin make them.
Two servers on one data directory do not see each other's spawns under way. A failed roster read
refuses the spawn, failing closed, while a failed `session.get` counts that session as not running.

Depth is read from the roster, so a session whose roster entry could not be written, or was
dropped after 14 days, starts its children as if it were the top of a tree.

**The brief says when to split.** A spawned session is told its depth and the limits. Below
`maxDepth` it is given a rule: split the task when it has 2 or more independent, substantial parts
touching separate files or areas, one session per part; do it itself when it is small, sequential or
tightly coupled, and never start exactly one session; and say which in one line of its reply,
`split: no, because …; considered: <the parts you weighed>` or `split: <n> parts: …`, so that a
transcript tells a reasoned decision to do the task itself from one never made, and a reviewer can
see which parts were weighed. A session that splits orchestrates: it ends its
turn while its children work, checks and integrates each part itself, never handing that checking
to another session, and sends its parent one combined report. At `maxDepth` it is told to do the
task itself. Every spawned session is told how to [report](#a-childs-report): once, with a status
and its artifacts, and with `blocked` and a concrete ask when it needs a decision from its parent.

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
[skill's description](#the-courier-orchestrate-skill) alone fires only once a model already takes its task for a big one; the pointer reaches it before it starts
working, and asks for the decision to be visible either way. A request without `courier_spawn` in
its tool list, from a session whose agent does not have the courier tools or one another plugin's
hook stripped them from, gets no pointer, since the session could not act on it. From the request after its first
spawn on, the session gets a `root orchestrator` part with the limits instead. Every part the hook
adds begins with the same `opencode-courier role:` prefix, and the hook adds none when one is there
already, so a second copy of the plugin loaded next to it does not add its own. Each part is the same
on every request of its session, so a session's prompt changes once, at its first spawn, and the
provider's prompt cache holds otherwise. Each instance remembers the depths it has looked up, so
the hook reads the roster once per session, not per request. It reads only the session's [reverse index](#roster) key and its own
children, never the whole roster: an entry an older copy wrote without a key is indexed on the next
load, and until then the hook takes its session for one nobody spawned, and points it to the skill
as a root with none started, which its brief, naming its depth, contradicts; `courier_spawn` still
enforces the limits.

## The courier-orchestrate skill

The tools make a tree of sessions possible; the skill is the playbook for using them. The plugin
registers one OpenCode skill, `courier-orchestrate`, through the plugin API's skill domain, in every
location it loads in, so it is listed among the available skills of every session there, with a
description saying when to load it: at the start of any implementation task that may have
independent parts, or when a session was started by one, to decide whether to split the task across
sessions and state the decision. It triggers on the task's shape, not on the conclusion that the
task is big, which a model working alone on one issue never reaches; a session nobody spawned is
also pointed to the skill by [the context hook](#session-trees-and-their-limits) before it starts.
A model loads it with OpenCode's `skill` tool, which asks the `skill` permission for `courier-orchestrate` like any
skill (a spawned session's request is relayed to its parent as any other); a person activates it
from the TUI's `/skills` dialog, which attaches its text to the next prompt. How OpenCode lists,
loads and injects a skill: [plugin-api-notes.md](plugin-api-notes.md#skills-v2026).

Its text is short and model-facing, kept in `src/skill.ts` and snapshotted with the other
model-facing strings. It names no limits (the role part and the brief give the session's own) and
says, in order: decide whether to split or do, by [the brief's rule](#session-trees-and-their-limits),
never starting exactly one session. An implementation task with one tightly
coupled core usually still has independent parts: its e2e scenario, its documentation, sometimes a
second test file, and a review of the core by a session with fresh context, which reads the
committed diff against the task and the repository's rules and reports its findings (`isolate:
false`, it edits nothing). The skill asks the session to weigh each of them, to do the core itself
first and commit it, so that the names and texts the other parts depend on are fixed, then, if 2 or more
remain, to start one session per remaining part in one group. Then it says which in one line of the reply before
starting, `split: no, because …; considered: <the parts you weighed>` or `split: <n> parts: …`, so
that a reasoned decision to do the task alone can be told from one never made, and a reviewer can
see what was weighed;
plan the parts so that no two edit the same files, each task complete enough to be done without the
orchestrator; start them with one `courier_spawn` per part, all in one [join group](#join-groups),
`isolate: true` where parts edit files in parallel; end the turn, without polling; read each
[report](#a-childs-report) by its status and artifacts, and what to do on `done`, `partial`,
`blocked` and `failed`; verify first-hand, never through another session (a review session's
findings are a report to act on, while running the checks stays the orchestrator's), running
checks through the project's scripts (`bun run <script>`, `npm run <script>`) rather than `./node_modules/.bin/<tool>`,
so that one permission rule covers them, since the orchestrating session's own permission prompts
are relayed nowhere and each one stalls the whole tree; integrate by merging each
reported branch, then `courier_cleanup`; report upward with one status for the whole, or reply to the
person at the top. Then what to do when a part goes wrong: a [failed turn](#a-child-that-fails) or
a [silent end](#a-child-that-ends-without-a-report), a `courier_spawn` refused by a limit (do the
part, or wait for a report; never retry in a loop), losing track (one `courier_tree`), and a subtree
to abandon (`courier_stop`). The real-model smoke test's recursive scenario
([docs/real-model.md](real-model.md#recursive-orchestration)) is where the text is tried against
free models, and the README's [Recursive orchestration](../README.md#recursive-orchestration) has
its prompt.

## A child's report

A child reports with `courier_send` to the session that started it, giving a `status`: `done`,
`partial` (some of the task is left; the report says what and why), `blocked` (it needs a decision
from its parent, and the report carries a concrete ask) or `failed`. The brief tells it to send
exactly one such report when it finishes, to send `blocked` rather than end quietly when it needs
its parent, and that a message without a status is progress, not its report. `courier_send` carries
the status as an attribute of the envelope the parent reads, `<courier from="<child>"
status="done">`, and in the delivered message's metadata (`status`), so the receiving model, and
[join groups](#join-groups), can branch on it without parsing prose. A status that is none of
the four is refused, since OpenCode does not check a tool's schema
([plugin-api-notes.md](plugin-api-notes.md)); `null` counts as none.

With the status, a report may list `artifacts`: `branch`, a string, `commits` and `files`, lists of
strings, and `checks`, a list of `{ command, result }`. They go in the message body after
the text, in one fixed layout, so a parent finds them in the same place in every report:

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
listed when no artifact is given. The status and the artifacts are `courier_send`'s rather than a
`courier_report` tool's: a child reports the same way it sends anything else, with the tool its
brief already names, and the tool count, and what a leaf's tool list looks like, stay as they are.

**A status settles the report; a message without one is progress.** A message with a status from a
child to its parent settles the child's report (`report/<sessionID>/settled`, `by: "report"` with
the `status`), whatever the status: `blocked` too, since the parent has been told and must act. A
message from the child to its parent without a status is noted as progress
(`report/<sessionID>/progress`) and settles nothing, so a child that sends "halfway there" and then
ends its turn without a report is [told to its parent](#a-child-that-ends-without-a-report), and
the notice says that its last message had no status. The tool's result tells the child which it
was: a report, with the usual line on ending its turn, or progress, with what a report needs. A
message to any session but the parent is neither. A child an earlier release of the plugin briefed
was never told about statuses, so its messages without one count as its report, as before: its
roster entry lacks the `reports: "status"` that `courier_spawn` now writes with every entry. The
plugin acts on no status beyond settling the report; what each one means is for the parent's model.

## Join groups

Each report wakes the parent separately, so a parent with five children takes five turns, each
re-reading its context, and in a tree that compounds at every level. A join group has the parent
woken once instead: `courier_spawn` takes an optional `group`, a name scoped to the calling session,
and the reports of the sessions started with the same name are held by the plugin until every one
of them has reported and the parent's turn that started them has ended, then delivered in one
message. A name is 1 to 60 letters, digits, dots,
dashes or underscores (`reviews`, `phase-1`); any other is refused before anything is started, and
`null` counts as none. `courier_spawn`'s result says the child's report is held with the group.

**What is held, and what is not.** A report with status `done`, `partial` or `failed` from a member
to its parent is held: `courier_send` records it (`group/<parentID>/<name>/<sessionID>`, with the
status, the text and the artifacts) and delivers nothing, and its result tells the child so, with
how many members have reported, so the child does not take it for a failed delivery. A held report
still settles the child's report as any report does: the child stops [owing one](#a-child-that-ends-without-a-report),
stops counting against the [limits](#session-trees-and-their-limits) once its turn has ended, and gets no
notice of a silent end. Everything the parent needs now passes through at once, as for a child in
no group: a `blocked` report (the member stays out, and reports again once it has its answer),
progress (a message without a status), a failed turn, a turn ended without a report, a permission
request, a question and a form. A member that reports twice has its later report held in place of
the earlier.

**The release.** Once every member has a held report, or has left (below), and the parent's turn
that started the last of them has ended, the group is released. A turn ends when it succeeds, fails
or is interrupted, but not when a shutdown stops it, which the next start resumes: OpenCode records
the end as the session's `time.idle`, which the release compares with when the last member joined.
So a member that reports while that turn is still running, even before its siblings are started,
waits for them, and the parent is woken once, by the group, not once per batch of members it
started in that turn. The parent gets one message, waking it if it is idle, wrapped in `<courier from="<members>"
group="<name>" reports="<n>">`, `from` listing the sessions whose reports it carries, comma-separated.
The body names the group and counts the reports by status, and the members without one, then lists
every report in the order the members joined, each as `[i/n] <sessionID> "<title>": <status>`
followed by its text and its artifacts in [the fixed layout](#a-childs-report), and after them the
members that left without a report. The message's metadata carries `group`, `reports` and `from`
(the same comma-separated list). The held reports
are then dropped, and the group with them: the name is free again, and a `courier_spawn` with it
starts a new group, with only the sessions started since. A session started into a group that is
still open joins it, and the release waits for it too. A member's report after the release, as when
the parent sends it more to do, is delivered on its own, as a report of a child in no group.

**A member that leaves.** A member whose turn [fails](#a-child-that-fails) or is interrupted (by
the person, or by OpenCode after an hour without activity; not by a shutdown, which the next start
resumes), whose task could not be handed over as it was started, whose session OpenCode deletes, or
that the parent drops with `courier_cleanup` (below), leaves the group without a report, and the group no longer waits for it: it is released once its
other members have reported and the parent's turn has ended, the message naming who left and why. The parent hears of each as of a
child in no group: a failed turn at once, in a notice with a line naming the group, a task not
handed over as `courier_spawn`'s error, an interruption or a deletion only in the group's
message, and a drop in `courier_cleanup`'s result and the group's message. For a failed turn, the member is marked as left before the notice goes out, so the parent
is waiting on the group meanwhile, and the scheduler is nudged after it, so the group's message
does not overtake the notice, unless a tick of the scheduler falls in the moment between the two. A member that reports after all before the release
rejoins with its report, and one whose report comes in while the group's message is going out keeps
it, to go out at the next tick. A member that has reported keeps its held report whatever happens to
its turn after, unless its next word to the parent is a `blocked` report: that passes through, and
the stale held report is dropped, so the member is out again until it reports. A held report
outlives the member's [roster](#roster) entry: a member whose entry expires after 14 days goes from
its group with no trace when it has not reported, and otherwise stays until the group is released,
which the dropping of the members still out brings about, so a group's keys live as long as the
roster entries of its members still out. A
group whose every member left is dropped unsent, with no report to carry: the parent was told of
each failed turn and did the rest, and hears of an interruption or a deletion no more than for a
child in no group. A member that [ends its turn without a report](#a-child-that-ends-without-a-report) is still
out, as a child in no group would still owe its report: the silent-end notice says the group's
other reports are held until it reports, or until the parent drops it, and `courier_children` shows it. A report that cannot be
held, the storage failing as `courier_send` runs, is delivered on its own, and the member dropped
from the group, which releases without it.

**Dropping a member.** A member that will not report holds every other member's report back: one
that ended its turn without a report, one whose failure or interruption the plugin missed (its
watcher was resubscribing, or the server was down), or one the parent has given up on. The parent
drops it with `courier_cleanup { sessionID }`, which [forgets the child](#worktree-cleanup), removing its worktree
first if it is isolated (one whose worktree is kept for its work is not dropped). A member still out
is first marked as left, `dropped` (`left: { at, by: "dropped" }` on its group key), then its roster entry and
report state go; the scheduler is nudged when that completes the group, so with the parent's turn
ended its held reports reach it at once, in one message that names the member under "Without a
report" (`you dropped it with courier_cleanup`), and the result of `courier_cleanup` says it was dropped
from the group (`group` in its metadata). A member whose report is held, or that already left, keeps
it and is not named as dropped. A dropped member that reports after all, before or after the
release, is delivered on its own, as a child in no group: the parent is no longer waiting on it, so
its report is neither held nor noted, and no group is opened again for it. If its membership cannot
be read, `courier_cleanup` fails before it forgets anything, and can be called again.

The drop is `courier_cleanup` rather than a tool or flag of its own: forgetting a child and taking
it out of what waits on it are one act, which `courier_cleanup` already did for an isolated member,
and a child with no worktree has nothing else to clean up. A dropped child is off the roster, so it no
longer counts toward the [limits](#session-trees-and-their-limits), and the plugin no longer tells
the parent of its failures or silent ends.

**The parent waits.** A session [waits](#a-child-that-ends-without-a-report) on a group as on any
children: while a member still owes it a report it has not been told about, and, once the group is
complete, for the message the scheduler is about to deliver. So a sub-orchestrator that has split
its task into a group and ended its turn is not reported to its own parent as having ended without
a report, until the group's message has reached it and it ends a turn without reporting; one told
that a member ended without a report, which ends its turn without acting on it, is reported, as it
would be for a child in no group.

**`courier_children`** lists, for a child started in a group, `group: { name, report }`, with
`report` one of `held`, `out`, `failed`, `interrupted`, `deleted` (it left), `released` (the group has been
delivered, or the child joined an earlier one of that name) or `unknown` (its membership could not
be read). A child whose group could not be joined when it was started is recorded in no group, and
`courier_spawn`'s result says so: its report comes on its own.

**Delivery.** The scheduler that delivers `courier_later` messages delivers released groups too,
at each tick, and at once when the parent's turn ends with a group complete, or a report, a
failure, an interruption, a deletion or a drop completes a group whose parent's turn has ended; so once its
turn has ended, the parent waits no longer than for a plain report on one server; with [two servers](#two-servers-on-one-data-directory)
on one data directory, by the one holding the owner key, within a tick of it. Each release is
claimed once in the process, like a scheduled message, and dropped only after the message has been
delivered: a delivery that fails is logged and tried again at the next tick, and nothing is lost,
while a crash between the delivery and the drop delivers it again after a restart. Held reports live
in the plugin's storage, so a restart loses none. A group whose parent OpenCode no longer knows is
dropped unsent, like the report state of a deleted session's children. The group's message is a
message like any other, steered into the parent's running turn or starting one, whatever `queue`
the members' `courier_send` calls gave: it makes a spawned parent owe a report, and a report of its
own settles that.

## A child that fails

A child reports with `courier_send`, which it cannot do when its turn fails: the model is not
available to the account, the credentials are missing, the provider is down. The plugin follows
OpenCode's events, and for every failed turn of a spawned session it sends the parent a message
from that child, marked `failed="<error type>"`, with the child's title and the error, waking the
parent if it is idle. The parent then decides: message the child to have it try again, start a
replacement, or carry on without it.

Every failed turn of a child is reported, also one that fails after the child has reported. A turn
that was interrupted is not a failure and is not reported, and neither is a failure that happens
while the OpenCode server is down or the plugin is not loaded; a `courier_later` check-in still
covers those.

## A child that ends without a report

A child's turn can also end without failing and without a `courier_send` to its parent: its model
replied in text and stopped, or took its task for done. The parent would wait for a report that
never comes, and in a tree, every session above it with it. So the plugin keeps, for each spawned
session, whether it owes its parent a report: from the moment its task or a message delivered
through courier or the plugin reaches it (OpenCode's `session.inbox.delivered` event: a message
from any session, a scheduled message, a webhook delivery, or one of the plugin's notices) until it
calls `courier_send` with its parent's id and a [status](#a-childs-report), or its turn fails or is
interrupted. What the person
types in the child's own session, and a compaction or move of it, is between the person and the
child: it does not make the child owe a report, so a child that has reported and then answers the
person is not told to its parent. The plugin tells these apart by the type OpenCode gives each item
as it enters the inbox (`session.inbox.enqueued`: `user`, `synthetic`, `compaction` or `move`),
remembered in memory for the last 1000 items of spawned sessions, since the delivery event does not
carry it. A delivery whose item it did not see enter, such as one queued before a restart, counts as
a message, so the parent is told rather than left waiting. The task, which `courier_spawn` hands
over as a prompt like the person's, is noted by `courier_spawn` itself (below). Only a message to the
session that started it, with a status, is a report; one without a status is progress, and one to
a sibling, or to the session at the top, is neither, since the parent is the one waiting for it.

When a turn of a spawned session ends without failing (`session.execution.succeeded`) while it
owes a report, the plugin sends its parent a message from that child, marked
`ended="without-report"`, with the child's title and its last reply as `courier_status` gives it
(at most 2000 characters), waking the parent if it is idle. When the child has messaged the parent
without a status since its last prompt, the notice says so: that message was progress, not the
report. The parent decides: message the child
with `courier_send` to have it carry on, or to report if its last reply is what it needed, or start
a replacement. Until the child reports, it counts toward the
[limits](#session-trees-and-their-limits). Each turn's end is claimed once, before its notice goes
out, so one notice is sent however many instances and copies of the plugin see it.

A turn that ends while the child waits is not reported. It waits while a session it started owes
it a report that it has not been told about, as a session that has split its task ends its turn to
wait for its children; while it has a permission request or a question pending; and while a
`courier_later` message for it is pending, or it has subscribed to a webhook topic since its last
prompt, either of which wakes it. A subscription made before the last prompt is not waiting, since
it outlives the delivery it was made for: once a delivery has come and the child has ended its turn
again without reporting, its parent is told. Once its children have reported, failed or been
interrupted, or it has been told that they ended without a report, a turn of it that ends without a
report of its own is reported. A turn
stopped by OpenCode's shutdown resumes on the next start and does not count as interrupted; one
stopped otherwise (by the person, or by OpenCode after an hour without activity) settles the report
and is not told, as before.

The state is kept in the plugin's storage, so a restart does not lose it: `report/<sessionID>/prompt`
holds when a prompt last reached the session (`{ at }`, epoch milliseconds),
`report/<sessionID>/settled` when it last reported, failed or was interrupted (`{ at, by, status }`,
`by` being `report`, `failed` or `interrupted`, and `status` the report's, `done`, `partial`,
`blocked` or `failed`, when it carried one), `report/<sessionID>/progress` when it last messaged its
parent without a status (`{ at }`), `report/<sessionID>/told` when its parent was last
told that it ended a turn without one (`{ at }`), and `report/<sessionID>/stopped` when
[`courier_stop`](#seeing-and-stopping-a-subtree) stopped it (`{ at }`). It owes a report while `prompt` is later than
`settled`, and its parent waits for it while `prompt` is later than `told` too.
The prompt's time is the one OpenCode published its delivery at, not when the plugin handled the
event, and the report's, or the progress's, is the server's clock as `courier_send` runs, before it delivers, so an event
handled late cannot make a report look older than the prompt it answers. `courier_spawn` writes the
first `prompt` itself, just before it hands the child its task, and settles it as failed if handing
it over fails. Each key keeps the later of two times, since both of the hub's subscriptions note
every event and one may be behind. The keys go with the child's roster entry, and when OpenCode
deletes the session (`session.deleted`), so its parent no longer waits for it; deleting a session
drops those of the sessions it started too, whose reports can no longer be delivered. If the notice
cannot be delivered, its `told` is taken back, unless a later notice has told the parent since.

What the plugin cannot see, it cannot judge: a prompt delivered while the server is down or the
plugin not loaded leaves the earlier one in place, so a turn after it that ends without a report
may not be told, and a `courier_send` whose note could not be written is taken for no report, and
for no progress. A
prompt the person types, a compaction someone asks for (OpenCode's compact command) or a move of
the session, which OpenCode delivers like a message, counts as one only when the plugin did not see
it enter the inbox; the compactions OpenCode makes on its own as the context fills never do.

## A child that asks for permission

When a child's tool call needs an approval (a permission rule with `"effect": "ask"`, or no rule
for it), OpenCode holds the call until someone answers in the child's session, which the person
working in the parent's session does not see. The plugin follows OpenCode's permission events, and
for a spawned session it sends the parent a message from that child, marked `asks="permission"`
and `request="<id>"`, waking the parent if it is idle. The message says what the child asks for
(the action, such as `shell` or `edit`, and its resources, such as the command or the paths), lists
the choices OpenCode's own prompt offers, and tells the parent to ask the person rather than
decide:

- `once`: allow this request only;
- `always`: allow it and save the rule for the project; offered only when the request says what
  to save, as in OpenCode's prompt;
- `reject`: refuse it, with a reason if the person gives one.

The parent asks you, with its question tool if it has one, and calls
`courier_answer { sessionID, requestID, reply, message? }` with your choice. The plugin passes it
on, and the child carries on. With [`nativeChildren`](#native-child-sessions) on, a native child's
request is answered in OpenCode's own prompt in the top session's view instead, and the parent is
told not to ask you.

A request of a child's child goes to the session at the top, the one you started the first child
from, and so on down any number of levels, since that is where you are; the message names the
session that started the asking one. Only that top session can answer it. A session started with
`courier_spawn` cannot answer what its own children ask, so it cannot get around a rule that makes
it ask by starting a child to do the job and approving it.

OpenCode ends the child's turn when a request is rejected without a message, and the child would
then never report back. So `courier_answer` always sends a message with a rejection, the person's
reason or a default one; the child's call fails and it carries on, and can report. The child's
model is told that the call could not be run, not the reason.

A request can also be answered without the parent: in the child's own session (for a
[native child](#native-child-sessions), in the view of the top of its native tree), or along with
another answer (an `always` that covers it, or a rejection, which rejects the session's other
pending requests as well). For a request the parent was told about, the plugin then sends it a
short message marked `answered="<reply>"` saying the request is settled, so it does not pass on a
stale question; after a rejection, the message adds that the child may have stopped, and that
`courier_send` gets it going again. A `courier_answer` that comes later anyway passes nothing on and
says so. The TUI's [asks inbox](#the-asks-inbox) answers through OpenCode's reply too, so the parent hears
the same.

`courier_status` and `courier_children` list the requests a session waits on under `pending`, so a
parent that has lost the message, after a compaction for example, can still find them. Whenever
the plugin starts following OpenCode's events again, after loading or after its event stream broke,
it also relays the requests that spawned sessions already wait on, so one asked in the gap is not
missed.

## A child that shows a form

OpenCode asks some things through forms of its own rather than a permission request or the question
tool, and shows them in the child's session only. The one a child meets most is web search: the
first `websearch` call made while no search provider has been chosen shows a "Web Search" form
(allow search through the providers OpenCode has, choose another provider, or disable web search),
and a second one, "Choose a web search provider", if the person picks another. The plugin cannot
pass such a form on or answer it, since the plugin API has no way to answer or withdraw a form; only
the person can, in the child's session.

So for a form of a spawned session the plugin sends the session at the top, the one its permission
requests go to, a message from that child marked `asks="form"`, `form="<id>"` and, when the form
says what it is for, `kind="<kind>"` (`kind="websearch.provider"` for web search), waking it if it
is idle. The message gives the form's title, its fields and their choices, and says that neither the
parent nor `courier_answer` can answer it, only the person, in that child's session, or, for a
[native child](#native-child-sessions), in the session whose view OpenCode shows it in, which the
message names: the parent should tell you, not choose for you. A form of a child's child goes to the top session, naming the
session that started the asking one, as with a permission request.

For web search the message adds what OpenCode does next. It waits for the choice at most a minute;
then the child's search fails with "Web search cancelled", and the child carries on without it. The
choice is kept for every session (OpenCode stores it globally), so once it is made, in any session,
no session is asked again: you can answer in the child's session, run one web search in your own
session and answer there, or pick the provider under OpenCode's "Third-party search" setting.

Once a form the parent was told about is answered, or withdrawn unanswered (dismissed, given up on
after OpenCode's minute, or cut off with the child's turn), the plugin sends a short message marked
`settled="answered"` or `settled="cancelled"` and `form="<id>"`, so the parent does not send you to a
form that is gone. The TUI's [asks inbox](#the-asks-inbox) lists and answers such forms, and the parent
hears the same.

The question tool's forms are not told this way: [the question relay](#a-child-that-asks-a-question)
passes every question of a spawned session on. Forms of sessions the plugin did not spawn are
ignored, among them MCP servers' requests for input, which OpenCode does not attach to a session.
The plugin cannot list the forms a session shows, so `courier_status` does not report them; a form
shown while the plugin was not following OpenCode's events is not told, and one settled then, or
across a server restart, is not told settled.

## A child that asks a question

A child that calls OpenCode's question tool shows its question in its own session only. The plugin
wraps that tool, and once the question of a spawned session is on screen, it sends the session at
the top, the one its permission requests go to, a message from that child marked
`asks="question"` and `request="question_<id>"`, waking it if it is idle. The message lists the
questions and their options, gives them again as one line of JSON in the question tool's own input
shape, and tells the parent to ask the person, with its question tool and exactly those questions,
rather than answer.

When the parent asks you the same questions with the same options, the two are linked: what you
pick in the parent's session is passed to the child's waiting call, which returns it as if you had
answered there, and the child carries on in the same turn. The parent's tool result says so. Only
the same wording links (spacing and case aside; the options may come in any order), so a question
of the parent's own with the same yes-or-no choices never answers a child's; when a waiting question
has the same choices, the parent's tool result says the answers were not passed on and names the
request. A parent that asked you some other way, in text or reworded, calls
`courier_answer { sessionID, requestID, answers }`: one entry per question, in order, each the
label you chose or the text you gave, or a list of labels where a question allows several. As with
permission requests, only the session at the top can answer. Answers to one question are passed on
one at a time, and once: a second waits for the first, and is told the question no longer waits once
the first got through.

The question stays in the child's session too, and you can answer it there instead. Whichever
answer comes first counts, and the other side's question is withdrawn:

- answered or dismissed in the child's session: the parent's open question disappears and its
  tool result says why, or, with none open, the parent gets a short message marked
  `answered="elsewhere"` or `answered="dismissed"` (or `answered="failed"`, when the child's
  question call failed, which ends its turn too). A dismissal there ends the child's turn, as
  OpenCode's question tool does, and the message says to `courier_send` it if it should carry on;
- answered in the parent's session: the child's question disappears;
- dismissed in the parent's session: the parent's turn ends, as OpenCode's tool does, and the
  child's call returns that you dismissed the question, so the child carries on without the answer
  and can report;
- answered with `courier_answer` while the parent's question is open (a parent that asks you and
  calls `courier_answer` in the same step): the parent's question disappears, and its tool result
  names the answers that went to the child.

A dismissal on either side reaches the other about two seconds later: OpenCode withdraws open
questions the same way when it shuts down, and the plugin waits that long to tell the two apart.

A question whose call is cut off stays answerable. When the child's turn is stopped (interrupted,
or by OpenCode itself, which stops every turn in a project location after 60 minutes without
activity there), or the server restarts or closes the project, the question is gone from the
screen. The plugin keeps it in its storage, sends the parent a message marked `stopped="true"`, or
`restarted="true"` when the plugin is next loaded, with the questions, and passes the answer on as a
message to the child, which wakes it. If the parent is asking you at that moment, your answer goes
that way without a new message. Stored questions are dropped after 14 days, once the child is off
its parent's roster, or beyond the 100 newest.

`courier_status` and `courier_children` list a session's questions under `pending`, with
`type: "question"`, the questions, and `stopped: true` for one that was cut off.

With [`nativeChildren`](#native-child-sessions) on, a native child's question is not linked: the
person answers it in OpenCode's own form, shown in the top session's view, and the top session is
only told.

A question is relayed only once OpenCode's permission check for it has passed: a child whose agent
may not ask questions (OpenCode's `general` agent, or a `question` rule with `"effect": "deny"`)
is refused as before, and the parent hears nothing. The child brief tells children to use the
question tool when the person must decide; a child can still send its question with
`courier_send` instead, and the parent then passes your answer back with `courier_send`.

The TUI's [asks inbox](#the-asks-inbox) answers a question as `courier_answer` does; the top session hears it
as a question answered in the child's own session.

## Roster

`courier_spawn` records each child under its parent in the plugin's storage, so a parent that has
lost track after a compaction or a server restart can call `courier_children` to find them again. A
child that can no longer be looked up is still listed, with the error instead of its state. The
roster is also where a session's depth and tree are read from, for the
[limits](#session-trees-and-their-limits). Whether a child [owes its parent a
report](#a-child-that-ends-without-a-report), and its place in a [join group](#join-groups), are
kept next to it, and dropped with its entry.
Entries are dropped 14 days after the child was started, when that parent's roster is read or
the plugin is next loaded, except isolated children whose worktree is still there (see
[Worktree cleanup](#worktree-cleanup)). Loading the plugin also removes report state
(`report/<sessionID>/*`) whose session has no entry left, as a cleanup that failed part-way leaves it,
best-effort: a key that will not go is retried at the next load. The `report/` keys are read before
the roster, so a child spawned during the sweep, whose entry is written before its first report key,
is never taken for an orphan. If the roster cannot be written, the child still gets its
task and `courier_spawn` says it is not on the list.

## Seeing and stopping a subtree

**`courier_tree`** lists the sessions under the calling session, or under `sessionID`: those it
started with `courier_spawn`, and those they started, and so on. The roster is read level by level,
one prefix scan per parent (never the whole roster), at most `maxTotal` sessions; past that the
result says `truncated` and the number, and `courier_tree` on one of the listed sessions lists what is
under it. The result is flat, in the order a tree is drawn (each session followed by what it started,
siblings oldest first). Each entry is what `courier_children` shows (`sessionID`, `title`,
`outcome`, `lastText`, `pending`, `directory`, `isolated`, `created`, and `group: { name, report }`
for a member of a join group) plus:

- `parentID` and `depth`: 1 for a child of the session the tree is read from;
- `report`, when its report state is known: `owes` (it has been prompted since it last reported,
  failed or was interrupted), `progressed` (it messaged its parent without a status since its last
  prompt), `ended` (its turn failed or was interrupted since) and `status` (the status of its last
  report: `done`, `partial`, `blocked` or `failed`).

Anyone can read any session's tree, as with `courier_children`.

**`courier_stop { sessionID, cleanup? }`** stops a session and every session under it:

1. Only a session above the target may stop it: the calling session must be one of the sessions that
   started the target, directly or through others, as for [`courier_answer`](#a-child-that-asks-for-permission),
   so a session cannot stop itself, a sibling or a parent, and one `courier_spawn` did not start cannot be stopped.
2. Every session in the subtree is marked stopped (`report/<sessionID>/stopped`) and the
   `courier_later` messages scheduled *for* them are cancelled, before any interrupt, so nothing
   scheduled wakes a session that has just been stopped. Messages they scheduled for other sessions,
   and webhook subscriptions, are left alone.
3. They are interrupted with `session.interrupt`, level by level, deepest first, the level's
   sessions at once. A session that does not run is not an error: its entry says `idle` and nothing
   else happens to it; one OpenCode no longer knows says `gone`, and one whose interrupt failed
   says `failed` with the error and may still run, while the others are stopped regardless. The
   subtree is then read again, up to three times, for a session one of them started meanwhile.
4. With `cleanup: true`, the worktrees of the stopped sessions that ran in one of their own are
   removed deepest first by the rules of [`courier_cleanup`](#worktree-cleanup), without `force`:
   one with uncommitted changes or commits on no branch is kept and listed in the result, and one
   that fails is listed with its error.

The result lists every session stopped, deepest first, with its outcome, the ids of the messages
cancelled, and the worktrees.

**Who is told.** An interrupt ends the turn with `session.execution.interrupted`, reason `user`,
which settles the session's report, as before, and takes a member out of its join group (the
release message names it as interrupted). The failure and the silent-end notices stay quiet for a
session stopped since its last prompt: a session prompted again after a stop is judged as any other.

- The calling session is not told of what it stopped.
- The parent of the target is told once, `ended="stopped"`, when it is not the caller, that is when
  there is a session between the caller and the target. The notice says it was stopped by a session
  above, and is not a failure. It is not sent when the target did not run, as nothing was stopped.
- Sessions under the target are not told: their parents are stopped too, and a notice would wake them.

A stopped session is not forgotten: it stays on the roster and in `courier_tree`, can be messaged with
`courier_send` (which prompts it again, and it owes a report again) and is removed by `courier_cleanup`.
A session of the subtree that a running turn of its own starts between the first look and the
last cannot be stopped.

## In the terminal

The package has three entrypoints: the server plugin (`.`, `dist/index.js`), a TUI part (`./tui`,
`dist/tui.js`) and its RPC contract (`./rpc`, `dist/rpc.js`). The server finds the other two next to
the first and reports `features: { server: true, tui: true, rpc: true }` in `GET /api/plugin`; it runs
only the server plugin, and the TUI loads `tui` for a plugin with that feature (`docs/plugin-api-notes.md`,
*TUI and RPC entrypoints*). The TUI part is a view: courier without a TUI attached, as under `opencode
serve`, `opencode service` or the paired app, behaves the same, and no model sees anything of it.

**The status entry.** In the prompt's footer (`prompt.footer.status`), for the open session:

```
courier 2 running · 1 waiting on you · 1 idle · group pair 1/2
```

It counts the sessions under the open session, those it started with `courier_spawn` and those they
started, at most `maxTotal` as `courier_tree` reads them (past that, `first <maxTotal> counted`), each
by what it does:

- `waiting on you`: it waits on a permission request or a question, those `courier_status` lists as
  `pending`, which go to the person at the top of its tree;
- `running`: its turn runs, or something reached it after its last turn ended, and it waits on no
  request;
- `idle`: neither, whether it has reported or waits for a message.

A session OpenCode no longer knows is not counted. Then, for each join group of the open session's own
children still open, `group <name> <reported>/<members>`: the members whose report is held out of
those that have not left (a group of a grandchild's is its parent's to wait on, and not shown). A part
that is zero is left out; the entry shows nothing on the home screen, where there is no session, for a
session that started none, and when the RPC fails, as on a server without it. It asks again 250 ms
after the first of the events that may change it (a session created or deleted, a turn started or
ended, a permission request asked or answered, a form created or settled, a message delivered), once
per burst, at the open session's own location (where the plugin is loaded), else the TUI's, else the
server's default one. A server that cannot register the RPC logs `courier rpc: not registered` and
loads the rest as before.

**The RPC.** `courier.summary`, registered by every instance at its location as the tools are, through
the same use cases as `courier_tree` and `courier_children` (the roster, the sessions' times, their
pending requests, the groups' standing); the roster is one store for every location. Over HTTP:

```
POST /api/rpc/courier/summary?directory=<location> {"input":{"sessionID":"ses_…"}}
{"output":{"running":0,"waiting":1,"idle":1,"groups":[{"name":"pair","reported":1,"members":2}]}}
```

with `truncated: <maxTotal>` when the subtree was cut. An input without a `sessionID` is refused as
`rpc.invalid_input`. The contract is `treeRpc` from `opencode-courier/rpc`, for a client's
`client.rpc(treeRpc)`.

**The build.** `dist/tui.js` is bundled by `script/build-tui.ts` with OpenTUI's Solid transform and
every package left external: the host provides `@opencode/plugin/tui`, `solid-js`, `@opentui/*` and
`effect` to a TUI part, so the package declares none of them for it. `e2e/tui.sh` checks it live, in
`tmux`.

### The asks inbox

Every permission request, question and form waiting on the person anywhere in the open session's courier
tree, answered in the TUI's dialogs with no model in between. It is opened by the command
`courier.asks`: its key `<leader>k` (`ctrl+x k` by default), the slash command `/asks`, the command
palette ("Courier: what waits on you"), or a click on the footer's entry while it shows `waiting on you`.
With no session open it says so; with nothing waiting, "Nothing in this courier tree waits on you."

**What it lists.** The tree is courier's own, read from the roster, not OpenCode's `parentID`: from the top
of the open session's lineage down, so every session of a tree, the root or a grandchild, lists the same,
at most `maxTotal` sessions as `courier_tree` reads them. The server's `asks` method gives the tree's
sessions and their permission requests and questions, as `courier_status` lists them (`pending`); the TUI
adds each session's forms (`GET /api/session/:id/form`), leaving out the question tool's own forms, which
are listed as their questions. One line per ask, oldest first (in the order the inbox first saw them, and
in the tree's order among those seen together):

```
Waiting on you (2)
  Permission: shell echo courier-asks         Root › Fix the bug › Write tests   depth 2 · group pair
  Question: Greeting: Which greeting?         Root › Fix the bug                 depth 1
```

A question whose call was cut off says `cut off, answered by message`. Searching filters the list.

**Answering.** Choosing an ask opens its dialog; `esc` goes back to the list, which is read again after
each answer and closes once nothing is left.

- A permission request: `Allow once`, `Always allow` (only when the request has something to save, which
  it names), `Reject`, or `Reject with a reason…`, which asks for the reason. It goes through OpenCode's own
  reply (`POST /api/session/:id/permission/:request/reply`, the TUI client's `permission.reply`), which
  settles it; a rejection always carries a message, the person's reason or `courier_answer`'s default, so
  the child's call fails and it carries on rather than ending its turn. OpenCode's `permission.replied` then
  reaches courier's events as any reply in the child's own session does: the session told about the
  request gets [one settled notice](#a-child-that-asks-for-permission) (`answered="once"`, …) and no second ask.
- A form: each field it shows in turn (hidden ones and those whose `when` fails on the answers so far are
  skipped): a choice for one with options (and an answer of the person's own where the field allows it), a
  yes or no for a boolean, several choices for a multiselect, typed text or a number otherwise; an optional
  field can be skipped. The answer goes through the TUI's `data.session.form.reply`, and OpenCode's
  `form.replied` gives the session told about the form [its settled notice](#a-child-that-shows-a-form). A
  form that opens a page (an `external` field) is left to its own session.
- A question: each of its questions in turn, one choice, several (toggled, then `Done`) where it allows
  them, or `Type your own answer…`. The answers go to the server's `answer` method, which passes them on as
  `courier_answer` does: as the result of the call that waits on it, or as a message when that call was cut
  off. The top session then hears it once, [as if the question had been answered in the asking
  session](#a-child-that-asks-a-question): if its own question call asking the person the same is open, that
  call is withdrawn with `answered in its own session (…)`; otherwise, if it was told about the question,
  it gets the settled notice (`answered="elsewhere"`). A later `courier_answer` for it passes nothing on.
  Answers that do not fit the question come back as a message in the TUI, and nothing is passed on.

**Attention.** 250 ms after the first of a burst of `permission.asked` and `form.created` events, the TUI
reads the open session's tree and plays, for each ask it has not sounded before, OpenCode's `permission`
sound for a permission request and its `question` sound for a question or a form, with a notification
(the ask and where it comes from) when the terminal is not focused. OpenCode's own TUI sounds for every
request and form it sees as well.

**The RPC.** `courier-person`, registered by every instance next to `courier`:

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
reason when the answers do not fit. The contract is `personRpc` from `opencode-courier/rpc`.

## Worktree cleanup

An isolated child works in a git worktree under OpenCode's data directory
(`…/opencode/worktree/<project>/<name>`, on a detached HEAD), and nothing removes it on its own.
When the parent has what it needs from the child, it calls `courier_cleanup { sessionID }`, which
removes the worktree and drops the child from `courier_children`. A child started without `isolate`
ran in the parent's directory and has no worktree: `courier_cleanup` only forgets it (outcome
`forgotten`), dropping its roster entry and report state, and, for a member of a join group that has
not reported, [dropping it from the group](#join-groups).
`courier_cleanup` never deletes a session. Deleting one in OpenCode (the TUI, the app or
`DELETE /api/session/<id>`) drops its report state and groups, and the report state of the sessions it
started; its roster entry stays, listed with the error, until its 14 days are up. With
[`nativeChildren`](#native-child-sessions) on, it also deletes the session's native children, and
theirs, which are forgotten the same way.

### Nested isolation

A root session's isolated child starts from the project's last commit, as above. When the session
calling `courier_spawn` with `isolate: true` is itself an isolated child on the roster, the new
worktree starts from the commit **the parent's worktree is on now**, so a sub-orchestrator hands its
committed work down; that commit is the child's recorded `base`. Uncommitted work is not handed
down: the brief of an isolated session tells it to commit before it spawns, and when the parent's
worktree has uncommitted changes `courier_spawn` says so in its result (the spawn goes on).

- The parent is found by the roster's reverse index alone; a parent whose index entry could not be
  written (see [the roster](#roster)) is taken for a root, and its children start from the
  project.
- If the parent's HEAD cannot be read (git missing, the worktree gone), `courier_spawn` fails and
  starts nothing: starting from the project instead would give the child code without the parent's
  work, unannounced. The error says to start it without `isolate`.
- Every isolated child is told to commit its work on a branch named `courier/<its session ID>`
  (it starts on a detached HEAD, so it creates it) and to name that branch in `artifacts.branch` of
  its report. The branch is in the shared repository, so the parent merges it into its own
  worktree, which is the parent's to do. `courier_cleanup` counts the branch like any other: the
  commits on it are not "on no branch", and the commits a worktree was made from never count.
- How `from` and `branch` behave in OpenCode 2.0.26: [plugin API notes](plugin-api-notes.md#creating-a-worktree-from-a-given-commit-v2026).

The worktree is kept, and the result says why, when it holds work that would otherwise be lost:

- uncommitted changes, untracked files included (ignored files, such as `node_modules`, are not
  work and go with the worktree);
- commits that are on no branch, tag or remote-tracking ref, which is where a child's commits on
  its detached HEAD end up. A commit on a branch survives the removal, so it does not count, and
  neither do commits the worktree was made from (`courier_spawn` records that commit), such as a
  parent's own unbranched work when an isolated child spawns isolated children of its own.

The result lists up to 50 changed paths (an untracked directory counts once) and 50 commits. Commit
or branch what you want to keep (`git -C <worktree> branch <name>` keeps its commits), or call
`courier_cleanup` again with `force: true` to discard it; `force` also removes a worktree git can
no longer read. A worktree whose directory is already gone is just dropped from the list; git
forgets its registration on its next `git worktree prune` or `git gc`.

The plugin reads a worktree's state by running git itself, which it looks for in its usual install
locations and never through `PATH`, so a writable directory early in `PATH` cannot put another
program in its place: `/usr/bin/git`, `/usr/local/bin/git`, `/opt/homebrew/bin/git` and
`/run/current-system/sw/bin/git` (NixOS and nix-darwin), or on Windows
`C:\Program Files\Git\cmd\git.exe` and its `(x86)` twin. Git installed anywhere else is named by
the environment variable `OPENCODE_COURIER_GIT`, an absolute path, set for the OpenCode server.
Without a git, `courier_cleanup` refuses with a message naming the places it looked, unless `force`
is set, and `courier_spawn` records no commit.

Cleanup is explicit only. A child reporting back does not mean the parent has merged, reviewed or
even read its work, and the parent may still send it more to do in the same worktree, so the
plugin never removes one on its own. Isolated children whose worktree still exists are kept on
`courier_children` past the 14 days, so they can still be found and cleaned up.

`courier_cleanup` cannot tell whether the child is still running, so call it after the child has
reported. It works on the calling session's own children.

## Scheduled messages

Pending `courier_later` messages are kept in the plugin's storage, and the plugin checks for due
ones every 15 seconds, so a message can arrive up to about 15 seconds late. Within one OpenCode
server, however many projects have the plugin loaded, one scheduler delivers, so each message
arrives once.

They survive a server restart. After a start, OpenCode loads plugins for a project the first time
that project is used, so messages that fell due while it was down are delivered then, not at the
moment the server comes back. A crash between delivering a message and forgetting it can deliver
it twice after the restart; a lost check-in would be worse.

## Several copies in one process

OpenCode runs one instance of the plugin per location (project or worktree), all in one process, and
after an update it loads the new copy of the package next to the old one until the old one unloads.
All instances share one process-wide hub, where each scheduled message, released join group,
OpenCode event, permission
request, form and question is claimed once, before any instance acts on it, so no message is
delivered twice and no notice is sent twice, whichever instance or copy sees it first. The hub also
runs the scheduler once per process and follows OpenCode's events through two instances, one of them
a standby, so that an instance unloading does not leave a gap in which an event, or a child's
question, is missed. A webhook receiver started by one instance is the one the others join, so two
never contend for the port. The `courier_spawn` calls under way are kept process-wide in the same
way, under a fixed key of their own, so spawns in every location and copy count each other against
the limits; so are the types of the items entering spawned sessions' inboxes, so whichever
instance or copy sees an item's delivery knows what it was.

The hub carries a version, which changes only when its shape or the meaning of a field does, not
with every release (it is 2 since the join groups: the scheduler's tick delivers released groups
too, and takes a nudge to run at once). A copy that finds a hub of another version in the process runs its own, under a
key of its version, and logs one line saying so. The claim sets themselves are shared across hub
versions, under keys whose shape and meaning are fixed for good, so an old and a new copy of the
plugin loaded together still never both deliver or tell the same thing; a change that needed
another meaning for one of them would make a new key and keep claiming in the old one as well.

What a scheduler tick and an event subscription do is the code of the copy loaded last, run through
the instance loaded first (or the earliest without a subscription), which may belong to an older
copy of the same hub version: so the ports an instance joins the hub with are part of that version
too, and a release whose tick or event handling needed a port older instances lack would change it.
A copy that unloads takes its code with it; the hub keeps none of it.

When an instance unloads, OpenCode waits, up to 2 seconds, for the work it leaves behind: a
scheduler tick running through it, the event subscription it ran (once its replacement has
started), and what it started on loading. Past that, what is still under way finishes on its own.

## Two servers on one data directory

Two OpenCode servers on one data directory, such as `opencode serve` next to the background server
of `opencode service`, share the plugin's storage (the roster, pending `courier_later` messages,
stored questions) but not its memory. The plugin handles that as follows:

- **A `courier_later` message is delivered by one server**, the one holding the scheduler's owner
  key, `scheduler/owner` in the plugin's storage. A server's scheduler delivers while it holds the
  key, renewing it as it goes, and skips its tick while another server's key is less than 60
  seconds old. A key that is missing or expired is taken with a short random wait and a read back,
  so of two servers taking it at once only one delivers. A server that stops gracefully releases
  the key; one that crashes or stalls leaves it to expire, and another server takes over within
  about 75 seconds, so the messages due meanwhile arrive late, not lost. The storage has no
  compare-and-set, so a message delivered twice is rare rather than impossible: it takes a process
  stalling for half a second or more between two storage calls, or a delivery running for over a
  minute. A release of the plugin from before the owner key (0.2.2 and earlier) delivers on its own
  schedule beside the owner.
- **A child's permission request, its failed turn and its turn without a report are told to the
  parent once**, by the server that runs the child's turn: the one that handled the `courier_spawn`,
  or the latest message, that started it. Whether a child owes a report compares the times of both
  servers' clocks, so they should be one machine's.
- **A released [join group](#join-groups) is delivered by the server holding the owner key**, as a
  `courier_later` message is: the members' `courier_send` calls hold their reports in the shared
  storage from whichever server runs them, and once the parent's turn has ended the owner's
  scheduler delivers the group at once when the last report is held, or the turn ends, on that
  server, or at its next tick otherwise.
- **`courier_answer` passes an answer on only from a turn on that same server.** Pending requests
  live in the memory of the process running the child, and the plugin API offers no channel between
  servers. From the other server it finds no request pending and says so: the request was answered
  some other way, or the session stopped waiting, or it waits in another OpenCode server on the
  same data directory, where the person has to answer it, in the child's session. `courier_status`
  likewise lists only the requests waiting on its own server.

Where you can, run one OpenCode server per data directory, or point a second one at another
(`XDG_DATA_HOME`).

## Webhooks

With the `webhook` option set (see [Webhooks](../README.md#webhooks) in the README), the plugin
listens for HTTP deliveries and turns them into messages for subscribed sessions:

- `POST /github` takes GitHub webhook deliveries. A pull request review, a review comment, a
  comment, a pull request or issue being opened, reopened, closed (or merged) or marked ready for
  review, or a completed check run, check suite or workflow run on a pull request goes to the
  sessions subscribed to `owner/repo#N` and to `owner/repo`; anything else with a repository (a
  push, a release) goes to `owner/repo` only. Pings, CI runs that have not completed, and other
  pull request and issue actions (pushes to the branch, edits, labels, assignments, review
  requests) wake nobody.
- `POST /hook/<name>` takes anything else, for sessions subscribed to `<name>`. A JSON body's
  `text`, `summary` or `message` field is delivered, otherwise the body itself.

Every delivery must carry an `X-Hub-Signature-256` header: `sha256=` followed by exactly 64 hex
digits, the HMAC-SHA256 under the shared secret. For GitHub that is of the raw body, as GitHub
sends it. For `/hook/<name>` it is of the name, a newline and the body, so a captured delivery
cannot be sent to another topic:

```bash
sig=$(printf '%s\n%s' deploys "$body" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)
curl -X POST -H "x-hub-signature-256: sha256=$sig" --data-binary "$body" http://127.0.0.1:4097/hook/deploys
```

A missing or wrong signature gets `401`, and the body is not parsed. The check is constant-time.
Bodies over 1 MiB (`maxBytes`) get `413`. A delivered event gets `202`, with the number of
sessions it reached, which can be 0. The digests of the last 1000 accepted deliveries are remembered
in memory, and a delivery already accepted gets `200 already delivered`. One that reached nobody
because every delivery to a session failed is forgotten again, so it can be retried. That stops
replays of a captured delivery, and it also means a GitHub Redeliver of a delivery that already
arrived is ignored. Redelivering one that failed works. Generic senders that post the same text
twice should add something unique, such as a timestamp, to the body.

The subscribed sessions are sent their messages at once, so a session slow to take one holds up
none of the others. A session that OpenCode no longer knows loses its subscriptions the next time a
delivery for it fails, and `courier_subscribe` refuses a session id that does not exist.

A session sees a short summary (event, repository and number, who, state or conclusion, link, and
at most 1500 characters of a review or comment body), wrapped in `<courier from="github"
event="...">` and followed by a note that it is outside text, to be treated as data. Review and
comment bodies are written by whoever can comment on the repository, so subscribe sessions only to
repositories whose commenters you trust with your agent's attention. The server log gets one line
per delivery (event, delivery id, number of sessions), never the payload or the secret.

GitHub does not report check suites on pull requests from forks, so CI results for those reach
`owner/repo` subscribers only. There is no GitHub event for a merge conflict.
