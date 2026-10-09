# Behaviour reference

How the plugin behaves beyond the happy path: what a child runs on, how deep and wide a tree of
sessions may grow, how a child's failures, permission requests and questions reach the session that
started it, what is kept where and for how long, and what the webhook receiver does with a delivery.
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

## Session trees and their limits

Any spawned session can call `courier_spawn` too, so sessions form a tree: the session nobody
spawned is its top, at depth 0, the sessions it starts are at depth 1, theirs at depth 2, and so on.
Three options bound the tree, each a positive integer, read from the plugin's `options` next to
`webhook`:

| Option | Default | |
|---|---|---|
| `maxDepth` | `3` | The deepest a spawned session may be. A session at this depth cannot start sessions. |
| `maxChildren` | `5` | How many of the sessions one session started may run at once. |
| `maxTotal` | `20` | How many spawned sessions may run at once in one tree, anywhere in it; the top session is not counted. |

```jsonc
{
  "plugins": [{ "package": "opencode-courier", "options": { "maxDepth": 2, "maxChildren": 3 } }]
}
```

Each location's instance reads its own options, and a spawn is checked by the instance of the
location the calling session runs in, so set them once, in the global config. A value that is not
a positive integer is not used: that limit keeps its default, and the server log says so when the
plugin loads. Like every option, a changed limit applies once OpenCode loads the plugin again.

