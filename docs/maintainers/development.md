# Development

How to build, test and check a change. [architecture.md](architecture.md) has how the code is laid
out, [plugin-api-notes.md](plugin-api-notes.md) what the host does that it works around, and
[releasing.md](releasing.md) how a release goes out. The rules a change follows are in
[CLAUDE.md](../../CLAUDE.md).

## Commands

```bash
bun install
bun run typecheck
bun test           # unit tests, with a fake plugin context
bun run build      # dist/: tsc for the server half and rpc, script/build-tui.ts for tui
# the live suites: install the CLI once, at the version of the pinned plugin API
npm install --prefix <scratch>/oc @opencode/cli@2.1.2
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode npm run test:e2e      # e2e/run.sh, every scenario in one run, no API key
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode E2E_SHARD=2/4 e2e/run.sh   # one of four shards, as a CI job runs it
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode E2E_GROUPS=depth e2e/run.sh  # only the named groups
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/tui.sh            # the TUI part, in tmux
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/real-model.sh     # a real model, not in CI
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/two-servers.sh    # two servers, not in CI
bun script/real-model-table.ts [name=]<run-dir>...   # a table per condition from real-model run directories
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode script/record-demo.sh demo.cast   # the README's demo, not in CI
script/render-demo.sh demo.cast                       # demo.mp4, narrated; needs agg, ffmpeg and uv
```

`KEEP=1` keeps a live script's temp directory and logs; `E2E_WORK` sets where it goes.

## The suites

- **Unit tests** (`bun test`, `test/`) run against a fake plugin context; CLAUDE.md names the ones
  that pin the import rules, the storage keys, the docs' links, the version pins and the model-facing
  strings.
- **The live suite** (`e2e/run.sh`) starts a real OpenCode V2 server in a throwaway project and home
  directory, with the plugin loaded from `dist/` and a scripted OpenAI-compatible stand-in model
  (`e2e/mock-model.mjs`), and walks every tool through its behaviour, `opencode plugin add` from a
  stand-in registry included. `e2e/search-plugin` stands in for a web search provider,
  `e2e/probe-plugin` logs the events each location's instance receives, and `e2e/kv.ts` reads,
  removes or sets the plugin's storage keys in OpenCode's database. It needs node, npm, bun, git,
  curl, jq and openssl. New behaviour gets a scenario there.

  The scenarios are in groups, each a `run_<name>` function in `e2e/run.sh` that starts its own
  parents and children and needs no other group, in the order of a full run. `E2E_SHARD=k/n` runs the
  k-th of n shards: the groups are dealt out by the seconds each took in CI (the weights in `SUITE`,
  which you update when a group changes much), the heaviest first onto the lightest shard, each shard
  keeping the order of a full run. CI runs four, each on its own runner with its own server, mock
  model and stand-in registry. `restart-question` and `roster`, which restart the server, always
  share a shard; `archive`, `memory`, `native` and `plugin-add` restart it too, to change an option
  or install the plugin, and need no shard mate. `epilogue`, the check of the server log, runs last
  in every shard. `E2E_GROUPS=a,b` runs the named groups only (it wins over `E2E_SHARD`), and `E2E_PLAN=1` prints what a run would go
  through. A new scenario goes into the group it belongs to, or a new group, which must not rely on
  state another leaves behind: a group that needs an isolated child's worktree starts one, as `probe`
  does. The run ends with the seconds each scenario took, the slowest first.

  The mock model holds a child's reply back by `CHILD_DELAY_MS` (5 s), so the parent's turn has ended
  and it is idle when the reply lands. A scenario that does not depend on that asks for less with
  `child_delay 1000` after its heading (the mock reads the delay from a file in the run's work
  directory at each request; the next heading resets it). A check that something did not happen
  waits for the event it would follow where there is one (`turn_ended`, the stop noted in storage, a
  message scheduled next delivered at the same tick), and sleeps only a second or two where there is
  none.
