# opencode-courier

[![CI](https://github.com/ivopogace/opencode-courier/actions/workflows/ci.yml/badge.svg)](https://github.com/ivopogace/opencode-courier/actions/workflows/ci.yml)

An [OpenCode](https://github.com/anomalyco/opencode) V2 plugin that lets one session start other
sessions, message them, and be woken by them, without polling.

A parent session calls `courier_spawn`, gets a session id back immediately and ends its turn. The
child works on its own and, when it is done or stuck, calls `courier_send` with the parent's id.
That message lands in the parent's inbox and OpenCode starts a new turn for the parent if it is
idle.

> **Status: early.** Passes an end-to-end test inside a live OpenCode V2 server
> (`opencode2 v0.0.0-beta-19271`) driven by a scripted stand-in model (`e2e/run.sh`); not yet
> tried with a real model.

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
| `courier_spawn` | Creates a session (optionally in its own git worktree with `isolate: true`), sends it the task plus a brief naming the parent and how to report back, and returns at once. |
| `courier_send` | Delivers a message to a session, signed with the sender's id, waking it if idle. |
| `courier_status` | One look at a session: outcome, idle time and last reply. For check-ins, not for waiting. |
| `courier_children` | Lists the sessions this one (or a given `sessionID`) started with `courier_spawn`, each with what `courier_status` reports plus its directory, whether it is isolated and when it was started. |
| `courier_later` | Schedules a message for a session (this one by default) in `delayMinutes` or `at` an ISO time, and returns an id. When due it is delivered like `courier_send`, queued behind any running turn and waking the session if idle. |
| `courier_cancel` | Drops a message scheduled with `courier_later`, e.g. because the child it was waiting for reported first. |
| `courier_subscribe` | Subscribes a session (this one by default) to webhook deliveries for a `topic`: `owner/repo`, `owner/repo#12` (one pull request or issue) or a generic name. Each matching delivery arrives as a message, queued behind any running turn and waking the session if idle. Needs the [webhook receiver](#webhooks). |
| `courier_unsubscribe` | Drops one topic, or all of a session's, e.g. once its pull request is merged. |

### Roster

`courier_spawn` records each child under its parent in the plugin's storage, so a parent that has
lost track after a compaction or a server restart can call `courier_children` to find them again.
A child that can no longer be looked up is still listed, with the error instead of its state.
Entries are dropped 14 days after the child was started, when that parent's roster is read or
the plugin is next loaded. If the roster cannot be written, the child still gets its task and
`courier_spawn` says it is not on the list.

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

Every delivery must carry an `X-Hub-Signature-256` header: `sha256=` followed by the hex
HMAC-SHA256 under the shared secret. For GitHub that is of the raw body, as GitHub sends it. For
`/hook/<name>` it is of the name, a newline and the body, so a captured delivery cannot be sent to
another topic:

```bash
sig=$(printf '%s\n%s' deploys "$body" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)
curl -X POST -H "x-hub-signature-256: sha256=$sig" --data-binary "$body" http://127.0.0.1:4097/hook/deploys
```

A missing or wrong signature gets `401`, and the body is not parsed. The check is constant-time.
Bodies over 1 MiB (`maxBytes`) get `413`. A delivered event gets `202`, with the number of
sessions it reached, which can be 0. The last 1000 accepted signatures are remembered in memory, and
a delivery whose signature was already accepted gets `200 already delivered`. That stops replays of
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

Requires OpenCode V2 (`npm install -g @opencode-ai/cli@beta`, command `opencode2`).

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

To receive webhooks, give the plugin a `webhook` option instead (see below).

Once published to npm, `opencode2 plugin add opencode-courier` installs it and adds it to the
global configuration.

## Receiving webhooks

The receiver is off unless the plugin has a `webhook` option. Put it in the **global** config
(`~/.config/opencode/opencode.json`), since there is one receiver per OpenCode server:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-courier/dist",
      "options": { "webhook": { "port": 4097, "secretFile": "~/.config/opencode/courier-webhook-secret" } }
    }
  ]
}
```

`"webhook": true` takes every default. If the option is given more than once, for example in a
project's config as well, the first location to load wins, and the others log that their settings
are ignored.

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
2. Give the agents that run children permissions that don't need a human; a child waiting on an
   approval prompt never reports back.
3. Use `isolate: true` whenever children edit files in parallel. The child's worktree is made
   from the last commit, so an uncommitted `opencode.json` is not there and the child falls back
   to your global config: keep providers and models in the global config, or commit the file.
4. A child that crashes before calling `courier_send` never wakes the parent. When you spawn a
   long-running child, also `courier_later` a check-in for yourself, and `courier_cancel` it when
   the child reports.

## Roadmap

Tracked as [issues](https://github.com/ivopogace/opencode-courier/issues):

- [#4](https://github.com/ivopogace/opencode-courier/issues/4) **Worktree cleanup** when an
  isolated child finishes.
- [#5](https://github.com/ivopogace/opencode-courier/issues/5) **Smoke test with a real model.**
- [#6](https://github.com/ivopogace/opencode-courier/issues/6) **Publish to npm.**

## Development

```bash
bun install
bun test           # unit tests, with a fake plugin context
npm run typecheck
npm run build      # emits dist/
OPENCODE_BIN=$(which opencode2) npm run test:e2e   # live test, see below
```

`e2e/run.sh` starts a real OpenCode V2 server in a throwaway project and home directory, with this
plugin loaded and `e2e/mock-model.mjs` as the model: an OpenAI-compatible server that replies from
a fixed script, so no API key is needed. It checks that a parent's spawn completes, that the parent
gets a new turn after its own has ended once the child reports (shared and `isolate: true`), that
`courier_status` reports and fails readably, that a `courier_later` message wakes an idle parent,
that a cancelled one never arrives, that a pending one is delivered after a server restart, that
`courier_children` lists the two children a parent spawned, before and after that restart, and that
a recorded GitHub review delivery (`e2e/fixtures/pull_request_review.json`), signed, wakes an idle
session subscribed with `courier_subscribe`, once, while unsigned and wrongly signed ones are
refused. It takes about two minutes and needs node, bun, git, curl, jq and openssl.

CI (`.github/workflows/ci.yml`) runs both on every push to `main` and every pull request, with the
OpenCode CLI at the same version as the pinned plugin API.

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

## License

MIT, see [LICENSE](LICENSE).
