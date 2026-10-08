# Smoke test with a real model

`e2e/run.sh` proves the plumbing with a scripted model. `e2e/real-model.sh` checks that a real
model uses the tools as intended: the parent spawns sessions instead of doing the work itself, it
ends its turn instead of waiting or polling, each child calls `courier_send` before it stops, and
each report wakes the idle parent. It is not part of CI. Re-run it after changing a tool
description, a tool result or the child brief.

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
| `COURIER_SCENARIO` | | `permission` or `question` for the two relay scenarios below; the fan-out by default. |
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

Turns are read from the transcript: OpenCode records an `idle` message when a turn ends, and a
delivered message opens a new turn when it arrived after that marker; otherwise it was steered into
the running turn. Polling means any `courier_status`, `courier_children` or `sleep` in the first
turn, right after spawning, or more than one in a later turn; a single look after being woken is
what `courier_status` is for, and is only noted. A report is a `courier_send` from a child; a
`courier_later` check-in does not count. The work directory keeps `parent.json`, `child-<id>.json`,
`timeline.txt`, `summary.json` and the server log. The exit code is 0 when every check passes and
1 when one fails. It is 2 when checks fail and model requests failed too, usually HTTP 429 from a
free model, because then the run says more about the provider than the plugin; run it again.

The README's [Quickstart](../README.md#quickstart) prompt is a shorter wording of the same task;
run it here with `COURIER_PROMPT` set to it and the default `COURIER_EXPECT`.

## The permission relay

`COURIER_SCENARIO=permission` checks a child that needs an approval. The project config adds a
rule that makes `shell` ask for any command containing `courier-permission`, and the parent is
asked:

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
go of it.

**Another server on the same data directory.** `courier_answer` from a turn on a server where the
child's request is not pending passes nothing on (see [the
reference](reference.md#two-servers-on-one-data-directory)). The permission scenario never reaches
that, since its parent answers on the server where the child waits, so `COURIER_PERSON=other-server`
adds a second server on the same data directory and changes what the person does: dismiss the
parent's question form, if there is one, and send "Allow it once." through the second server. The
parent's next turn, and its `courier_answer`, then run on the second server, which does not hold the
request. The checker records what the parent says next, and its fourth check becomes "the parent's
courier_answer on the other server passed nothing on and named another server". Then, as the
person, it allows the request in the child's own session on the first server, so the child carries
on and reports.

```bash
COURIER_SCENARIO=permission COURIER_PERSON=other-server OPENCODE_BIN=<scratch>/oc/node_modules/.bin/opencode e2e/real-model.sh
```

## The question relay

`COURIER_SCENARIO=question` checks a child that must ask the person something. The parent is asked:

> Start one helper session with courier_spawn and give it this task, word for word: "Find out from
> the user which greeting they want to use: Hello, Hi or Hey. Then report the chosen greeting to the
> session that started you." Do not ask the user anything yourself before the helper does, and do
> not do the task yourself. When the helper reports back, reply with one line: GREETING \<the
> greeting it reported\>

The child is not told how to ask: the brief's line about the question tool is part of the test. The
script waits until the parent asks the person, with a question form in its own session or a turn
that ends in a question in text, and plays the person: it answers the form with the option labelled
`COURIER_ANSWER` (default `Hi`), or replies with it. Then it checks six things: the parent spawned
a child that asked and the parent asked the person; the parent did not answer by itself; the parent
asked with the child's options; the parent passed the answer on (a linked question, a
`courier_answer`, or a `courier_send` with the answer); the child got it and reported it; and the
parent's final reply holds it. Its notes say how the child asked and how the answer was passed on.
As for the permission scenario, the parent is started over the HTTP API.

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

## Results

All runs used free models on Zen, which publishes no versions beyond the names. On the current
code and OpenCode 2.0.24, `longcat-2.5-preview-free` passes the fan-out (the README quickstart
prompt included), the permission relay (on one server and with `COURIER_PERSON=other-server`) and
the question relay. A passing fan-out run is 10 to 12 model requests; the relay runs are smaller.