- **The TUI suite** (`e2e/tui.sh`) runs the TUI part live, the TUI in `tmux`: the footer entry and the
  RPC behind it, the tree panel, `/courier stop`, the asks inbox and the memory view, from `dist/`
  and from the package `opencode plugin add` installs.
- **The real-model smoke test** (`e2e/real-model.sh`) runs the same server with a real model, free on
  OpenCode Zen by default, and checks that it uses the tools as meant: [real-model.md](real-model.md).
  Re-run it after any change to a model-facing string. [`script/real-model-table.ts`](../../script/real-model-table.ts)
  tabulates many runs per condition ([real-model.md](real-model.md#reading-many-runs)).
- **Two servers** (`e2e/two-servers.sh`) runs two servers on one data directory:
  [plugin-api-notes.md](plugin-api-notes.md#two-servers-on-one-data-directory).

## Recording the demo

The video at the top of README.md is made in two steps, neither in CI.

[`script/record-demo.sh`](../../script/record-demo.sh) records it: `e2e/tui.sh`'s server, project and
scripted model, with the TUI in `tmux`, typed into scene by scene the way README.md's
[Demos](../../README.md#demos) lists them, each step waiting for the screen to show what it leads to.
[`script/demo-cast.mjs`](../../script/demo-cast.mjs) writes the pane's output to an asciicast v2 file,
with a marker at the start of each scene and one for each highlight: a step that points at something
on screen (`look`, or `click` on a tree panel row) marks its cells, until the next key. `COLS` and `ROWS` (160×42) size the terminal, `PACE` scales
the holds on each finished step (`PACE=0.3` for a quick check of the scenes), and a scene whose
screen does not come ends the run with that screen printed and the temp directory kept.

[`script/render-demo.sh`](../../script/render-demo.sh) turns the cast into a 1920×1080 `.mp4` with a
voice-over. [`script/demo-narration.json`](../../script/demo-narration.json) holds a line per scene,
keyed by the scene's name (`""` for the opening before the first scene), and the voice;
[`script/demo-timeline.mjs`](../../script/demo-timeline.mjs) caps the cast's pauses at `IDLE` (3 s)
and refuses a narration whose scenes are not the cast's; [`script/demo-voice.py`](../../script/demo-voice.py),
run with `uv`, speaks each line with [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX),
downloaded from Hugging Face on the first run, no key needed; [`agg`](https://github.com/asciinema/agg)
draws the terminal. Each scene's line starts with the scene, and a scene shorter than its line holds
its last frame until the voice ends. Around each highlight the screen is dimmed and the highlight
framed in orange, so the viewer follows what the voice names. It needs agg, ffmpeg, node and uv.

```bash
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode script/record-demo.sh demo.cast
script/render-demo.sh demo.cast   # demo.mp4
```

A new feature with something to see in the TUI gets a scene in `record-demo.sh`, its line in the
narration, and a line in README.md's Demos. GitHub plays a video in Markdown only from its own
uploads, so the finished file is dragged into an issue or PR comment, and README.md carries the URL
GitHub gives it, on a line of its own.

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
  `.claude/**`) skips all of them; the unit job, with `test/links.test.ts`, still runs. The job named
  `Live test against OpenCode V2` waits for all of them and fails if any does; it is the one the
  branch ruleset requires, and it passes with all of them skipped, which a skipped workflow would not.

`.github/workflows/latest.yml` runs the live test once more on the newest `@opencode/cli` release,
with the build still on the pinned plugin API: on every push to `main` and nightly, never on a pull
request, allowed to fail. When that release is newer than the pin, it opens one issue for it,
"OpenCode X.Y.Z is out", saying whether the suites passed ([the pin](releasing.md#the-plugin-api-pin)).
Run it by hand with `gh workflow run latest.yml`.

The release workflows (`release-start.yml`, `release-tag.yml`, `release.yml`) run CI again on the
tag: [releasing.md](releasing.md).
