# Handoff: issue #32, relay a child's question to its parent (PR #33)

You continue a run that was stopped on the owner's request. You know nothing else; this file, the
repo, PR #33 and issue #32 are your sources. Read CLAUDE.md and README.md ("A child that asks a
question", "Notes on the V2 plugin API") first.

- Repo: https://github.com/ivopogace/opencode-courier. Worktree on this machine:
  `D:\opencode-courier\.claude\worktrees\issue-28-question-relay`, branch `issue-28-question-relay`
  (keep the name; do not rename).
- PR: #33 "Relay a child's question to its parent, and the answer back". Body is a placeholder,
  still to be written (see Remaining work).
- Issue: #32 (it replaced the deleted #28; same text). The research comment that is the design:
  https://github.com/ivopogace/opencode-courier/issues/32#issuecomment-5974548555
- The orchestrator is the local Claude Code session `opencode-courier-f1`. End your run with exactly
  one block: `READY TO MERGE` (PR number, head sha, CI result on that sha, review rounds and what
  they changed, decisions), `NEEDS USER DECISION` (question, 2-4 options, recommendation) or
  `BLOCKED`.

## Standing rules

- PR body says `Closes #32`. Write #32, never #28, anywhere new (PR, docs, comments, commits).
- No references to, or links to, upstream OpenCode pull requests or issues (anomalyco/opencode#…)
  anywhere: code, README, docs, commit messages, PR body. Describe OpenCode's behaviour from the
  pinned version (0.0.0-beta-19271) and its source instead.
- Never push to main, never merge, never force-push. No release, no version bump.
- Do not touch the owner's OpenCode service (a background `opencode2` service runs on this machine)
  or `~/.config/opencode`; run experiments only on your own throwaway servers (the e2e scripts do).
- NEEDS USER DECISION for anything that changes how the owner runs or exposes the plugin, costs
  money, publishes, or needs a secret.
- Every tool: `options: { codemode: false }`, metadata without `undefined`, failures through
  `describeFailure`. Behaviour changes come with unit tests, an e2e scenario where practical, README.
- Commit messages from a file (`git commit -F`), since PowerShell 5.1 splits at embedded quotes.

## What the PR does

A session started with `courier_spawn` that calls OpenCode's built-in `question` tool has its
question relayed to the session at the TOP of its spawn tree (the same session its permission
requests go to, #27 design), which alone answers it. The answer comes back as the result of the
child's waiting tool call ("User has answered your questions: …", OpenCode's own text and output
shape `{ answers: string[][] }`). The owner's message route (child `courier_send`s its question,
parent asks, parent `courier_send`s back) still works; the child brief gained one line:
"If you need the person to decide something, use your question tool; it reaches them through the
session that started you."

### Why Effect-level (verified, not just taken from the research)

`@opencode-ai/plugin/dist/promise/adapter.js` (`fromPromise`): the promise API's tool editor hands
out the original `execute` as `promiseExecutor` = `Effect.runPromiseWith(context)` with no abort
signal, and wraps a replacement in `Effect.promise(() => …)` without one. So a promise-level
wrapper cannot interrupt the child's original call, and OpenCode's `Form.ask` only withdraws a form
when the asking effect is interrupted (`Effect.onInterrupt(() => cancel(form.id))`). Hence the
default export is now an Effect plugin. OpenCode loads `"effect" in value ? value :
PluginPromise.fromPromise(value)` (`packages/core/src/plugin/module.ts`), and its own
`PluginPromise.fromPromise` is the same `@opencode-ai/plugin/promise/adapter` export we call.

### Layout

- `src/index.ts`: `export const courier = (relay: RelaySlot = {}) => Plugin.define({ id, setup })`
  is the old promise plugin (tools, scheduler, webhook, watcher). Its setup builds `questionPorts`
  (storage, session.synthetic, now, newID `question_<uuid>`, log), sets `relay.ports`, calls
  `joinRelay`, runs `noticeCutOff` once; cleanup clears both. The default export is
  `EffectPlugin.define({ id: "courier", effect: host => fromPromise(courier(relay)).effect(host)
  then relayQuestions(host, () => relay.ports) })`. `courier_answer` takes
  `{ sessionID, requestID, reply?, message?, answers? }`; `answerRequest` dispatches on the id:
  `question_…` → `answerQuestion` (needs `answers`, refuses `reply`/`message`), else the #27
  permission path (needs `reply`, refuses `answers`). `answers` entries are a string or a list of
  strings, one entry per question. `CourierPorts.pending` merges permission requests and questions.
