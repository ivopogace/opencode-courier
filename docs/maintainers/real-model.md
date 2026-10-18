# Smoke test with a real model

`e2e/run.sh` proves the plumbing with a scripted model. `e2e/real-model.sh` checks that a real model
uses the tools as meant: the parent spawns sessions instead of doing the work itself, ends its turn
instead of waiting or polling, each child calls `courier_send` with a status before it stops, and
each report wakes the idle parent. It is not part of CI. Re-run it after any change to a model-facing
string: `src/**/text.ts`, `src/kernel/protocol.ts`, `src/skill.ts` or a tool description.

## Running it

```bash
bun install
npm install --prefix <scratch>/oc @opencode/cli@2.0.32
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/real-model.sh
```

It sets up the same throwaway home directory, project and server as `run.sh`, with the plugin loaded
from the local build. The default model, `opencode/longcat-2.5-preview-free`, is free on [OpenCode
Zen](https://opencode.ai/zen) and needs no key: the provider is declared in `opencode.json` with
Zen's endpoint, so OpenCode's model catalog is not needed either. Free models are rate limited;
check Zen's terms before sending them anything private (the prompts here are trivial on purpose).

Since 2026-10-17 Zen's free tier refuses that declared endpoint: HTTP 403, `provider.auth`, with the
body `FreeTierError` "OpenCode's free tier can only be used from within OpenCode". A bare request gets
it at once, and a recursive run got seven requests through before every later one was refused. Set
`COURIER_BASE_URL=` (empty) so OpenCode's own catalog entry for the `opencode` provider is used, which
Zen takes as "within OpenCode"; nothing else about the run changes. From a shared cloud address the
same 403 then comes by volume, not by client: that day, from a Claude Code cloud VM, 14 attempts on
`longcat-2.5-preview-free` and 7 on `deepseek-v4.1-flash-free` each got 0 to 17 requests of 9 to 14k
tokens through and then none (49 of about 110 requests refused in the first eight attempts); tiny
requests of about 500 tokens still passed 7 of 8 and 6 of 6 one at a time while a lone 40 KB prompt
was refused, and after an hour of attempts tiny ones were refused too (2 of 3). A tree typed into the
TUI in `tmux` was cut off the same way after seven requests, and the newest published CLI was still
2.0.32, so it is neither a client check nor a version check; `deepseek-v4.1-flash-free` adds HTTP 429
`provider.quota` of its own. The recursive scenario needs 15 to 25 such requests in four minutes, more
than that address's budget allowed at any hour tried, so the memory conditions of #263 are run from a
machine of one's own: [Running the memory conditions by hand](#running-the-memory-conditions-by-hand).

| Variable | Default | |
|---|---|---|
| `COURIER_PROVIDER`, `COURIER_MODEL` | `opencode`, `longcat-2.5-preview-free` | The model, as OpenCode names it. |
| `COURIER_BASE_URL` | Zen's endpoint for `opencode` | Declares the provider in `opencode.json` as an OpenAI-compatible endpoint with this URL. Set it empty to use OpenCode's catalog instead, with the provider's usual key variable, such as `ANTHROPIC_API_KEY`. |
| `COURIER_API_KEY_ENV` | | For a declared provider, the name of the variable holding its key. The config refers to it as `{env:NAME}`, so the key is never written to a file. |
| `COURIER_SCENARIO` | | `permission`, `question` or `recursive` for the scenarios below; the fan-out by default. |
| `COURIER_PROMPT`, `COURIER_EXPECT` | per scenario | The parent's prompt, and the values the reports and the final reply must hold. |
| `COURIER_FILES` | per scenario | With `recursive`: the files, relative to the project, that must hold those values, in the same order. |
| `COURIER_MAX_DEPTH` | `3` | With `recursive`: the `maxDepth` the checker holds the tree to. |
| `COURIER_PERSON` | | `other-server`, with `permission`: the person answers through a second server on the same data directory. |
| `COURIER_ANSWER` | `Hi` | With `question`: the option the person picks. |
| `COURIER_NATIVE` | | `1` loads the plugin with [`nativeChildren`](../reference.md#native-child-sessions) on. |
| `COURIER_SEED` | | A JSON file of plugin storage keys, `{ "<key>": <value>, … }`, set with `e2e/kv.ts` once the server is up and before the parent's prompt; `<project>` in a key or value stands for the project's id. For a tree [record](../reference.md#memory) an earlier tree would have left: [the memory conditions](#running-the-memory-conditions-by-hand). |
| `COURIER_TIMEOUT` | `300` | Seconds to wait for the parent's first turn, and then for the children. |
| `E2E_WORK` | a new temp dir | Where the transcripts and logs go. |

Each run prints a timeline of every session's turns and tool calls, its checks and notes, and keeps
`parent.json`, `child-<id>.json`, `timeline.txt`, `summary.json` and the server log in the work
directory. Turns are read from the transcript: OpenCode records an `idle` message when a turn ends,
and a delivered message opens a new turn when it arrived after that marker; otherwise it was steered
into the running turn. The exit code is 0 when every check passes and 1 when one fails; it is 2 when
checks fail and model requests failed too, usually HTTP 429 from a free model, since the run then says
more about the provider than the plugin: run it again. Run it in a plainly named directory (the
default temp dir is): a model that copies a long, odd path into its children's tasks gets it wrong,
and the files land elsewhere.

## The fan-out

The default. The parent is asked:

> Have two helper sessions work in parallel and report back to you. One runs the shell command
> `` `sleep 20; echo $((17 * 23))` ``, the other runs `` `sleep 40; echo $((2 ** 10))` ``, and each
> reports the number it printed. Start them with courier_spawn and do not run the commands
> yourself. When both have reported back, reply with one line: RESULTS \<first\> \<second\>

The sleeps stand in for real work, so each report finds the parent idle, 20 seconds apart: without
them the reports were steered into the parent's still-open first turn, and the wake was never tested. Eight
checks: the parent spawned two children; it ended its first turn after spawning, with no reports in
it; it did not poll (any `courier_status`, `courier_children` or `sleep` right after spawning, or more
than one in a later turn; a single look after being woken is only noted); both children called `courier_send` to the parent; both reports woke it
(each arrived after its first turn and got a reply); each report carries a status; each holds its
child's answer; and the final reply holds both. A `courier_later` check-in is not a report.

The README's [Quickstart](../../README.md#quickstart) prompt is a shorter wording of the same task:
set `COURIER_PROMPT` to it. A [join group](../reference.md#join-groups) is checked by adding *Start
them with courier_spawn, both in one join group named "pair", so that you are woken once with both
reports*; the checker takes the group's message as the report of each member it lists.

| Model | OpenCode | Result |
|---|---|---|
| `longcat-2.5-preview-free` | 2.0.28 | 8/8 in 9 model requests: a `split: 2 parts: …` line, both children in one join group it named itself, one woken turn, every report `done`, `RESULTS 391 1024`. |
| `longcat-2.5-preview-free`, `COURIER_NATIVE=1` | 2.0.28 | 8/8 in 11 requests; both children recorded with the parent as `parent_id` and an empty ruleset. |
| `longcat-2.5-preview-free`, two `isolate: true` helpers that each commit a file | 2.0.26 | Pass: both created `courier/<their session ID>`, committed on it and named it in their report. |

## The permission relay

`COURIER_SCENARIO=permission`. The project config makes `shell` ask for any command containing
`courier-permission`, and the parent is asked:

> Have a helper session run the shell command `` `echo courier-permission-$((6 * 7))` `` and report
> back what it printed. Start it with courier_spawn and do not run the command yourself. When it has
> reported back, reply with one line: RESULT \<what it printed\>

The script plays the person: it answers OpenCode's permission prompt in the parent's session, the one
`courier_answer`'s `permission.assert` opens for the child's request, with `once`. A parent that asks
the person first, with a question form or in text, gets its form answered with the option for "once"
or the reply "Allow it once.", and the prompt is then answered all the same. Seven checks: the parent
spawned a child, which asked, and the parent was told; nothing was passed on before the person had
answered; the parent proposed `once` with `courier_answer` without asking first; OpenCode asked the
person in the parent's session for what the child asked, holding the call; `courier_answer` passed
`once` on after the person allowed it; the child ran its command and reported
`courier-permission-42`; the final reply holds it. The parent is started over the HTTP API, as a TUI
session would be: `opencode run` answers the prompts in its own session itself, and cancels question
forms there while attached.

`COURIER_PERSON=other-server` adds a second server on the same data directory: the person rejects
the parent's prompt without a reason, which ends the parent's step and leaves the child's request
waiting (or dismisses the parent's form, for a parent that asked first), and sends "Allow it once."
through the second server, whose `courier_answer` holds no request, so the fifth check becomes "the
parent's courier_answer on the other server passed nothing on and named another server". The person
then allows the request in the child's own session on the first server. With `COURIER_NATIVE=1` the
script answers the child's request directly, as OpenCode's prompt in the parent's view would, and
fails a parent that asks with a form.

| Model | OpenCode | Result |
|---|---|---|
| `longcat-2.5-preview-free` | 2.0.29 | 7/7: told, the parent proposed `once` with `courier_answer` at once, asking nothing itself; the call was held while OpenCode's prompt in its session showed the child's command, and once the person allowed it there the child ran it, reported `done`, and the parent replied `RESULT courier-permission-42`. |
| `longcat-2.5-preview-free`, `COURIER_NATIVE=1` | 2.0.29 | 6/6: told with the `shown="native"` notice, the parent wrote one line (*The helper session is waiting on your permission to run the `echo` shell command.*) and ended its turn, calling nothing; told `answered="once"` after the person allowed it in OpenCode's prompt, it replied `RESULT courier-permission-42`. |
| `longcat-2.5-preview-free`, `COURIER_NATIVE=1`, run on an earlier wording of the native notice, which still listed `once` and `reject` for a person who asks the model to answer for them | 2.0.29 | 0/6: told with the `shown="native"` notice, the parent wrote one line and then proposed `once` with `courier_answer` all the same ("Proposing approval to the user now"), so OpenCode asked the person a second time, in the parent's session, and held the call; the notice now says not to call `courier_answer`, and names the ids only for a person who tells the model to. |
| `longcat-2.5-preview-free`, `COURIER_NATIVE=1` | 2.0.28 | 6/6: told with the `shown="native"` notice, the parent wrote one line (*The helper session is waiting on your permission to run the shell command.*) and ended its turn; after the person allowed it, it was told `answered="once"` and replied `RESULT courier-permission-42`. |
| `longcat-2.5-preview-free`, `COURIER_NATIVE=1`, run before native children got their own notice, so on the notice every other child gets | 2.0.28 | 6/6: asked the person with a question form offering `once`, `always` and `reject`, and passed `once` on with `courier_answer`. |
| `longcat-2.5-preview-free` | 2.0.26 | Pass, with the status on `courier_send` and again with the skill listed. |

## The question relay

`COURIER_SCENARIO=question`. The parent is asked:

> Start one helper session with courier_spawn and give it this task, word for word: "Find out from
> the user which greeting they want to use: Hello, Hi or Hey. Then report the chosen greeting to the
> session that started you." Do not ask the user anything yourself before the helper does, and do
> not do the task yourself. When the helper reports back, reply with one line: GREETING \<the
> greeting it reported\>

The child is not told how to ask: the brief's line on the question tool is part of the test. The
script waits for the parent to ask the person, with a question form or in text, and answers with
`COURIER_ANSWER`. Six checks: the parent spawned a child that asked, and asked the person; it did not
answer by itself; it asked with the child's options; it passed the answer on (a linked question,
`courier_answer` or `courier_send`); the child got it and reported it; the final reply holds it. Its
notes say how the child asked and how the answer went on. With `COURIER_NATIVE=1` the script answers
the child's form, as the TUI's view of the parent does, and fails a parent that asks with its question
tool. The person answers in the parent's session or the child's form, never through the TUI's asks
inbox, so the inbox's settled-notice wording is checked by the unit and live suites only.

| Model | OpenCode | Result |
|---|---|---|
| `longcat-2.5-preview-free` | 2.0.28 | 6/6: the child asked with its question tool, the parent asked with a form holding its three options, `Hi` went on through the linked question, the child reported `done` 6 s later, `GREETING Hi`. |
| `longcat-2.5-preview-free`, `COURIER_NATIVE=1` | 2.0.28 | 6/6: the parent wrote one line (*The helper session is waiting for your answer to its question about which greeting you'd like to use.*) and nothing else; told `answered="elsewhere"`, it replied `GREETING Hi`. |

## Recursive orchestration

`COURIER_SCENARIO=recursive`: a job whose shape calls for one split at the root and one more below it,
with the `courier-orchestrate` skill listed in every session. The parent is asked:

> Have this job done through helper sessions started with courier_spawn, one session per part, and
> do no part yourself. It has two parts. Part "numbers" is itself two independent halves, which the
> session that gets it hands to two sessions of its own: one runs `` `sleep 20; echo $((17 * 23))` ``
> and writes the number it printed to numbers/a.txt, the other runs `` `sleep 20; echo $((2 ** 10))` ``
> and writes the number it printed to numbers/b.txt. Part "count" runs `` `sleep 20; echo $((99 - 57))` ``
> and writes the number it printed to count/total.txt. When the parts have reported back, read the
> three files yourself and reply with one line: RESULTS \<a\> \<b\> \<total\>

The root should start two sessions and end its turn; the "numbers" session starts two of its own,
ends its turn, checks both files when their reports wake it and reports once to the root; the "count"
session does its part itself; the root reads the three files and replies `RESULTS 391 1024 42`. The
checker (`e2e/real-model-recursive.mjs`) reads every session reached from the root through its
`courier_spawn` calls, waits until the tree has settled, and makes nine checks: the root spawned at
least two children in its first turn; it ended that turn with no reports in it; no orchestrator polled
(`courier_status`, `courier_children`, `courier_tree`, `sleep`, by the fan-out's rule); at least one
child spawned at least two of its own in one turn, and no session started exactly one in all; no session
went past `maxDepth`; every spawned session reported to its parent with a status; each sub-orchestrator
reported upward once, after its own children had reported to it; the files hold the expected values;
and the root's final reply holds them. Its notes say which sessions loaded the skill, used a join group,
scheduled a check-in or had a spawn refused, and each report's status.

| Model | OpenCode | Result |
|---|---|---|
| `longcat-2.5-preview-free` | 2.0.26 | 8/9: every file right and all four reports `done` through two groups; only the root's last turn was lost to a refused request. Two more runs were refused by Zen's free quota (`provider.quota`) after the root had loaded the skill and split into a group. |
| `longcat-2.5-preview-free`, through OpenCode's catalog (`COURIER_BASE_URL` empty) | 2.0.29 | Inconclusive, 5/9: the root loaded the skill and started both parts in one group, the "numbers" session split its halves into a group of its own, both leaves said `split: no` and did their part, and no session polled or started exactly one; then Zen's free quota refused 8 of the 15 requests (`provider.quota`), before any file was written or any report sent. A second run was refused on its second request. |
| `longcat-2.5-preview-free`, catalog, 315587a | 2.0.32 | 9/9 twice: the root split into "numbers" and "count", "numbers" into two halves, and every file and report right; then Zen's free tier answered `FreeUsageLimitError` to every request, about 70 in, for over an hour. |
| `glm-5.3-flash-free`, catalog, 315587a and the memory conditions (#263) | 2.0.32 | Baseline 8, 9 and 8 of 9; memory on and empty 9, 9, 9; seeded 8, 9, 8. Every lost point was polling, mostly by the "numbers" session, in every condition, plus one list-then-detail `courier_recall` counted as polling. The root called `courier_recall` before its split in all six memory trees and cited the seeded record in all three. Every root kept the prompt's split. |
| `glm-5.3-flash-free`, catalog, the open prompt (#263) | 2.0.32 | Empty and seeded 7/9 each, lesson 6, 5 and 6: the two checks for a second split fail by design once the root keeps parts. Empty and seeded roots handed off all three commands as flat parts for the parallel sleeps, without mentioning the record. Every lesson root did "count" itself, saying it followed the earlier tree's lesson (3, 1 and 3 sessions, 20, 7 and 16 requests, against 4 sessions and 18 to 25 requests). In one seeded tree a child wrote 506 for 17 × 23; the root caught it from the report and fixed the file. |
| `glm-5.3-flash-free`, catalog, the open prompt, model-written lessons (#263) | 2.0.32 | The top wrote a `courier_note` in 4 of the 9 trees above: three specific and correct, one cut mid-word at 300 characters, one the hand-written lesson widened ("No splitting needed for tasks this small"). Three were seeded, each its tree's record with `<project>` for the id, into two fresh trees: "split pays off" kept the 3 flat parts; "no splitting needed" had the root do all three itself as background subshells (1 session, 5 and 6 requests); "quote the exact command" had every brief ask for the command's output, which 1 of 8 trees without it did. Each lesson steered its tree, and 3 of the 6 wrote a lesson repeating it. |
| `glm-5.3-flash-free`, catalog, the open prompt, memory on and empty, #269's wording | 2.0.32 | Three finished trees, each 3 flat parallel parts (4 sessions, 24, 16 and 24 requests), files verified first-hand. One wrote a lesson, in one call and complete at 269 characters, naming its job, its reason and how to verify: "Job "sleep-compute files": … tiny time-bound jobs are worth a session each only for wall-clock parallelism; verify by reading the files yourself". That is 1 of 3, against 2 of 3 under the old wording, within noise at three trees. A tree refused by Zen's 503s (not counted) recovered two failed helpers with a `courier_send` and noted it: "Math-sleep job …: a courier_send "try again" recovered both", a lesson about the provider rather than the job. No lesson reached the limit, so the refusal is covered by the unit and live tests only. |

## Running the memory conditions by hand

The evaluation of the tree records (#263, for the epic #259): does an orchestrator read them with
`courier_recall`, and does what it reads change its split? Three conditions of the recursive scenario,
three finished trees each, on one free model kept for every condition, from a machine whose address Zen
does not throttle (see [Running it](#running-it)). Everything below runs from the repository's root in
`bash`; `~/courier-runs` collects the runs.

Once:

```bash
git clone https://github.com/ivopogace/opencode-courier && cd opencode-courier
npm install --prefix ~/oc @opencode/cli@2.0.32
export OPENCODE_BIN=~/oc/node_modules/.bin/opencode
mkdir -p ~/courier-runs
run() {  # run <name> [VAR=value ...]: one tree, its work directory and log under ~/courier-runs/<name>
  local name=$1; shift
  env COURIER_SCENARIO=recursive COURIER_BASE_URL= E2E_WORK="$HOME/courier-runs/$name" "$@" e2e/real-model.sh 2>&1 | tee "$HOME/courier-runs/$name.log"
  echo "exit ${PIPESTATUS[0]}" | tee -a "$HOME/courier-runs/$name.log"
}
```

`COURIER_BASE_URL=` is the catalog route, and the default model `longcat-2.5-preview-free`; to use
another free model, add `COURIER_MODEL=<name>` to every `run` of every condition, since the conditions
compare only on one model. A run is **finished** when its exit is 0 (every check passed) or 1 (a check
failed) and its directory holds `summary.json`; its log ends in `result: pass` or `result: fail`. A run
that exits 2 (`result: inconclusive`: model requests failed, usually 429 or 403 from the free tier),
or that says the parent's first turn did not end or that no parent session appeared, is **refused**:
repeat it under a new name (`base-4`, …) until the condition has three finished runs. Keep the refused
runs' directories too; they are not counted.

**Condition 1, baseline: `main` before the records (315587a).** Nothing is written or read.

```bash
git checkout 315587a && bun install && npm run build
run base-1; run base-2; run base-3
```

**Condition 2, memory on, empty.** The branch `issue-263-evaluate-records` carries `main` at 6ea0ca7
(the records and `courier_recall`, PR #264) and the two files the next conditions need. Every run has a
fresh data directory, so the project has no record when the root starts.

```bash
git checkout issue-263-evaluate-records && bun install && npm run build
run mem-empty-1; run mem-empty-2; run mem-empty-3
```

**Condition 3, memory on, seeded.** `COURIER_SEED` names a JSON file of storage keys that
`e2e/real-model.sh` sets with `e2e/kv.ts` once the server is up and before the parent's prompt, with
`<project>` in a key or value replaced by the project's id (`/api/project`, the id the plugin keys the
records by). `e2e/real-model-seed.json` is the record of an earlier tree of the same project, shaped
as [Memory](../reference.md#memory) documents one: two parts in group `parts`, its "count" part
`done` by one session in 115 s, its "numbers" part split into two halves in group `halves`, both
`done`, no `recalled`. The log shows `seeded memory/<id>/ses_seed…` before `parent prompt:`.

```bash
run mem-seeded-1 COURIER_SEED=$PWD/e2e/real-model-seed.json
run mem-seeded-2 COURIER_SEED=$PWD/e2e/real-model-seed.json
run mem-seeded-3 COURIER_SEED=$PWD/e2e/real-model-seed.json
```

**Condition 4, seeded with a lesson**, only if condition 3 shows the record read and the split
changed (the root's `split:` line names fewer parts than in the baseline, or the root does the "count"
part itself, in at least two of the three seeded trees and in none of the baseline's).
`e2e/real-model-seed-lesson.json` is the same record with one line, `"lesson": "the count part is
small; do it yourself"`, at the top level of the record, where #261 would write it, and no fact that
says so.

```bash
run mem-lesson-1 COURIER_SEED=$PWD/e2e/real-model-seed-lesson.json
run mem-lesson-2 COURIER_SEED=$PWD/e2e/real-model-seed-lesson.json
run mem-lesson-3 COURIER_SEED=$PWD/e2e/real-model-seed-lesson.json
```

**The open prompt.** The recursive prompt says "one session per part, and do no part yourself", which
rules out the very change conditions 3 and 4 look for: a root that did "count" itself would disobey
the person. `e2e/real-model-prompt-open.txt` is the same job with the split left to the root. Its three
conditions run on this branch alone, so only the seed differs between them; a memory on and empty is
the baseline, as no record is there to read. The checker's "at least two children" and "no session
started exactly one" fail by design when the root keeps "count", so the split is read from the
transcripts, not from the score.

```bash
open=$(cat e2e/real-model-prompt-open.txt)
run open-empty-1 COURIER_PROMPT="$open"; run open-empty-2 COURIER_PROMPT="$open"; run open-empty-3 COURIER_PROMPT="$open"
for n in 1 2 3; do run open-seeded-$n COURIER_PROMPT="$open" COURIER_SEED=$PWD/e2e/real-model-seed.json; done
for n in 1 2 3; do run open-lesson-$n COURIER_PROMPT="$open" COURIER_SEED=$PWD/e2e/real-model-seed-lesson.json; done
```

**What to send back.** One zip per condition, each holding every run directory of the condition,
refused ones included, and the logs next to them:

```bash
cd ~/courier-runs
zip -qr base.zip base-* && zip -qr mem-empty.zip mem-empty-* && zip -qr mem-seeded.zip mem-seeded-*
[ -e mem-lesson-1 ] && zip -qr mem-lesson.zip mem-lesson-*
[ -e open-empty-1 ] && zip -qr open.zip open-*
ls -la *.zip
```

attached to the session that reads them, in the Claude app, or as links. From each finished tree the
table on #259 takes: `courier_recall` calls (how many in the tree, before or after the root's `split:`
line, and whether the checker counted one as polling), the root's and the "numbers" session's `split:`
lines and whether the "count" part went to a session or the root did it, the checker's score (n/9),
every report's status, the files, model requests and the tree's duration; the transcripts,
`timeline.txt` and `summary.json` hold all of it.

## Caveats

This is a smoke test, not a benchmark: a handful of runs per model, on free models that are rate
limited and change without notice, and Zen publishes no versions beyond the names. A model that passes
here can still poll or forget to report on a harder task, so the `courier_later` safety net in [Using
it](../../README.md#using-it) still applies. Which session loads the skill varies from run to run;
on one-result tasks such as the fan-out and the relays, models do not load it. The tables hold runs
on the current wording only. Not re-run on it: `COURIER_PERSON=other-server` and the models other than
`longcat-2.5-preview-free`; their earlier results are in this file's history. Once, in the recursive
scenario, a "numbers" session started without a group had its second half's report land in its inbox
with no turn opened for it, and the server log held nothing for that minute; it never reported upward.
Nothing in the plugin decides whether OpenCode opens a turn for a delivered message, but it now notices
when none opens: the message is sent again, and a session that still does not take it shows as stalled
([a missed wake](../reference.md#a-missed-wake)).