What the models did on the fan-out, over some 30 runs while the tool wording was tuned:

| Model | Result |
|---|---|
| `longcat-2.5-preview-free` | Completed the fan-out from the start, but polled both children with `courier_status` right after spawning while its reasoning said "Let me end my turn now", and cancelled its own safety-net check-in before either child had reported. After tuning: two spawns, at most one check-in, end of turn. |
| `nemotron-3-ultra-free` | Never ended its first turn before tuning: it used `courier_later` as a way to wait, a dozen one-minute check-ins it never cancelled, until both reports had been steered into the running turn. After tuning it ended its turn in four runs of five; in the fifth a 44-second provider step let the first report land in the open turn. |
| `muse-spark-1.3-contributor-free` | Passed every run that was not rate limited. Once listed a question's options in another order than the child, which the question link now accepts. |
| `mimo-v2.6-flash-free` | Always sent `delayMinutes` as a string, was refused, and retried, which kept its first turn open long enough for the first report to land in it. Accepted since `courier_later` takes a string. |
| `big-pickle` | Did everything right as a parent; rate limits stopped its woken turn and one child before `courier_send`. A child that dies like this is what the `courier_later` check-in is for. |

Every child that was not stopped by a rate limit ran its command and called `courier_send` with
the right number, without any change to the child brief. In the question scenario every child asked
with its question tool rather than by message, on the brief's one line about it, and every parent
asked the person with a question form holding the child's three options. One `nemotron` run
spawned three helpers for the one it was asked for and answered while the third still waited; that
is the model's doing, not the relay's.

## What was tuned

- **Saying what "end your turn" means, where the model decides.** The `courier_spawn` result
  used to say only "It will report back with courier_send". Now it says the report starts a new
  turn, to end the turn by replying without calling more tools once every session is started, and
  that this does not drop the task. The `courier_later` result for a session's own check-in says
  to end the turn once nothing else is left to do now, so a session that sets itself a reminder in
  the middle of its work is not told to stop. Both descriptions spell out "end your turn by
  replying without calling more tools". The models that misbehaved meant to end their turn and kept
  calling tools.
- **Not inviting a cancel.** The `courier_later` result said "Cancel it with courier_cancel." In
  one tuning run nemotron did, at once, to the check-in it had just made. For a session's own
  check-in it now says to cancel it if what it checks on reports first. nemotron still cancels
  early at times; it costs it the safety net, not the fan-out.
- **`delayMinutes` accepts a string.** mimo sent strings whatever the schema said, and Muse Spark
  did too once. `courier_later` now takes a number or a string and reads the string as a number;
  anything that is not a finite number of minutes, zero or more, is still refused, and so is a
  delay too far away for a date to hold. The plugin's own schema checks do not run in OpenCode
  (see [Notes on the V2 plugin API](plugin-api-notes.md)), which the first attempts at this fix
  ran into.
- **The `courier_answer` result when no request is pending here.** On the other-server run the
  wording took five drafts. A free model takes the first plausible explanation it is given, so
  listing the possibilities (answered some other way, stopped waiting, waiting in another server)
  was not enough: it settled on "already answered" in most runs, and one draft sent it to message
  the child, which interrupted the child's waiting command. Only a sentence the model could repeat
  reached the person every time. The shipped text names the possibilities, says only the person can
  see which, gives the sentence to pass on, and ends with the usual line on ending the turn:

  > Nothing was passed on: no request per_… of ses_… is pending in this OpenCode server. It was
  > answered some other way, or the session stopped waiting, or it waits in another OpenCode server
  > on the same data directory, which this one cannot reach; only the person can see which. Tell
  > them: "Your answer was not passed on. If the session still waits, its request is in another
  > OpenCode server: answer it there, in that session." Do not message the session about it or answer
  > it again from here. If nothing else is left to do now, end your turn by replying without calling
  > more tools.

## Caveats

This is a smoke test, not a benchmark: a handful of runs per model, on free models that are rate
limited and change without notice. A model that passes here can still poll or forget to report on
a harder task, so the `courier_later` safety net in [Using it](../README.md#using-it) still
applies.
