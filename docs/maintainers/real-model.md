# Smoke test with a real model

`e2e/run.sh` proves the plumbing with a scripted model. `e2e/real-model.sh` checks that a real model
uses the tools as meant: the parent spawns instead of doing the work, ends its turn instead of
polling, each child reports with a status, and each report wakes the parent. It is not in CI.
Re-run it after any change to a model-facing string: `src/**/text.ts`, `src/kernel/protocol.ts`,
`src/skill.ts` or a tool description.

Its results stay with the person who ran it: they go in no pull request, issue or document.

## Running it

```bash
bun install
npm install --prefix <scratch>/oc @opencode/cli@2.3.0
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
| `COURIER_SCENARIO` | the fan-out | `permission`, `question`, `recursive`, `recursive-fault`, `recursive-staged`, `recursive-finding`, `recursive-conflict`, `discovery` or `review`. |
| `COURIER_PROMPT`, `COURIER_EXPECT` | per scenario | The parent's prompt, and the values the reports and the reply must hold. |
| `COURIER_FILES` | per scenario | Recursive scenarios and `discovery`: the files that must hold those values, in order; for `recursive-staged` the first is the core's. |
| `COURIER_MAX_DEPTH` | `5` | Recursive scenarios: the `maxDepth` the checker holds the tree to. |
| `COURIER_TEST_COMMAND` | `npm test` | `review`: the command the checker runs the project's tests with, in the root's checkout. |
| `COURIER_TESTS` | `5` | `review`: how many tests must pass there, the fixture's two and the three the job asks for. |
| `COURIER_SKILL` | | `deny` denies `courier-orchestrate` in `permissions`, so no session can load it. |
| `COURIER_PERSON` | | `other-server`, with `permission`: the person answers through a second server. |
| `COURIER_ANSWER` | `Hi` | With `question`: the option the person picks. |
| `COURIER_TIMEOUT` | `300` | Seconds to wait for the parent's first turn, then for the children. A slow model needs `600`. |
| `E2E_WORK` | a new temp dir | Where the transcripts and logs go. |

Each run prints a timeline of every session's turns and tool calls, its checks and notes. It keeps
`parent.json`, `child-<id>.json`, `timeline.txt`, `summary.json` and the server log in the work
directory. The exit code is 0 when every check passes, 1 when one fails, and 2 when checks fail and
model requests failed too (usually a 429): run it again. Use a plainly named work directory: a model
that copies a long, odd path into a task gets it wrong.

The prompts are in `e2e/real-model.sh`, the checks in the `e2e/real-model*.mjs` checkers; the run
prints each check by name. A checker given `--saved` re-reads a run's saved transcripts instead of
asking the server.

### Reading a stall

The server runs at `--log-level debug` with `e2e/probe-plugin` loaded. To trace a session that
stops moving:

- `timeline.txt` gives each step and tool call with start and end times. A long gap between a tool's
  end and the next step is visible; a step shown as `…` is a request with no answer.
- `server.log` logs no line per provider request, only failures (`Failed to drain Session`). No
  error after the tool's end says nothing.
- `probe.log` has one JSON line per event (`at`, `type`, `sessionID`). No events for the session
  after the tool's end means the server did nothing.

### What counts as polling

The prompts give each command as it is, with no `sleep` standing in for work. A report that reaches
a parent while its turn still runs is steered into that turn and counts as delivered: one look after
each report, in a turn of its own or steered in, is not polling. A `courier_tree` call before the
session's first `courier_spawn` is not polling either; one after the first spawn and before any
report is.

## The fan-out

The default: two children each run one command and report; the parent ends its turn after
spawning and replies once both reports are in. The README's Quickstart prompt is a shorter wording
with sleeps, which keep the children busy past the parent's first turn so that each report visibly
wakes it: set `COURIER_PROMPT` to it.

## The permission relay

`COURIER_SCENARIO=permission`. The child's command needs a permission; the script plays the person
and allows OpenCode's prompt in the parent's session. It checks that the parent is told, passes
nothing on before the person answers, and passes `once` on after. The parent is started over the
HTTP API, since `opencode run` answers its own session's prompts.

`COURIER_PERSON=other-server` has the person answer through a second server, whose `courier_answer`
holds no request, so the check becomes that it named the other server. With a native child (the
parent passed `native: true` on its own) the script answers in the child's session, as OpenCode's
view of the parent would, and checks the `shown="native"` notice instead.

What only the live run saw, OpenCode's prompt or form in the parent's session, is kept in
`summary.json` under `observed` for `--saved`.

## The question relay

`COURIER_SCENARIO=question`. The child must ask the person a question; it is not told how, so the
brief's line on the question tool is under test. The script answers with `COURIER_ANSWER` when the
parent asks, and checks that the parent relayed the child's options and the answer rather than
answering itself.

## Recursive orchestration

`COURIER_SCENARIO=recursive`: one split at the root and one more below it. The checker
(`e2e/real-model-recursive.mjs`) reads every session reached from the root: the root spawns two or more
children in its first turn and a child two or more of its own in one turn, nobody polls, no session goes past `maxDepth`, every session reports with a status,
each sub-orchestrator reports once after its children, and the files and the reply hold the values.
A sub-orchestrator that starts exactly one child with no tool call of its own before it fails (a
heuristic for a verifier that starts one implementor). Its notes say who loaded the skill and when,
and who used a check-in or had a spawn refused.

`e2e/real-model-prompt-open.txt` leaves the split to the root. With it, the "two or more children"
checks fail by design when the root keeps a part, so read the split from the transcripts.

## A part that goes wrong

`COURIER_SCENARIO=recursive-fault`: one half is told to report `partial` first and finish when its
parent says so. It tests the skill's steps 4 to 6: the parent messages the leaf before reporting
upward, the leaf then reports `done`, and the parent reports upward once. A parent that answers the
leaf from what `courier_tree` shows, before the report has reached it, passes. "Session …
reported 2 times" is expected for the leaf.

## A part with a core

`COURIER_SCENARIO=recursive-staged`: the "numbers" part has a seed both halves need, so a correct
session writes the seed first, then starts the halves together. The prompt does not say to, and
neither does the skill, so run it with the skill and without (`COURIER_SKILL=deny`), several runs
each, to see whether staging depends on it. A `sleep` before any spawn is the core's work, not
polling. The core is found by the first write of its file; a `cd numbers && echo … > seed.txt` is not
seen.

## A finding passed on

`COURIER_SCENARIO=recursive-finding`: the person sends the "count" session a new requirement
mid-run; the plugin passes it up, and the skill says to pass it on to the parts it changes. The
parts wait on files (`.go-count`, `.go-halves`) that the checker creates once the finding has come
down far enough, so the sessions are still running when it arrives. The checks follow the words: the
root got the plugin's `route="prompt"` envelope and passed them on, without a status, to the other
part, which passed them on to each of its halves.

A failing run waits out no timeout: once nothing can move before the waits run out, the checker
creates the files itself, and the log names where the finding stopped. That decision is `releaseOf`
in `e2e/real-model-recursive-release.mjs`. The 150 s in each command only bounds a wait whose
checker has stopped.

## Words against a task

`COURIER_SCENARIO=recursive-conflict`: a smoke check of the `route="prompt"` envelope's wording
against text that contradicts a session's task, run five times. It measures no wording against
another. It uses [A finding passed on](#a-finding-passed-on)'s job and release; the person tells the
half for `numbers/b.txt` not to write that file. The checks: the file is not written, the half still
reports its number, and the root's reply says why the file was left.

Every message to the half after the envelope is quoted in the notes, and those that look like an
order to write the file anyway are marked `possible countermand`. The mark is no check: a message
that repeats the person's words matches too.

**The person's step.** A person reads the quoted messages of each run and records how many are
countermands, messages telling the half to drop the text and do its task as given. That count, not
the marks, is what the check is read by.

**The reading.** A countermand, or a session replacing `numbers/b.txt`, in two or more of the five
runs reopens the wording of `typedNotice`, which says after "acts on it." that the session "decides
what the text means for its part"; a new wording is checked the same way, five runs. Fewer than two
leaves the text as it is.

## A finding a session makes

`COURIER_SCENARIO=discovery`: three parts side by side; "init" makes a key the other two need. In
[A finding passed on](#a-finding-passed-on) the person brings the finding; here a session meets it
in its own work. The fixture `e2e/fixtures/discovery-project` makes the key at random, so no session
can know it beforehand: it reaches the others through courier or not at all. Nothing in the prompt
says to tell anyone; the brief tells the "init" session to send its parent what others need, and the
skill tells the root to pass it on. The checker (`e2e/real-model-discovery.mjs`) releases the
waiting parts once the root has passed the key on, or once it no longer can.

The `finding:` note, and `finding` in `summary.json`, give what a batch counts: whether the key
reached the root, how many parts had it before they reported, and how many turns the root took. A
root that runs "init" first and starts the others after its report fails only the check that the root spawned the three parts in its first turn, and
the notes call it staged. The key is not wholly out of reach: the work directory above the project
holds the server's log with the "init" shell output, so the notes name a part that went looking
there, whose file then does not show the relay.

## A change and its review

`COURIER_SCENARIO=review`: a code change in `e2e/fixtures/review-project`, reviewed by a session
with fresh context, then fixed and checked. The shape is in the prompt, so the plugin's tools are
under test and not a playbook. The checker (`e2e/real-model-review.mjs`) tells the stages apart by
order at the root, checks that the review session and anything it started changed nothing, and runs
the project's tests itself in the root's checkout (`COURIER_TEST_COMMAND`, output in `tests.txt`).
Its notes give each stage's agent and isolation and what the review read, ran and reported.

## Comparing conditions

A run is **finished** when it exits 0 or 1 and has a `summary.json`. Repeat a run that exits 2, or
whose first turn did not end, under a new name. To compare conditions, keep one model and run each
several times:

```bash
run() {  # run <name> [VAR=value ...]: work directory and log under ~/courier-runs/<name>
  local name=$1; shift
  env E2E_WORK="$HOME/courier-runs/$name" "$@" e2e/real-model.sh 2>&1 | tee "$HOME/courier-runs/$name.log"
  echo "exit ${PIPESTATUS[0]}" | tee -a "$HOME/courier-runs/$name.log"
}
run base-1 COURIER_SCENARIO=recursive
run open-1 COURIER_SCENARIO=recursive COURIER_PROMPT="$(cat e2e/real-model-prompt-open.txt)"
for n in 1 2 3 4 5; do
  run staged-skill-$n COURIER_SCENARIO=recursive-staged
  run staged-noskill-$n COURIER_SCENARIO=recursive-staged COURIER_SKILL=deny
done
```

### Reading many runs

`script/real-model-table.ts` prints one Markdown table per condition, a row per run directory:

```bash
bun script/real-model-table.ts baseline=$HOME/courier-runs/base-1 open=$HOME/courier-runs/open-1
bun script/real-model-table.ts $HOME/courier-runs/*   # no label: each directory is its own condition
```

A label before `=` names the condition; several directories may share one. Each row has the
verdict, the score, skill loads per depth, polled sessions, requests, the cache read and uncached
input tokens per request, the duration and the `split:` lines; a line under each table gives the
means over its finished runs. The cache column is what a change to the role part is judged by:
compare it before and after, on one model.

**How many runs a claim needs.** A claim such as "the polling went away" is about a rate. Five
finished runs per condition on each of two models is the floor; with fewer, call the result an
observation. Pick the metric and the conditions before changing a wording, and read the same columns
after.

## Caveats

This is a smoke test, not a benchmark: a few runs on one model. A model that passes here can still
poll or forget to report on a harder task, so a `courier_later` check-in still pays. Which session
loads the skill varies from run to run; on one-result tasks, models do not load it.
