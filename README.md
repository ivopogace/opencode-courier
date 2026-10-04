# opencode-courier

[![CI](https://github.com/ivopogace/opencode-courier/actions/workflows/ci.yml/badge.svg)](https://github.com/ivopogace/opencode-courier/actions/workflows/ci.yml)

An [OpenCode](https://github.com/anomalyco/opencode) V2 plugin that lets one session start other
sessions, message them, and be woken by them, without polling.

A parent session calls `courier_spawn`, gets a session id back immediately and ends its turn. The
child works on its own and, when it is done or stuck, calls `courier_send` with the parent's id.
That message lands in the parent's inbox and OpenCode starts a new turn for the parent if it is
idle. A child whose turn fails instead, so that it cannot report, is reported by the plugin, and a
child that waits for a permission or asks a question has it passed to the parent, who asks you and
passes your answer back.

> **Status: early.** Passes an end-to-end test inside a live OpenCode V2 server
> (`opencode2 v0.0.0-beta-19271`) driven by a scripted stand-in model (`e2e/run.sh`), and a smoke
> test with real (free) models: see [Real models](#real-models).

## How the wake works

There is no polling anywhere. `courier_send` calls the plugin API's `session.synthetic`, which
admits a message into the target session's inbox and, unless `resume: false` is passed, calls
`execution.wake` on it (`packages/core/src/session/session.ts` on OpenCode's `beta` branch).
OpenCode's own background subagents report to their parent the same way
(`packages/core/src/session/subagent-completion.ts`).

Delivery is `steer` by default (injected into the target's running turn, or starts one if idle);
`queue: true` waits until the current turn ends.

## Tools

| Tool | Does |
|---|---|
| `courier_spawn` | Creates a session (optionally in its own git worktree with `isolate: true`) on the parent's model, sends it the task plus a brief naming the parent and how to report back, and returns at once. |
| `courier_send` | Delivers a message to a session, signed with the sender's id, waking it if idle. |
| `courier_status` | One look at a session: outcome, idle time, last reply and the permission requests and questions it waits on. For check-ins, not for waiting. |
| `courier_children` | Lists the sessions this one (or a given `sessionID`) started with `courier_spawn`, each with what `courier_status` reports plus its directory, whether it is isolated and when it was started. |
| `courier_cleanup` | Removes the git worktree of a child started with `isolate: true` and drops the child from `courier_children`. Keeps a worktree with uncommitted changes or commits on no branch, tag or remote and lists them, unless `force: true` is passed. |
| `courier_answer` | Passes the person's answer to a permission request or a question that a session started from this one waits on, after the plugin relayed it here: `reply` (`once`, `always` or `reject`, with an optional `message`) for a permission request, `answers` for a question. See [A child that asks for permission](#a-child-that-asks-for-permission) and [A child that asks a question](#a-child-that-asks-a-question). |
| `courier_later` | Schedules a message for a session (this one by default) in `delayMinutes` or `at` an ISO time, and returns an id. When due it is delivered like `courier_send`, queued behind any running turn and waking the session if idle. |
| `courier_cancel` | Drops a message scheduled with `courier_later`, e.g. because the child it was waiting for reported first. |
| `courier_subscribe` | Subscribes a session (this one by default) to webhook deliveries for a `topic`: `owner/repo`, `owner/repo#12` (one pull request or issue) or a generic name. Each matching delivery arrives as a message, queued behind any running turn and waking the session if idle. Needs the [webhook receiver](#webhooks). |
| `courier_unsubscribe` | Drops one topic, or all of a session's, e.g. once its pull request is merged. |

### The child's model

A child runs on the model its parent is using, not on OpenCode's default, so a parent you moved to
another model starts children that can reach theirs too. The exception is a child given an `agent`
that names a model of its own: that agent's model is kept. If the parent's model cannot be looked
up, the child is started anyway, on OpenCode's default.

### A child that fails

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

### A child that asks for permission

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

### A child that asks a question

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
  and can report.

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

### Roster

`courier_spawn` records each child under its parent in the plugin's storage, so a parent that has
lost track after a compaction or a server restart can call `courier_children` to find them again.
A child that can no longer be looked up is still listed, with the error instead of its state.
Entries are dropped 14 days after the child was started, when that parent's roster is read or
the plugin is next loaded, except isolated children whose worktree is still there (see
[Worktree cleanup](#worktree-cleanup)). If the roster cannot be written, the child still gets its task and
`courier_spawn` says it is not on the list.

### Worktree cleanup

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

Cleanup is explicit only. A child reporting back does not mean the parent has merged, reviewed or
even read its work, and the parent may still send it more to do in the same worktree, so the
plugin never removes one on its own. Isolated children whose worktree still exists are kept on
`courier_children` past the 14 days, so they can still be found and cleaned up.

`courier_cleanup` cannot tell whether the child is still running, so call it after the child has
reported. It works on the calling session's own children.

### Scheduled messages

Pending `courier_later` messages are kept in the plugin's storage, and every loaded copy of the
plugin checks for due ones every 15 seconds, so a message can arrive up to about 15 seconds late.
OpenCode loads the plugin once per project location; the copies share one claim set, so each
message is delivered once.

They survive a server restart. After a start, OpenCode loads plugins for a project the first time
that project is used, so messages that fell due while it was down are delivered then, not at the
moment the server comes back. A crash between delivering a message and forgetting it can deliver
it twice after the restart; a lost check-in would be worse.

### Webhooks

With the `webhook` option set (see [Receiving webhooks](#receiving-webhooks)), the plugin listens
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

A session that OpenCode no longer knows loses its subscriptions the next time a delivery for it
fails, and `courier_subscribe` refuses a session id that does not exist.

A session sees a short summary (event, repository and number, who, state or conclusion, link, and
at most 1500 characters of a review or comment body), wrapped in `<courier from="github"
event="...">` and followed by a note that it is outside text, to be treated as data. Review and
comment bodies are written by whoever can comment on the repository, so subscribe sessions only to
repositories whose commenters you trust with your agent's attention. The server log gets one line
per delivery (event, delivery id, number of sessions), never the payload or the secret.

GitHub does not report check suites on pull requests from forks (`pull_requests` is empty), so CI
results for those reach `owner/repo` subscribers only. There is no GitHub event for a merge
conflict.

## Install

Requires OpenCode V2, command `opencode2`. Its plugin API is still beta, and each release is built
and tested against one version of it: the `@opencode-ai/plugin` peer dependency in `package.json`.
The CLI of that version is the one known to work:

```bash
npm install -g @opencode-ai/cli@0.0.0-beta-19271
```

Then install the plugin:

```bash
opencode2 plugin add opencode-courier
```

This installs the package from npm and adds `"opencode-courier"` to `plugins` in the global
configuration (`~/.config/opencode/opencode.json`). To receive webhooks, replace that entry with the
object form shown below, which carries a `webhook` option.

### From a local clone

```bash
git clone <this repo> && cd opencode-courier
bun install && npm run build
```

Then list it in `opencode.json` (V2 uses `plugins`, plural). A local plugin path must be a
**directory**; OpenCode loads its `index.js`, and ignores a path to a file with a warning:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-courier/dist"]
}
```

## Receiving webhooks

The receiver is off unless the plugin has a `webhook` option. Put it in the **global** config
(`~/.config/opencode/opencode.json`), since there is one receiver per OpenCode server:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-courier",
      "options": { "webhook": { "port": 4097, "secretFile": "~/.config/opencode/courier-webhook-secret" } }
    }
  ]
}
```

From a local clone, `package` is the path to its `dist` directory instead. `"webhook": true`
takes every default. If the option is given more than once, for example in a project's config as
well, the first location to load wins, and the others log that their settings are ignored.

| Option | Default | |
|---|---|---|
| `port` | `4097` | Port to listen on. |
| `host` | `127.0.0.1` | Address to bind. Only this machine can reach the default. |
| `secretFile` | | File holding the shared secret (`~` is expanded). |
| `secretEnv` | `COURIER_WEBHOOK_SECRET` | Environment variable holding it, when there is no `secretFile`. |
| `maxBytes` | `1048576` | Largest body accepted. |

The secret is never read from `opencode.json` itself (a `secret` key is refused), so the config
can be committed. Make one with `openssl rand -hex 32 > ~/.config/opencode/courier-webhook-secret`
and `chmod 600` it. A file is the safer choice with `opencode2 service start`, whose environment
may not be your shell's. Without a usable secret the receiver does not start, and the server log
says why.

On GitHub, add a webhook to the repository (Settings → Webhooks) with content type
`application/json`, the same secret, and the events you want (pull request reviews, review
comments, issue comments, pull requests, check suites or workflow runs). GitHub must reach the
receiver, and by default it only listens on `127.0.0.1`: forward a public URL to it with a tunnel
you trust (`cloudflared tunnel --url http://127.0.0.1:4097`, `ngrok http 4097`, or
`smee --url https://smee.io/<channel> --target http://127.0.0.1:4097/github`, which needs no
inbound port at all) and use `<public URL>/github` as the payload URL. Whatever you expose, only
signed deliveries are acted on.

The receiver starts when OpenCode loads the plugin, which after a server start happens the first
time a project is used. Until then deliveries fail; GitHub does not retry them on its own, but
lists them under Recent Deliveries with a Redeliver button.

## Using it

1. Keep the background server running so sessions can be woken while you are away
   (`opencode2 service start`; `opencode2 service status` to check).
2. Give the agents that run children the permissions their work needs. A child that hits an
   approval prompt has it passed to its parent, which asks you (see
   [A child that asks for permission](#a-child-that-asks-for-permission)), but the child waits
   until you answer, so keep prompts for what you want to decide yourself. A child's question goes
   to the parent the same way (see [A child that asks a question](#a-child-that-asks-a-question)),
   so let the agents that run children use the `question` tool if they should be able to ask you;
   OpenCode's default agent may.
3. Use `isolate: true` whenever children edit files in parallel. The child's worktree is made
   from the last commit, so an uncommitted `opencode.json` is not there and the child falls back
   to your global config: keep providers and models in the global config, or commit the file.
   When you are done with an isolated child, `courier_cleanup` it so its worktree does not linger.
4. A child that crashes before calling `courier_send` never wakes the parent. When you spawn a
   long-running child, also `courier_later` a check-in for yourself, and `courier_cancel` it when
   the child reports.

## Real models

`e2e/real-model.sh` runs the same live server with a real model and asks the parent to fan a small
task out to two children. It reports which tools the parent called and in what order, whether it
ended its turn instead of polling, whether each child called `courier_send`, and whether each report
woke the idle parent. By default it uses a free model on OpenCode Zen, which needs no key:

```bash
OPENCODE_BIN=$(which opencode2) e2e/real-model.sh
COURIER_MODEL=muse-spark-1.3-contributor-free OPENCODE_BIN=$(which opencode2) e2e/real-model.sh
COURIER_SCENARIO=permission OPENCODE_BIN=$(which opencode2) e2e/real-model.sh
COURIER_SCENARIO=question OPENCODE_BIN=$(which opencode2) e2e/real-model.sh
```

With `COURIER_SCENARIO=permission` it runs the permission relay instead: one child whose command
needs an approval, and the script in the person's place. It checks that the parent asks rather
than answering by itself, answers its question with `once`, and checks that the parent passes that
on with `courier_answer` and the child runs its command and reports.

With `COURIER_SCENARIO=question` it runs the question relay: one child whose task is to find out
from the person which of three greetings to use, without being told how to ask. The script plays
the person in the parent's session. It checks that the child asks with its question tool (or
records that it sent its question with `courier_send` instead), that the parent asks the person
rather than answering by itself, with the child's options, and that the person's answer reaches the
child, which reports it.

On `opencode2 v0.0.0-beta-19271`, `longcat-2.5-preview-free`, `muse-spark-1.3-contributor-free`
and `nemotron-3-ultra-free` complete the fan-out with both reports waking the parent, after the
tool results were tuned to say plainly that the parent should end its turn. How to run it, what
each model did, what was tuned and why: [docs/real-model.md](docs/real-model.md). It costs nothing
on the free models, and it is not part of CI.

## Roadmap

Tracked as [issues](https://github.com/ivopogace/opencode-courier/issues).

## Development

```bash
bun install
bun test           # unit tests, with a fake plugin context
npm run typecheck
npm run build      # emits dist/
OPENCODE_BIN=$(which opencode2) npm run test:e2e   # live test, see below
OPENCODE_BIN=$(which opencode2) e2e/real-model.sh  # with a real model, see Real models
```

`e2e/run.sh` starts a real OpenCode V2 server in a throwaway project and home directory, with this
plugin loaded and `e2e/mock-model.mjs` as the model: an OpenAI-compatible server that replies from
a fixed script, so no API key is needed. It checks that a parent's spawn completes, that the parent
gets a new turn after its own has ended once the child reports (shared and `isolate: true`), that
`courier_status` reports and fails readably, that a child runs on the model its parent was started
with rather than the default one, that a child whose model request is refused is reported to its
idle parent, once and with the error, that a child's permission request (a project rule makes it
ask before one command) wakes its idle parent once, with what it asks for and the choices, that
`courier_status` shows it pending and `courier_answer` passes the answer back, `once` to a shared
child and `reject` to an isolated one, after which the child carries on and reports, that a request
answered in the child's own session gets the parent a message that it is settled and a later
`courier_answer` passes nothing on, that a child's question (the stand-in model calls OpenCode's
question tool) wakes its idle parent once, with the questions, which the parent asks the person in
its own session, that `courier_status` shows it pending, and that the person's answer there reaches
the child: single choice, multi-select, a typed answer (from an isolated child), and through
`courier_answer` from a parent that relabelled the options or reworded the question, which is then
told its answers were not passed on; that answering in the child's session
withdraws the parent's question, that a dismissal on either side is passed to the other, that a
question whose child's turn was interrupted, or both turns, or that was open across a server
restart, still reaches the child with the answer, as a message, and that a question of a child's
child goes to the session at the top; that a `courier_later` message wakes an idle parent
(with its delay sent as a string, as some models send it),
that a cancelled one never arrives, that a pending one is delivered after a server restart, that
`courier_children` lists the two children a parent spawned, before and after that restart, that
a recorded GitHub review delivery (`e2e/fixtures/pull_request_review.json`), signed, wakes an idle
session subscribed with `courier_subscribe`, once, while unsigned and wrongly signed ones are
refused, and that `courier_cleanup` removes an isolated child's clean worktree but keeps one with an
uncommitted file until asked with `force`. Last, it packs the package with `npm pack`, serves the
tarball from a stand-in registry (`e2e/registry.mjs`), installs it with `opencode2 plugin add
opencode-courier` and checks that its tools load from the installed copy. It takes about two
minutes and needs node, npm, bun, git, curl, jq and openssl.

CI (`.github/workflows/ci.yml`) runs both on every push to `main` and every pull request, with the
OpenCode CLI at the same version as the pinned plugin API.

### Releasing

A release starts from GitHub and ends with a maintainer's 2FA approval on npm; no tag needs
creating or pushing by hand. Three workflows under `.github/workflows/` take turns:

1. **Start a release** (Actions → Start a release → Run workflow, from `main`, or
   `gh workflow run release-start.yml -f version=patch`). `version` is `patch`, `minor`, `major`
   or an exact version such as `0.2.0-beta.1`. The workflow bumps `version` in `package.json`,
   checks that the current version is tagged, that the new one is higher and that neither a
   `vX.Y.Z` tag, a `release-X.Y.Z` branch nor npm has it, then pushes the branch `release-X.Y.Z`
   and opens the pull request "Release X.Y.Z".
2. GitHub holds the checks of a pull request that GitHub Actions opened: select **Approve
   workflows to run** in its merge box, review it, and squash-merge it like any other pull
   request (`main` takes nothing else).
3. **Tag the release** runs on every push to `main` that touches `package.json`. When the version
   there has no tag yet, it tags the commit `vX.Y.Z` and dispatches **Release** on that tag. A
   version whose tag exists is left alone, so a push that does not bump the version does nothing.
4. **Release** (`release.yml`), on the tag, runs the CI workflow, checks that the tag matches the
   `version` in `package.json`, builds, and runs `npm stage publish` from the `npm` environment,
   authenticated as the repository variable `NPM_AUTH` says: with the `NPM_TOKEN` secret
   (`token`, the default) or through npm trusted publishing (`oidc`), both below. It adds a
   provenance attestation, which links the package to the workflow run that built it, unless
   `NPM_PROVENANCE` turns it off. A prerelease (`0.2.0-beta.1`) is staged for the `next`
   dist-tag.
5. It then creates a **draft** GitHub release with generated notes (marked as a prerelease for
   one), so nothing is announced yet.
6. A maintainer reviews the staged version and approves it with 2FA: on npmjs.com under Staged
   Packages, or with `npm stage list` and `npm stage approve <id>`. The version is live from then.
7. Publish the draft release: `gh release edit vX.Y.Z --draft=false`, or Publish release on
   GitHub.

Why the tag is dispatched rather than pushed into `on: push: tags`: Tag the release pushes it with
the workflow's `GITHUB_TOKEN`, and GitHub starts no workflow for an event made with that token,
`workflow_dispatch` excepted. The dispatch names the tag as its ref, so `GITHUB_REF` is the tag:
that is what the `npm` environment's `v*` rule and Release's tag check look at, and the rule stays
as it is. A tag pushed by hand still triggers Release as before.

**Dry runs**, to exercise the flow without releasing. Start a release with `dry_run` computes the
bump and shows the diff, pushing nothing. Tag the release with `dry_run` (the default when run by
hand, and it runs on any branch) checks the version and the tag, builds and runs
`npm stage publish --dry-run`, which also refuses a version npm already has; so run it on the
release branch to rehearse a release: `gh workflow run release-tag.yml --ref release-X.Y.Z`.
Release itself takes a `dry_run` on a tag cut with this flow (v0.1.2 onward; earlier tags carry a
`release.yml` without the dispatch trigger), `gh workflow run release.yml --ref vX.Y.Z
-f dry_run=true`: the environment admits the tag, the token is checked in token mode (a missing
one is a warning there), the package is packed and nothing is staged or released.

The flow needs the repository setting **Allow GitHub Actions to create and approve pull requests**
(Settings → Actions → General → Workflow permissions); without it Start a release stops at opening
the pull request. Should a release pull request show neither checks nor the approval banner, close
and reopen it: that is an event a person made, and CI runs on it as on any pull request.

**By hand**, should a step fail. The bump is an ordinary pull request that changes `version` in
`package.json`; once it is merged, Tag the release tags it. If that run failed, tag the merge
commit yourself and the tag push runs Release as it always did:

```bash
git fetch origin && git tag -a vX.Y.Z -m vX.Y.Z origin/main && git push origin vX.Y.Z
```

If the tag exists but Release did not start: `gh workflow run release.yml --ref vX.Y.Z`. If staging
fails, nothing reached npm and the version is still free. Re-running the job reuses the workflow
file at the tag, so after fixing `release.yml` move the tag to the fixed commit instead:
`git push origin :refs/tags/vX.Y.Z`, then tag and push again (or re-run Tag the release on
`main` with `dry_run` off).

Repository variables are set under Settings → Secrets and variables → Actions → Variables, and a
re-run of the job picks a change up without moving the tag.

**The token** (`NPM_AUTH` unset or `token`). `NPM_TOKEN` is a secret of the `npm` environment
(repository Settings → Environments → `npm` → Environment secrets). It holds an npm granular
access token, made on npmjs.com under Access Tokens → Generate New Token → Granular Access Token,
with:

- Packages and scopes: Read and write, for `opencode-courier` only;
- **Bypass two-factor authentication left off.** Such a token can stage a version but not publish
  one, so nothing goes live without a maintainer's 2FA approval, even if the token leaks;
- an expiry date. npm caps how long a token with write access lives; when it has expired or been
  revoked, the job stops at "Check the npm token", and a new token replaces the secret.

Limit the `npm` environment to version tags: under its Deployment branches and tags, choose
Selected branches and tags and add the tag pattern `v*`. Otherwise a workflow on any branch that
names the environment can read the secret. A tag ruleset on `v*` closes the remaining gap, with
two things to know: Tag the release creates the tags with the workflow's token, so a rule that
restricts creation needs the GitHub Actions app in the ruleset's bypass list or the tag push fails;
and a rule against deletion also blocks the move-the-tag recovery above for anyone not in that
list.

If "Check the npm token" passes but staging fails with E403, look at the package's Publishing
access on npmjs.com (the package's Settings): the option that disallows tokens refuses this one
too.

The job stages with `--provenance`, signed through GitHub's OIDC token and Sigstore. Should npm
refuse the attestation, set the repository variable `NPM_PROVENANCE` to `false` and re-run the job,
which then stages without one; any value other than `true` or `false` (in any case) stops the job.

**Trusted publishing** (`NPM_AUTH` set to `oidc`) needs no stored token, but does not work for this
repository yet: npm rejects the immutable OIDC subject claims GitHub issues for repositories
created after 2026-07-15 ([npm/cli#9969](https://github.com/npm/cli/issues/9969)), with `OIDC token
exchange error - package not found`. Once npm fixes that:

1. On npmjs.com, give the package a trusted publisher: this repository, workflow `release.yml`,
   environment `npm`, allowed to stage only.
2. Set the repository variable `NPM_AUTH` to `oidc` and release. In this mode the job does not pass
   `NPM_TOKEN`, so a failed exchange cannot fall back to it: npm falls back to the placeholder
   token setup-node configures and the job fails with E401. Before staging it logs the claims of
   its OIDC token (repository, workflow, environment, ref), so a mismatch with the trusted
   publisher shows, and it stages with `--loglevel verbose`, because npm reports a failed exchange
   only there. Trusted publishing adds the provenance attestation itself.
3. Once a release has been staged that way, revoke the token on npmjs.com and delete the
   `NPM_TOKEN` secret. To go back, set `NPM_AUTH` to `token` or delete the variable.

To stage by hand instead (npm 11.15.0 or later, Node 22.14 or later):

```bash
git checkout vX.Y.Z
npm install && npm run build
npm login
npm stage publish --access public   # add --tag next for a prerelease
```

Approve the staged version with 2FA as above, then create the release:
`gh release create vX.Y.Z --verify-tag --generate-notes` (add `--prerelease` for a prerelease). A
version staged by hand has no provenance attestation.

A prerelease version (`1.2.0-beta.1`) is staged for the `next` dist-tag and its release is marked
as a prerelease. Nothing moves `next` after a stable release, so it can point at an older version
than `latest`; that only matters to someone installing `opencode-courier@next`, and
`npm dist-tag rm opencode-courier next` removes the tag until the next prerelease sets it again.

CI also checks the package as published: `publint` for `package.json` and `exports`, and
`@arethetypeswrong/cli` for the type declarations.

The plugin API is still beta and pinned to an exact version in `package.json`; bump it
deliberately and re-run both test suites.

### Notes on the V2 plugin API

Found while testing against `0.0.0-beta-19271`:

- A plugin tool is only reachable through code mode's `execute` tool unless it is registered with
  `options: { codemode: false }`. The courier tools are direct tools.
- A tool whose result `metadata` holds an `undefined` value never completes: the call stays
  `running` and no error is reported. Results here drop `undefined` keys.
- A plugin cannot add an HTTP route to OpenCode's own server. The nearest thing, `rpc.register`,
  is reached through the authenticated `/api/rpc` endpoint with a JSON envelope, so neither
  GitHub's headers nor the raw body its signature covers would get through. The webhook receiver
  is therefore its own small listener inside the OpenCode process, shared by the plugin's
  per-location instances. It waits for the previous listener to finish closing before it binds,
  as after a plugin reload, and if binding fails, the next instance to load tries again. A plugin's options come from a `{ "package", "options" }` entry in
  `plugins`, which takes a local directory as `package` too.
- OpenCode errors such as `Session.NotFoundError` can arrive with an empty message, so the tools
  rethrow them with the tag and session id.
- OpenCode decodes a tool's input with its own copy of `effect`, not the plugin's, and schema
  checks and transformations from the plugin's copy do not survive that: `Schema.Finite` refuses
  the number `2` ("Expected a finite number"), and `Schema.FiniteFromString` fails with "Cannot
  convert a symbol to a number". Tool inputs use plain schemas and the tools validate the values
  themselves; a unit test keeps it that way.
- `permission.asked` and `permission.replied` reach a plugin's `event.subscribe()`, as
  `session.execution.failed` does. OpenCode keeps pending permission requests per location, and a
  plugin instance's `permission` domain answers from its own location's, so a request of an
  isolated child is answered through the instance loaded in the child's worktree. The plugin keeps
  the domain of every loaded instance and answers through the one that holds the request.
- A permission request rejected without a message ends the asking session's turn ("The user
  declined this tool call"); with a message, only the tool call fails, and its model is told that
  the call could not be run, not the message.
- A plugin can replace the `execute` of any tool, OpenCode's own included, with `tool.transform`
  and the editor's `update` (an id that is missing is ignored). OpenCode's question tool is such a
  tool, `question`, added by a plugin of OpenCode's own that loads before external ones. The
  promise API hands the original `execute` out only as a function returning a promise, run
  without an abort signal, so the call cannot be stopped once started. OpenCode's form service
  withdraws a question's form when the call that asked it is interrupted, and nothing else in the
  plugin API can withdraw or answer a form: the context has no form domain. The question relay
  needs to withdraw a child's question once its parent's answer is in, so the plugin's default
  export is an Effect plugin (`{ id, effect }`): it runs the promise plugin through `fromPromise`
  from `@opencode-ai/plugin/promise/adapter`, which is what OpenCode does with a promise plugin,
  then wraps the question tool with the Effect API, where the original `execute` is an Effect
  that can be raced and interrupted. The plugin's `effect` is the same version as OpenCode's
  (`4.0.0-rc.112` at the pinned version), and Effects of the two copies compose. A plugin loaded
  after this one that replaces `question` as well would drop the relay.
- OpenCode's question tool asks through a form. `form.created` reaches `event.subscribe()` (form
  events are ephemeral, never stored), of every location's plugin instance whichever location the
  form is in, with the form's `metadata.tool.id`, the id of the call; the
  form is created only after the call's permission check has passed. A person dismissing a form
  makes the tool die with `QuestionTool.CancelledError`, which ends the asking session's turn
  ("The user dismissed this question"). Forms live in memory: a restart drops them, and the call
  that asked stays `running` until the session's next turn marks it aborted. When OpenCode closes
  a location, as on a graceful server shutdown, it unloads the plugin there first and then
  withdraws every open form, which looks to the tool exactly like the person dismissing it; the
  relay treats a call that ends after its plugin instance unloaded as cut off, not dismissed.
- OpenCode stops every turn in a project location after 60 minutes without a stored session event
  there (`packages/core/src/location-activity.ts`), which withdraws any question still open. A
  tool call has no timeout of its own.
- `Schema.Number` advertises the strings `"Infinity"`, `"-Infinity"` and `"NaN"` in its JSON
  Schema, so models are offered a string where a number is meant. Some send numbers as strings
  regardless, so `courier_later` takes `delayMinutes` as either.

## License

MIT, see [LICENSE](LICENSE).
