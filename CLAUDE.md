# CLAUDE.md

opencode-courier is an OpenCode V2 plugin that lets sessions spawn, message and wake each other
without polling. README.md is the user-facing reference and `docs/reference.md` the long form of the
behaviour; read both, and `docs/plugin-api-notes.md`, before changing the plugin.

## Layout

`src/`:

- `index.ts`: the plugin, an Effect plugin running the promise one. Builds the ports, registers the
  tools, starts the scheduler, the watcher and the webhook receiver; the Effect half wraps the
  question tool and binds it to its instance's member in the hub.
- `tools.ts`: the twelve courier tools: input schemas, descriptions and results. `skill.ts`: the
  `courier-orchestrate` skill, registered through the skill domain; its text is in `notices.ts`.
- `notices.ts`: every other model-facing string (tool result texts, the child brief, the skill, the
  envelope, the failure, permission, form, question and webhook notices), as pure functions that import
  nothing of the plugin's but `json.ts`. `test/notices.test.ts` snapshots them and the tool
  descriptions, so a wording change shows up as a diff in `test/__snapshots__/`; update it with
  `bun test --update-snapshots` and rerun the real-model smoke test.
- `courier.ts`: spawn, send, status, children. `limits.ts`: the session tree limits `spawn()` checks,
  and the `context` hook naming each spawned session's role and hiding `courier_spawn` from a leaf.
  `report.ts`: whether each spawned session owes its parent a report. `group.ts`: join groups, the
  reports held with them and their delivery from the scheduler's tick. `later.ts`: scheduled
  messages and their delivery. `roster.ts`: the children each parent spawned. `cleanup.ts`:
  removing an isolated child's worktree. `tree.ts`: the subtree under a session, read level by level
  from the roster (`courier_tree`). `stop.ts`: stopping a subtree (`courier_stop`). `webhook.ts`: the webhook receiver and subscriptions.
  `version.ts`: the log line on an OpenCode version other than the pinned one.
- `watch.ts`: following OpenCode's events to tell a parent that a child's turn failed or ended
  without a report, waits for a permission, or shows a form only the person can answer. `relay.ts`: the permission and form
  notices, and passing a permission answer back.
- `question/`: relaying a child's question by wrapping OpenCode's `question` tool. `index.ts` is
  what the rest of the plugin imports; `relay.ts` wraps the tool; `answer.ts` passes an answer on;
  `lifecycle.ts` takes the signals `watch.ts` and `src/index.ts` send (forms shown, shutdowns,
  instances joining, events followed); `shared.ts` the hub's question state and storage keys;
  `pure.ts` the pure parts; `runtime.ts` the copy's own Effect runtime and clock, which tests swap
  for a `TestClock`. Inside the folder the relay is Effect code; what it exports, and the hub's
  shared fields, which copies of other versions use, stay promises and plain functions. Effect
  stays inside the folder.
- `hub.ts`: the plugin's process-wide state in one versioned hub, which instances join with their
  ports and location and leave on unload, and the scheduler's loop, run once per hub and by one
  server per data directory (the owner key `scheduler/owner` in the plugin's storage). The
  version-skew rule is in `docs/reference.md`. `storage.ts`: storage helpers and `processWide`,
  which only `hub.ts` uses. `json.ts`: readers for untyped JSON. `bounded.ts`: the bounded `Set`
  and `Map` of remembered ids; it imports nothing of the plugin's. `test/imports.test.ts` checks
  these import rules.

`test/`: unit tests against a fake plugin context (`bun test`).

`e2e/`: `run.sh` is the live test against a real OpenCode V2 server, driven by `mock-model.mjs`, a
scripted OpenAI-compatible stand-in model, with `search-plugin` as a stand-in web search provider,
`probe-plugin` logging the events each location's instance receives, and `kv.ts` to read, remove or
set the plugin's storage keys in OpenCode's database. New behaviour gets a scenario there.
`two-servers.sh`, not in CI: two servers on one data directory; its findings are in
`docs/plugin-api-notes.md`. `real-model.sh` (with `real-model.mjs`, `real-model-permission.mjs`,
`real-model-question.mjs` and `real-model-recursive.mjs` for `COURIER_SCENARIO=permission`, `question`
and `recursive`): smoke test with a real model, free on OpenCode Zen by default, not in CI. Re-run it
after changing tool descriptions, results, the child brief or the skill; `docs/real-model.md`
describes it and its results.

`.github/workflows/ci.yml`: both suites on every push to `main` and every pull request, and the
live suite once more on the `latest` OpenCode release, allowed to fail. Its `sonar` job scans
`src/` on SonarCloud with the unit coverage and fails when the quality gate does: no new bug,
vulnerability or unreviewed hotspot, and at least 80% coverage on new code. `release-start.yml`,
`release-tag.yml` and `release.yml`: the release flow, `docs/releasing.md`.

## Commands

```bash
bun install
bun run typecheck
bun test
bun run build
# live test: install the CLI once, at the version of the pinned plugin API
npm install --prefix <scratch>/oc @opencode/cli@2.0.26
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode npm run test:e2e   # ~2 min, no API key
```

## Rules

- The V2 plugin API is pinned to an exact version, `@opencode/plugin@2.0.26`, as devDependency and
  as peer dependency alike (the peer picks the copy `opencode plugin add` installs next to the
  plugin, see `docs/plugin-api-notes.md`; a unit test keeps the two equal), and the live test
  installs `@opencode/cli` at that same version. Read the API's types in `node_modules` rather than
  guessing; the OpenCode V2 source is on the `v2` branch of https://github.com/anomalyco/opencode,
  with each release tagged (`v2.0.26`). A pin bump adds a row to README.md's Supported OpenCode
  version table, moves the version README names elsewhere (Quickstart, OpenCode V2 native, the
  install command; a unit test checks them), and adds a section to `docs/plugin-api-notes.md` on
  what changed.
- Every tool is registered with `options: { codemode: false }`, returns metadata without
  `undefined` values, and rethrows failures through `describeFailure`.
- Behaviour changes come with unit tests and an e2e scenario, and update README.md and
  `docs/reference.md`.
- Feature work goes on a branch and through a PR with green CI; `Closes #N` in the body.
- Code comments and TSDoc only where the code cannot say it itself, and at most two lines each.
- Running several issues at once in child sessions: the `courier-wave` skill.
