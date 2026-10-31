# CLAUDE.md

opencode-courier is an OpenCode V2 plugin that lets sessions spawn, message and wake each other
without polling. Before changing the plugin, read README.md (the user-facing reference),
`docs/reference.md` (the long form of the behaviour) and `docs/maintainers/plugin-api-notes.md` (the
host's traps). `docs/maintainers/` also has `architecture.md` (modules, import rules, storage keys,
the hub), `development.md` (commands, suites, CI), `real-model.md` and `releasing.md`.

## Layout

- `src/index.ts`: the server plugin and its composition root (tools, tick jobs, event modules, the
  `Waits` port). The only file that imports more than one module's `index.ts`.
- `src/tui.tsx` and `src/rpc.ts`: the TUI and RPC entrypoints, never imported by the server half.
  `src/skill.ts`: the `courier-orchestrate` skill.
- `src/kernel/`: what models see of the protocol (`protocol.ts`) and the tool helpers (`tool.ts`).
- `src/platform/`: the process-wide hub, the scheduler loop, OpenCode's event stream, storage helpers.
  Imports nothing outside itself.
- The modules, each imported from outside only through its `index.ts`: `tree/` (the session tree:
  spawn, send, reports, groups, missed wakes, the `context` hook, the tree panel), `person/`
  (permission requests, forms, the question relay), `scheduling/` (`courier_later`), `webhook/` and
  `memory/`. `person/` and `memory/` may import `tree/`; nothing else crosses. Each has `ports.ts`,
  a pure `domain.ts`, `text.ts` (its model-facing strings, pure), `tools.ts`, and one file per use case.
  `tree/store.ts` and `memory/store.ts` are the only files that know their storage keys.
- `test/`: unit tests against a fake plugin context. `imports.test.ts` enforces the import rules;
  `notices.test.ts` snapshots every `text.ts`, the skill and the tools' descriptions and schemas
  (`bun test --update-snapshots`); `links.test.ts` resolves every Markdown link.
- `e2e/run.sh`: the live suite against a real OpenCode server and `mock-model.mjs`, a scripted model,
  in groups named in its `SUITE`. `tui.sh`: the TUI in tmux. `real-model.sh`: a smoke test with a
  real model, not in CI.
- `.github/workflows/ci.yml` runs the unit, live (four shards), TUI and SonarCloud jobs on every pull
  request; `latest.yml` runs the live suite on OpenCode's latest release and opens an issue for a
  newer one.

## Commands

```bash
bun install
bun run typecheck
bun test
bun run build      # dist/: tsc for the server half and rpc, script/build-tui.ts for tui
bun script/compat-table.ts --check   # the version tables against the release tags (git fetch --tags)
# live test: install the CLI once, at the version of the pinned plugin API
npm install --prefix <scratch>/oc @opencode/cli@2.2.5
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode npm run test:e2e   # every scenario in one run, no API key; E2E_SHARD=k/n for a part
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/tui.sh         # the TUI part, needs tmux
```

## Rules

- The plugin API is pinned to `@opencode/plugin@2.2.5` exactly, as devDependency and peer alike, and
  the live test installs `@opencode/cli` at that version. Read the API's types in `node_modules`, and
  OpenCode's source on the `v2` branch of https://github.com/anomalyco/opencode (tagged per release).
  A pin bump moves the version README names and the exact `effect` to the one the new plugin depends
  on, moves `@opentui/core`, `@opentui/solid`, `solid-js` and `@opencode/theme` to OpenCode's root
  catalog at the new tag (devDependencies, never peers), re-checks the traps in
  `plugin-api-notes.md`, and is followed by a patch release. Never edit the Supported OpenCode version
  tables by hand: `script/compat-table.ts` generates them.
- Every tool is registered with `options: { codemode: false }`, returns metadata without `undefined`
  values, and rethrows failures through `describeFailure`, except the plain permission decline
  `courier_answer` rethrows as it is.
- A behaviour change comes with unit tests and an e2e scenario, and updates `docs/reference.md`, where
  each behaviour is stated once. README.md stays at about 150 lines: the pitch, install, a short
  how-it-works, the options, the tools table and the demo.
- After changing a model-facing string (`src/**/text.ts`, `src/kernel/protocol.ts`, `src/skill.ts` or
  a tool description), re-run `e2e/real-model.sh` and update its table in `real-model.md`.
- Keep the provider's prompt cache: a spawned session's role part goes to its `role` instruction
  entry once, before its first prompt; where `context.ts` adds it as a system part instead, it is the
  same on every request. So `courier_spawn` does not gate on the skill being loaded. The skill
  repeats the brief's split rule on purpose: the root has no brief.
- Feature work goes on a branch and through a PR with green CI; `Closes #N` in the body.
- Code comments and TSDoc only where the code cannot say it itself, at most two lines each.
- Running several issues at once in child sessions: the `courier-wave` skill.