- `src/question.ts` (new, ~730 lines). Main pieces:
  - Types: `Prompt`, `Asked` (stored: requestID, sessionID, top, title, startedBy?, questions,
    askedAt), `Stored` (Asked + `answered?: true` tombstone), `Question` (in-memory: `call`,
    `link`, `relaying`, `settling`), `Elsewhere` (child/dismissed/failed), `Outcome`
    (answers/dismissed).
  - Shared process-wide state on `globalThis[Symbol.for("opencode-courier.questions")]`, set up
    field by field: `questions` Map, `noticed` Set (cut-off notice sent once per process),
    `shown` Map (calls waiting for `form.created`, key `"<sessionID> <callID>"`), `passing` Map
    (per-question answer lock), `answered` Set, `loaded` Set of ports, `following`/`followed`
    (event-stream counting). `timing` = { closingGraceMs 30 s, passingWaitMs 30 s } (tests change it).
  - `relayQuestions(host, ports)`: `host.tool.transform(editor => editor.update("question", tool =>
    tool.execute = linking(ports, asking(ports, tool.execute))))`.
  - `asking` (child side): if the caller is on a roster (`lineage`), registers a `shown` waiter,
    races the original execute against `fromTop` (wait for `form.created` → `relay` = register,
    store `question/<id>`, steer notice `asks="question"` to the top → wait `byTop`). `onExit`
    (sync) clears `call` unless the top's answer won, starts `settle` (async), resolves `accepted`.
  - `settle`: awaits `relaying`; top answered → `forget` storage; interrupted, or ended after the
    plugin instance unloaded (`ports() !== current`) → cut off: stays registered, `tellCutOff
    ("stopped")` unless a link is open, or `tellLater` (unloaded); otherwise (answered in child,
    dismissed, failed) → drop, then resolve the link or send `answered="elsewhere|dismissed|failed"`.
  - `linking` (top side): `linkFor` finds an unlinked waiting/cut-off question of this top with the
    same choices AND same wording (normalised); races the top's own ask against `elsewhere`; on the
    person's answer calls `deliver` and appends a note ("passed on … do not call courier_answer");
    on dismissal in the top passes the dismissal down (child gets the DISMISSED text and carries
    on); unlinked calls with a waiting question of the same choices get a hint naming it.
  - `deliver` / `passOn`: per-question lock (`passing`, 30 s wait), hand the outcome to `call`
    and await `accepted`; otherwise await `settling`, then send as a message
    (`<courier from=top answers="question_…">`) if still stored, mark `answered`, `forget`.
  - `answerQuestion` (courier_answer): `answeringTop` (shared with relay.ts), `normalize`, `deliver`.
  - `pendingQuestions`, `noticeCutOff` (on load: prune >14 days / off roster / beyond 100 newest /
    answered; tell the rest `restarted="true"`), `joinRelay`, `tellLater`, `formShown`,
    `formsMayHaveBeenMissed`, `eventsFollowed`/`eventsLeft` (release waiters when no instance was
    following events), `forgetQuestions` (tests).
- `src/watch.ts`: handles `form.created` → `formShown`; counts followed streams.
- `src/relay.ts`: exports `origin(startedBy)` and `STAYS_QUIET` now shared with question notices;
  `answer` uses `answeringTop`. `src/roster.ts`: `lineageIn`, `answeringTop`.
- `src/courier.ts`: `Pending` union (permission | question with `stopped?`), brief line.
- Tests: `test/question.test.ts` (fake question tool built from Effects: `Effect.callback` form,
  dies with `{_tag:"QuestionTool.CancelledError"}` on dismiss, `onInterrupt` records cancellation),
  `test/plugin.test.ts` uses `courier(relay).setup(ctx)` and checks the default export shape.
- e2e: `e2e/run.sh` question scenarios (link single/multi/typed-from-isolated, relabel → courier_answer,
  reword → hint → courier_answer, answered in child, dismissed in child, dismissed in parent, child
  interrupted while parent asks, both interrupted (sweep-like), nested grandchild → top, server
  restart). `e2e/mock-model.mjs`: COURIER-QUESTION[-MULTI|-RELABEL|-REWORD][ isolate|nested].
  `e2e/real-model.sh` `COURIER_SCENARIO=question` with `e2e/real-model-question.mjs`.
