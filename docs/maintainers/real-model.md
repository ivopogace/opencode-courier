# Smoke test with a real model

`e2e/run.sh` proves the plumbing with a scripted model. `e2e/real-model.sh` checks that a real model
uses the tools as meant: the parent spawns instead of doing the work, ends its turn instead of
polling, each child reports with a status, and each report wakes the parent. It is not in CI.
Re-run it after any change to a model-facing string: `src/**/text.ts`, `src/kernel/protocol.ts`,
`src/skill.ts` or a tool description.

The tables below are one batch, measured at af27ef7 on OpenCode 2.2.6 with a self-hosted model behind
an OpenAI-compatible endpoint and `COURIER_TIMEOUT=600`, except [Words against a task](#words-against-a-task),
measured at e4addb9 the same way. A new batch replaces them. A scenario with no table has no result in
this batch.

## Running it

```bash
bun install
npm install --prefix <scratch>/oc @opencode/cli@2.2.6
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/real-model.sh
```

It uses the same throwaway server as `run.sh`, with the local build. The default model,
`opencode/deepseek-v4.1-flash-free`, is free on [OpenCode Zen](https://opencode.ai/zen) and needs no
key. Zen's free models come and go: `opencode models opencode` lists the current ones. Free models
are rate limited; check Zen's terms before sending anything private.

The free tier counts messages per public address, per day. A cloud session reaches it through a
proxy address shared with other sessions, so even its first request is refused ("You've used today's
free messages"): run it from your own machine, or with a paid provider's key.

| Variable | Default | |
|---|---|---|
| `COURIER_PROVIDER`, `COURIER_MODEL` | `opencode`, `deepseek-v4.1-flash-free` | The model, as OpenCode names it in its catalog, with the provider's usual key variable. |
| `COURIER_BASE_URL` | | Declares the provider as an OpenAI-compatible endpoint, for a model not in the catalog. Zen's free tier refuses its own endpoint declared so (403, `FreeTierError`). |
| `COURIER_API_KEY_ENV` | | For a declared provider, the variable holding its key (written as `{env:NAME}`, never to a file). |
| `COURIER_SCENARIO` | the fan-out | `permission`, `question`, `recursive`, `recursive-fault`, `recursive-staged`, `recursive-finding`, `recursive-conflict` or `review`. |
| `COURIER_PROMPT`, `COURIER_EXPECT` | per scenario | The parent's prompt, and the values the reports and the reply must hold. |
| `COURIER_FILES` | per scenario | Recursive scenarios: the files that must hold those values, in order; for `recursive-staged` the first is the core's. |
| `COURIER_MAX_DEPTH` | `5` | Recursive scenarios: the `maxDepth` the checker holds the tree to. |
| `COURIER_TEST_COMMAND` | `npm test` | `review`: the command the checker runs the project's tests with, in the root's checkout. |
| `COURIER_TESTS` | `5` | `review`: how many tests must pass there, the fixture's two and the three the job asks for. |
| `COURIER_SKILL` | | `deny` denies `courier-orchestrate` in `permissions`, so no session can load it. |
| `COURIER_PERSON` | | `other-server`, with `permission`: the person answers through a second server. |
| `COURIER_ANSWER` | `Hi` | With `question`: the option the person picks. |
| `COURIER_NATIVE` | | `1` turns `nativeChildren` on, so every child is native unless the spawn says `native: false`. |
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

### No sleeps

The fan-out and recursive prompts give each command as it is, with no `sleep` standing in for work.
`recursive-finding`'s parts wait on files the checker creates (below).
A report that reaches a parent while its turn still runs is
steered into that turn, and the checkers count it as delivered: the first turn may hold reports, and
one look after each report, in a turn of its own or steered in, is not polling.

## The fan-out

The default. The parent is asked:

> Have two helper sessions work in parallel and report back to you. One runs the shell command
> `` `echo $((17 * 23))` ``, the other runs `` `echo $((2 ** 10))` ``, and each reports the number it
> printed. Start them with courier_spawn and do not run the commands yourself. When both have reported back, reply with one line: RESULTS \<first\> \<second\>

Eight checks: two children spawned; the first turn ended after spawning; no polling (a
`courier_children`, `courier_tree` or `sleep` right after spawning, or more than one after a
report); both children reported to the parent; both reports reached it, waking it or steered into
its running turn, and got a reply; each carries a status and its answer; the reply holds both. The
README's Quickstart prompt is a shorter wording with sleeps, which keep the children busy past the
parent's first turn so that each report visibly wakes it: set `COURIER_PROMPT` to it. To check a join group, add *both in one join group named "pair"*.

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
a native child the script answers the child's request directly, as OpenCode's view of the parent
would, and makes six checks: the parent was told with the `shown="native"` notice; it neither
answered nor asked again; the request was settled (the parent was told so, or passed `once` on with
`courier_answer` after the person told it to); the child reported; the reply holds it. A child is
native with `COURIER_NATIVE=1`, or when the parent spawns it with `native: true` on its own, which
the checker reads from the spawn or the notice.

`--saved` re-reads a run. What only the live run saw, OpenCode's prompt or form in the parent's
session, is kept in `summary.json` under `observed`. A `summary.json` without it has it read from the
transcript, a `courier_answer` proposing `once` in the parent's turn after the notice standing for
the held prompt.

| Condition | Result |
|---|---|
| skill listed | 3 of 3 passed, 7/7 each. |

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

| Condition | Result |
|---|---|
| skill listed | 3 of 3 passed, 6/6 each. |

## Recursive orchestration

`COURIER_SCENARIO=recursive`: one split at the root and one more below it. The parent is asked:

> Have this job done through helper sessions started with courier_spawn, one session per part, and
> do no part yourself. It has two parts. Part "numbers" is itself two independent halves, which the
> session that gets it hands to two sessions of its own: one runs `` `echo $((17 * 23))` `` and writes
> the number it printed to numbers/a.txt, the other runs `` `echo $((2 ** 10))` `` and writes the
> number it printed to numbers/b.txt. Part "count" runs `` `echo $((99 - 57))` `` and writes the number it printed to count/total.txt. When the parts have reported back, read the
> three files yourself and reply with one line: RESULTS \<a\> \<b\> \<total\>

The checker (`e2e/real-model-recursive.mjs`) reads every session reached from the root and makes
nine checks: the root spawned two or more in its first turn and ended it, reports steered into it
allowed; no orchestrator polled (the root's one `courier_recall` before its split is allowed, a
sub-orchestrator's is not, and one look after each report); a
child spawned two or more of its own in one turn, and no sub-orchestrator started exactly one without
a tool call of its own before it (a heuristic for a verifier that starts one implementor: the
transcript shows work, not what it was for); no
session went past `maxDepth`; every session reported with a status; each sub-orchestrator reported
once, after its children (a child whose report was sent but held in a group still counts, so one
that reports in the turn that started its group passes); the files and the reply hold the values. Its notes say who loaded the skill
and when, who used a group, a check-in or had a spawn refused.

`e2e/real-model-prompt-open.txt` leaves the split to the root. With it, the "two or more children"
checks fail by design when the root keeps a part, so read the split from the transcripts. The
scripted prompt fixes the split, so it cannot show what `courier_recall` is worth; the open prompt
with a seeded record can.

| Condition | Result |
|---|---|
| skill listed | 3 of 3 passed, 9/9 each, mean 31 requests (31 to 32). |
| `COURIER_SKILL=deny` | 3 of 3 passed, 9/9 each, mean 27 requests (26 to 28). |

## A part that goes wrong

`COURIER_SCENARIO=recursive-fault`: the recursive job with one half told to report `partial` first,
then finish when its parent says so. It tests the skill's steps 4 to 6. The prompt passes that half
its task word for word:

> Have this job done through helper sessions started with courier_spawn, one session per part, and
> do no part yourself. It has two parts. Part "numbers" is itself two independent halves, which the
> session that gets it hands to two sessions of its own, doing neither half itself: one runs
> `` `echo $((17 * 23))` `` and writes the number it printed to numbers/a.txt; the other gets
> this task, passed on word for word: "Run `` `echo $((2 ** 10))` ``. Do not write any file
> yet: report status partial with the number it printed, saying that writing it to numbers/b.txt is
> left, and end your turn. Once the session that started you sends you a message to finish, write the
> number to numbers/b.txt and report status done." Part "count" runs `` `echo $((99 - 57))` ``
> and writes the number it printed to count/total.txt. When the parts have reported back, read the
> three files yourself and reply with one line: RESULTS \<a\> \<b\> \<total\>

The checker runs with `--fault` (recorded in `summary.json`, so `--saved` repeats it): the nine
checks, then four. The faulty session is found by its first non-`done` report: the fault reached a
leaf; its parent messaged it after the leaf's first message that was not `done` and before reporting
upward; it then reported `done`; its parent reported upward once, `done`. That first message is a
report or a message without a status, counted from when the leaf sent it, so a parent that reads a
report held in a group from its standing and answers before the group delivers it passes. "Session …
reported 2 times" is expected for it.

| Condition | Result |
|---|---|
| `recursive-fault`, skill listed | 3 of 3 passed, 13/13 each, mean 33 requests (32 to 34). |
| `recursive-fault`, `COURIER_SKILL=deny` | 3 of 3 passed, 13/13 each, mean 31 requests (30 to 32). |

## A part with a core

`COURIER_SCENARIO=recursive-staged`: the "numbers" part has a seed both halves need, so a correct
session does the seed first, then starts the halves together. The prompt does not say to:

> Have this job done through helper sessions started with courier_spawn, one session per part, and
> do no part yourself. It has two parts. Part "numbers" has a seed and two halves; the session that
> gets it hands the halves to two sessions of its own. The seed: run `` `echo $((7 * 61))` ``
> and write the number it printed to numbers/seed.txt. The halves each read the seed from
> numbers/seed.txt: one writes the seed times 17 to numbers/a.txt, the other writes the seed plus 1000
> to numbers/b.txt. Part "count" runs `` `echo $((99 - 57))` `` and writes the number it
> printed to count/total.txt. When the parts have reported back, read the four files yourself and
> reply with one line: RESULTS \<seed\> \<a\> \<b\> \<total\>

The checker runs with `--staged`: the nine checks, then three. A `sleep` before any spawn, in a prompt
that has one, is the core's work, not polling. The core is found by the first write of its file (`write`, `edit`, `patch`,
or a shell redirect; `cd numbers && echo … > seed.txt` is not seen). The checks: no half started
before the seed was written (or its session reported); the session that staged started two or more
halves together; it reported upward once, `done`.

Run it with the skill and without, several runs each, and table them. The skill says nothing about staging, so the pair shows whether staging depends on it:

```bash
run() {  # run <name> [VAR=value ...]
  local name=$1; shift
  env COURIER_SCENARIO=recursive-staged E2E_WORK="$HOME/courier-runs/$name" "$@" e2e/real-model.sh 2>&1 | tee "$HOME/courier-runs/$name.log"
  echo "exit ${PIPESTATUS[0]}" | tee -a "$HOME/courier-runs/$name.log"
}
for n in 1 2 3 4 5; do run staged-skill-$n; run staged-noskill-$n COURIER_SKILL=deny; done
bun script/real-model-table.ts $(for n in 1 2 3 4 5; do echo skill=$HOME/courier-runs/staged-skill-$n noskill=$HOME/courier-runs/staged-noskill-$n; done)
```

## A finding passed on

`COURIER_SCENARIO=recursive-finding`: the recursive job with parts that wait on files before they
print: the "count" session must still be running when the person writes, and the halves when the
finding has come down two levels. The checker, run with `--finding`, plays the person: once the
"count" session's turn runs, it prompts that session that every file of the job must hold its number
followed by ` checked`, then creates `.go-count`, which lets that part go on. Once each session the
other part started has been sent a message without a status after the finding reached that part, or
was started after it with the finding in its task, it
creates `.go-halves`, which lets the halves go on. Each wait ends after 150 s if its file never
comes. The prompt says another process creates those files and no session touches them, so a run's
timeline shows whether one did. Neither the prompt nor the person's message says to pass the finding on: the plugin
passes it up, and the skill says to pass it on to the parts it changes.

The checks: the nine, with each file holding `<number> checked`, then four. The person's message
reached the "count" session; the root holds the plugin's `route="prompt"` envelope naming that
session; the root passed the words on, without a status, to the other part after the envelope; that
part's session passed them on to each of its halves, by message or in the task of a half started
after they arrived. Notes say whether the "count" session also sent the words up itself, and quote
every message to it after the envelope.

```bash
run() {  # run <name> [VAR=value ...]
  local name=$1; shift
  env COURIER_SCENARIO=recursive-finding E2E_WORK="$HOME/courier-runs/$name" "$@" e2e/real-model.sh 2>&1 | tee "$HOME/courier-runs/$name.log"
  echo "exit ${PIPESTATUS[0]}" | tee -a "$HOME/courier-runs/$name.log"
}
for n in 1 2 3; do run finding-skill-$n; run finding-noskill-$n COURIER_SKILL=deny; done
bun script/real-model-table.ts $(for n in 1 2 3; do echo skill=$HOME/courier-runs/finding-skill-$n noskill=$HOME/courier-runs/finding-noskill-$n; done)
```

A slow model needs `COURIER_TIMEOUT=600`: with steps of 20 s or more the default wait gives up while
a sub-orchestrator's wake turn still runs.

| Condition | Result |
|---|---|
| skill listed | 3 of 3 passed, 13/13 each, mean 34 requests (31 to 39). |

## Words against a task

`COURIER_SCENARIO=recursive-conflict`: a smoke check of the `route="prompt"` envelope's wording against
text that contradicts a session's task, run five times. It measures no wording against another. The
prompt is [A finding passed on](#a-finding-passed-on)'s, and the checker, run with `--conflict`, plays
the person. It creates `.go-count` as soon as the "count" session runs. It finds the half for
`numbers/b.txt` at depth 2 by `2 ** 10` or `numbers/b.txt` in its task, and once that half has an
assistant message and no settled report, prompts it:

> Do not write numbers/b.txt. Print the number and report it to the session that started you; that
> file is handled outside this job.

then creates `.go-halves`. The item is delivered at the half's step after its wait ends, so the
sessions above read the envelope after the half has started acting on the words.

The checks: the seven of the recursive set that do not read the files or the reply, then six. The
files hold `391` and `42` and `numbers/b.txt` does not exist; the half's report to its parent holds
`1024`; the root's final reply names the file and says why it was left; the words reached the half as
a `user` item; the envelope naming the half reached the session that started it and the root; no
session wrote `numbers/b.txt`.

Every message to the half after the envelope is quoted in the notes. Those matching
`/write .*b\.txt/i`, `/as your task says/i`, `/finish your task/i` or `/still required/i` are marked
`possible countermand`. The mark is no check: a message that repeats the person's words matches the
first pattern too.

**The person's step.** A person reads the quoted messages of each run and records here how many are
countermands, messages telling the half to drop the text and do its task as given. That count, not
the marks, is what the check is read by.

**The reading.** A countermand, or a session replacing `numbers/b.txt`, in two or more of the five
runs reopens the wording: the sentence "It decides what the text means for its part." goes after
"acts on it." in `typedNotice` and is checked the same way, five runs. Fewer than two leaves the text
as it is.

```bash
for n in 1 2 3 4 5; do
  env COURIER_SCENARIO=recursive-conflict E2E_WORK="$HOME/courier-runs/conflict-$n" e2e/real-model.sh 2>&1 | tee "$HOME/courier-runs/conflict-$n.log"
done
```

| Condition | Result |
|---|---|
| skill listed | 3 of 5 passed, 13/13 three times, 12/13 and 5/13 once each, mean 30 requests (25 to 33). No countermand and no replaced file in the four runs that reached the conflict, so the text stays as it is. The 12/13 is the check that every session reported with a status. In the 5/13 the root started the halves itself, so the words never reached a half at depth 2. |

## A change and its review

`COURIER_SCENARIO=review`: a code change, reviewed by a session with fresh context, then fixed and
checked. The project is `e2e/fixtures/review-project`, a Node module with one function and two
tests that run with `npm test`, committed into the work directory so that an isolated session's
worktree holds it. The parent is asked:

> The tests of this project run with `npm test`. The job: add a function `slugify(text)` to
> lib/words.js, exported like the one already there, that lower-cases the text, turns every run of
> characters other than letters and digits into one hyphen and strips hyphens from both ends, so that
> "Hello, World!" gives "hello-world"; with tests for it in test/words.test.js, at least three, one of
> them for text with punctuation at both ends. Do none of the work yourself. First, one helper session
> started with courier_spawn makes the change and reports. Once it has reported, one review session
> with fresh context, started with courier_spawn, reads the change against this job, changes nothing
> and reports what it found. Then have any finding that holds fixed by a helper session. Finally run
> `npm test` yourself and reply with one line: REVIEWED \<the number of passing tests\>

The shape is in the prompt, so the plugin's tools are under test and not a playbook; which agent
each stage ran with is a note. The checker (`e2e/real-model-review.mjs`) tells the stages apart by
order at the root: the sessions started before any report are the change, the first started after
that report is the review, those started after the review's report are the fix. It runs the
project's tests itself in the root's checkout (`COURIER_TEST_COMMAND`; the runner's output goes to
`tests.txt`, and the totals are read from node's TAP or spec reporter) and makes ten checks: a session for the change in the first turn, which ended with no
report in it; a review session in a later turn; the review session and anything it started changed
nothing (no `write`, `edit` or `patch`, no shell command that commits, stages, installs, edits in
place or redirects into a file); its report reached the root before the final reply; no polling;
every session reported with a status; the root ran the tests itself after the review's report; the
files exist and the first holds the symbol (`COURIER_EXPECT`); the tests pass, `COURIER_TESTS` or
more; the reply holds `REVIEWED` and that number. Its notes say, per session the root started, which
stage it was, its agent, isolation and group; what the change made and committed; what the review
read and ran and what it reported; what the root did after the review, itself or through sessions.

## Seeding a record

`COURIER_SEED` names a JSON file of storage keys, `{ "<key>": <value> }`, set with `e2e/kv.ts`
before the parent's prompt. `<project>` in a key or value stands for the project's id. The log shows
`seeded memory/<id>/…` before `parent prompt:`. Three seeds are checked in:
`e2e/real-model-seed.json`, an earlier tree's record; `e2e/real-model-seed-lesson.json`, the
same with the lesson "the count part is small; do it yourself"; and
`e2e/real-model-seed-lesson-halves.json`, the same with "halves of a list are too small to spawn;
do them yourself", a lesson only the "numbers" session of the recursive scenario can act on, which
reaches it through the `lessons` entry alone, as a spawned session calls no `courier_recall`.

A run is **finished** when it exits 0 or 1 and has a `summary.json`. Repeat a run that exits 2, or
whose first turn did not end, under a new name. To compare conditions, keep one model and run each
several times:

```bash
run() {  # run <name> [VAR=value ...]: work directory and log under ~/courier-runs/<name>
  local name=$1; shift
  env COURIER_SCENARIO=recursive E2E_WORK="$HOME/courier-runs/$name" "$@" e2e/real-model.sh 2>&1 | tee "$HOME/courier-runs/$name.log"
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
join groups, polled sessions, requests, the cache read tokens per request (the provider's prompt
cache hits over the whole tree, `-` for a summary written before they were kept), the uncached input
tokens per request (what the provider read anew), the duration and
the `split:` lines. A line under each table gives the means over its finished runs. The cache
column is what a change to the role part is judged by: compare it before and after, on one model.

**How many runs a claim needs.** A claim such as "the polling went away" is about a rate. Five
finished runs per condition on each of two models is the floor; with fewer, call the result an
observation. Pick the metric and the conditions before changing a wording, and read the same columns
after.

## Caveats

This is a smoke test, not a benchmark: a few runs on one model. A
model that passes here can still poll or forget to report on a harder task, so a `courier_later`
check-in still pays. Which session loads the skill varies from run to run; on one-result tasks,
models do not load it. No table reaches the five-run floor on two models. No results for: the fan-out, `permission` with
`COURIER_PERSON=other-server`, `recursive-staged` and `review`.
