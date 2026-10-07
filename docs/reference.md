# Behaviour reference

How the plugin behaves beyond the happy path: what a child runs on, how its failures, permission
requests and questions reach the session that started it, what is kept where and for how long, and
what the webhook receiver does with a delivery. The [README](../README.md) has the short version.

## The OpenCode version

### How a release is tested

The end-to-end suite runs on the pinned version (the README's [Supported OpenCode
version](../README.md#supported-opencode-version) table) with every change, and once more on the
newest `@opencode/cli` release, where a failure is a warning rather than a red build, so a host
release that breaks the plugin shows up in CI first. A newer OpenCode may still break tools;
[plugin-api-notes.md](plugin-api-notes.md) lists what the pinned version already needed working
around, and what changed the last time the pin moved.

### Other versions it was tried on

0.2.2 moves the pin to 2.0.24, which changed nothing the plugin calls; 0.2.1 passes the suite on
2.0.24 as well. 0.2.1 changes nothing but the pin: 2.0.23 changed nothing the plugin calls, and
0.2.0 passes the suite on 2.0.23 as well. 0.2.0 was tested on 2.0.22 and on the `dev` build
0.0.0-dev-20534 of 2026-10-04, the newest build then (no 2.x release above 2.0.22 existed), where
the suite passed too. Of the older hosts tried, it loads on 2.0.4 and 2.0.21 (nothing in between was
run, and the suite was not), and fails to load on 2.0.0 and 2.0.3, which lack the `model` domain the
plugin API gained in 2.0.4. The version in `package.json` protects nobody on its own: OpenCode says
nothing about it, since `opencode plugin add` installs the plugin whatever your OpenCode version and
its loader warns about nothing either (a recorded experiment, in
[plugin-api-notes.md](plugin-api-notes.md#what-plugin-add-and-loading-do-with-the-peer-dependency-2026-10-04),
which also says why the peer dependency stays exact rather than a range: it picks the copy of the
plugin API the plugin runs on). The plugin's own log line,
[below](#the-log-line-on-another-version), is the only runtime signal, apart from the load failure
on those hosts before 2.0.4. Check yours with `opencode --version`.

### The log line on another version

Each build of the plugin is tested against one OpenCode version, the exact `@opencode/plugin`
version under `devDependencies` in its `package.json`, which the plugin reads from its own
package when it loads, along with its own `version`. When the running OpenCode reports another
version (`app.version` in the plugin context), the plugin writes one line to the server log, as
`opencode serve --print-logs` shows it:

```
opencode-courier 0.2.0 was built and tested against OpenCode 2.0.22; this server is 2.0.30 (channel beta). Its tools may fail: see the Supported OpenCode version table in the README, https://github.com/ivopogace/opencode-courier#supported-opencode-version
```

That is all it does: the plugin loads and registers its tools as usual, since the other version
may well be compatible, and no tool result mentions it, so the models never see it. The line is
written once per load, so once per project location OpenCode sets the plugin up for, never per
tool call. An older server is named the same way as a newer one, and so is a development build
of OpenCode, whose version is not a release's; one whose plugin context reports no version at all
gets the line too, saying so, since that is the mismatch the line is for. If the plugin cannot
read its own `package.json`, it logs that instead and carries on.

## Updating the plugin

Install the plugin by name, without a version (`opencode plugin add opencode-courier`). OpenCode
only checks plugins for updates when their entry is not an exact version: `opencode-courier` (or a
tag or range such as `opencode-courier@latest` or `opencode-courier@^0.2.0`) is checked against npm,
but `opencode-courier@0.2.1` counts as fixed. Its check reports it as current without asking npm, so
`opencode plugin check`, `opencode plugin update` and *check for updates* (ctrl+r) in the TUI's
`/plugins` dialog never offer a newer release. If your entry carries an exact version, replace it
with the name and restart OpenCode:

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

## A child that fails

A child reports with `courier_send`, which it cannot do when its turn fails: the model is not
available to the account, the credentials are missing, the provider is down. The plugin follows
OpenCode's events, and for every `session.execution.failed` of a session on a roster it sends the
parent a message from that child, marked `failed="<error type>"`, with the child's title and the
error, waking the parent if it is idle. The parent then decides: message the child to have it try
again, start a replacement, or carry on without it.

Every failed turn of a child is reported, also one that fails after the child has reported. A turn
that was interrupted is not a failure and is not reported, and neither is a failure that happens
while the OpenCode server is down or the plugin is not loaded; a `courier_later` check-in still
covers those.

## A child that asks for permission

When a child's tool call needs an approval (a permission rule with `"effect": "ask"`, or no rule
for it), OpenCode holds the call until someone answers in the child's session, which the person
working in the parent's session does not see. The plugin follows `permission.asked`, and for a
session on a roster it sends the parent a message from that child, marked `asks="permission"` and
`request="<id>"`, waking the parent if it is idle. The message says what the child asks for (the
action, such as `shell` or `edit`, and its resources, such as the command or the paths), lists
the choices OpenCode's own prompt offers, and tells the parent to ask the person rather than
decide:

- `once`: allow this request only;
- `always`: allow it and save the rule for the project; offered only when the request says what
  to save, as in OpenCode's prompt;
- `reject`: refuse it, with a reason if the person gives one.

The parent asks you, with its question tool if it has one, and calls
`courier_answer { sessionID, requestID, reply, message? }` with your choice. The plugin passes it
on with the plugin API's `permission.reply`, and the child carries on.

A request of a child's child goes to the session at the top, the one you started the first child
from, and so on down any number of levels, since that is where you are; the message names the
session that started the asking one. Only that top session can answer it. A session started with
`courier_spawn` cannot answer what its own children ask, so it cannot get around a rule that makes
it ask by starting a child to do the job and approving it.

OpenCode ends the child's turn when a request is rejected without a message, and the child would
then never report back. So `courier_answer` always sends a message with a rejection, the person's
reason or a default one; the child's call fails and it carries on, and can report. At
`0.0.0-beta-19271` the child's model is told that the call could not be run, not the reason.

A request can also be answered without the parent: in the child's own session, or along with
another answer (an `always` that covers it, or a rejection, which rejects the session's other
pending requests as well). For a request the parent was told about, the plugin then sends it a
short message marked `answered="<reply>"` saying the request is settled, so it does not pass on a
stale question; after a rejection, the message adds that the child may have stopped, and that
`courier_send` gets it going again. A `courier_answer` that comes later anyway passes nothing on and
says so.

`courier_status` and `courier_children` list the requests a session waits on under `pending`, so a
parent that has lost the message, after a compaction for example, can still find them. Whenever
the plugin starts following OpenCode's events, on loading and after its event stream broke, it
also relays the requests that spawned sessions already wait on, so one asked in the gap is not
missed.

## A child that shows a form

OpenCode asks some things through forms of its own rather than a permission request or the question
tool, and shows them in the child's session only. The one a child meets most is web search: the
first `websearch` call made while no search provider has been chosen shows a "Web Search" form
(allow search through the providers OpenCode has, choose another provider, or disable web search),
and a second one, "Choose a web search provider", if the person picks another. The plugin cannot
pass such a form on or answer it, since the plugin API has no way to answer or withdraw a form; only
the person can, in the child's session.

So the plugin follows `form.created`, and for a form of a session on a roster it sends the session at
the top, the one its permission requests go to, a message from that child marked `asks="form"`,
`form="<id>"` and, when the form says what it is for, `kind="<kind>"` (`kind="websearch.provider"`
for web search), waking it if it is idle. The message gives the form's title, its fields and their
choices, and says that neither the parent nor `courier_answer` can answer it, only the person, in
that child's session: the parent should tell you, not choose for you. A form of a child's child
goes to the top session, naming the session that started the asking one, as with a permission
request. Each form is told once, however many plugin instances see it.

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
passes every question of a spawned session on, and OpenCode marks those forms with the kind
`question`. Forms of sessions not on a roster are ignored, among them MCP servers' requests for
input, which OpenCode does not attach to a session. The plugin cannot list the forms a session
shows, so `courier_status` does not report them; a form shown while the plugin was not following
OpenCode's events is not told, and one settled then, or across a server restart, is not told settled.

## A child that asks a question

A child that calls OpenCode's question tool shows its question in its own session only. The plugin
wraps that tool, and once the question of a session on a roster is on screen, it sends the session
at the top, the one its permission requests go to, a message from that child marked
`asks="question"` and `request="question_<id>"`, waking it if it is idle. The message lists the
questions and their options, gives them again as one line of JSON in the question tool's own input
shape, and tells the parent to ask the person, with its question tool and exactly those questions,
rather than answer.

When the parent asks you the same questions with the same options, the two are linked: what you
pick in the parent's session is passed to the child's waiting call, which returns it as if you had
answered there, and the child carries on in the same turn. The parent's tool result says so. Only
the same wording links (spacing and case aside; the options may come in any order), so a question
of the parent's own with the same yes-or-no choices never answers a child's; when a waiting question has the same choices, the
parent's tool result says the answers were not passed on and names the request. A parent that asked you some
other way, in text or reworded, calls
`courier_answer { sessionID, requestID, answers }`: one entry per question, in order, each the
label you chose or the text you gave, or a list of labels where a question allows several. As with
permission requests, only the session at the top can answer. Answers to one question are passed on
one at a time, and once: a second waits for the first, and is told the question no longer waits once
the first got through. A first that has not got through after 30 seconds gives way, and the second
goes on; should the first still get through, the child is told twice.

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
  and can report. Should the parent ask you again within the two seconds the dismissal is held
  (below), that question is withdrawn too, saying the child carries on without the answers;
- answered with `courier_answer` while the parent's question is open (a parent that asks you and
  calls `courier_answer` in the same step): the parent's question disappears, and its tool result
  names the answers that went to the child, as a message when its question had been cut off. A
  pick in the parent's question that lands just as `courier_answer` goes through is not passed on,
  and the parent's tool result says so; a dismissal that lands then is dropped and logged.

A dismissal on either side reaches the other about two seconds later: OpenCode withdraws open
questions the same way when it shuts down, and the plugin waits that long to tell the two apart.

A question whose call is cut off stays answerable. When the child's turn is stopped (interrupted,
or by OpenCode itself, which stops every turn in a project location after 60 minutes without
activity there), or the server restarts or closes the project, the question is gone from the
screen. The plugin keeps it in its storage, sends the parent a message marked `stopped="true"`, or
`restarted="true"` when the plugin is next loaded (or half a minute later, when
OpenCode closed only that project, keeps running, and has the plugin loaded for another), with the
questions, and passes
the answer on as a message to the child, which wakes it. If the parent is asking you at that
moment, your answer goes that way without a new message. When the plugin loads, stored questions
are dropped after 14 days, once the child is off its parent's roster, or beyond the 100 newest.