- Docs: README updated (Tools table, "A child that asks a question", setup note, e2e/real-model
  paragraphs, API notes incl. Effect export, form events, shutdown order, sweep); CLAUDE.md layout.
  `docs/real-model.md` NOT yet updated.

### Key facts learned (verified)

- `form.created` reaches every instance's `event.subscribe()` with `form.metadata.tool.id` = call
  id; the form exists only after the call's permission check passed (so relaying waits for it).
- Dismissal = the tool dies with `QuestionTool.CancelledError` (ends the asking turn).
- Graceful shutdown (Linux CI, SIGTERM): OpenCode unloads the plugin instance first, then the Form
  layer's finalizer cancels every pending form (looks exactly like a dismissal). Found via CI logs
  (commit 07c0828 logging); fixed in 3dce01b by treating "ended after unload" as cut off. Windows
  kills the server hard, so this only shows on CI.
- Inactivity sweep (`packages/core/src/location-activity.ts`): interrupts a location's executions
  after 60 min without durable session events, then evicts; hard-coded, not configurable.

## State right now

- Head: `5229d479261a69c69730981551f0341e2ce8a5ea` (5229d47), pushed, worktree clean.
- CI on 5229d47: both jobs PASS (unit: typecheck, tests, build, publint, attw; live: the whole
  e2e suite on Linux, including `plugin add` and every question scenario). Earlier: 3dce01b and 748bcb2 fully green;
  1886be3…40e1247 were cancelled by later pushes (concurrency group), never failed. 4b413a4 and
  07c0828 failed only the restart scenario (the shutdown bug fixed in 3dce01b).
