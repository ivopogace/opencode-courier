# Smoke test with a real model

`e2e/run.sh` proves the plumbing with a scripted model. `e2e/real-model.sh` checks that a real
model uses the tools as intended: the parent spawns sessions instead of doing the work itself, it
ends its turn instead of waiting or polling, each child calls `courier_send` before it stops, and
each report wakes the idle parent. It is not part of CI.

## Running it

```bash
bun install
npm install --prefix <scratch>/oc @opencode/cli@2.0.24
OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/real-model.sh
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
| `COURIER_PERSON` | | `other-server`, with `COURIER_SCENARIO=permission`: the person answers the parent through a second server on the same data directory (see below). |
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
  PASS the parent did not poll its children (courier_status, courier_children, sleep)
  PASS both children called courier_send to the parent
  PASS both reports woke the parent: each arrived after its first turn and got a reply
  PASS each report holds its child's answer
  PASS the parent's final reply holds both answers
  usage: 12 model requests, 25460 input / 891 output / 662 reasoning tokens, 75136 cache reads, ...
result: pass
```

`opencode2 v0.0.0-beta-19271` records no marker when a session goes idle, so turns are read from
the transcript: a delivered message opens a new turn when the session's last step had ended its
turn (a finish reason other than `tool-calls`, or a failed request) and completed before the
message arrived; otherwise it was steered into the running turn. Since `opencode v2.0.22` the
transcript records an `idle` message when a turn ends (with its `outcome`), which the checkers
take as the end of a turn too. Polling means any
`courier_status`, `courier_children` or `sleep` in the first turn, right after spawning, or more
than one in a later turn; a single look after being woken is what `courier_status` is for, and is
only noted. A report is a `courier_send` from a child; a `courier_later` check-in does not count.
The work directory keeps `parent.json`, `child-<id>.json`,
`timeline.txt`, `summary.json` and the server log. The exit code is 0 when every check passes and
1 when one fails. It is 2 when checks fail and model requests failed too, usually HTTP 429 from a
free model, because then the run says more about the provider than the plugin; run it again.

## What the models did

27 runs on 2026-10-03, all with `opencode2 v0.0.0-beta-19271` and the plugin built from this
branch, against free models on Zen (which publishes no versions beyond the names):

| Model | Runs | Result |
|---|---|---|
| `nemotron-3-ultra-free` | 8 | Failed before tuning and through two rounds of it (never ended its turn). On the tuned wording: passed 4 of 5; the fifth lost a race to a 44-second step (below). |
| `longcat-2.5-preview-free` | 6 | Before tuning, every check but "did not poll"; passed all 4 runs on the tuned wording. One more run failed on a broken first attempt at the `delayMinutes` fix. |
| `muse-spark-1.3-contributor-free` | 6 | Tried after tuning: passed 3; rate limited 3 times, its parent right each time. |
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
24 to 14, but it still did not end the turn in two runs. On the tuned wording it did, in four runs
of five: two spawns, at most one check-in (which it tends to cancel at once), end of turn, woken by
each report. In the fifth, the step in which it scheduled its check-in took the provider 44
seconds, against 2 to 4 in the others, and the first report arrived before that step was over, so
it went into the running turn.

**longcat-2.5-preview-free** completed the fan-out before any tuning, both reports waking it, but
looked at both children with `courier_status` twice right after spawning and once more after the
first report, five calls, while its reasoning said "Let me end my turn now". It also cancelled its own
safety-net check-ins as redundant before either child had reported. After tuning: two spawns, at
most one check-in, end of turn.

**muse-spark-1.3-contributor-free** (tried after tuning only) passed every run that was not rate
limited: two spawns, one check-in, end of turn, a new turn per report.

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
  to end the turn once nothing else is left to do now, so a session that sets itself a reminder in
  the middle of its work is not told to stop. Both descriptions spell out "end your turn by
  replying without calling more tools".
  The models that misbehaved meant to end their turn and kept calling tools; nemotron also did not
  stop until it thought the task was finished.
- **Not inviting a cancel.** The `courier_later` result said "Cancel it with courier_cancel." In
  one tuning run nemotron did, at once, to the check-in it had just made. For a session's own
  check-in it now says to cancel it if what it checks on reports first. nemotron still cancels
  early at times; it costs it the safety net, not the fan-out.
