# Development

How to build, test and check a change. [architecture.md](architecture.md) has how the code is laid
out, [plugin-api-notes.md](plugin-api-notes.md) what the host does that it works around, and
[releasing.md](releasing.md) how a release goes out.

## Commands

```bash
bun install
bun run typecheck
bun test           # unit tests, with a fake plugin context
bun run build      # dist/: tsc for the server half and rpc, script/build-tui.ts for tui
# the live suites: install the CLI once, at the version of the pinned plugin API
npm install --prefix <scratch>/oc @opencode/cli@2.0.29
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode npm run test:e2e      # e2e/run.sh, every scenario in one run, no API key
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode E2E_SHARD=2/4 e2e/run.sh   # one of four shards, as a CI job runs it
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode E2E_GROUPS=depth e2e/run.sh  # only the named groups
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/tui.sh            # the TUI part, in tmux
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/real-model.sh     # a real model, not in CI
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/two-servers.sh    # two servers, not in CI
```

## The suites

- **Unit tests** (`bun test`, `test/`) run against a fake plugin context; `test/fixtures/reset.ts`
  clears the process-wide state between them, and `test/fixtures/two-copies.ts` loads two copies of
  the platform. Among them: `test/imports.test.ts` checks the import rules, `test/store.test.ts`
  pins the storage keys and values, `test/links.test.ts` resolves every relative link and anchor in
  the docs, `test/pin.test.ts` keeps the version pins and the versions README names in step, and
  `test/notices.test.ts` snapshots every model-facing string, so a wording change shows up as a diff
  in `test/__snapshots__/` (`bun test --update-snapshots` updates it). `test/tui.test.tsx` and
  `test/inbox.test.tsx` render the TUI part against a fake TUI context with OpenTUI's `testRender`
  (`bunfig.toml` preloads its Solid transform).
- **The live suite** (`e2e/run.sh`) starts a real OpenCode V2 server in a throwaway project and home
  directory, with the plugin loaded from `dist/` and a scripted OpenAI-compatible stand-in model
  (`e2e/mock-model.mjs`), and walks every tool through its behaviour, `opencode plugin add` from a
  stand-in registry included. `e2e/search-plugin` stands in for a web search provider,
  `e2e/probe-plugin` logs the events each location's instance receives, and `e2e/kv.ts` reads, removes
  or sets the plugin's storage keys in OpenCode's database. It needs node, npm, bun, git, curl, jq and
  openssl. New behaviour gets a scenario there.

  The scenarios are in groups, each a `run_<name>` function in `e2e/run.sh` that starts its own parents
  and children and needs no other group, in the order of a full run. `E2E_SHARD=k/n` runs the k-th of
  n shards: the groups are dealt out by the seconds each took in CI (the weights in `SUITE`, which
  you update when a group changes much), the heaviest first onto the lightest shard, and each shard
  keeps the order of a full run. CI runs four, each on its own runner with its own server, mock model
  and stand-in registry. `restart-question` and `roster`, which restart the server, always share a
  shard, and `epilogue`, the check of the server log, runs last in every shard. `E2E_GROUPS=a,b` runs
  the named groups only, to try one while changing it, and `E2E_PLAN=1` prints what a run would go
  through. A new scenario goes into the group it belongs to, or a new group, which then must not rely
  on state another leaves behind: a group that needs an isolated child's worktree starts one, as
  `probe` does. The run ends with the seconds each scenario took, the slowest first.

  The mock model holds a child's reply back by `CHILD_DELAY_MS` (5 s), so the parent's turn has ended
  and it is idle when the reply lands. A scenario that does not depend on that asks for less with
  `child_delay 1000` after its heading (the mock reads the delay from `$E2E_WORK/child-delay` at each
  request; the next heading resets it). A check that something did not happen waits for the event it
  would follow where there is one (`turn_ended`, the stop noted in storage, a message scheduled next
  delivered at the same tick), and sleeps only a second or two where there is none.
- **The TUI suite** (`e2e/tui.sh`) runs the TUI part live, the TUI in `tmux`: the footer entry and the
  RPC behind it, the tree panel, `/courier stop` and the asks inbox, from `dist/` and from the package
  `opencode plugin add` installs.
- **The real-model smoke test** (`e2e/real-model.sh`) runs the same server with a real model, free on
  OpenCode Zen by default, and checks that it uses the tools as meant: [real-model.md](real-model.md).
  Re-run it after any change to a model-facing string: `src/**/text.ts`, `src/kernel/protocol.ts`,
  `src/skill.ts` or a tool description in a `src/**/tools.ts`.
- **Two servers** (`e2e/two-servers.sh`) runs two servers on one data directory:
  [plugin-api-notes.md](plugin-api-notes.md#two-servers-on-one-data-directory).

`KEEP=1` keeps a live script's temp directory and logs; `E2E_WORK` sets where it goes.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request; a new push to a pull
request cancels its running CI:

- **Typecheck, unit tests, build**, then `publint` and `@arethetypeswrong/cli` on the package as
  published.
- **SonarCloud** scans `src/` with the unit coverage and fails when the quality gate does: no new bug,
  vulnerability or unreviewed hotspot, and at least 80% coverage on new code. It runs on `main` and on
  pull requests from this repository, not on a fork's.
- **The live test**, with the CLI at the pinned version: `e2e/run.sh` in four shards and `e2e/tui.sh`,
  five jobs in parallel; a shard's logs and timings are uploaded as `e2e-logs-shard-k` when it fails.
  A pull request that changes only documentation (`README.md`, other Markdown, `docs/**`,
  `.claude/**`) skips both; the unit job, with `test/links.test.ts`, still runs. The job named `Live
  test against OpenCode V2` waits for all of them and fails if any does; it is the one the branch ruleset
  requires, and it passes with both skipped, which a skipped workflow would not.

`.github/workflows/latest.yml` runs the live test once more on the newest `@opencode/cli` release,
with the build still on the pinned plugin API: on every push to `main` and nightly, never on a pull
request. Allowed to fail: a red run is a warning, so a host release that breaks the plugin shows up
here before it reaches a user. Run it by hand with `gh workflow run latest.yml`.

The release workflows (`release-start.yml`, `release-tag.yml`, `release.yml`) run CI again on the
tag: [releasing.md](releasing.md).

## Contributing a change

Feature work goes on a branch and through a pull request with green CI, `Closes #N` in its body. A
change in behaviour comes with unit tests, an `e2e/run.sh` scenario, and its line in README.md or
[docs/reference.md](../reference.md). Every tool is registered with `options: { codemode: false }`,
returns metadata without `undefined` values, and rethrows failures through `describeFailure`
([why](plugin-api-notes.md#tools)).