**`courier_spawn` enforces them.** Before it creates anything, it works out the calling session's
depth and tree from the [roster](#roster) and refuses, with an error naming the limit and what to do
instead (do the work yourself, or end the turn and try again once a child has reported), when the
child would be deeper than `maxDepth`, or when `maxChildren` or `maxTotal` sessions are already
live. A session is live while its turn runs, or a session below it runs: its turn runs from its
creation until it ends, and again while a message keeps it busy, and a session that has split its
task and ended its turn to wait for its children stays live while any of them, or theirs, runs. A
session whose turn has ended, reported, failed or interrupted, with nothing below it running, does
not count. Its turn counts as ended when `session.get` fails, so one OpenCode no longer knows, or
cannot look up, does not count either. A child counts only while it runs, not until it has
reported: a child that ends its turn without `courier_send` stops counting at once; counting it
until it has reported comes with [#101](https://github.com/ivopogace/opencode-courier/issues/101).

Each check reads the whole roster once, to find the calling session's tree, and looks up every
session in that tree with `session.get`. The checks run one at a time in the process,
and a spawn under way counts until its child is on the roster, so several `courier_spawn` calls made
at once cannot get past a limit together, whichever locations or copies of the plugin make them.
Two servers on one data directory do not see each other's spawns under way.

Depth is read from the roster, so a session whose roster entry could not be written, or was
dropped after 14 days, starts its children as if it were the top of a tree.

**The brief says when to split.** A spawned session is told its depth and the limits. Below
`maxDepth` it is given a rule: split the task when it has 2 or more independent, substantial parts
touching separate files or areas, one session per part; do it itself when it is small, sequential or
tightly coupled, and never start exactly one session. A session that splits orchestrates: it ends its
turn while its children work, checks and integrates each part itself, never handing that checking
to another session, and sends its parent one combined report. At `maxDepth` it is told to do the
task itself.

**A `context` hook names the role on every model request.** For a spawned session the plugin adds
one system part, `opencode-courier role: …`, naming its role and depth: `sub-orchestrator` below
`maxDepth`, with the limits, and `leaf` at it, which is told it cannot start sessions. A leaf's
request also goes without `courier_spawn` in its tool list, so its model does not try it. The hook
is guidance and `courier_spawn` the guarantee: another plugin's hook can put the tool back, and the
call is still refused.

A session nobody spawned gets nothing from the hook until it has started a session, so one that
never uses the courier sends exactly the request it did before. From the request after its first
spawn on, it gets a `root orchestrator` part with the limits. Each part is the same on every request
of its session, so it changes the session's prompt once and the provider's prompt cache holds after
that. Each instance remembers the depths it has looked up, so the hook reads the roster once per
session, not per request. It reads only the session's [reverse index](#roster) key and its own
children, never the whole roster: an entry an older copy wrote without a key is indexed on the next
load, and until then the hook takes its session for one nobody spawned; `courier_spawn` still
enforces the limits.

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
on, and the child carries on.

A request of a child's child goes to the session at the top, the one you started the first child
from, and so on down any number of levels, since that is where you are; the message names the
session that started the asking one. Only that top session can answer it. A session started with
`courier_spawn` cannot answer what its own children ask, so it cannot get around a rule that makes
it ask by starting a child to do the job and approving it.

OpenCode ends the child's turn when a request is rejected without a message, and the child would
then never report back. So `courier_answer` always sends a message with a rejection, the person's
reason or a default one; the child's call fails and it carries on, and can report. The child's
model is told that the call could not be run, not the reason.

A request can also be answered without the parent: in the child's own session, or along with
another answer (an `always` that covers it, or a rejection, which rejects the session's other
pending requests as well). For a request the parent was told about, the plugin then sends it a
short message marked `answered="<reply>"` saying the request is settled, so it does not pass on a
stale question; after a rejection, the message adds that the child may have stopped, and that
`courier_send` gets it going again. A `courier_answer` that comes later anyway passes nothing on and
says so.

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
parent nor `courier_answer` can answer it, only the person, in that child's session: the parent
should tell you, not choose for you. A form of a child's child goes to the top session, naming the
session that started the asking one, as with a permission request.

For web search the message adds what OpenCode does next. It waits for the choice at most a minute;
then the child's search fails with "Web search cancelled", and the child carries on without it. The
choice is kept for every session (OpenCode stores it globally), so once it is made, in any session,
no session is asked again: you can answer in the child's session, run one web search in your own
session and answer there, or pick the provider under OpenCode's "Third-party search" setting.

Once a form the parent was told about is answered, or withdrawn unanswered (dismissed, given up on
after OpenCode's minute, or cut off with the child's turn), the plugin sends a short message marked
`settled="answered"` or `settled="cancelled"` and `form="<id>"`, so the parent does not send you to a
form that is gone.

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

A question is relayed only once OpenCode's permission check for it has passed: a child whose agent
may not ask questions (OpenCode's `general` agent, or a `question` rule with `"effect": "deny"`)
is refused as before, and the parent hears nothing. The child brief tells children to use the
question tool when the person must decide; a child can still send its question with
`courier_send` instead, and the parent then passes your answer back with `courier_send`.

## Roster

`courier_spawn` records each child under its parent in the plugin's storage, so a parent that has
lost track after a compaction or a server restart can call `courier_children` to find them again. A
child that can no longer be looked up is still listed, with the error instead of its state. The
roster is also where a session's depth and tree are read from, for the
[limits](#session-trees-and-their-limits).
Entries are dropped 14 days after the child was started, when that parent's roster is read or
the plugin is next loaded, except isolated children whose worktree is still there (see
[Worktree cleanup](#worktree-cleanup)). If the roster cannot be written, the child still gets its
task and `courier_spawn` says it is not on the list.

## Worktree cleanup

An isolated child works in a git worktree under OpenCode's data directory
(`…/opencode/worktree/<project>/<name>`, on a detached HEAD), and nothing removes it on its own.
When the parent has what it needs from the child, it calls `courier_cleanup { sessionID }`, which
removes the worktree and drops the child from `courier_children`.

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
All instances share one process-wide hub, where each scheduled message, OpenCode event, permission
request, form and question is claimed once, before any instance acts on it, so no message is
delivered twice and no notice is sent twice, whichever instance or copy sees it first. The hub also
runs the scheduler once per process and follows OpenCode's events through two instances, one of them
a standby, so that an instance unloading does not leave a gap in which an event, or a child's
question, is missed. A webhook receiver started by one instance is the one the others join, so two
never contend for the port. The `courier_spawn` calls under way are kept process-wide in the same
way, under a fixed key of their own, so spawns in every location and copy count each other against
the limits.

The hub carries a version, which changes only when its shape or the meaning of a field does, not
with every release. A copy that finds a hub of another version in the process runs its own, under a
key of its version, and logs one line saying so. The claim sets themselves are shared across hub
versions, under keys whose shape and meaning are fixed for good, so an old and a new copy of the
plugin loaded together still never both deliver or tell the same thing; a change that needed
another meaning for one of them would make a new key and keep claiming in the old one as well.

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
- **A child's permission request and a child's failed turn are told to the parent once**, by the
  server that runs the child's turn: the one that handled the `courier_spawn`, or the latest
  message, that started it.
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
