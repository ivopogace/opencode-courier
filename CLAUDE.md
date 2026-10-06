# CLAUDE.md

opencode-courier is an OpenCode V2 plugin that lets sessions spawn, message and wake each other
without polling. README.md is the user-facing reference and `docs/reference.md` the long form of the
behaviour; read both, and `docs/plugin-api-notes.md`, before changing the plugin.

## Layout

- `src/courier.ts`: spawn, send, status, children. `src/later.ts`: scheduled messages and their
  scheduler. `src/roster.ts`: the children each parent spawned. `src/cleanup.ts`: removing an
  isolated child's worktree. `src/webhook.ts`: the webhook receiver and subscriptions.
  `src/watch.ts`: following OpenCode's events to tell a parent that a child's turn failed or that it
  waits for a permission. `src/relay.ts`: the permission notices and passing the answer back.
  `src/question.ts`: relaying a child's question, by wrapping OpenCode's `question` tool.
  `src/storage.ts`: shared storage helpers. `src/index.ts`: the plugin (an Effect plugin running
  the promise one), tool schemas and wiring.
- `test/`: unit tests against a fake plugin context (`bun test`).
- `e2e/run.sh`: live test against a real OpenCode V2 server, driven by `e2e/mock-model.mjs`, a
  scripted OpenAI-compatible stand-in model. New behaviour gets a scenario there.
- `e2e/real-model.sh` (with `e2e/real-model.mjs`, `e2e/real-model-permission.mjs` for
  `COURIER_SCENARIO=permission` and `e2e/real-model-question.mjs` for `COURIER_SCENARIO=question`):
  smoke test with a real model, free on OpenCode Zen by default; not in CI. Re-run it after changing tool descriptions, results or the child brief;
  `docs/real-model.md` has the results.
- `.github/workflows/ci.yml`: both suites on every push to `main` and every pull request.
  Its `sonar` job scans `src/` on SonarCloud (`sonar-project.properties`) with the unit coverage,
  on `main` and on this repository's pull requests. The PR bar: no new bug, vulnerability or
  unreviewed hotspot, and at least 80% coverage on new code.
  `release-start.yml`, `release-tag.yml` and `release.yml`: the release flow, `docs/releasing.md`.

## Commands

```bash
bun install
bun run typecheck
bun test
bun run build
# live test: install the CLI once, at the version of the pinned plugin API
npm install --prefix <scratch>/oc @opencode/cli@2.0.23
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode npm run test:e2e   # ~2 min, no API key
```

## Rules

- The V2 plugin API is pinned to an exact version, `@opencode/plugin@2.0.23`, as devDependency and
  as peer dependency alike (the peer picks the copy `opencode plugin add` installs next to the
  plugin, see `docs/plugin-api-notes.md`; a unit test keeps the two equal), and the live test
  installs `@opencode/cli` at that same version; CI runs it once more on the `latest` release,
  allowed to fail. Read the API's types in `node_modules` rather than
  guessing; the OpenCode V2 source is on the `v2` branch of https://github.com/anomalyco/opencode,
  with each release tagged (`v2.0.23`). A pin bump adds a row to README.md's Supported OpenCode
  version table and a section to `docs/plugin-api-notes.md` on what changed.
- Every tool is registered with `options: { codemode: false }`, returns metadata without
  `undefined` values, and rethrows failures through `describeFailure`.
- Behaviour changes come with unit tests and an e2e scenario, and update README.md and
  `docs/reference.md`.
- Feature work goes on a branch and through a PR with green CI; `Closes #N` in the body.
- Running several issues at once in child sessions: the `courier-wave` skill.
