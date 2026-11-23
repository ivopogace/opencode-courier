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
npm install --prefix <scratch>/oc @opencode/cli@2.4.1
export OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode
npm run test:e2e                # e2e/run.sh, every scenario, no API key
E2E_SHARD=2/4 e2e/run.sh        # one of four shards, as CI runs it
E2E_GROUPS=depth e2e/run.sh     # only the named groups
e2e/tui.sh                      # the TUI part, in tmux
e2e/real-model.sh               # a real model, not in CI: real-model.md
e2e/two-servers.sh              # two servers on one data directory, not in CI
```

`KEEP=1` keeps a live script's temp directory and logs; `E2E_WORK` sets where it goes. `ROUNDS`
(default 10) sets how many `courier_later` messages `e2e/two-servers.sh` schedules each round.

To try a local build in OpenCode, list the `dist` directory (not a file) in `plugins`:
`"plugins": ["/absolute/path/to/opencode-courier/dist"]`.

## Writing a live scenario

`e2e/run.sh` runs a real OpenCode server in a throwaway home and project, with the plugin from
`dist/` and a scripted stand-in model (`e2e/mock-model.mjs`). It needs node, npm, bun, git, curl, jq
and openssl. New behaviour gets a scenario there.

- Scenarios live in groups, each a `run_<name>` function that starts its own sessions and relies on
  no other group's state. A new scenario goes into its group, or a new one.
- `E2E_SHARD=k/n` deals the groups to shards by the seconds each took in CI (the weights in
  `SUITE`, which the run log prints as `group <name>: N s`; update them when a group changes much). `restart-question` and `roster` always share a
  shard (`BOUND`). `epilogue`, the server log check, runs last in every shard. `E2E_PLAN=1` prints
  what a run would do.
- The mock model holds a child's reply back a few seconds (`CHILD_DELAY_MS`), so the parent is idle
  when it lands. A scenario that does not need that sets `child_delay 1000` after its heading.
- The suite's config sets `nativeChildren`, which the plugin logs and does not read, so every child
  is standalone unless the mock passes `native: true`. A scenario about a native child prompts through
  the API (`api_prompt`), not `opencode run` ([the trap](plugin-api-notes.md#native-parentid)).
- A check that something did not happen never waits out a timeout. It first waits for an event
  ordered after the point where the unwanted thing would have happened, then checks once:
  `end_handled` after `turn_ended` for what the courier does at a turn's end (it deletes a marker
  session the roster lists and waits for the courier to forget it, which it handles after every
  earlier event), a message delivered at the same tick,
  a storage key the path removes last, `wait_log` for a server log line. A wait that fails after N seconds when the event never comes
  is fine.

`e2e/kv.ts` reads, removes or sets the plugin's storage keys (`bun e2e/kv.ts get|remove <key>`, or
`set <key> <json> <a key the plugin stored | @<plugin id>>`), so a scenario can stand in for an older
copy or another server. `e2e/search-plugin` stands in for a web search provider; `e2e/probe-plugin`
logs the events each instance receives; `e2e/registry.mjs` serves the packed plugin as a stand-in
npm registry and redirects every other request to the real one.

## Recording the demo

The README's GIF is made in two steps, neither in CI:

```bash
OPENCODE_BIN=... script/record-gif.sh demo-gif                 # about 2 minutes, in real time
uv run script/render-gif.py demo-gif docs/demo.gif             # about 1 minute
```

`record-gif.sh` drives the TUI in `tmux`, scene by scene, on `e2e/tui.sh`'s setup, with the helpers
of `script/demo-lib.sh`, and keeps tmux's own screens; it needs tmux and what `e2e/tui.sh` needs. A
scene whose screen does not come ends the run, printing that screen. `render-gif.py` draws the
screens with Pillow and has ffmpeg encode the GIF; it needs ffmpeg, uv and `fc-match`. The scenario
is `e2e/mock-model.mjs`'s `demoTree`, paced by `MOCK_CHILD_DELAY_MS`. In the scenes, `look` puts the
spotlight on the lines a caption is about, `hold` moves it with them when the transcript scrolls,
and `zoom on` and `zoom off` mark the moments the render magnifies.

The recording takes `COLS` and `ROWS`, `PACE` (scales the holds after each step; `0.3` for a quick
check) and `TYPE_DELAY`. The render takes `FONT_SIZE`, `FPS`, `IDLE`, `MOTION_FPS` (the frame rate
while something animates), `ZOOM` (`1` for none) and the fonts as `MONO_FONT`, `MONO_BOLD_FONT`,
`FONT` and `KEY_FONT`.

`docs/demo.gif` stays under 3 MB: the README loads it from GitHub. A frame that changes the whole
picture costs 50 to 80 KB, which is why the zoom magnifies the spotlight alone, not the screen.
`render-gif.py` prints the size; over the limit, render with `MOTION_FPS=10` or `ZOOM=1`.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request, and as the first
job of `release.yml`. The required check
is `Live test against OpenCode V2`: it waits for the four `e2e/run.sh` shards and `e2e/tui.sh`, and
passes when they are skipped. A pull request that changes only Markdown, `docs/**` or `.claude/**`
skips the live jobs; the unit job, with the docs' link check, still runs. SonarCloud fails on a new
bug, vulnerability or unreviewed hotspot, or under 80% coverage on new code.

Coverage of a `.tsx` file counts the lines of the Solid preload's output, which has no source map, so
an uncovered line SonarCloud names in `src/tui.tsx` or a module's `tui.tsx` is a line of that output,
not of the source. To find it, run the file through `transformSolidSource` from
`@opentui/solid/scripts/solid-transform.js` and read the line there.

`latest.yml` runs the live suites on the newest OpenCode release, nightly and on `main`, allowed to
fail. It opens an issue when that release is newer than the pin ([the pin](releasing.md#the-plugin-api-pin)).

`claude.yml` runs a review by Claude Code when an outside contributor opens, reopens or marks
ready a pull request or pushes to it, and when a maintainer comments `@claude` on one. It reads the diff and CI's
results and runs none of the pull request's code. The outside review runs on `pull_request_target`,
with the secrets, so it checks out the base branch and its tools are only `gh pr` and inline review comments. It needs the repository secret `CLAUDE_CODE_OAUTH_TOKEN`, from
`claude setup-token`, and counts against that subscription's usage limits.