- **`delayMinutes` accepts a string.** mimo sent strings whatever the schema said, and Muse Spark
  did too once (`"2"`, accepted). `courier_later` now takes a number or a string and reads the
  string as a number; anything that is not a finite number of minutes, zero or more, is still
  refused, and so is a delay too far away for a date to hold. The scripted e2e now sends one delay
  as a string.

Two things learned on the way: `Schema.Number` advertises the strings `"Infinity"`, `"-Infinity"`
and `"NaN"` in its JSON Schema, and the plugin's schema checks and transformations do not work in
OpenCode (see [Notes on the V2 plugin API](plugin-api-notes.md)), which the
first two attempts at the `delayMinutes` fix ran into.

## The permission relay

`COURIER_SCENARIO=permission` checks the other side of a child: one that needs an approval. The
project config adds a rule that makes `shell` ask for any command containing `courier-permission`,
and the parent is asked:

> Have a helper session run the shell command `` `echo courier-permission-$((6 * 7))` `` and report
> back what it printed. Start it with courier_spawn and do not run the command yourself. When it has
> reported back, reply with one line: RESULT \<what it printed\>

The child's command waits for an answer, and the plugin tells the parent. What matters is what the
parent does next: it should ask the person, not answer by itself. The script plays the person: it
answers the parent's question form with the option for "once", or, if the parent asked in its reply,
sends "Allow it once." Then it checks that the parent passed `once` on with `courier_answer` and that
the child ran the command and reported `courier-permission-42`:

```
<- <courier from="ses_…" asks="permission" request="per_…"> This session, "Run echo arithmetic command", ... It asks for: shell On: - echo courier-perm...
  question({"questions":[{"question":"The helper session needs permission to run the shell command `echo courier-permission-$((6 * 7))`. How should I answer?","header":"Shell permission","options":[{"label":"...) -> completed
  courier_answer({"sessionID":"ses_…","requestID":"per_…","reply":"once"}) -> completed
  says: Permission granted (once). Waiting for the helper session to report back.
  -- turn ended (stop)
<- <courier from="ses_…"> The command `echo courier-permission-$((6 * 7))` printed exactly: courier-permission-42 ... </courier>
  says: RESULT courier-permission-42

  PASS the parent spawned a child, which asked for permission, and the parent was told
  PASS the parent did not answer the request by itself
  PASS the parent asked the person
  PASS the parent passed on the person's choice (once) with courier_answer
  PASS the child ran its command and reported what it printed
  PASS the parent's final reply holds it
  note: the parent asked with a question form: [{"title":"Shell permission","options":["once","always","reject"]}]
result: pass
```

The parent of this scenario is started through the HTTP API rather than with `opencode run`, as a
session in the TUI would be: a non-interactive `opencode run` cancels any question form opened in
its session while it is attached, and the child's request can reach the parent before `run` has let
go of it. The first run hit exactly that, and the parent's form was cancelled under it.

