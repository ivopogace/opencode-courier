# opencode-courier

**Your OpenCode session hands work to other sessions, ends its turn, and is woken when they
report.** Multi-session orchestration for OpenCode V2: spawn child sessions, be woken by them. No
polling.

[![CI](https://github.com/ivopogace/opencode-courier/actions/workflows/ci.yml/badge.svg)](https://github.com/ivopogace/opencode-courier/actions/workflows/ci.yml)
[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=ivopogace_opencode-courier&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=ivopogace_opencode-courier)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=ivopogace_opencode-courier&metric=coverage)](https://sonarcloud.io/summary/new_code?id=ivopogace_opencode-courier)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=ivopogace_opencode-courier&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=ivopogace_opencode-courier)
[![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=ivopogace_opencode-courier&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=ivopogace_opencode-courier)
[![npm](https://img.shields.io/npm/v/opencode-courier)](https://www.npmjs.com/package/opencode-courier)
[![Socket Badge](https://badge.socket.dev/npm/package/opencode-courier)](https://socket.dev/npm/package/opencode-courier)
[![License: MIT](https://img.shields.io/npm/l/opencode-courier)](LICENSE)
[![Supported OpenCode V2 version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fivopogace%2Fopencode-courier%2Fmain%2Fpackage.json&query=%24.peerDependencies%5B%27%40opencode%2Fplugin%27%5D&label=opencode&color=blue)](#supported-opencode-version)

![A parent spawns two slow children, writes a README itself, and is woken by each report](docs/demo-async-tui.gif)

A parent writes a README while two slow children work, and each report wakes it ([the
prompt](#demos)).

## Quickstart

```bash
npm install -g @opencode/cli@2.0.26   # OpenCode V2, at the version courier is tested on
opencode plugin add opencode-courier  # by name, so OpenCode offers new releases
opencode                              # in any folder
```

Paste this prompt:

> Start two helper sessions with courier_spawn and have each report back to you. One runs
> `` `sleep 20; echo $((17 * 23))` ``, the other `` `sleep 40; echo $((2 ** 10))` ``. Do not run the
> commands yourself. When both have reported, reply with one line: RESULTS \<first\> \<second\>

The parent spawns both children and ends its turn. Within a minute the first report starts a new
turn on its own, about 20 seconds later the second does, and the parent replies `RESULTS 391 1024`.
If OpenCode asks to allow a child's command, the parent passes the question to you. Free models
sometimes stall on a request; if nothing moves for a few minutes, send the prompt again. Next:
[Using it](#using-it).

## OpenCode V2 native

Courier is built on OpenCode V2's plugin API (`@opencode/plugin`), not the V1 one
(`@opencode-ai/plugin`), and needs OpenCode V2. Each release is pinned to one V2 version and tested
against it end to end; the current one is tested on **OpenCode 2.0.26**. CI also runs the live
suite on the newest OpenCode release, so a host release that breaks the plugin shows up there
first. Older releases and their versions: [Supported OpenCode version](#supported-opencode-version).

> **Status: early.** Passes an end-to-end test inside a live OpenCode V2 server driven by a
> scripted stand-in model, and a smoke test with real (free) models: see
> [Development](#development).

## Courier or the built-in subagent tool?

OpenCode V2 has its own [`subagent` tool](https://opencode.ai/v2/docs/agents): it starts an agent
with fresh context in a child session, and the parent either waits for its final answer or, with
`background: true`, carries on and is notified when the child finishes. Passing the child's
`sessionID` back sends it another prompt, steering it if it is running and waking it if it is idle.
Use it when one result back is all you need: a search, a review, a self-contained task that needs
nothing from you on the way.

Use courier when the work needs more than one result back. On top of what the built-in tool does,
it adds:

- **Messages from the child, mid-run:** with the built-in tool a child's one message to its parent
  is its final answer. With courier a child reports progress, or asks its parent something,
  whenever it likes with `courier_send`, and any session can message any other.
- **Waking an idle session from anywhere:** a message from a child, a schedule or a webhook starts a
  new turn in a session that has ended its own.
- **Scheduled messages:** `courier_later` wakes a session at a set time, for check-ins and
  reminders.
- **Webhooks:** GitHub reviews, comments and CI runs, or any signed POST, wake the
  [subscribed](#webhooks) session.
- **Worktree isolation:** `isolate: true` gives a child its own git worktree, so children can edit
  files in parallel.
- **Relaying to you:** a child's permission requests and questions reach you through the parent,
  and your answers go back; a form only you can answer is pointed out to you.

## How it works

A parent session calls `courier_spawn`, gets a session id back immediately and ends its turn. The
child works on its own and, when it is done or stuck, calls `courier_send` with the parent's id.
That message lands in the parent's inbox and OpenCode starts a new turn for the parent if it is
idle. A child whose turn fails instead, so that it cannot report, is reported by the plugin, and a
child that waits for a permission or asks a question has it passed to the parent, who asks you and
passes your answer back. A child that waits on a form only you can answer, such as OpenCode asking
which web search provider to use, has its parent told so.

There is no polling anywhere: a message is admitted into the target session's inbox through
OpenCode's own API, which wakes the session, the same way OpenCode's background subagents report to
their parent. Delivery is `steer` by default (injected into the target's running turn, or starts
one if idle); `queue: true` waits until the current turn ends.

## Demos

**The parent does not wait.** Prompt: *"Spawn two children: one runs `sleep 30` then lists the
exports of math.js, the other runs `sleep 45` then lists the exports of text.js. Don't wait for
them: meanwhile write a short README.md for this folder yourself, and add their reports to it when
they arrive."*

The recording at the top is this run. Watch the parent write its README and finish its turn 16
seconds in, while both children still sleep. Each report then starts a new turn on its own (the
`Message from ses_…` line is the child's message): the first after about 30 seconds, the second
after about 45, and the parent folds each into the README and cancels the check-in it had scheduled
for itself.

**A child's question reaches you.** Prompt: *"Spawn a child session to add a multiply function to
math.js. It must ask me first whether to name it multiply, times or product."*

![A child's question opens as a form in the parent's session, times is picked, and the child carries on](docs/demo-question-tui.gif)

Watch the child's question open in the parent's session as OpenCode's own question form, where
`times` is picked. The parent passes it back, and the child adds `times` to math.js and reports.

Both recordings are real runs with a free model on [OpenCode Zen](https://opencode.ai/zen) (Muse
Spark 1.3).

## Install

### Supported OpenCode version

Requires OpenCode V2: the `opencode` command from `@opencode/cli` (also installed as `opencode2`,
the name of the beta line). Each release of this plugin is built and tested against exactly one
OpenCode V2 version, and a release that moves the pin adds a row here. OpenCode itself never
checks the version: the plugin installs and loads on any V2 host. When it loads on a version other
than the pinned one, it writes one line to the server log naming both versions, so a mismatch is
named before a tool fails. More in [the reference](docs/reference.md#the-opencode-version).

| opencode-courier | OpenCode V2 (`opencode` and `@opencode/plugin`) |
|---|---|
| 0.2.3 | 2.0.26 |
| 0.2.2 | 2.0.24 |
| 0.2.1 | 2.0.23 |
| 0.2.0 | 2.0.22 |
| 0.1.6 | 0.0.0-beta-19271 (the beta line: `opencode2` from `@opencode-ai/cli`, and `@opencode-ai/plugin`) |

Check yours with `opencode --version`, and install the matching CLI with:

```bash
npm install -g @opencode/cli@2.0.26
```

### The plugin

```bash
opencode plugin add opencode-courier
```

This installs the package from npm and adds `"opencode-courier"` to `plugins` in the global
configuration (`~/.config/opencode/opencode.json`). To receive webhooks, replace that entry with the
object form shown under [Webhooks](#webhooks), which carries a `webhook` option.

Install it by name, without a version: OpenCode only checks plugins for updates when their entry is
not an exact version, so `opencode-courier@0.2.1` is never offered a newer release. How to move an
entry that carries a version to the name, and what to look at when an update still does not show:
[Updating the plugin](docs/reference.md#updating-the-plugin).

### From a local clone

```bash
git clone https://github.com/ivopogace/opencode-courier && cd opencode-courier
bun install && npm run build
```

Then list it in `opencode.json` (V2 uses `plugins`, plural). A local plugin path must be a
**directory**; OpenCode loads its `index.js`, and ignores a path to a file with a warning:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-courier/dist"]
}
```

## Using it

1. Keep the background server running so sessions can be woken while you are away (`opencode
   service start`; `opencode service status` to check).
2. Give the agents that run children the permissions their work needs. A child that hits an approval
   prompt has it passed to its parent, which asks you, but the child waits until you answer, so keep
   prompts for what you want to decide yourself. A child's question goes to the parent the same
   way, so let the agents that run children use the `question` tool if they should be able to ask
   you; OpenCode's default agent may. Choose a web search provider before children search the web
   (run one web search in your own session and answer OpenCode's prompt, or use its "Third-party
   search" setting): otherwise the first child to search shows that prompt in its own session,
   which only you can answer there.
3. Use `isolate: true` whenever children edit files in parallel. The child's worktree is made from
   the last commit, so an uncommitted `opencode.json` is not there and the child falls back to your
   global config: keep providers and models in the global config, or commit the file. When you are
   done with an isolated child, `courier_cleanup` it so its worktree does not linger.
4. A child that crashes before calling `courier_send` never wakes the parent. When you spawn a
   long-running child, also `courier_later` a check-in for yourself, and `courier_cancel` it when
   the child reports.

## Tools

| Tool | Does |
|---|---|
| `courier_spawn` | Creates a session (optionally in its own git worktree with `isolate: true`) on the parent's model, sends it the task plus a brief naming the parent and how to report back, and returns at once. |
| `courier_send` | Delivers a message to a session, signed with the sender's id, waking it if idle. |
| `courier_status` | One look at a session: outcome, idle time, last reply and the permission requests and questions it waits on. For check-ins, not for waiting. |
| `courier_children` | Lists the sessions this one (or a given `sessionID`) started with `courier_spawn`, each with what `courier_status` reports plus its directory, whether it is isolated and when it was started. |
| `courier_cleanup` | Removes the git worktree of a child started with `isolate: true` and drops the child from `courier_children`. Keeps a worktree with uncommitted changes or commits on no branch, tag or remote and lists them, unless `force: true` is passed ([reference](docs/reference.md#worktree-cleanup)). |
| `courier_answer` | Passes your answer to a permission request or a question that a session started from this one waits on: `reply` (`once`, `always` or `reject`, with an optional `message`) for a permission request, `answers` for a question. |
| `courier_later` | Schedules a message for a session (this one by default) in `delayMinutes` or `at` an ISO time, and returns an id. When due it is delivered like `courier_send`, queued behind any running turn and waking the session if idle. |
| `courier_cancel` | Drops a message scheduled with `courier_later`, e.g. because the child it was waiting for reported first. |
| `courier_subscribe` | Subscribes a session (this one by default) to webhook deliveries for a `topic`: `owner/repo`, `owner/repo#12` (one pull request or issue) or a generic name. Each matching delivery arrives as a message, queued behind any running turn and waking the session if idle. Needs the [webhook receiver](#webhooks). |
| `courier_unsubscribe` | Drops one topic, or all of a session's, e.g. once its pull request is merged. |

## How children reach you

The short version; the long one, with every edge, is [docs/reference.md](docs/reference.md).

- **A child runs on its parent's model**, not on OpenCode's default, so a parent you moved to
  another model starts children that can reach theirs too. An `agent` with a model of its own keeps
  it. [More](docs/reference.md#the-childs-model).
- **A child that fails** cannot report, so the plugin does: every failed turn of a spawned session
  sends its parent a message marked `failed="<error type>"`, with the error, waking it if idle.
  [More](docs/reference.md#a-child-that-fails).
- **A child that asks for permission** has the request passed to the session at the top, with what
  it asks for and the choices OpenCode offers (`once`, `always`, `reject`). That session asks you
  and answers with `courier_answer`; the child carries on.
  [More](docs/reference.md#a-child-that-asks-for-permission).
- **A child that asks a question** with OpenCode's question tool has it shown in the top session.
  When that session asks you the same question, your answer goes to the child's waiting call as if
  you had answered there. Whichever answer reaches the child first counts, in its session, in the
  parent's or by `courier_answer`, and the other question is withdrawn; a question stays answerable
  across an interrupted turn or a server restart.
  [More](docs/reference.md#a-child-that-asks-a-question).
- **A child that shows a form** the plugin cannot pass on, such as OpenCode's web search asking
  for a provider, has the top session told, marked `asks="form"`, with the form's choices: only you
  can answer it, in the child's session. [More](docs/reference.md#a-child-that-shows-a-form).
- **The plugin remembers.** Each parent's children (`courier_children`), pending `courier_later`
  messages and open questions survive a compaction or a restart; entries are dropped after 14 days.
  [Roster](docs/reference.md#roster), [Scheduled messages](docs/reference.md#scheduled-messages).
- **One OpenCode server per data directory, preferably.** A second server on the same one, such as
  `opencode serve` next to `opencode service`, shares the plugin's storage: one of the two delivers
  `courier_later` messages, but a child's permission request can only be answered from the server
  that runs the child. [More](docs/reference.md#two-servers-on-one-data-directory).
- **Worktrees are yours to remove.** An isolated child's worktree is kept until `courier_cleanup`,
  which refuses to drop uncommitted changes or unbranched commits unless told to.
  [More](docs/reference.md#worktree-cleanup).

## Webhooks

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

From a local clone, `package` is the path to its `dist` directory instead. `"webhook": true` takes
every default. If the option is given more than once, for example in a project's config as well, the
first location to load wins, and the others log that their settings are ignored.

| Option | Default | |
|---|---|---|
| `port` | `4097` | Port to listen on. |
| `host` | `127.0.0.1` | Address to bind. Only this machine can reach the default. |
| `secretFile` | | File holding the shared secret (`~` is expanded). |
| `secretEnv` | `COURIER_WEBHOOK_SECRET` | Environment variable holding it, when there is no `secretFile`. |
| `maxBytes` | `1048576` | Largest body accepted. |

The secret is never read from `opencode.json` itself (a `secret` key is refused), so the config can
be committed. Make one with `openssl rand -hex 32 > ~/.config/opencode/courier-webhook-secret` and
`chmod 600` it. A file is the safer choice with `opencode service start`, whose environment may not
be your shell's. Without a usable secret the receiver does not start, and the server log says why.

On GitHub, add a webhook to the repository (Settings → Webhooks) with content type
`application/json`, the same secret, and the events you want (pull request reviews, review comments,
issue comments, pull requests, check suites or workflow runs). GitHub must reach the receiver, and
by default it only listens on `127.0.0.1`: forward a public URL to it with a tunnel you trust
(`cloudflared tunnel --url http://127.0.0.1:4097`, `ngrok http 4097`, or `smee --url
https://smee.io/<channel> --target http://127.0.0.1:4097/github`, which needs no inbound port at
all) and use `<public URL>/github` as the payload URL. Whatever you expose, only signed deliveries
are acted on.

The receiver starts when OpenCode loads the plugin, which after a server start happens the first
time a project is used. Until then deliveries fail; GitHub does not retry them on its own, but lists
them under Recent Deliveries with a Redeliver button.

Once it runs, `courier_subscribe` ties a session to a topic and every matching delivery arrives as a
message, queued behind any running turn and waking the session if idle:

- `POST /github` takes GitHub webhook deliveries: reviews, comments, pull requests and issues being
  opened, closed or merged, and completed CI runs reach the sessions subscribed to `owner/repo#N`
  and `owner/repo`; other events with a repository reach `owner/repo`.
- `POST /hook/<name>` takes anything else, for sessions subscribed to `<name>`: a JSON body's
  `text`, `summary` or `message` field, otherwise the body itself.

Every delivery must be signed (`X-Hub-Signature-256`, HMAC-SHA256 under the shared secret), replays
are refused, and what a session sees is a short summary marked as outside text. Which events wake
whom, the signing scheme for `/hook/<name>`, limits and status codes: [the
reference](docs/reference.md#webhooks).

## Development

```bash
bun install
bun test           # unit tests, with a fake plugin context
npm run typecheck
npm run build      # emits dist/
OPENCODE_BIN=$(which opencode) npm run test:e2e   # live test, about two minutes, no API key
OPENCODE_BIN=$(which opencode) e2e/real-model.sh  # smoke test with a real model, not in CI
```

The live test (`e2e/run.sh`) starts a real OpenCode V2 server in a throwaway project and home
directory, with this plugin loaded and a scripted OpenAI-compatible stand-in model, and walks every
tool through the behaviour above. It needs node, npm, bun, git, curl, jq and openssl. New behaviour
gets a scenario there.

The smoke test (`e2e/real-model.sh`) runs the same server with a real model (by default a free one
on [OpenCode Zen](https://opencode.ai/zen), no key needed) and checks that the parent spawns instead
of doing the work, ends its turn instead of polling, and is woken by each report;
`COURIER_SCENARIO=permission` and `COURIER_SCENARIO=question` exercise the two relays. Which models
pass and what was tuned for them: [docs/real-model.md](docs/real-model.md).

CI runs both suites on every push to `main` and every pull request, with the OpenCode CLI at the
pinned version, and the live suite once more on the newest OpenCode release, where a failure warns
rather than breaks the build. SonarCloud scans `src/` on `main` and on pull requests. Releases start
from GitHub and end with a maintainer's 2FA approval on npm: [docs/releasing.md](docs/releasing.md).
What the plugin API does that the plugin had to work around: [docs/plugin-api-notes.md](docs/plugin-api-notes.md).

## Contributing

Questions and bug reports go to the [issues](https://github.com/ivopogace/opencode-courier/issues).
Pull requests are welcome: a change in behaviour comes with a unit test, an `e2e/run.sh` scenario
and its line in this README or [docs/reference.md](docs/reference.md), and CI must be green.

## License

MIT, see [LICENSE](LICENSE).
