# Smoke test with a real model

`e2e/run.sh` proves the plumbing with a scripted model. `e2e/real-model.sh` checks that a real
model uses the tools as intended: the parent spawns sessions instead of doing the work itself, it
ends its turn instead of waiting or polling, each child calls `courier_send` before it stops, and
each report wakes the idle parent. It is not part of CI.

## Running it

```bash
bun install
npm install --prefix <scratch>/oc2 @opencode-ai/cli@0.0.0-beta-19271
OPENCODE_BIN=<scratch>/oc2/node_modules/.bin/opencode2 e2e/real-model.sh
```

It sets up the same throwaway home directory, project and OpenCode server as `run.sh`, with the
plugin loaded from the local build. By default the model is `opencode/longcat-2.5-preview-free`, a
free model on [OpenCode Zen](https://opencode.ai/zen), which needs no key: the provider is declared in
`opencode.json` with Zen's endpoint, so OpenCode's model catalog (models.dev) is not needed
either. Free models are rate limited, and check Zen's terms before sending them anything private;
the prompt here is trivial on purpose.

| Variable | Default | |
|---|---|---|
| `COURIER_PROVIDER`, `COURIER_MODEL` | `opencode`, `longcat-2.5-preview-free` | The model, as OpenCode names it. |
| `COURIER_BASE_URL` | Zen's endpoint for `opencode` | Declares the provider in `opencode.json` as an OpenAI-compatible endpoint with this URL. Set it empty to use OpenCode's catalog instead, with the provider's usual key variable, such as `ANTHROPIC_API_KEY`. |
| `COURIER_API_KEY_ENV` | | For a declared provider, the name of the variable holding its key. The config refers to it as `{env:NAME}`, so the key is never written to a file. |
| `COURIER_PROMPT`, `COURIER_EXPECT` | see below | The parent's prompt, and the values the reports and the final reply must hold. |
| `COURIER_TIMEOUT` | `300` | Seconds to wait for the parent's first turn, and then for the children. |
| `E2E_WORK` | a new temp dir | Where the transcripts and logs go. |

The parent is asked:

> Have two helper sessions work in parallel and report back to you. One runs the shell command
> `` `sleep 20; echo $((17 * 23))` ``, the other runs `` `sleep 40; echo $((2 ** 10))` ``, and each
> reports the number it printed. Start them with courier_spawn and do not run the commands
> yourself. When both have reported back, reply with one line: RESULTS \<first\> \<second\>

The sleeps stand in for real work. Without them the children reported within a few seconds, while
the parent was still finishing its turn, so the reports were steered into that turn and the wake
was never tested. With them, each report should find the parent idle, 20 seconds apart.

After the parent's first turn, the script waits until both children have reported and the parent
has finished with them (or every child has stopped), saves the transcripts, and prints a timeline
and seven checks:

```
turn 1 (opened by the prompt):
  says: I'll start both helper sessions in parallel with `courier_spawn`.
  courier_spawn({"task":"Run the shell command `sleep 20; echo $((17 * 23))` and report back the number it printed. ...) -> completed
  courier_spawn({"task":"Run the shell command `sleep 40; echo $((2 ** 10))` and report back the number it printed. ...) -> completed
  says: Both helpers are running. I'll set a safety-net check-in in case either fails to report, then end my turn ...
  courier_later({"message":"Safety check-in: verify both helper sessions (ses_… and ses_…) ...) -> completed
  -- turn ended (stop)
turn 2 (opened by the report from ses_…):
  <- the report from ses_…: <courier from="ses_…"> The command `sleep 20; echo $((17 * 23))` printed: 391 </courier>
  says: First helper reported: **391** (17 × 23). Waiting for the second helper (2 ** 10) before giving the final result.
  -- turn ended (stop)
turn 3 (opened by the report from ses_…):
  <- the report from ses_…: <courier from="ses_…"> The command `sleep 40; echo $((2 ** 10))` completed ... 1024 </courier>
  says: Both helpers have reported. Cancelling the safety check-in now.
  courier_cancel({"id":"later_…"}) -> completed
  says: RESULTS 391 1024
  -- turn ended (stop)

  PASS the parent spawned two children with courier_spawn
  PASS the parent ended its first turn after spawning, with no reports in it
  PASS the parent never polled (courier_status, courier_children, sleep)
  PASS both children called courier_send to the parent
  PASS both reports woke the parent: each arrived after its first turn and got a reply
  PASS each report holds its child's answer
  PASS the parent's final reply holds both answers
  usage: 12 model requests, 25460 input / 891 output / 662 reasoning tokens, 75136 cache reads, ...
result: pass
```

`opencode2 v0.0.0-beta-19271` records no marker when a session goes idle, so turns are read from
the transcript: a delivered message opens a new turn when the session's last step had ended its
turn (finish reason other than `tool-calls`) and completed before the message arrived; otherwise
it was steered into the running turn. The work directory keeps `parent.json`, `child-<id>.json`,
`timeline.txt`, `summary.json` and the server log. The exit code is 0 when every check passes and
1 when one fails. It is 2 when checks fail and model requests failed too, usually HTTP 429 from a
free model, because then the run says more about the provider than the plugin; run it again.

## What the models did

19 runs on 2026-10-03, all with `opencode2 v0.0.0-beta-19271` and the plugin built from this
branch, against free models on Zen (which publishes no versions beyond the names):

| Model | Runs | Result |
|---|---|---|
| `nemotron-3-ultra-free` | 5 | Failed before tuning and through two rounds of it (never ended its turn); passed both runs on the final build. |
| `longcat-2.5-preview-free` | 4 | Before tuning, every check but "never polled"; passed both runs on the tuned wording. One more run failed on a broken first attempt at the `delayMinutes` fix. |
| `muse-spark-1.3-contributor-free` | 3 | Tried after tuning: passed twice, rate limited once. |
| `mimo-v2.6-flash-free` | 5 | Every run that scheduled a check-in had it rejected (string `delayMinutes`); the fix was checked on its own. Full runs after it were rate limited. |
| `big-pickle` | 2 | Right as a parent both times; rate limited before the end. |

Every child that was not stopped by a rate limit ran its command and called `courier_send` with
the right number before it stopped, without any change to the child brief.

**nemotron-3-ultra-free** never ended its first turn. It said it would and then called another
tool, using `courier_later` as a way to wait: 12 check-ins of a minute each, plus a
`courier_children` look, until both reports had been steered into the still-running turn. The
check-ins it never cancelled woke it three more times after it had answered.

```
  says: Started both sessions. Waiting for them to report back...
  courier_later({"delayMinutes":2,"message":"Check if both sessions have reported their results"}) -> completed
  courier_later({"delayMinutes":1,"message":"Check if both sessions have reported their results"}) -> completed
  ... 10 more ...
  courier_children({"sessionID":"ses_…"}) -> completed
```

Its reasoning, step after step: "Now I need to end my turn and wait for the reports." — followed
each time by a tool call. Through the tuning below its polling went away and its requests went from
24 to 14, but it still did not end the turn in two runs; on the final build it did, in both runs:
two spawns, at most one check-in, end of turn, woken by each report.

**longcat-2.5-preview-free** completed the fan-out before any tuning, both reports waking it, but
looked at both children with `courier_status` twice right after spawning and once more after the
first report, five calls, while its reasoning said "Let me end my turn now". It also cancelled its own
safety-net check-ins as redundant before either child had reported. After tuning: two spawns, at
most one check-in, end of turn.

**muse-spark-1.3-contributor-free** (tried after tuning only) passed both complete runs: two spawns,
one check-in, end of turn, a new turn per report, and the check-in cancelled at the end.

**mimo-v2.6-flash-free** spawned correctly and ended its turn, but always sent `delayMinutes` as a
string (`"3"`, `"3.0"`), got `Expected number`, and sent the same string again, two or three times
a run. The retries kept its first turn going long enough for the first report to land in it. It
got through only by shelling out to `date` and passing `at` instead. After the fix, asked on its own
to schedule a check-in, its `"delayMinutes":"3"` was accepted at the first try, twice.

**big-pickle** did everything right as a parent (two spawns, one check-in, end of turn, woken by the
first report), but rate limits stopped its woken turn and one child before `courier_send`. A child
that dies like this is what the `courier_later` check-in is for.

## What was tuned

- **Saying what "end your turn" means, where the model decides.** The `courier_spawn` result
  used to say only "It will report back with courier_send". Now it says the report starts a new
  turn, to end the turn by replying without calling more tools once every session is started, and
  that this does not drop the task. The `courier_later` result for a session's own check-in says
  the same. Both descriptions spell out "end your turn by replying without calling more tools".
  The models that misbehaved meant to end their turn and kept calling tools; nemotron also did not
  stop until it thought the task was finished.
- **Not inviting a cancel.** The `courier_later` result said "Cancel it with courier_cancel." In
  one tuning run nemotron did, at once, to the check-in it had just made. For a session's own
  check-in it now says to cancel it if what it checks on reports first.
- **`delayMinutes` accepts a string.** mimo sent strings whatever the schema said, and Muse Spark
  did too once (`"2"`, accepted). `courier_later` now takes a number or a string and reads the
  string as a number; anything that is not a finite number of minutes, zero or more, is still
  refused.

Two things learned on the way: `Schema.Number` advertises the strings `"Infinity"`, `"-Infinity"`
and `"NaN"` in its JSON Schema, and the plugin's schema checks and transformations do not work in
OpenCode (see [Notes on the V2 plugin API](../README.md#notes-on-the-v2-plugin-api)), which the
first two attempts at the `delayMinutes` fix ran into.

## Cost

Nothing: every run used free models. The 18 runs with a summary made 209 model requests, about
990,000 input, 13,000 output and 12,000 reasoning tokens, plus 815,000 cache reads. A passing run
is 10 to 12 requests, 25,000 to 110,000 input tokens (nemotron reads the most, with little
caching) and about 1,000 output tokens.

## Caveats

This is a smoke test, not a benchmark: a handful of runs per model, on free models that are rate
limited and change without notice. A model that passes here can still poll or forget to report on
a harder task, so the `courier_later` safety net in [Using it](../README.md#using-it) still
applies.