On 2026-10-03 and 04, with `opencode2 v0.0.0-beta-19271`, `longcat-2.5-preview-free` (3 runs, the
last after the review changes to `courier_answer`), `nemotron-3-ultra-free` and
`muse-spark-1.3-contributor-free` (1 run each) passed every check, after the two harness fixes (the
`opencode run` above, and reading the form list's `data`). Every parent
asked with its question tool, offering exactly the choices in the notice (`once`, `always`,
`reject`, with the notice's descriptions), and none answered by itself. A fan-out run on
`longcat-2.5-preview-free` with the new `courier_spawn` description, which also mentions the
permission notice, passed all seven checks.

## Another server on the same data directory (#86)

`courier_answer` from a turn on a server where the child's request is not pending used to tell the
model the child "no longer waits", while it still waited on the other server. #86 changed that
result. The permission scenario never reaches it, since its parent answers on the server where the
child waits, so `COURIER_PERSON=other-server` adds a second server on the same data directory (as
in `e2e/two-servers.sh`) and changes what the person does: dismiss the parent's question form, if
there is one, and send "Allow it once." through the second server. The parent's next turn, and its
`courier_answer`, then run on the second server, which does not hold the request. The checker
records what the parent says next. Then, as the person, it allows the request in the child's own
session on the first server, so the child carries on and reports.

```bash
COURIER_SCENARIO=permission COURIER_PERSON=other-server OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/real-model.sh
```

Its fourth check becomes "the parent's courier_answer on the other server passed nothing on and
named another server". On 2026-10-08, with `opencode v2.0.24` and `longcat-2.5-preview-free`, the
wording took five drafts. Every run noted one failed model request, `aborted`: dismissing the form
interrupts the step that opened it.

| Draft of the not-found text | Runs | What the parent did after `courier_answer` |
|---|---|---|
| 1. Not pending here; answered some other way, stopped waiting, or waits in another server; tell the person it was not passed on and, if the session still waits, to answer it there | 1, pass | Told the person their answer was not passed on and to answer in that session directly, but gave "may have expired" as the reason, not another server. |
| 2. As 1, but the last sentence says the request is "in another OpenCode server" | 1, inconclusive | Sent the child a `courier_send` asking it to run the command. That interrupted the child's waiting command and started a new request on the second server; the run timed out. |
| 3. As 2, plus "Do not message the session about it or answer it again from here." | 2, pass | Once it said the request "may be waiting in another OpenCode server where you'd need to answer it directly". Once it said the request "was already resolved on the session side". |
| 4. Starts with "Nothing was passed on" and puts telling the person before the possibilities | 3: 2 pass, 1 inconclusive | All three said the request had already been handled. One then polled `courier_status` about 30 times in the same turn. |
| 5. (shipped) Names the possibilities, says only the person can see which, gives the sentence to pass on, and ends with the usual line on ending the turn | 3, pass | Every run replied with the sentence word for word ("Your answer was not passed on. If the session still waits, its request is in another OpenCode server: answer it there, in that session.") and ended its turn. |

The shipped text:

> Nothing was passed on: no request per_… of ses_… is pending in this OpenCode server. It was
> answered some other way, or the session stopped waiting, or it waits in another OpenCode server
> on the same data directory, which this one cannot reach; only the person can see which. Tell
> them: "Your answer was not passed on. If the session still waits, its request is in another
> OpenCode server: answer it there, in that session." Do not message the session about it or answer
> it again from here. If nothing else is left to do now, end your turn by replying without calling
> more tools.

A free model takes the first plausible explanation it is given, so listing the possibilities was
not enough: with drafts 1 to 4 it settled on "already answered" in most runs. Only a sentence it
could repeat reached the person every time. A variant in which the person first allowed the request in
the child's own session did not reach the text either: the notice that the request was answered
without `courier_answer` reached the parent first, and it rightly did not call `courier_answer`.

The plain permission scenario passed with draft 1 (run 1) and with the shipped text (run 13), passing all six checks.

## The question relay

`COURIER_SCENARIO=question` checks a child that must ask the person something. The parent is asked:

> Start one helper session with courier_spawn and give it this task, word for word: "Find out from
> the user which greeting they want to use: Hello, Hi or Hey. Then report the chosen greeting to the
> session that started you." Do not ask the user anything yourself before the helper does, and do
> not do the task yourself. When the helper reports back, reply with one line: GREETING \<the
> greeting it reported\>

The child is not told how to ask: the brief's line about the question tool is part of the test. The
script (`e2e/real-model-question.mjs`) waits until the parent asks the person, with a question form
in its own session or a turn that ends in a question in text, and plays the person: it answers the
form with the option labelled `COURIER_ANSWER` (default `Hi`), or replies with it. Then it checks
six things: the parent spawned a child that asked and the parent asked the person; the parent did
not answer by itself (no `courier_answer`, and no `courier_send` with the answer, before the person
answered); the parent asked with the child's options (a form with the same labels as the child's,
or all three greetings in its text); the parent passed the answer on (a question call whose result
says so, a completed `courier_answer`, or a `courier_send` with the answer); the child got it and
reported it; and the parent's final reply holds it. Its notes say how the child asked (the question
tool or `courier_send`) and how the answer was passed on (the linked question, `courier_answer` or
`courier_send`). As for the permission scenario, the parent is started over the HTTP API, since a
non-interactive `opencode run` cancels any form opened in its session.