`courier_status` and `courier_children` list a session's questions under `pending`, with
`type: "question"`, the questions, and `stopped: true` for one that was cut off. A question whose
message to the parent could not be sent, or whose record could not be stored, is listed there too,
and can be answered all the same.

A question is relayed only once OpenCode's permission check for it has passed: a child whose agent
may not ask questions (OpenCode's `general` agent, or a `question` rule with `"effect": "deny"`)
is refused as before, and the parent hears nothing. The plugin learns that a question is on screen
from OpenCode's events; when no instance of it followed them for a while and one does again, it
relays every question still waiting for that, since one shown meanwhile was not seen. The child brief tells children to use the
question tool when the person must decide; a child can still send its question with
`courier_send` instead, and the parent then passes your answer back with `courier_send`.

## Roster

`courier_spawn` records each child under its parent in the plugin's storage, so a parent that has
lost track after a compaction or a server restart can call `courier_children` to find them again.
A child that can no longer be looked up is still listed, with the error instead of its state.
Entries are dropped 14 days after the child was started, when that parent's roster is read or
the plugin is next loaded, except isolated children whose worktree is still there (see
[Worktree cleanup](#worktree-cleanup)). If the roster cannot be written, the child still gets its task and
`courier_spawn` says it is not on the list.

## Worktree cleanup

An isolated child works in a git worktree under OpenCode's data directory
(`…/opencode/worktree/<project>/<name>`, on a detached HEAD), and nothing removes it on its own.
When the parent has what it needs from the child, it calls `courier_cleanup { sessionID }`, which
removes the worktree through the plugin API's `worktree.remove` and drops the child from
`courier_children`.

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

The plugin reads a worktree's state, and the commit `courier_spawn` records, by running git itself,
which it looks for in its usual install locations and never through `PATH`, so a writable
directory early in `PATH` cannot put another program in its place: `/usr/bin/git`,
`/usr/local/bin/git`, `/opt/homebrew/bin/git` and `/run/current-system/sw/bin/git` (NixOS and
nix-darwin), or on Windows `C:\Program Files\Git\cmd\git.exe` and its `(x86)` twin. Git
installed anywhere else is named by the environment variable `OPENCODE_COURIER_GIT`, an absolute
path, set for the OpenCode server. Without a git, `courier_cleanup` refuses with a message naming
the places it looked, unless `force` is set, and `courier_spawn` records no commit.

Cleanup is explicit only. A child reporting back does not mean the parent has merged, reviewed or
even read its work, and the parent may still send it more to do in the same worktree, so the
plugin never removes one on its own. Isolated children whose worktree still exists are kept on
`courier_children` past the 14 days, so they can still be found and cleaned up.

`courier_cleanup` cannot tell whether the child is still running, so call it after the child has
reported. It works on the calling session's own children.

## Scheduled messages

Pending `courier_later` messages are kept in the plugin's storage, and every loaded copy of the
plugin checks for due ones every 15 seconds, so a message can arrive up to about 15 seconds late.
OpenCode loads the plugin once per project location; the copies in one server share one claim set,
so each message is delivered once. Two servers on one data directory do not share it (see below).

They survive a server restart. After a start, OpenCode loads plugins for a project the first time
that project is used, so messages that fell due while it was down are delivered then, not at the
moment the server comes back. A crash between delivering a message and forgetting it can deliver
it twice after the restart; a lost check-in would be worse.

## Two servers on one data directory

Two OpenCode servers on one data directory, such as `opencode serve` next to the background server
of `opencode service`, share the plugin's storage but not its memory. Measured at 2.0.24 with
`e2e/two-servers.sh` ([the notes](plugin-api-notes.md#two-servers-on-one-data-directory-2026-10-07)):

- A `courier_later` message is delivered by whichever server's scheduler finds it due first, and
  twice when both look within a few milliseconds of each other. With the plugin loaded on both at
  the same moment, from none to all of ten messages due together were delivered twice, varying
  from run to run; loaded half a tick apart, none was.
- A child's permission request and a child's failed turn are told to the parent once, by the
  server that runs the child's turn: the one that handled the `courier_spawn`, or the latest
  message, that started it.
- `courier_answer` passes an answer on only from a turn on that same server. From the other one it
  finds no request, says the child no longer waits, and passes nothing on, while the child still
  waits. By the same token, not measured, `courier_status` lists only the requests waiting on its
  own server.

Run one OpenCode server per data directory, or point a second one at another (`XDG_DATA_HOME`).

## Webhooks

With the `webhook` option set (see [Receiving webhooks](../README.md#webhooks)), the plugin listens
for HTTP deliveries and turns them into messages for subscribed sessions:

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
digits, the HMAC-SHA256 under the shared secret. For GitHub that is of the raw body, as GitHub sends it. For
`/hook/<name>` it is of the name, a newline and the body, so a captured delivery cannot be sent to
another topic:

```bash
sig=$(printf '%s\n%s' deploys "$body" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)
curl -X POST -H "x-hub-signature-256: sha256=$sig" --data-binary "$body" http://127.0.0.1:4097/hook/deploys
```

A missing or wrong signature gets `401`, and the body is not parsed. The check is constant-time.
Bodies over 1 MiB (`maxBytes`) get `413`. A delivered event gets `202`, with the number of
sessions it reached, which can be 0. The digests of the last 1000 accepted deliveries are remembered in
memory (as lowercase hex, so re-casing the header does not get around it), and a delivery already
accepted gets `200 already delivered`. One that reached nobody because every delivery to a session
failed is forgotten again, so it can be retried. That stops replays of
a captured delivery, and it also means a GitHub Redeliver of a delivery that already arrived is
ignored. Redelivering one that failed works. Generic senders that post the same text twice should
add something unique, such as a timestamp, to the body.

The subscribed sessions are sent their messages at once, so a session slow to take one holds up
none of the others. A session that OpenCode no longer knows loses its subscriptions the next time a
delivery for it fails, and `courier_subscribe` refuses a session id that does not exist.

A session sees a short summary (event, repository and number, who, state or conclusion, link, and
at most 1500 characters of a review or comment body), wrapped in `<courier from="github"
event="...">` and followed by a note that it is outside text, to be treated as data. Review and
comment bodies are written by whoever can comment on the repository, so subscribe sessions only to
repositories whose commenters you trust with your agent's attention. The server log gets one line
per delivery (event, delivery id, number of sessions), never the payload or the secret.

GitHub does not report check suites on pull requests from forks (`pull_requests` is empty), so CI
results for those reach `owner/repo` subscribers only. There is no GitHub event for a merge
conflict.
