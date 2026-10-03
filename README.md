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
| `courier_cleanup` | Removes the git worktree of a child started with `isolate: true` and drops the child from `courier_children`. Keeps a worktree with uncommitted changes or commits on no branch, tag or remote and lists them, unless `force: true` is passed. |
| `courier_later` | Schedules a message for a session (this one by default) in `delayMinutes` or `at` an ISO time, and returns an id. When due it is delivered like `courier_send`, queued behind any running turn and waking the session if idle. |
| `courier_cancel` | Drops a message scheduled with `courier_later`, e.g. because the child it was waiting for reported first. |

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
  its detached HEAD end up. A commit on a branch survives the removal, so it does not count.

Commit or branch what you want to keep (`git -C <worktree> branch <name>` keeps its commits), or
call `courier_cleanup` again with `force: true` to discard it. A worktree that is already gone is
just dropped from the list.

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

Once published to npm, `opencode2 plugin add opencode-courier` installs it and adds it to the
global configuration.

## Using it

1. Keep the background server running so sessions can be woken while you are away
   (`opencode2 service start`; `opencode2 service status` to check).
2. Give the agents that run children permissions that don't need a human; a child waiting on an
   approval prompt never reports back.
3. Use `isolate: true` whenever children edit files in parallel. The child's worktree is made
   from the last commit, so an uncommitted `opencode.json` is not there and the child falls back
   to your global config: keep providers and models in the global config, or commit the file.
   When you are done with an isolated child, `courier_cleanup` it so its worktree does not linger.
4. A child that crashes before calling `courier_send` never wakes the parent. When you spawn a
   long-running child, also `courier_later` a check-in for yourself, and `courier_cancel` it when
   the child reports.

## Roadmap

Tracked as [issues](https://github.com/ivopogace/opencode-courier/issues):

- [#2](https://github.com/ivopogace/opencode-courier/issues/2) **Webhook receiver**: turn GitHub
  (or any) webhooks into `courier_send`s.
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
that a cancelled one never arrives, that a pending one is delivered after a server restart, and
that `courier_children` lists the two children a parent spawned, before and after that restart, and
that `courier_cleanup` removes an isolated child's clean worktree but keeps one with an uncommitted
file until asked with `force`. It takes about two minutes and needs node, bun, git, curl and jq.

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
- OpenCode errors such as `Session.NotFoundError` can arrive with an empty message, so the tools
  rethrow them with the tag and session id.

## License

MIT, see [LICENSE](LICENSE).