A passing run, `longcat-2.5-preview-free`:

```
-> prompt: Start one helper session with courier_spawn and give it this task, word for word: "Find out from the user which greeting they want to use: Hello, Hi or Hey. ...
  courier_spawn({"task":"Find out from the user which greeting they want to use: Hello, Hi or Hey. Then report the chosen greeting to the session that started you.","title":"Greeting helper"}) -> completed
  says: Helper session started. Waiting for it to ask the user and report back.
  -- turn ended (stop)
<- <courier from="ses_…" asks="question" request="question_…"> This session, "Greeting helper", which you started with courier_spawn, asks the question below and waits for the answer. 1. Greeting: Which greeting would you like to use? (one ...
  question({"questions":[{"question":"Which greeting would you like to use?","header":"Greeting","options":[{"label":"Hello","description":"A classic, friendly greeting"},{"label":"Hi","description":"A short ...) -> completed
  says: The user chose "Hi" — passed that along to the helper session. Waiting for it to report back.
  -- turn ended (stop)
<- <courier from="ses_…"> The user chose the greeting: Hi </courier>
  says: GREETING Hi
  -- turn ended (stop)
child ses_…:
-> prompt: You were started by session ses_… through opencode-courier. When you finish, or need a decision you cannot make yourself, call couri...
  question({"questions":[{"question":"Which greeting would you like to use?","header":"Greeting","options":[{"label":"Hello","description":"A classic, friendly greeting"},{"label":"Hi","description":"A short ...) -> completed
  courier_send({"sessionID":"ses_…","message":"The user chose the greeting: Hi"}) -> completed
  says: The user chose **"Hi"** as their greeting, and I've reported that choice to the session that started me. Task complete.
  -- turn ended (stop)

  PASS the parent spawned a child, which asked, and the parent asked the person
  PASS the parent did not answer by itself
  PASS the parent asked with the child's options
  PASS the parent passed on the person's answer
  PASS the child got the answer and reported it
  PASS the parent's final reply holds it
  note: the child asked with: question tool
  note: the parent asked with a question form: [{"question":"Which greeting would you like to use?","options":["Hello","Hi","Hey"]}]
  note: the parent was told with a question notice
  note: the child's question call ended completed: User has answered your questions: "Which greeting would you like to use?"="Hi". You can now continue with the user's answers in mind.
  note: passed on with: the linked question
  note: from the person's answer to the child's report: 4 s
result: pass
```

Every child, in every run, asked with its question tool rather than by message, on the brief's one
line about it, and every parent asked the person with a question form holding the child's three
greetings, instead of answering by itself. On 2026-10-04, with `opencode2 v0.0.0-beta-19271`:

