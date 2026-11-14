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
  `src/skill.ts`: the `courier-orchestrate` skill, the tools' mechanics; planning and reviewing the
  parts is left to the person's own skills.
- `src/kernel/`: what models see of the protocol (`protocol.ts`) and the tool helpers (`tool.ts`).
- `src/platform/`: the process-wide hub, the scheduler loop, OpenCode's event stream, storage helpers.
  Imports nothing outside itself.
- The modules, each imported from outside only through its `index.ts`: `tree/` (the session tree:
  spawn, send, reports, groups, missed wakes, the `context` hook, the tree panel), `person/`
  (permission requests, forms, the question relay) and `scheduling/` (`courier_later`).
  `person/` may import `tree/`; nothing else crosses. Each has `ports.ts`, a pure
  `domain.ts`, `text.ts` (its model-facing strings, pure), `tools.ts`, and one file per use case.
  `tree/store.ts` is the only file that knows its storage keys.
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
npm install --prefix <scratch>/oc @opencode/cli@2.3.0
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode npm run test:e2e   # every scenario in one run, no API key; E2E_SHARD=k/n for a part
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/tui.sh         # the TUI part, needs tmux
```

## Rules

- The plugin API is pinned to `@opencode/plugin@2.3.0` exactly, as devDependency and peer alike, and
  the live test installs `@opencode/cli` at that version. Read the API's types in `node_modules`, and
  OpenCode's source on the `v2` branch of https://github.com/anomalyco/opencode (tagged per release).
  A pin bump follows "The plugin API pin" in `docs/maintainers/releasing.md` and is followed by a
  patch release. Never edit the Supported OpenCode version tables by hand: `script/compat-table.ts`
  generates them.
- Every tool is registered with `options: { codemode: false }`, returns metadata without `undefined`
  values, and rethrows failures through `describeFailure`, except the plain permission decline
  `courier_answer` rethrows as it is.
- A behaviour change comes with unit tests and an e2e scenario, and updates `docs/reference.md`, where
  each behaviour is stated once. README.md stays at about 150 lines: the pitch, install, a short
  how-it-works, the options, the tools table and the demo.
- Docs state how things are now: no history, no "used to", "since #N" or "no longer"; that lives in
  git, PR bodies and release notes.
- After changing a model-facing string (`src/**/text.ts`, `src/kernel/protocol.ts`, `src/skill.ts` or
  a tool description), re-run `e2e/real-model.sh`; its result is not put in a pull request, an issue or a document.
- Keep the provider's prompt cache: a spawned session's role part goes to its `role` instruction
  entry before its first prompt, and is put again only when the session starts its first native
  child while `nativeChildren` is off, which arrives as one instruction update and leaves the cached
  prefix alone; where `context.ts` adds it as a system part instead, it is the same on every
  request. So `courier_spawn` does not gate on the skill being loaded. The skill
  states the root's split rule and the split-line forms on purpose: the root has no brief, its role
  line loses the rule at its first spawn, and a brief can be compacted away.
- Feature work goes on a branch and through a PR with green CI; `Closes #N` in the body.
- No comments, in any file: no line or block comment, no TSDoc, no docstring, no script header. A
  fact about OpenCode or the host goes in docs/maintainers/plugin-api-notes.md, a script's usage in
  docs/maintainers/development.md. Only what a tool reads stays: a shebang, a `# shellcheck` or
  `@ts-expect-error` directive, a `uv` script header, an action pin's `# vX.Y.Z`, a Markdown marker.
- Running several issues at once in child sessions: the `courier-wave` skill.
- Adopting a new OpenCode release (its notes, the pin bump, new host features, retiring what the
  host now does itself): the `opencode-release` skill.
- Repeating the EGM review of the skill until it finds nothing: the `courier-egm-loop` skill.
