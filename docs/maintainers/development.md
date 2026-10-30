# Development

How to build and test a change. The rules a change follows are in [CLAUDE.md](../../CLAUDE.md).
See also [architecture.md](architecture.md), [plugin-api-notes.md](plugin-api-notes.md) and
[releasing.md](releasing.md).

## Commands

```bash
bun install
bun run typecheck
bun test           # unit tests, with a fake plugin context
bun run build      # dist/
# the live suites need the CLI at the pinned plugin API version
npm install --prefix <scratch>/oc @opencode/cli@2.2.3
export OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode
npm run test:e2e                # e2e/run.sh, every scenario, no API key
E2E_SHARD=2/4 e2e/run.sh        # one of four shards, as CI runs it
E2E_GROUPS=depth e2e/run.sh     # only the named groups
e2e/tui.sh                      # the TUI part, in tmux
e2e/real-model.sh               # a real model, not in CI: real-model.md
e2e/two-servers.sh              # two servers on one data directory, not in CI
```

`KEEP=1` keeps a live script's temp directory and logs; `E2E_WORK` sets where it goes.

To try a local build in OpenCode, list the `dist` directory (not a file) in `plugins`:
`"plugins": ["/absolute/path/to/opencode-courier/dist"]`.

## Writing a live scenario

`e2e/run.sh` runs a real OpenCode server in a throwaway home and project, with the plugin from
`dist/` and a scripted stand-in model (`e2e/mock-model.mjs`). It needs node, npm, bun, git, curl, jq
and openssl. New behaviour gets a scenario there.

- Scenarios live in groups, each a `run_<name>` function that starts its own sessions and relies on
  no other group's state. A new scenario goes into its group, or a new one.
- `E2E_SHARD=k/n` deals the groups to shards by the seconds each took in CI (the weights in
  `SUITE`; update them when a group changes much). `restart-question` and `roster` restart the server
  and share a shard. `epilogue`, the server log check, runs last in every shard. `E2E_PLAN=1` prints
  what a run would do.
- The mock model holds a child's reply back 5 s (`CHILD_DELAY_MS`), so the parent is idle when it
  lands. A scenario that does not need that sets `child_delay 1000` after its heading.
- A check that something did not happen waits for the event it would follow (`turn_ended`, a
  message delivered at the same tick). Sleep a second or two only where there is none.

`e2e/kv.ts` reads, removes or sets the plugin's storage keys; `e2e/search-plugin` stands in for a
web search provider; `e2e/probe-plugin` logs the events each instance receives.

## Recording the demo

The README's video is made in two steps, neither in CI:

```bash
OPENCODE_BIN=... script/record-demo.sh demo.cast   # about 4 minutes, in real time
script/render-demo.sh demo.cast                    # demo.mp4, about 6 minutes
```

`record-demo.sh` drives the TUI in `tmux`, scene by scene, on `e2e/tui.sh`'s setup, and writes an
asciicast with a marker per scene and highlight. It needs tmux, jq, curl and what `e2e/tui.sh`
needs. A scene whose screen does not come ends the run, printing that screen.

`render-demo.sh` adds the voice-over (`script/demo-narration.json`, a line per scene, spoken with
Kokoro-82M through `uv`) and the highlights, and scales to 1920×1080. It needs agg, ffmpeg, node, uv
and `fc-match` (or `FONT` and `MONO_FONT`). A narration change needs only the render.

| Setting | Default | |
|---|---|---|
| `COLS`, `ROWS` | `160`, `42` | Terminal size for the recording. |
| `PACE` | `1` | Scales the holds after each step; `0.3` for a quick check. |
| `TYPE_DELAY` | `0.05` | Seconds per typed key. |
| `FONT_SIZE`, `FPS` | `20`, `15` | The render's font size and frame rate. |
| `IDLE` | `3` | The longest pause kept in the cast, in seconds. |

A feature with something to see in the TUI gets a scene in `record-demo.sh` and its line in the
narration. GitHub plays a video only from its own uploads: drag the file into an issue or PR comment
and put the URL it gives on its own line in README.md.

The README's GIF, an orchestrator with two leads and their four workers walked through in the tree
panel, is made the same way, without a voice: each step has a caption under the screen, and each key
pressed shows beside it.

```bash
OPENCODE_BIN=... script/record-gif.sh demo-gif                 # about 2 minutes, in real time
uv run script/render-gif.py demo-gif docs/demo.gif             # about 1 minute
```

`record-gif.sh` shares `script/demo-lib.sh` with `record-demo.sh`, but keeps tmux's own screens,
about twelve a second, rather than a cast, so the render needs no terminal emulator: `render-gif.py`
draws them with Pillow and has ffmpeg encode the GIF. Its scenario is `e2e/mock-model.mjs`'s
`demoTree`; `MOCK_CHILD_DELAY_MS` (`7000`) paces its workers, who report after two to five times it.
The render takes `FONT_SIZE` (`14`), `FPS` (`10`) and `IDLE` (`2.5`), and the fonts as `MONO_FONT`,
`MONO_BOLD_FONT`, `FONT` and `KEY_FONT` (else `fc-match`'s DejaVu Sans Mono, Inter and DejaVu Sans).

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request. The required check
is `Live test against OpenCode V2`: it waits for the four `e2e/run.sh` shards and `e2e/tui.sh`, and
passes when they are skipped. A pull request that changes only Markdown, `docs/**` or `.claude/**`
skips the live jobs; the unit job, with the docs' link check, still runs. SonarCloud fails on a new
bug, vulnerability or unreviewed hotspot, or under 80% coverage on new code.

`latest.yml` runs the live suites on the newest OpenCode release, nightly and on `main`, allowed to
fail. It opens an issue when that release is newer than the pin ([the pin](releasing.md#the-plugin-api-pin)).

`claude.yml` runs a review by Claude Code when an outside contributor opens a pull request, marks it
ready or pushes to it, and when a maintainer comments `@claude review` on one. It reads the diff and CI's
results and runs none of the pull request's code. The outside review runs on `pull_request_target`,
with the secrets, so it checks out the base branch and its tools are only `gh pr`. It needs the repository secret `CLAUDE_CODE_OAUTH_TOKEN`, from
`claude setup-token`, and counts against that subscription's usage limits.
