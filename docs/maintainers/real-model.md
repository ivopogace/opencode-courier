# Smoke test with a real model

`e2e/run.sh` proves the plumbing with a scripted model. `e2e/real-model.sh` checks that a real model
uses the tools as meant: the parent spawns instead of doing the work, ends its turn instead of
polling, each child reports with a status, and each report wakes the parent. It is not in CI.
Re-run it after any change to a model-facing string: `src/**/text.ts`, `src/kernel/protocol.ts`,
`src/skill.ts` or a tool description.

## Running it

```bash
bun install
npm install --prefix <scratch>/oc @opencode/cli@2.1.4
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/real-model.sh
```

It uses the same throwaway server as `run.sh`, with the local build. The default model,
`opencode/longcat-2.5-preview-free`, is free on [OpenCode Zen](https://opencode.ai/zen) and needs no
key. Free models are rate limited; check Zen's terms before sending anything private.

Zen's free tier refuses the provider `COURIER_BASE_URL` declares (403, `FreeTierError`): set
`COURIER_BASE_URL=` (empty) to use OpenCode's own catalog entry. From a shared cloud address the
free tier refuses by volume too, so run the recursive scenarios (15 to 25 requests in four minutes)
from your own machine.

| Variable | Default | |
|---|---|---|
| `COURIER_PROVIDER`, `COURIER_MODEL` | `opencode`, `longcat-2.5-preview-free` | The model, as OpenCode names it. |
| `COURIER_BASE_URL` | Zen's endpoint | Declares the provider as an OpenAI-compatible endpoint. Empty uses OpenCode's catalog, with the provider's usual key variable. |
| `COURIER_API_KEY_ENV` | | For a declared provider, the variable holding its key (written as `{env:NAME}`, never to a file). |
| `COURIER_SCENARIO` | the fan-out | `permission`, `question`, `recursive`, `recursive-fault` or `recursive-staged`. |
| `COURIER_PROMPT`, `COURIER_EXPECT` | per scenario | The parent's prompt, and the values the reports and the reply must hold. |
| `COURIER_FILES` | per scenario | Recursive scenarios: the files that must hold those values, in order; for `recursive-staged` the first is the core's. |
| `COURIER_MAX_DEPTH` | `3` | Recursive scenarios: the `maxDepth` the checker holds the tree to. |
| `COURIER_SKILL` | | `deny` denies `courier-orchestrate` in `permissions`, so no session can load it. |
| `COURIER_PERSON` | | `other-server`, with `permission`: the person answers through a second server. |
| `COURIER_ANSWER` | `Hi` | With `question`: the option the person picks. |
| `COURIER_NATIVE` | | `1` turns `nativeChildren` on. |
| `COURIER_SEED` | | A JSON file of storage keys to set before the prompt ([seeding a record](#seeding-a-record)). |
| `COURIER_TIMEOUT` | `300` | Seconds to wait for the parent's first turn, then for the children. |
| `E2E_WORK` | a new temp dir | Where the transcripts and logs go. |

Each run prints a timeline of every session's turns and tool calls, its checks and notes. It keeps
`parent.json`, `child-<id>.json`, `timeline.txt`, `summary.json` and the server log in the work
directory. The exit code is 0 when every check passes, 1 when one fails, and 2 when checks fail and
model requests failed too (usually a 429): run it again. Use a plainly named work directory: a model
that copies a long, odd path into a task gets it wrong.

### Reading a stall

The server runs at `--log-level debug` with `e2e/probe-plugin` loaded. To trace a session that
stops moving:

- `timeline.txt` gives each step and tool call with start and end times. A long gap between a tool's
  end and the next step is visible; a step shown as `…` is a request with no answer.
- `server.log` logs no line per provider request, only failures (`Failed to drain Session`). No
  error after the tool's end says nothing.
- `probe.log` has one JSON line per event (`at`, `type`, `sessionID`). No events for the session
  after the tool's end means the server did nothing.

## The fan-out

The default. The parent is asked:

> Have two helper sessions work in parallel and report back to you. One runs the shell command
> `` `sleep 20; echo $((17 * 23))` ``, the other runs `` `sleep 40; echo $((2 ** 10))` ``, and each
> reports the number it printed. Start them with courier_spawn and do not run the commands
> yourself. When both have reported back, reply with one line: RESULTS \<first\> \<second\>

Eight checks: two children spawned; the first turn ended after spawning; no polling (a
`courier_status`, `courier_children` or `sleep` right after spawning, or more than one in a later
turn); both children reported to the parent; both reports woke it; each carries a status and its
answer; the reply holds both. The README's Quickstart prompt is a shorter wording: set
`COURIER_PROMPT` to it. To check a join group, add *both in one join group named "pair"*.

| Model | OpenCode | Result |
|---|---|---|
| `longcat-2.5-preview-free` | 2.0.28 | 8/8 in 9 requests, both children in one group it named itself, `RESULTS 391 1024`. |
| `longcat-2.5-preview-free`, `COURIER_NATIVE=1` | 2.0.28 | 8/8 in 11 requests; both children native, with an empty ruleset. |
| `longcat-2.5-preview-free`, two isolated helpers that commit | 2.0.26 | Pass: each committed on `courier/<its session ID>` and named it in its report. |

## The permission relay

`COURIER_SCENARIO=permission`. `shell` asks for any command containing `courier-permission`, and
the parent is asked:

> Have a helper session run the shell command `` `echo courier-permission-$((6 * 7))` `` and report
> back what it printed. Start it with courier_spawn and do not run the command yourself. When it has
> reported back, reply with one line: RESULT \<what it printed\>

The script plays the person and allows OpenCode's prompt in the parent's session. A parent that
asks first gets "once" as the answer. Seven checks: the parent was told of the request; nothing
passed on before the person answered; the parent proposed `once` without asking first; OpenCode
asked the person in the parent's session; `once` was passed on after the person allowed it; the
child reported `courier-permission-42`; the reply holds it. The parent is started over the HTTP API,
since `opencode run` answers its own session's prompts.

`COURIER_PERSON=other-server` has the person reject the parent's prompt and answer through a second
server, whose `courier_answer` holds no request; then allow the request in the child's session. With
`COURIER_NATIVE=1` the script answers the child's request directly, as OpenCode's view of the parent
would.

| Model | OpenCode | Result |
|---|---|---|
| `longcat-2.5-preview-free` | 2.0.29 | 7/7: proposed `once` at once; the person allowed it in OpenCode's prompt; `RESULT courier-permission-42`. |
| `longcat-2.5-preview-free`, `COURIER_NATIVE=1` | 2.0.29 | 6/6: told with the `shown="native"` notice, the parent wrote one line and ended its turn; told `answered="once"`, it replied. |

## The question relay

`COURIER_SCENARIO=question`. The parent is asked:

> Start one helper session with courier_spawn and give it this task, word for word: "Find out from
> the user which greeting they want to use: Hello, Hi or Hey. Then report the chosen greeting to the
> session that started you." Do not ask the user anything yourself before the helper does, and do
> not do the task yourself. When the helper reports back, reply with one line: GREETING \<the
> greeting it reported\>

The child is not told how to ask: the brief's line on the question tool is under test. The script
answers with `COURIER_ANSWER` when the parent asks. Six checks: the child asked and the parent asked
the person; it did not answer by itself; it used the child's options; it passed the answer on; the
child reported it; the reply holds it. With `COURIER_NATIVE=1` the script answers the child's form.

| Model | OpenCode | Result |
|---|---|---|
| `longcat-2.5-preview-free` | 2.0.28 | 6/6: the parent asked with the child's three options, `Hi` went on through the linked question, `GREETING Hi`. |
| `longcat-2.5-preview-free`, `COURIER_NATIVE=1` | 2.0.28 | 6/6: the parent wrote one line; told `answered="elsewhere"`, it replied `GREETING Hi`. |

## Recursive orchestration

`COURIER_SCENARIO=recursive`: one split at the root and one more below it. The parent is asked:

> Have this job done through helper sessions started with courier_spawn, one session per part, and
> do no part yourself. It has two parts. Part "numbers" is itself two independent halves, which the
> session that gets it hands to two sessions of its own: one runs `` `sleep 20; echo $((17 * 23))` ``
> and writes the number it printed to numbers/a.txt, the other runs `` `sleep 20; echo $((2 ** 10))` ``
> and writes the number it printed to numbers/b.txt. Part "count" runs `` `sleep 20; echo $((99 - 57))` ``
> and writes the number it printed to count/total.txt. When the parts have reported back, read the
> three files yourself and reply with one line: RESULTS \<a\> \<b\> \<total\>

The checker (`e2e/real-model-recursive.mjs`) reads every session reached from the root and makes
nine checks: the root spawned two or more in its first turn and ended it; no orchestrator polled; a
child spawned two or more of its own in one turn, and no sub-orchestrator started exactly one; no
session went past `maxDepth`; every session reported with a status; each sub-orchestrator reported
once, after its children; the files and the reply hold the values. Its notes say who loaded the skill
and when, who used a group, a check-in or had a spawn refused.

`e2e/real-model-prompt-open.txt` leaves the split to the root. With it, the "two or more children"
checks fail by design when the root keeps a part, so read the split from the transcripts. The
scripted prompt fixes the split, so it cannot show what `courier_recall` is worth; the open prompt
with a seeded record can.

| Model | OpenCode | Result |
|---|---|---|
| `deepseek-v4.1-flash-free`, catalog, 045ae2c | 2.0.32 | 9/9 in 30 requests, 52 s: both orchestrators split into groups and scheduled and cancelled a check-in; no polling. |
| `deepseek-v4.1-flash-free`, catalog, 43393b0 | 2.0.32 | 9/9 in 26 requests, 52 s: both orchestrators loaded the skill and recalled once before splitting; no gap in the timeline. |
| `longcat-2.5-preview-free`, catalog, e6ec247 and 0d02efe | 2.0.32 | 9/9 twice and 5/9 once. In the 5/9 a leaf's next step never came, for unknown reasons. Skill loads varied from run to run. |
| `longcat-2.5-preview-free`, catalog, 315587a | 2.0.32 | 9/9 twice, then Zen's free tier refused every request for over an hour. |
| `glm-5.3-flash-free`, catalog, 315587a, memory off / on and empty / seeded | 2.0.32 | 8–9 of 9 in every condition; every lost point was polling. With memory on, the root recalled before its split in all six trees and cited the seeded record in all three. |
| `glm-5.3-flash-free`, catalog, the open prompt, empty / seeded / lesson | 2.0.32 | Empty and seeded roots handed off all three parts flat. Every root with the lesson did "count" itself, as the lesson said (1 to 3 sessions, against 4). |
| `glm-5.3-flash-free`, catalog, the open prompt, model-written lessons | 2.0.32 | The top wrote a lesson in 4 of 9 trees, and in 1 of 3 on the current wording. Each lesson, seeded into a fresh tree, steered it. |

## A part that goes wrong

`COURIER_SCENARIO=recursive-fault`: the recursive job with one half told to report `partial` first,
then finish when its parent says so. It tests the skill's steps 5 to 8. The prompt passes that half
its task word for word:

> Have this job done through helper sessions started with courier_spawn, one session per part, and
> do no part yourself. It has two parts. Part "numbers" is itself two independent halves, which the
> session that gets it hands to two sessions of its own, doing neither half itself: one runs
> `` `sleep 20; echo $((17 * 23))` `` and writes the number it printed to numbers/a.txt; the other gets
> this task, passed on word for word: "Run `` `sleep 20; echo $((2 ** 10))` ``. Do not write any file
> yet: report status partial with the number it printed, saying that writing it to numbers/b.txt is
> left, and end your turn. Once the session that started you sends you a message to finish, write the
> number to numbers/b.txt and report status done." Part "count" runs `` `sleep 20; echo $((99 - 57))` ``
> and writes the number it printed to count/total.txt. When the parts have reported back, read the
> three files yourself and reply with one line: RESULTS \<a\> \<b\> \<total\>

The checker runs with `--fault` (recorded in `summary.json`, so `--saved` repeats it): the nine
checks, then four. The faulty session is found by its first non-`done` report: the fault reached a
leaf; its parent messaged it before reporting upward; it then reported `done`; its parent reported
upward once, `done`. "Session … reported 2 times" is expected for it.

| Model | OpenCode | Result |
|---|---|---|
| `deepseek-v4.1-flash-free`, catalog, 1dbebb3, skill listed | 2.1.2 | 4 of 5 passed. Every run handled the `partial` report: one message to finish, then `done`. The lost point was a root calling `courier_children`. |
| `deepseek-v4.1-flash-free`, catalog, 1dbebb3, `COURIER_SKILL=deny` | 2.1.2 | 5 of 5 passed, 13/13 each. Without the skill, the `partial` report was handled no worse. |

## A part with a core

`COURIER_SCENARIO=recursive-staged`: the "numbers" part has a seed both halves need, so a correct
session does the seed first, then starts the halves together. The prompt does not say to:

> Have this job done through helper sessions started with courier_spawn, one session per part, and
> do no part yourself. It has two parts. Part "numbers" has a seed and two halves; the session that
> gets it hands the halves to two sessions of its own. The seed: run `` `sleep 20; echo $((7 * 61))` ``
> and write the number it printed to numbers/seed.txt. The halves each read the seed from
> numbers/seed.txt: one writes the seed times 17 to numbers/a.txt, the other writes the seed plus 1000
> to numbers/b.txt. Part "count" runs `` `sleep 20; echo $((99 - 57))` `` and writes the number it
> printed to count/total.txt. When the parts have reported back, read the four files yourself and
> reply with one line: RESULTS \<seed\> \<a\> \<b\> \<total\>

The checker runs with `--staged`: the nine checks, then three. A `sleep` before any spawn is the
core's work, not polling. The core is found by the first write of its file (`write`, `edit`, `patch`,
or a shell redirect; `cd numbers && echo … > seed.txt` is not seen). The checks: no half started
before the seed was written (or its session reported); the session that staged started two or more
halves together; it reported upward once, `done`.

Run it with the skill and without, several runs each, and table them:

```bash
run() {  # run <name> [VAR=value ...]
  local name=$1; shift
  env COURIER_SCENARIO=recursive-staged COURIER_BASE_URL= E2E_WORK="$HOME/courier-runs/$name" "$@" e2e/real-model.sh 2>&1 | tee "$HOME/courier-runs/$name.log"
  echo "exit ${PIPESTATUS[0]}" | tee -a "$HOME/courier-runs/$name.log"
}
for n in 1 2 3 4 5; do run staged-skill-$n; run staged-noskill-$n COURIER_SKILL=deny; done
bun script/real-model-table.ts $(for n in 1 2 3 4 5; do echo skill=$HOME/courier-runs/staged-skill-$n noskill=$HOME/courier-runs/staged-noskill-$n; done)
```

| Model | OpenCode | Result |
|---|---|---|
| `deepseek-v4.1-flash-free`, catalog, 1dbebb3, skill listed | 2.1.2 | 4 of 5 passed. Every "numbers" session wrote the seed itself, then started both halves in one group. The lost point was one `courier_children` call. |
| `deepseek-v4.1-flash-free`, catalog, 1dbebb3, `COURIER_SKILL=deny` | 2.1.2 | 5 of 5 passed. Every run staged; staging does not depend on the skill. |

## Seeding a record

`COURIER_SEED` names a JSON file of storage keys, `{ "<key>": <value> }`, set with `e2e/kv.ts`
before the parent's prompt. `<project>` in a key or value stands for the project's id. The log shows
`seeded memory/<id>/…` before `parent prompt:`. Two seeds are checked in:
`e2e/real-model-seed.json`, an earlier tree's record, and `e2e/real-model-seed-lesson.json`, the
same with the lesson "the count part is small; do it yourself".

A run is **finished** when it exits 0 or 1 and has a `summary.json`. Repeat a run that exits 2, or
whose first turn did not end, under a new name. To compare conditions, keep one model and run each
several times:

```bash
run() {  # run <name> [VAR=value ...]: work directory and log under ~/courier-runs/<name>
  local name=$1; shift
  env COURIER_SCENARIO=recursive COURIER_BASE_URL= E2E_WORK="$HOME/courier-runs/$name" "$@" e2e/real-model.sh 2>&1 | tee "$HOME/courier-runs/$name.log"
  echo "exit ${PIPESTATUS[0]}" | tee -a "$HOME/courier-runs/$name.log"
}
run mem-seeded-1 COURIER_SEED=$PWD/e2e/real-model-seed.json
run open-lesson-1 COURIER_PROMPT="$(cat e2e/real-model-prompt-open.txt)" COURIER_SEED=$PWD/e2e/real-model-seed-lesson.json
```

### Reading many runs

`script/real-model-table.ts` prints one Markdown table per condition, a row per run directory:

```bash
bun script/real-model-table.ts baseline=$HOME/courier-runs/base-1 seeded=$HOME/courier-runs/mem-seeded-1
bun script/real-model-table.ts $HOME/courier-runs/*   # no label: each directory is its own condition
```

A label before `=` names the condition; several directories may share one. A path that is no run is
skipped with a line on stderr. Each row has the verdict, the score, skill loads per depth, recalls,
join groups, polled sessions, requests, the duration and the `split:` lines. A line under each
table gives the means over its finished runs.

**How many runs a claim needs.** A claim such as "the polling went away" is about a rate. Five
finished runs per condition on each of two models is the floor; with fewer, call the result an
observation. Pick the metric and the conditions before changing a wording, and read the same columns
after.

## Caveats

This is a smoke test, not a benchmark: a few runs on free models that change without notice. A
model that passes here can still poll or forget to report on a harder task, so a `courier_later`
check-in still pays. Which session loads the skill varies from run to run; on one-result tasks,
models do not load it. No row reaches the five-run floor on two models. Not re-run on the current
wording: `COURIER_PERSON=other-server` and the models other than `longcat-2.5-preview-free`. Earlier
rows, among them a native-notice wording that scored 0/6, are in this file's history.
