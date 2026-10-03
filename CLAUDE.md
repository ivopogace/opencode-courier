# CLAUDE.md

opencode-courier is an OpenCode V2 plugin that lets sessions spawn, message and wake each other
without polling. README.md is the user-facing reference; read it, including "Notes on the V2
plugin API", before changing the plugin.

## Layout

- `src/courier.ts`: spawn, send, status, children. `src/later.ts`: scheduled messages and their
  scheduler. `src/roster.ts`: the children each parent spawned. `src/cleanup.ts`: removing an
  isolated child's worktree. `src/webhook.ts`: the webhook receiver and subscriptions.
  `src/watch.ts`: telling a parent that a child's turn failed. `src/storage.ts`: shared storage
  helpers. `src/index.ts`: the plugin, tool schemas and wiring.
- `test/`: unit tests against a fake plugin context (`bun test`).
- `e2e/run.sh`: live test against a real OpenCode V2 server, driven by `e2e/mock-model.mjs`, a
  scripted OpenAI-compatible stand-in model. New behaviour gets a scenario there.
- `e2e/real-model.sh` (with `e2e/real-model.mjs`): smoke test with a real model, free on OpenCode
  Zen by default; not in CI. Re-run it after changing tool descriptions, results or the child brief;
  `docs/real-model.md` has the results.
- `.github/workflows/ci.yml`: both suites on every push to `main` and every pull request.
  `release-start.yml`, `release-tag.yml` and `release.yml`: the release flow, Releasing in README.md.

## Commands

```bash
bun install
bun run typecheck
bun test
bun run build
# live test: install the CLI once, at the version of the pinned plugin API
npm install --prefix <scratch>/oc2 @opencode-ai/cli@0.0.0-beta-19271
OPENCODE_BIN=<scratch>/oc2/node_modules/.bin/opencode2 npm run test:e2e   # ~2 min, no API key
```

## Rules

- The V2 plugin API is beta and pinned to `@opencode-ai/plugin@0.0.0-beta-19271`. Read its types
  in `node_modules` rather than guessing; the OpenCode source is on the `beta` branch of
  https://github.com/anomalyco/opencode.
- Every tool is registered with `options: { codemode: false }`, returns metadata without
  `undefined` values, and rethrows failures through `describeFailure`.
- Behaviour changes come with unit tests and an e2e scenario, and update README.md.
- Feature work goes on a branch and through a PR with green CI; `Closes #N` in the body.
- Running several issues at once in child sessions: the `courier-wave` skill.