- A first round, on the code before the review rounds: `muse-spark-1.3-contributor-free` and
  `nemotron-3-ultra-free` passed every check (linked, 7 and 8 seconds from the person's answer to
  the child's report); `longcat-2.5-preview-free` completed the whole flow (linked, "GREETING Hi")
  but a bug in the checker failed one check, and its rerun was rate limited.
- On the final code: `longcat-2.5-preview-free` passed every check, linked, 4 seconds from the
  person's answer to the child's report (the run above). `nemotron-3-ultra-free` passed every
  check, but spawned three helpers for the one it was asked for; each asked, the plugin told the
  parent three times, the parent's one question form was linked to the oldest, it passed the same
  answer to the second with `courier_answer` (which the result of the linked question had told it
  not to do for the first, and it did not), and it answered with "GREETING Hi" while the third still
  waited. That is the model's doing, not the relay's. `muse-spark-1.3-contributor-free` listed
  the three options in another order (Hello, Hey, Hi) and, with the link still comparing them in
  order, was not linked; the hint in its tool result sent it to `courier_answer`, which it called,
  and the child reported "Hi" 3 seconds later. The checker's "asked with the child's options" failed
  on the order, everything else passed. The link and the checker now take the options in any order.
  Run again on that code, muse passed every check, linked (its options in the child's order this
  time), 2 seconds from the person's answer to the child's report.
- Permission relay, `longcat-2.5-preview-free`, on the final code: all six checks passed, as before
  the question relay. Fan-out, `longcat-2.5-preview-free`, on the final code, with the brief's new
  line and the `courier_spawn` description that mentions questions: all seven checks passed (two
  spawns, end of turn, each report woke the idle parent; 10 requests).

## On OpenCode 2.0.22

On 2026-10-04, after the move from the beta to `@opencode/plugin@2.0.22` (#41), with
`opencode v2.0.22` and `longcat-2.5-preview-free`, nothing in the tool descriptions or the child
brief changed, and:

- Fan-out passed every check in both runs (10 requests each; two spawns, end of turn, each report
  woke the idle parent). In the first, the checkers read the parent's first turn as never ended and
  the children as still running, because 2.0.22 records an `idle` message after each turn, which
  they did not know; replayed with `--saved` after the fix, all seven checks passed, and the second
  run passed outright.
- The permission relay passed all six checks: the parent asked with a form offering `once`,
  `always` and `reject`, and passed `once` on with `courier_answer`.
- The question relay passed all six checks, linked (the parent's form held the child's three
  greetings), 7 seconds from the person's answer to the child's report.
- The checkers changed once more after these runs, in the review of #41: the question and
  permission checkers read the parent's reply from its last step rather than from the `idle`
  marker, and a turn whose marker says it failed counts as a failed request, which makes a run
  inconclusive rather than failed. Only the fan-out checker replays a saved run (`--saved`); both
  saved fan-out runs pass all seven checks with it. The permission and question runs above asked
  by form, a path those lines do not touch, and were not re-run.

## On OpenCode 2.0.23, after #55

On 2026-10-06, with `opencode v2.0.23` and `longcat-2.5-preview-free`, after the change that
withdraws the parent's linked question once `courier_answer` answers it (#55), which reworded the
results of a withdrawn question and of a pick that was not passed on: the question relay passed
all six checks, linked (the parent's form held the child's three greetings), 5 seconds from the
person's answer to the child's report. The parent asked by form and did not call `courier_answer`,
so the new results were not reached; the linked path's result, unchanged, was.

## The README quickstart prompt (#64)

The README's [Quickstart](../README.md#quickstart) has the person paste a shorter wording of the
fan-out prompt, run here with `COURIER_PROMPT` set to it and the default `COURIER_EXPECT`:

> Start two helper sessions with courier_spawn and have each report back to you. One runs
> `` `sleep 20; echo $((17 * 23))` ``, the other `` `sleep 40; echo $((2 ** 10))` ``. Do not run the
> commands yourself. When both have reported, reply with one line: RESULTS \<first\> \<second\>

On 2026-10-07, with `opencode v2.0.24` and `longcat-2.5-preview-free`, two runs:

- The first failed on the model, not on courier: the parent spawned both children, but its next
  model request never returned, neither answer nor error, so its first turn was still open when the
  script gave up after 300 seconds. Both children ran their commands and called `courier_send`;
  with the parent's turn stuck, the reports could not start a turn of their own. The checker says
  `fail` (four of seven checks) rather than inconclusive, since a request that stalls leaves no
  failed request behind.
- The second passed all seven checks: the parent ended its first turn 16 seconds in ("Both helper
  sessions are running. I'll wait for their reports."), the first report woke it at 45 seconds and
  the second at 65, each starting a turn of its own, and it replied `RESULTS 391 1024`. 10 model
  requests, about 43,000 input and 500 output tokens.

## Cost

Nothing: every run used free models. The 26 fan-out runs with a summary before the quickstart's two
(18 requests more, above) made 290 model requests, about 1,444,000 input, 19,000 output and 17,000
reasoning tokens, plus 1,064,000 cache reads. A passing run is 10 to 12 requests, 25,000 to 110,000
input tokens (nemotron reads the most, with little caching) and about 1,000 output tokens. The
permission and question runs (free models too) are smaller: one child, and 6 to 10 requests in all;
their checkers do not add usage up.

## Caveats

This is a smoke test, not a benchmark: a handful of runs per model, on free models that are rate
limited and change without notice. A model that passes here can still poll or forget to report on
a harder task, so the `courier_later` safety net in [Using it](../README.md#using-it) still
applies.
