# opencode-courier

[![CI](https://github.com/ivopogace/opencode-courier/actions/workflows/ci.yml/badge.svg)](https://github.com/ivopogace/opencode-courier/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode-courier)](https://www.npmjs.com/package/opencode-courier)
[![Socket Badge](https://badge.socket.dev/npm/package/opencode-courier)](https://socket.dev/npm/package/opencode-courier)
[![License: MIT](https://img.shields.io/npm/l/opencode-courier)](LICENSE)
[![Supported OpenCode V2 version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fivopogace%2Fopencode-courier%2Fmain%2Fpackage.json&query=%24.peerDependencies%5B%27%40opencode%2Fplugin%27%5D&label=opencode&color=blue)](#supported-opencode-version)

An [OpenCode](https://github.com/anomalyco/opencode) V2 plugin that lets one session start other
sessions, message them, and be woken by them, without polling.

A parent session calls `courier_spawn`, gets a session id back immediately and ends its turn. The
child works on its own and, when it is done or stuck, calls `courier_send` with the parent's id.
That message lands in the parent's inbox and OpenCode starts a new turn for the parent if it is
idle. A child whose turn fails instead, so that it cannot report, is reported by the plugin, and a
child that waits for a permission or asks a question has it passed to the parent, who asks you and
passes your answer back.

> **Status: early.** Passes an end-to-end test inside a live OpenCode V2 server driven by a
> scripted stand-in model, and a smoke test with real (free) models: see
> [Development](#development).

**The parent does not wait.** Prompt: *"Spawn two children: one runs `sleep 30` then lists the
exports of math.js, the other runs `sleep 45` then lists the exports of text.js. Don't wait for
them: meanwhile write a short README.md for this folder yourself, and add their reports to it when
they arrive."*

![A parent spawns two slow children, writes a README itself, and is woken by each report](docs/demo-async-tui.gif)

Watch the parent write its README and finish its turn 16 seconds in, while both children still
sleep. Each report then starts a new turn on its own (the `Message from ses_…` line is the child's
message): the first after about 30 seconds, the second after about 45, and the parent folds each
into the README and cancels the check-in it had scheduled for itself.

**A child's question reaches you.** Prompt: *"Spawn a child session to add a multiply function to
math.js. It must ask me first whether to name it multiply, times or product."*

![A child's question opens as a form in the parent's session, times is picked, and the child carries on](docs/demo-question-tui.gif)

Watch the child's question open in the parent's session as OpenCode's own question form, where
`times` is picked. The parent passes it back, and the child adds `times` to math.js and reports.

<details>
<summary>The same two runs in OpenCode's web UI</summary>

![The async demo in the web UI: the parent writes its README, ends its turn, and is woken by each report](docs/demo-async.gif)

![The question demo in the web UI: the child's question appears in the parent, is answered there, and the child carries on](docs/demo-question.gif)

</details>

Both recordings are real runs on `opencode2 v0.0.0-beta-19271` with a free model on [OpenCode
Zen](https://opencode.ai/zen) (Muse Spark 1.3).

## How the wake works

There is no polling anywhere. `courier_send` calls the plugin API's `session.synthetic`, which
admits a message into the target session's inbox and, unless `resume: false` is passed, calls
`execution.wake` on it (`packages/core/src/session/session.ts` on OpenCode's `v2` branch).
OpenCode's own background subagents report to their parent the same way
(`packages/core/src/session/subagent-completion.ts`).

Delivery is `steer` by default (injected into the target's running turn, or starts one if idle);
`queue: true` waits until the current turn ends.

## Install

### Supported OpenCode version

Requires OpenCode V2: the `opencode` command from `@opencode/cli` (the same binary is also installed
as `opencode2`, the name of the beta line, so a shell that still calls that keeps working). Each
release of this plugin is built and tested against exactly one OpenCode V2 version, the
`@opencode/plugin` version pinned in `package.json` (the CLI and the plugin API share a version).
The end-to-end suite runs on that version with every change, and once more on the newest
`@opencode/cli` release, where a failure is a warning rather than a red build, so a host release
that breaks the plugin shows up in CI first. A newer OpenCode may still break tools;
[docs/plugin-api-notes.md](docs/plugin-api-notes.md) lists what the pinned version already needed
working around, and what changed the last time the pin moved. A release that moves the pin adds a
row here. When the plugin loads on an OpenCode whose version is not the pinned one, it writes one
line to the server log naming both versions, so a mismatch is named before a tool fails.

| opencode-courier | OpenCode V2 (`opencode` and `@opencode/plugin`) |
|---|---|
| 0.2.0 | 2.0.22 |
| 0.1.6 | 0.0.0-beta-19271 (the beta line: `opencode2` from `@opencode-ai/cli`, and `@opencode-ai/plugin`) |

0.2.0 was tested on 2.0.22 and on the `dev` build 0.0.0-dev-20534 of 2026-10-04, the newest build
then (no 2.x release above 2.0.22 existed), where the suite passed too. Of the older hosts tried, it
loads on 2.0.4 and 2.0.21 (nothing in between was run, and the suite was not), and fails to load on
2.0.0 and 2.0.3, which lack the `model` domain the plugin API gained in 2.0.4. The version in
`package.json` protects nobody on its own: OpenCode says nothing about it, since
`opencode plugin add` installs the plugin whatever your OpenCode version and its loader warns about
nothing either (a recorded experiment, in
[docs/plugin-api-notes.md](docs/plugin-api-notes.md#what-plugin-add-and-loading-do-with-the-peer-dependency-2026-10-04),
which also says why the peer dependency stays exact rather than a range: it picks the copy of the
plugin API the plugin runs on). The plugin's own log line above is the only runtime signal, apart
from the load failure on those hosts before 2.0.4. Check yours with `opencode --version`, and
install the matching CLI with:

```bash
npm install -g @opencode/cli@2.0.22
```

### The plugin

Then install the plugin:

```bash
opencode plugin add opencode-courier
```

This installs the package from npm and adds `"opencode-courier"` to `plugins` in the global
configuration (`~/.config/opencode/opencode.json`). To receive webhooks, replace that entry with the
object form shown under [Webhooks](#webhooks), which carries a `webhook` option.

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

## Using it

1. Keep the background server running so sessions can be woken while you are away (`opencode
   service start`; `opencode service status` to check).
2. Give the agents that run children the permissions their work needs. A child that hits an approval
   prompt has it passed to its parent, which asks you (see [A child that asks for
   permission](docs/reference.md#a-child-that-asks-for-permission)), but the child waits until you
   answer, so keep prompts for what you want to decide yourself. A child's question goes to the
   parent the same way (see [A child that asks a
   question](docs/reference.md#a-child-that-asks-a-question)), so let the agents that run children
   use the `question` tool if they should be able to ask you; OpenCode's default agent may.
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
| `courier_cleanup` | Removes the git worktree of a child started with `isolate: true` and drops the child from `courier_children`. Keeps a worktree with uncommitted changes or commits on no branch, tag or remote and lists them, unless `force: true` is passed. |
| `courier_answer` | Passes the person's answer to a permission request or a question that a session started from this one waits on, after the plugin relayed it here: `reply` (`once`, `always` or `reject`, with an optional `message`) for a permission request, `answers` for a question. See [A child that asks for permission](docs/reference.md#a-child-that-asks-for-permission) and [A child that asks a question](docs/reference.md#a-child-that-asks-a-question). |
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
  you had answered there; a question stays answerable across an interrupted turn or a server
  restart. [More](docs/reference.md#a-child-that-asks-a-question).
- **The plugin remembers.** Each parent's children (`courier_children`), pending `courier_later`
  messages and open questions survive a compaction or a restart; entries are dropped after 14 days.
  [Roster](docs/reference.md#roster), [Scheduled messages](docs/reference.md#scheduled-messages).
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

`e2e/run.sh` starts a real OpenCode V2 server in a throwaway project and home directory, with this
plugin loaded and `e2e/mock-model.mjs` as the model: an OpenAI-compatible server that replies from a
fixed script. It walks every tool through the behaviour above, including a permission request, a
question answered on either side, a server restart with pending work, a signed and an unsigned
GitHub delivery, and the package installed from a stand-in npm registry. It needs node, npm, bun,
git, curl, jq and openssl. New behaviour gets a scenario there.

`e2e/real-model.sh` runs the same server with a real model (by default a free one on [OpenCode
Zen](https://opencode.ai/zen), no key needed) and asks the parent to fan a small task out to two
children; `COURIER_SCENARIO=permission` and `COURIER_SCENARIO=question` exercise the two relays with
the script in the person's place. It checks that the parent spawns instead of doing the work, ends
its turn instead of polling, and that each report wakes it. Which models pass and what was tuned for
them: [docs/real-model.md](docs/real-model.md).

CI (`.github/workflows/ci.yml`) runs both suites on every push to `main` and every pull request,
with the OpenCode CLI at the same version as the pinned plugin API, and the live suite once more
with the CLI at its `latest` dist-tag: that job may fail, and its step summary names the version it
ran on, so a host release that breaks the plugin is seen without blocking the build. Releases start from GitHub and
end with a maintainer's 2FA approval on npm: [docs/releasing.md](docs/releasing.md). What the plugin
API does that the plugin had to work around, and what changed when the pin last moved:
[docs/plugin-api-notes.md](docs/plugin-api-notes.md).

## Contributing

Questions and bug reports go to the [issues](https://github.com/ivopogace/opencode-courier/issues).
Pull requests are welcome: a change in behaviour comes with a unit test, an `e2e/run.sh` scenario
and its line in this README or [docs/reference.md](docs/reference.md), and CI must be green.
Maintainers release from GitHub as [docs/releasing.md](docs/releasing.md) describes.

## License

MIT, see [LICENSE](LICENSE).