- Unit tests: 190 pass, 0 fail (`bun test`).
- Last local e2e (Windows, on 17279fa): all question scenarios pass; only the 3 known Windows-only
  failures ("child runs in its own worktree", "courier_children lists both", "lists both
  children"); the `plugin add` block is skipped locally (see machine notes). Not run on 40e1247
  or 5229d47 yet.
- Real models (all on code from before the review rounds, ~4b413a4, so they need rerunning):
  - question, longcat-2.5-preview-free: whole flow worked (child used question tool, parent asked
    with identical options, link passed "Hi", child reported, final "GREETING Hi"), but the checker
    failed one check due to a checker bug (fixed since); a rerun was rate limited (inconclusive).
  - question, muse-spark-1.3-contributor-free: PASS (linked, 7 s person→report).
  - question, nemotron-3-ultra-free: PASS (linked, 8 s).
  - permission, longcat: PASS. fan-out, longcat: inconclusive (HTTP 429 rate limits).
- The hour-long sweep was NOT run against this code (stopped on the owner's decision; the owner
  tests it). The research ran it against the spike only. The cut-off path is unit-tested and the
  e2e "both turns are stopped" scenario uses the same interrupt the sweep uses.

## Review rounds (code-review skill, high)

1. (748bcb2) linking on choices alone could mislink yes/no → require same wording; unload-cut-off
   re-notice; settle/relay ordering; double answer to cut-off; missed form.created on resubscribe;
   oldest-first; roster read once; shared top check and notice wording.
2. (1886be3) unload race with reload → keep registered + tellLater; releases only when no instance
   follows events; answer sent before storage drop; settle off the call's exit path; reworded hint
   + e2e scenario.
3. (f54db9e) call cleared at exit, answers wait for settle; sent-once set; field-by-field shared
   state; prune known cut-off; hint scope; closing-grace tests.
4. (c9f7957) acknowledged handoff (`accepted`): a call already ending does not swallow an answer;
   no cut-off notice while an answer is under way; answered tombstone; hint widened.
5. (17279fa) per-question lock (answers wait instead of refusing); tombstone via storedOf; settle
   by-top uses forget; prune catch; exclude passing from links.
6. (40e1247) bounded 30 s wait; own-entry delete; accepted answer leaves the list at once; relay
   failure withdrew links (reverted in 7); answered pruning.
7. (5229d47) relay failure keeps the question registered and answerable; hung answer releases its
   lock after 30 s; pending hides passing/answered; README notes; tests.
8. (in progress, NOT acted on) findings on 40e1247…5229d47, my assessment:
   - `src/question.ts` ~556: `fromTop` awaits `relay` before waiting on `byTop`, so a hanging
     notice blocks every answer from reaching the call. REAL. Start relay without awaiting it.
   - ~252/267: after the release timer, a second answer calls the same `call` and gets the same
     `accepted` → reports its answers as delivered while the child got the first. REAL (needs a
     >30 s hang).
   - ~463/274: if `storage.set` fails in relay, the question stays registered but the message
     path requires a stored record → courier_answer says "no longer waits" after a cut-off. REAL,
     storage-failure edge.
   - ~515: after a failed relay notice, settle sends a "settled" notice to a top never told.
     REAL, minor (needs a `told` flag).
   - README ~131: "goes on if the first did not get through" is inaccurate when the first is just
     slow (>30 s): both can go out. REAL (doc).
   - ~345: `pendingQuestions` hides passing/answered only for storage-scanned entries, not
     registry entries. REAL, minor.
   - ~244: wait timer not unref'd. Minor.
   - ~457/483: relay's boolean return is now unused; stale comment. Cleanup.
   - ~252: two deadlines (release timer vs waiter timer). Design smell.
   - no e2e for these: races/hangs are not practical in e2e; unit tests cover what they can.

## My view on convergence

Not converging by patching. Rounds 3-8 all found interleavings in the same place: the async
answer handoff (promises `byTop`/`accepted`/`settling`/`relaying` plus the `passing` lock and
timers). Each fix opened a narrower window. The main flows are solid (CI live suite and real models
pass); what remains are edge cases around storage failures, hung notices and exact simultaneity.
I was about to replace the handoff with ONE synchronous state per question, which removes most of
it. Recommended, and then ONE more review round, then stop, documenting residual edge cases
(storage write failures, notices that never return) in the PR body instead of chasing them:

- `state: "waiting" | "taken" | "cutoff" | "sending" | "done"` on `Question`.
- `deliver`: synchronous claim. `waiting` → `taken`, resolve `byTop`, return "result" (no await).
  `cutoff` → `sending`, send the message, then `done` (on failure back to `cutoff` and throw).
  `sending` → throw "an answer to it is being passed on already". Unknown id → load it from
  storage as `cutoff` first. No `passing` lock, no `accepted`, no wait timers.
- `onExit` (sync) decides the state from the exit: by top → `done`; interrupted or unloaded →
  `cutoff` (if it was `taken`, the handed outcome must still go: send it as a message from
  settle); child answered/dismissed/failed → `done` (if it was `taken`, tell the top its answer was
  not used). The async part of settle is I/O only (storage, notices), ordered after `relaying`.
- `fromTop`: start `relay` without awaiting it, then wait on `byTop`; keep a `told` flag so a
  settled notice only goes to a top that was told.
- The message path uses the registry entry, not the presence of a stored record; storage is only
  persistence across restarts (plus the `answered` tombstone / set).
- linkFor/hint/noticeCutOff/tellLater/pending read `state` instead of call/link/passing checks.
Keep the existing tests (they test behaviour); rewrite only the ones about `passingWaitMs`
(a second answer while one is `sending` is now refused with a clear error; update the README
sentence about answers waiting for each other).

## Remaining work, in order

1. (Recommended) the state-machine rewrite above in `src/question.ts`, tests adjusted; or, if you
   judge it unnecessary, fix the real round-8 items individually.
2. `bun run typecheck`, `bun test`, `bun run build`; local e2e (see machine notes); push.
3. One more `code-review high <previous head>...HEAD` round; fix what is real; stop there unless a
   correctness bug in the main flows shows up. List deliberate non-fixes in the PR body.
4. Make sure the DEBUG commit 07c0828's logging is not in the final diff. It was already removed
   in 3dce01b (no `DEBUG` / "call ended," / "linked call of" strings remain in src); verify with
   `git diff origin/main...HEAD -- src | grep -i debug`. Its commit stays in history (no
   force-push); the PR is squash-merged.
5. CI green on the final head: `gh pr checks 33 --watch`.
6. Real-model reruns on the final code (free Zen models, no key): question on longcat, muse,
   nemotron; permission on longcat; fan-out on longcat (it hit 429 last time; wait a few minutes
   between runs). Record in `docs/real-model.md`: a new "## The question relay" section next to
   "## The permission relay" (prompt, what the checker does, a sample timeline, per-model results,
   the opencode-run note that the parent is started over the API), and update the dated results
   line and Cost section. The earlier results above can be mentioned as the first round.
7. PR body (`gh pr edit 33 --body-file …`, write the file with `[IO.File]::WriteAllText` to avoid a
   BOM): what changed; decisions (top-of-tree routing like permissions and why: one hop, the
   person is at the top, a middle session cannot answer what its children ask; Effect plugin via
   fromPromise and why; link needs same wording + choices, hint otherwise; dismissal in the parent
   is passed down as "dismissed, carry on" rather than ending the child's turn, like #27's
   rejection-with-message; dismissal in the child ends its turn as OpenCode does; relay gated on
   form.created; cut-off/restart/unload handling; the message route kept + brief line;
   `courier_answer` shape and that permission callers are unchanged; `asks="question"`,
   `answered="elsewhere|dismissed|failed"`, `stopped`/`restarted` attributes; pending entries);
   testing (unit count, e2e scenarios, CI, local Windows caveats, real-model results); review
   rounds one line each; the hour-long sweep listed as NOT run against this code, left to the
   owner (the research ran it on the spike); residual edge cases. Link the research comment
   (issuecomment-5974548555 on #32). `Closes #32`. No upstream references.
8. Final block to the orchestrator.

## This machine (Windows 11, PowerShell 5.1 tool, Git Bash at D:\Git\usr\bin\bash.exe)

- Scratch: `S=$TEMP\claude\D--opencode-courier\f7e0f9ca-2c38-4a46-ba10-2862f2b9260b\scratchpad`.
  Your files go in `$S\build-28\`. bun: `$env:PATH = "$S\bin;$S\bun\node_modules\bun\bin;$env:PATH"`
  in PowerShell. `jq.exe` is in `$S\bin` (Git Bash scripts get it via the PATH set in win.sh).
- `opencode2` (pinned 19271) is `D:\nodejs\opencode2` (exe under
  `D:\nodejs\node_modules\@opencode-ai\cli\bin\opencode2.exe`). The owner's service also runs it:
  never stop/restart it, never `opencode2 service …` against the real home.
- Live e2e: `$S\build-28\win.sh` copies `e2e/*.sh` with CR stripped, rewrites ROOT to the
  worktree and the `lib.sh` source path, and DELETES the final `plugin add` block (it calls
  `opencode2 service stop`; CI runs it on Linux). Run from PowerShell:
  `$env:KEEP="1"; $env:E2E_WORK="D:/c28e2e/wN"; & 'D:\Git\usr\bin\bash.exe' "<S with forward
  slashes>/build-28/win.sh" run.sh 2>&1 | Out-File -Encoding utf8 "$S\build-28\e2e-N.log"`
  (background it; ~6 min). Use E2E_WORK under `D:/c28e2e/` (short path): under %TEMP% the paths
  get too long for git ("Filename too long") and the run dies silently. Expect exactly the 3 known
  Windows failures. Ports: run.sh 4599-4602, real-model 4610.
- Real models: `& 'D:\Git\usr\bin\bash.exe' "<S>/build-28/real.sh" <model> "<scenarios>"` runs
  `real-model.sh` per scenario (default "question permission fanout"), work dirs
  `D:/c28e2e/real-<scenario>-<model>-<time>`. Free models rate limit (429 → "inconclusive", exit 2);
  space runs out. Each run rebuilds `dist`; do not run two suites at once (a rebuild can reload
  the plugin in the other server).
- `$S\build-28\sweep.sh`: one-off 60-minute sweep check (port 4620/4621, uses a dist copy in
  `node_modules/.c28-sweep-dist`). Stopped and not to be rerun now (owner's decision).
- Quirks that cost time: the Edit tool on these CRLF working-tree files once left a bare CR that
  `tsc` accepted but bun refused ("Expected ; but found await"), so run `bun test` after edits.
  `Set-Content`/`Out-File -Encoding utf8` add a BOM (strip it, or use `[IO.File]::WriteAllText`).
  PowerShell mangles double quotes in native args (jq filters): put jq filters in a file, `jq -f`.
  `MSYS_NO_PATHCONV=1` only per command if you pass `/api/...` paths to `opencode2 api` (curl is
  fine). CRLF warnings on commit are harmless (repo is LF, autocrlf on).
- Graceful shutdown only happens on Linux (CI); to debug a CI-only failure, download the
  `e2e-logs` artifact (`gh run download <id> -n e2e-logs -D D:\c28e2e\ciN`) and read server.log;
  plugin `console.error` lines show up there.
