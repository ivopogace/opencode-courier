# Plugin API traps

What the OpenCode V2 plugin API and host do that the plugin works around or relies on, at
`@opencode/plugin@2.3.0` and OpenCode 2.3.0. A pin bump re-checks each trap and moves that version.
OpenCode's source is on the `v2` branch of https://github.com/anomalyco/opencode, each release
tagged (`v2.3.0`); a host path is given only where a pin bump must find the code again. A "since"
stays only where the plugin still runs on an older host and branches on it. How the plugin's modules
fit together is in [architecture.md](architecture.md).

Each trap reads: **what it is.** Host: what OpenCode does. Courier: what the plugin does about it.
Where: the code or test that handles it.

## Tools

- **Code mode hides plugin tools.** Host: a plugin tool is reachable only through code mode's
  `execute` tool unless registered with `options: { codemode: false }`. Courier: registers every
  tool so. Where: `src/*/tools.ts`, `test/plugin.test.ts`.
- **`undefined` in metadata hangs a call.** Host: a tool whose result `metadata` holds an
  `undefined` value never completes; the call stays `running`, with no error. Courier: returns
  metadata without `undefined` values. Where: `src/*/tools.ts`; `test/courier.test.ts` checks it.
- **Errors can have an empty message.** Host: OpenCode errors such as `Session.NotFoundError` can
  have an empty message; a throw becomes a `Tool.Error` the model sees, and the turn goes on.
  Courier: tools rethrow through `describeFailure`, with the tag (`_tag`) and the session id. Where:
  `rethrow` in `src/kernel/tool.ts`, `describeFailure` in `src/kernel/protocol.ts`.
- **The host decodes tool input.** Host: OpenCode decodes tool input with its own `effect`, so checks
  and transformations in a plugin's schemas are not to be relied on. Courier: tool inputs use plain
  schemas and validate values themselves. Where: `src/*/tools.ts`; `test/plugin.test.ts` keeps it so.
- **Numbers arrive as sentinels or strings.** Host: `Schema.Number` advertises `"Infinity"`,
  `"-Infinity"` and `"NaN"`, some models send numbers as strings, and the host renders a union as one
  flat `anyOf` (the number, the sentinel enum, the string). Courier: `courier_later` takes
  `delayMinutes` as number or string. Where: `src/scheduling/tools.ts`; the snapshot in
  `test/notices.test.ts` pins the schema.
- **Schemas are shared across steps.** Host: tool schemas are converted once and shared; the runner
  waits for plugin reloads before each step; a call to a tool deleted from the map gets
  `Tool is not available for this request: <name>` and the turn goes on. Courier: the `context` hook
  only deletes tools from the map, never edits a schema in place. Where: `src/tree/context.ts`;
  `run_depth` in `e2e/run.sh`.
- **Schemas are closed.** Host: every Effect tool schema is rendered with
  `onExcessProperty: "error"`. Courier: renders them the same way in its snapshot. Where:
  `test/notices.test.ts`.
- **Undeclared keys are deleted.** Host: `tool-input-repair` deletes a key a tool does not declare
  before the tool runs. Courier: a renamed optional key stays declared under its old name while it is
  accepted. Where: `src/*/tools.ts`.
- **Reading `context.signal` opts into a cooperative stop.** Host: a promise tool that reads
  `context.signal`, or spreads the context, gets the signal aborted on the person's stop, and
  whatever it returns is its result. Courier: tools read only `sessionID`, `id` and `messageID`, so
  a stop interrupts them. Where: `src/*/tools.ts`.

## Events

- **Events reach every location's instance.** Host: `permission.*`, `form.*` and
  `session.execution.*` reach every location's instance through `event.subscribe()`, with the same
  event id; an instance gets only events published while it is subscribed. Courier: the hub keeps a
  standby subscription for hand-over and relays pending requests on every (re)subscribe. Where:
  `src/platform/hub.ts`, `relayPending` in `src/person/events.ts`; seen with `e2e/probe-plugin`.
- **`types` filters the stream.** Host: `event.subscribe({ types })` (since `@opencode/plugin@2.2.0`)
  yields only those types; `types` cannot name `server.connected`, which a plugin never receives; the
  adapter forwards only `types` and `signal`, never `onActivity`, so a plugin cannot tell when its
  stream connects. Courier: subscribes with its modules' types, so it never sees streamed
  `session.text.*`, `session.reasoning.*` and `session.tool.*`; still drops an event outside its
  types for a host that ignores the filter; runs the `followed` hooks at the first event or
  `CONNECTED_MS` after subscribing. Where: `src/platform/events.ts`.
- **An execution is one busy period.** Host: `session.execution.started`, `.succeeded`, `.failed` and
  `.interrupted` frame a busy period, one terminal event however many prompts were steered in.
  `.interrupted` has `reason` `user` or `shutdown` (resumed on the next start; a plain decline
  reports it too, see [Permission requests](#permission-requests)); the schema's `inactivity` and
  `superseded` are published by nothing. A steered message interrupts nothing: `inbox.enqueued`
  (`delivery: "steer"`), `inbox.delivered` at the next step, one `.succeeded`. An interrupt with
  `resume` while a steer waits publishes `.interrupted` (`user`), then `.started` and the steer's
  `inbox.delivered`. Courier: reads turn ends from these. Where: `src/tree/events.ts`.
- **Every event carries `created`.** Host: its publish time in epoch milliseconds. Courier: relies on
  it. Where: `src/tree/events.ts`.
- **`retryAfterMs` can overflow a `Date`.** Host: a failed execution's `retryAfterMs`, set by rate and
  quota limits, counts from the event's `created`; a provider's retry header is clamped to 2^53 ms.
  Courier: ignores a wait over 30 days. Where: `src/tree/domain.ts`.
- **402 fails at once, 429 retries.** Host: a provider's 402 fails the turn at once; a 429 is retried
  for minutes. Courier: the live suite's out-of-quota child answers 402. Where:
  `e2e/mock-model.mjs`.
- **Closing a stream can hang.** Host: `return()` on a subscription's iterator waits on OpenCode,
  which may not answer while a location closes. Courier: closes it without awaiting. Where:
  `src/platform/events.ts`.
- **`session.status` and `session.idle` never come.** Host: nothing in core publishes them. Courier:
  does not subscribe to them.

## The inbox and wakes

- **`delivered` carries only the id.** Host: `session.inbox.delivered` (`data.inboxID` only) is
  published as each prompt, synthetic message, requested compaction or move reaches the session; the
  delivered message is stamped with the event's `created`. The runner's own compactions skip the
  inbox, as does its continuation after the output token limit (after two continuations the turn
  fails as `output-limit`). Only `session.inbox.enqueued` carries the item's type (`user`,
  `synthetic`, `compaction`, `move`) and a synthetic item's `payload.metadata`; the `synthetic`
  call's returned id may arrive after the `delivered` event. Courier: remembers each item's kind from
  `enqueued` until delivery; `notePrompt` tells a session's own check-in and a status-less message
  from other courier messages by metadata; a continued turn owes no report again. The report
  reminder matches its delivery by id ([the idle hook](#the-idle-hook)); one delivered before its id
  is noted reads as a prompt. Where: `src/tree/events.ts`.
- **A `user` item does not say where it came from.** Host: a prompt's `metadata` is copied into the
  inbox item's user payload, and `enqueued` carries it; a prompt through the API or `opencode run`,
  `/init`, `/review`, a prompt with a skill attached and a `subagent` follow-up all arrive with
  `metadata: null`. Courier: the fan-up of typed text goes by item kind, not author. Where:
  `src/tree/relay.ts`.
- **What the TUI sends.** Host (`packages/tui/src/component/prompt/index.tsx`): typed text goes
  through `data.session.prompt` with no metadata, a slash command through `session.command`; the `!`
  shell mode calls `session.shell`, which admits no `user` item (it records the shell's start and end
  and a `synthetic` result with `resume: false`). Courier: the fan-up reads `user` items, so a pin
  bump re-checks each. Where: `src/tree/relay.ts`.
- **`/goal`'s kickoff carries `source: "goal"`.** Host (`packages/core/src/plugin/goal.ts`): it is a
  `synthetic` item unless the prompt has attachments, then a `user` prompt. Courier: the fan-up passes
  the `user` one up; a pin bump re-checks which one it is. Where: `src/tree/relay.ts`.
- **`session.inbox.cancelled`.** Host (`packages/core/src/session/inbox.ts`): published for an item
  withdrawn before delivery. Courier: drops the stored text of a typed-in item on it; a pin bump
  re-checks that it still comes. Where: `src/tree/events.ts`, `src/tree/relay.ts`.
- **How a synthetic message wakes an idle session.** Host: `session.synthetic` admits it
  (`inbox.enqueued`, a pending inbox row), then rings the run coordinator, which publishes
  `execution.started` and drains: `inbox.delivered`, the turn, one terminal event. A healthy wake is
  `enqueued → started → delivered → … → succeeded`. Only a new synthetic, prompt, compaction, skill or
  resume rings again. Courier: the missed-wake watch follows that sequence. Where: `src/tree/wake.ts`.
- **A lost wake is silent.** Host: `enqueued` with no `started`; `synthetic` skips the wake while a
  revert is staged, and an interrupt between the doorbell and the stop clears the wake with no error
  or log. Neither reproduces on demand. Courier: `watchWake` keys on that signature; `delivered`
  without `started` means this instance missed an event, and `time.busy`
  ([below](#is-a-session-running)) records a start whose event was missed. Where: `src/tree/wake.ts`.
- **A waiting item hides from the transcript.** Host: a waiting inbox item bumps `time.updated` (to
  the item's `time.created`, `idle` unchanged) and is not in the transcript until delivered, so the
  session reads at rest; the plugin API cannot list the inbox (`GET /api/session/:id/inbox` can).
  `session.synthetic` with the `id` of an item already waiting or delivered returns that item and
  still wakes the session. Courier: a re-sent wake reuses the id, so it adds no message; the
  `inbox.enqueued` event is handled apart from the `synthetic` call that caused it. Where:
  `src/tree/wake.ts`, `src/tree/events.ts`.
- **`resume: false` is the only way to send without starting a turn.** Host: `queue` still wakes an
  idle session; with `resume: false` the item waits for the next turn; `inbox.enqueued` does not
  carry `resume`. Courier: marks such messages in their metadata (`resume: false` beside
  `source: "courier"`) and `watchWake` skips them; a permission request's settled notice, the report
  reminder and the fork notice are sent this way. Where: `src/tree/wake.ts`,
  `src/person/events.ts`, `src/tree/nudge.ts`, `src/tree/fork.ts`.

## Is a session running

- **`time.updated` is no sign of activity.** Host: stamped for renames, metadata, permissions, agent
  and model switches, moves, archive and unarchive (which also set `time.archived`), reverts,
  `inbox.enqueued`, and as a step starts or ends; never on a turn's tool or text events. A turn's end
  sets `time.idle`, not `time.updated`, so `updated > idle` holds both for an idle session renamed
  since and for one between two steps. Courier: does not read activity from it. Where:
  `src/tree/running.ts`, `src/tree/domain.ts`.
- **`time.idle` is when the last turn ended.** Host: stamped from `execution.succeeded`, `failed` and
  `interrupted`, but not from a shutdown; never cleared, always moves forward, in place by the time
  the plugin sees the turn's end. Courier: relies on it. Where: `src/tree/running.ts`.
- **`time.busy`** (since 2.2.2). Host: the start of the latest execution, stamped on
  `session.execution.started` with `time.updated` left untouched; absent until a session's first
  execution. Courier: `busy` not later than `idle` is at rest since `idle`, whatever `updated` says;
  `busy` later than `idle` (or `idle` undefined with `busy` set) is a session running or one at rest
  after a `shutdown` interruption, a plain decline included, which stamps no `idle` (the resumed
  execution stamps `busy` again); only the transcript tells the two apart. Where:
  `src/tree/running.ts`, `src/tree/domain.ts`.
- **The transcript.** Host: `session.context()` returns stored messages, not what the `context` hook
  sees, starting at the last compaction. A turn's end is an `idle` message with
  `outcome: "succeeded" | "failed" | "interrupted"`; the `agent-switched`, `model-switched` and
  `location-switched` messages and a person's `shell` message are no turn. A turn ended by a plain
  decline or dismissed question ends on an assistant message with `error.type` `aborted`
  (`STEP_INTERRUPTED`) and sets no `time.idle`; a shutdown during a step leaves the same mark, and the
  next boot resumes the turn. `skill`, `compaction` and a `system` notice start a turn. Courier: a
  transcript ending on `idle`, past those no-turn messages, is at rest; one ending on the aborted
  message is at rest and ended when that message completed; any other message after `idle` reads
  running. Where: `endsIdle` in `src/tree/domain.ts`.
- **A delivered item stamps nothing until its first step.** Host: a read just after a stamp can show
  rest for a session about to run. Courier: tolerates the window. Where: `src/tree/running.ts`.

## The idle hook

`experimental.idle` (`SessionIdle { sessionID, background }`, since 2.2.4) runs in `SessionRunner`
(`packages/core/src/session/runner/llm.ts`) when a session that ran the model has no pending input
and would go idle. Its name and shape may still change: a pin bump re-checks both.

- **Shape.** Courier: reads only `sessionID` and each `background` item's `sessionID`. Where:
  `src/tree/nudge.ts`.
- **Admitted input keeps the execution going.** Host: after the hook, the runner checks the inbox and
  loops; a hook that always admits input loops forever. Courier: sends the reminder with
  `resume: false`, which only skips `execution.wake`, and the missed-wake watch skips it; the
  `nudged` note bounds it to one per prompt. Where: `src/tree/nudge.ts`, `src/tree/store.ts`.
- **It does not always run.** Host: not after an interruption (a plain decline, a dismissed
  question), a failure or control-only work such as a manual compaction. Courier: those ends are told
  without a reminder. Where: `src/tree/events.ts`.
- **A throw fails the execution.** Courier: `onIdle` logs every failure. Where: `src/tree/nudge.ts`.
- **The reminder publishes inbox events.** Host: admitted input still publishes `enqueued` and
  `delivered`. Courier: `notePrompt` matches its inbox id to the `nudged` note rather than taking it
  for a new prompt. Where: `src/tree/events.ts`.
- **Unknown hook names are accepted.** Host: `PluginHooks` keys callbacks by name without checking
  it, so a host without the hook takes the registration and never runs it. Courier: the parent is
  then told of a silent end as without the hook; the hook is registered after the `context` hook and
  a refusal is logged. Where: `src/index.ts`.
- **Every instance's callback runs, after `/goal`'s.** Host: `trigger` runs every callback for the
  name in registration order, each loaded instance's, after `pre` built-ins such as `/goal`'s, which
  run before package plugins. On a child with an active goal, its continuation may already be pending
  when the reminder is admitted; the plugin API cannot read a session's inbox, and the goal's state
  is in its own plugin's storage. Courier: the hub's claim and the `nudged` note keep it to one
  reminder; both inputs go in the next step, the reminder says to carry on if work is left, and that
  prompt's one reminder is spent. Where: `src/tree/nudge.ts`.

## Permission requests

- **Requests are per location.** Host: pending requests are kept per location, and an instance's
  `permission` domain answers only its own. Courier: keeps every instance's domain, so an isolated
  child's request is answered through the instance in its worktree. Where: `src/person/permission.ts`.
- **`decision` in, `reply` out.** Host: `permission.reply` takes `decision`; the `permission.replied`
  event carries `reply`. Courier: `courier_answer` takes `reply`. Where: `src/person/permission.ts`.
- **A rejection without a message ends the turn.** Host: it ends the asking turn ("The user declined
  this tool call"); with a message only the call fails, and the model is not told the message.
  Courier: every rejection carries one. Where: `src/person/permission.ts`.
- **A plain decline looks like a shutdown.** Host: it sets no `time.idle` and no `idle` message; the
  execution ends as `interrupted` with `reason: "shutdown"` on an `aborted` assistant message, keeping
  its claim, so the next boot resumes the turn ("The server restarted while you were working") and
  stamps `time.busy` again. A message steered in during the turn is then delivered at once in a turn
  of its own. Courier: tells it from a real shutdown by the transcript ending on the aborted message.
  Where: `endsIdle` in `src/tree/domain.ts`, `wakeEnded` in `src/tree/wake.ts`.
- **`permission.assert` resolves with nothing.** Host:
  `permission.assert({ sessionID, action, resources, save?, metadata?, source?, agent? })` checks the
  session's rules and, on ask, creates a request in that session and waits. The request's id and
  whether the person chose `once` or `always` come only from the events. With `save`, `always` saves a
  project-wide rule and answers every other pending request it covers. It rejects with a
  `Tool.Error` wrapping `Permission.BlockedError` (deny rule), `Permission.CorrectedError` (rejection
  with feedback) or `Session.NotFoundError`, with the cause as its `error`, and builds the
  `Tool.Error`'s `message` from the cause: the deny rule's message, the rejection's `feedback`, or
  "Session not found: <id>". A plain rejection rejects with `Permission.DeclinedError` itself, which
  ends the step only if the tool rethrows it untouched. Courier: `courier_answer` asserts without
  `save`; `refusalOf` reads the feedback from the wrapping error's `message`, so the person's reason
  reaches the result; the plain decline is rethrown as it is, not through `describeFailure`. Where:
  `src/person/permission.ts`; `run_answer` in `e2e/run.sh`.
- **`opencode run --auto` answers asserted requests.** Host: it replies `once` to every request in its
  session, asserted ones included. Courier: the scenario that holds the prompt drives the parent
  through the API. Where: `e2e/run.sh`.
- **The TUI's prompt shows little of a plugin's action.** Host: the prompt renders per action; an
  action it does not know, such as a plugin's, shows only `Tool: <action>`, without its resources. A
  `source` of type `tool` adds that tool call's input and metadata. Request `metadata` is read only
  for `url`, `query`, `provider`, `files`, `diff`, `parentDir` and `filepath`, and `assert` cannot set
  the request's `message`. `permission.list` gives `metadata` and `source` back. Courier: the asks
  inbox reads from them which child the top's prompt is for. Where: `src/person/permission.ts`,
  `src/person/tui.tsx`.

## The question tool and forms

- **`tool.transform` replaces any tool.** Host: the editor's `update` replaces any tool's `execute`,
  OpenCode's included; `question` comes from an OpenCode plugin that loads before external ones.
  Courier: wraps `question` for the relay; a later plugin that replaces it too drops the relay.
  Where: `src/person/question/relay.ts`.
- **Only an interrupt withdraws a question.** Host: the plugin API cannot answer or withdraw a form.
  Courier: the default export is an Effect plugin (`{ id, effect }`) that runs the promise plugin
  through `fromPromise` (`@opencode/plugin/promise/adapter`) and wraps `question` with the Effect
  API, whose `execute` can be interrupted once the parent's answer is in. Where: `src/index.ts`,
  `src/person/question/relay.ts`.
- **The adapter passes the same `location`.** Host: the promise plugin gets the same `location`
  object. Courier: the relay finds its ports in the hub by it; an adapter that copied it would break
  the relay. Where: `src/person/question/relay.ts`.
- **Forms live in memory.** Host: `form.created` (never stored) carries `metadata.tool.id`, and comes
  only after the call's permission check passed. A dismissal kills the tool with
  `QuestionTool.CancelledError`, ending the turn. A restart drops forms, and the call stays `running`
  until the next turn marks it aborted. Courier: reads dismissals from that error. Where:
  `src/person/question/pure.ts`.
- **What a plugin sees of forms.** Host: `form.created`, `form.replied` and `form.cancelled`. Forms
  come from the question tool (`kind: "question"`), web search and MCP elicitation
  (`kind: "mcp-elicitation"`, session id `global`). `GET /api/form` lists them;
  `DELETE /api/session/:id/form/:form` dismisses one. `session.form.list` on a session whose location
  is idle answers an empty list without booting it. Courier: relays forms of sessions it spawned.
  Where: `src/person/form.ts`.
- **Conditional fields.** Host: a field shows when all its `when` conditions hold; a condition on a
  field not answered is false; on a multiselect, `eq` means the answer includes the value. A hidden
  field is not asked: OpenCode's form view submits its default, when it has one, and conditions read
  it. Courier: the asks inbox does the same. Where: `src/person/tui.tsx`.

## Locations

- **Eviction.** Host: a location is evicted after 60 minutes without a stored session event
  (`experimental.location_idle_timeout`, `false` turns it off), but never while a session in it is
  executing, a background job it owns runs, or a terminal or client MCP socket retains it. Eviction
  interrupts no session. A tool call has no timeout. Courier: relies on it.
- **A shutdown looks like a dismissal.** Host: a graceful shutdown closes locations one by one; a
  closing location first withdraws its forms, so a question call dies with
  `QuestionTool.CancelledError` as if dismissed; about 40 ms later `location.shutdown` arrives, then
  the plugin unloads. Courier: the question relay holds a dismissal 2 seconds
  (`dismissalGraceMs`) to tell the two apart. Where: `src/person/question/lifecycle.ts`.
- **Some routes 404 for a gone directory.** Host: `GET /api/plugin?directory=<worktree>` does not boot
  that location; a session there does. A session whose location's directory is gone answers 404
  `LocationNotFoundError` on some routes (not the instruction-entry, interrupt, rename, archive,
  `synthetic` and `compact` ones, which do not boot the location; the plugin API's
  `session.synthetic` is the global session service's). The health route is `/api/info`. Courier: a
  test for a deleted session by an error tag with `NotFound` matches that error too. Where:
  `isNotFound` in `src/platform/json.ts`.
- **Directories are canonical.** Host: directories that differ by a trailing slash or `..` are one
  location, and `session.create` stores the canonical directory. Courier: compares no directories
  today; a comparison must resolve both first.

## Installing and loading a plugin

- **Options come from a `plugins` entry.** Host: from a `{ "package", "options" }` entry; a local
  plugin must be a directory, and a path to a file is ignored with a warning. Courier: documents it.
  Where: [reference.md](../reference.md#options).
- **Nothing checks the version.** Host: `opencode plugin add` installs into an empty directory under
  `~/.cache/opencode/npm/`, with the peers at the versions the package names; neither it nor the
  loader reads `peerDependencies` or `engines`. Courier: warns in the server log on another version.
  Where: `src/platform/version.ts`; for users,
  [reference.md](../reference.md#the-opencode-version).
- **The host's copies run.** Host: `ensurePluginRuntime` (`packages/plugin/src/runtime.ts`) resolves
  every import of `effect` and `@opencode/plugin*` to OpenCode's own copy. Courier: the installed
  peers serve the build, the tests and older hosts; either way the relay's Effects and the host's
  must compose, so the plugin's `effect` is the host's version. Where: `package.json`.
- **The peers stay exact.** Host: a range would install, on an older host, the newest match, which
  nothing tested. Courier: exact peers; the exact `effect` peer can fail `npm install` with ERESOLVE
  in a project with another `effect`, which `opencode plugin add` never meets. Where: `package.json`.
- **Update checks skip exact versions.** Host: `plugin check`, `plugin update` and the TUI's check
  parse the entry with `npm-package-arg` and skip type `version` without asking the registry.
  Courier: documents it. Where: [reference.md](../reference.md#updating-the-plugin).

## Managed policy

- **`plugin.use` can refuse the plugin.** Host: the loader refuses a plugin the organisation's
  managed policy denies, `plugin.use` on the plugin's target, before `integration.use` on
  `plugin:<name>`; a legacy `integration.use` whose resource starts `plugin:`, `skill:` or `mcp:`
  decodes into the new action, so old policies still apply. Courier: nothing to do.
- **`skill.use` removes the skill.** Host: a `skill.use` deny removes the skill from the registry in a
  `post` plugin, after the courier's `editor.add`; a denied `courier-orchestrate` is then neither
  listed nor loadable (`skill` fails "unable to load", `/skills` with `SkillNotFoundError`). Courier:
  the tools and the role part work without it, as with a `skill` rule's deny. Where: `src/skill.ts`;
  `COURIER_SKILL=deny` in `e2e/real-model.sh`.

## Console event watches

- **A watch is invisible to the plugin.** Host: with the `console_watches`
  [feature flag](#feature-flags) on and a Console workspace that has event watches, OpenCode's
  Console plugin adds the Code Mode tools `console_watch.watch` and `unwatch`, pinned in the catalog.
  A watched Slack thread, pull request, issue, commit, Actions run or MCP server event wakes the
  session with `session.synthetic` (`metadata.source: "console.watch"`, `delivery: "steer"`), at
  most 5 times in 10 minutes and 20 since the person's last prompt. Like
  [a schedule](#opencodes-schedules), a watch has no API, no event and no `Waits` supplier, so a
  spawned session that watches something and ends its turn reads as ended without a report and goes
  on when the watch fires. Courier: `CHILD_RULES` does not deny these tools (denied the tool, a
  session told to wait for a pull request kept looking for another way and did not report); the
  brief asks such a session to tell its parent and schedule itself a `courier_later` check-in first,
  which `isScheduled` supplies to `Waits`. Where: `childBrief` in `src/tree/text.ts`,
  `src/scheduling/later.ts`.

## Feature flags

- **Flags are off in a release build.** Host: `todo`, `background_compaction`, `media_blob`,
  `schedules`, `artifacts`, `shell_timeout_background`, `console_watches`, `mcp_events`
  (`packages/schema/src/config/flag.ts`) are off in a release build, on in local and dev builds,
  turned on by `experimental.<key>: true`, `experimental.all_flags: true` or `OPENCODE_FLAGS=all`
  (`-key` turns one off). Courier: the traps above and below that need one name it.

## Native `parentID`

What a native child (`courier_spawn` with `native: true`) rests on:

- **`Session.create` takes a `location` or a `parentID`**, never both. Host: with a parent the child
  takes its location. Courier: an isolated child cannot be native. Where: `src/tree/spawn.ts`.
- **Inheritance.** Host: with a `parentID` and no `permissions`, a child gets its parent's session
  ruleset; a ruleset passed is kept; `metadata` is inherited too. Courier: passes its own ruleset
  (`CHILD_RULES`, [OpenCode's schedules](#opencodes-schedules)) and its own metadata. Where:
  `src/tree/spawn.ts`.
- **Providers see a subagent.** Host: `parentID ?? fork?.sessionID ?? id` goes out as
  `x-session-affinity`, `X-Session-Id`, `x-opencode-session` and `promptCacheKey`, plus
  `x-opencode-parent-session-id` and `x-parent-session-id`; GitHub Copilot sends
  `X-Interaction-Type: conversation-subagent` and `x-initiator: agent`. Courier: documents it for
  users. Where: [reference.md](../reference.md#native-child-sessions).
- **The TUI.** Host: a root's view lists the asks of the root and every descendant; a child's view
  lists none. `autoaccept` replies `once` for the family. Session lists show `parentID: null` only. A
  root's `cost` sums its family. Courier: documents it for users. Where:
  [reference.md](../reference.md#native-child-sessions).
- **`opencode run` owns the family.** Host: `once` with `--auto`, reject without, and it cancels their
  questions and forms. Courier: the live suite drives native scenarios through
  `POST /api/session/:id/prompt`. Where: `api_prompt` in `e2e/run.sh`.
- **`opencode run` and a running native child.** Host (`packages/cli/src/run/noninteractive.ts`): once
  the root is idle, the run waits while any session under it is active, but checks again only when a
  turn ends in the root or in the session of a job (a shell, a subagent of OpenCode's own), which a
  courier child is not. A native child still running at that check keeps the run from exiting until
  a later turn of the root ends. Courier: a notice it sends at the child's end (it failed, it ended
  without a report) starts such a turn; a report does not for certain, since the child sends it from
  its turn, which ends a step later, so the turn the report starts in the root may end first, and the
  run then waits for good. With the mock model the root's turn ends about 25 ms before the child's,
  and the run stalls when the client's check takes less than that. Where: `e2e/run.sh` (through the
  API).
- **Deletion.** Host: `Session.remove` interrupts and removes each native child recursively, with a
  `session.deleted` each. Courier: forgets them on the event. Where: `src/tree/events.ts`.
- **No generated title.** Host: no title and no warming for a session with a `parentID`. Courier: sets
  the title. Where: `src/tree/spawn.ts`.
- **OpenCode reports every turn end to the parent.** Host: when an execution of a session with a
  `parentID` ends (succeeded with an assistant message, failed, or interrupted by the person, not a
  shutdown), the host admits a synthetic `<subagent sessionID="…"
  state="completed|error|cancelled|running" description="…">` with the child's last text into the
  parent (`metadata: { source: "subagent", childID, agent, state }`, delivery `steer`, without
  `resume: false`) and wakes it unless a revert is staged. No job is needed, so a native courier child
  sends one per turn. Nothing opts out: neither the session nor the subagent tool has a switch, and
  the plugin API cannot withdraw an inbox item. Courier: `notePrompt` keeps such a message from
  counting as a prompt in a parent started with `courier_spawn`; `courier_stop` waits for it from a
  stopped native child, as from a subagent; the parent's `role` entry tells the model what the
  message is (`HOST_REPORTS`, [architecture.md](architecture.md#instruction-entries)) rather than the
  `context` hook editing it, since the child's last text in it is the only copy when a child ends
  without reporting. Where: `src/tree/events.ts`, `src/tree/stop.ts`, `src/tree/text.ts`.
- **A restart resumes a directly driven child**, a native child included, and defers the resumed
  children's wakes until the parents' attempts are counted. Courier: relies on it.

## OpenCode's subagent tool

What reading OpenCode's subagents into a tree rests on:

- **The tool is `subagent`**, not `task`. Host: it creates the child with `parentID` and the
  `description` as title, and prompts it with `You are a subagent spawned by another session.` first.
  Its input is `agent`, `description`, `prompt`, `model` and `sessionID`, and any other key a mock
  sends is deleted ([Tools](#tools)). `experimental.subagent_depth` (default 1) counts `parentID`
  links up to the root, so a native courier child cannot start one by default; a standalone one can.
  Courier: reads subagents into the tree by `parentID`. Where: `src/tree/subtree.ts`.
- **`session.list({ parentID })`.** Host: lists a session's children from any location, 50 by
  default, most recently updated first; `ctx.session.list` is the same call. Courier: finds subagents
  with it. Where: `src/tree/subtree.ts`.
- **Every call runs in the background** and returns at once; nothing ties the child to the parent's
  call. Host: each time the child's execution ends, interrupted included, the parent gets the report
  [above](#native-parentid), which wakes an idle parent, or one still stopping; its `state` is
  `running` while the child's own background work runs. Courier: `courier_stop` waits for it
  (`SETTLE_MS`) and interrupts the parent again. Where: `src/tree/stop.ts`.
- **An existing session is accepted.** Host (`packages/core/src/tool/plugin/subagent.ts`): `subagent`
  takes the id of a session whose `parentID` is the caller and prompts it as a plain `user` item.
  Courier: a parent's follow-up into its native child is a `user` item like typed text, and the
  fan-up passes it up; a pin bump re-checks it. Where: `src/tree/relay.ts`.
- **A completed call's content** names the child's id (`working in the background (sessionID: …)`).
  Courier: the live suite reads it. Where: `e2e/run.sh`.

## Models and variants

- **A session's model wins over its agent's variant.** Host: `session.create` takes
  `model: { providerID, id, variant? }` (`Model.Ref`); a session that names a model runs on it at its
  own `variant`, and the agent's `model.variant` counts only for a session with no model. Courier:
  passes the agent's variant with its model. Where: `src/tree/model.ts`.
- **A wrong model fails the first turn.** Host: a model OpenCode does not have, or a variant the model
  has not, fails the session's first turn (`ModelUnavailableError`, `VariantUnavailableError`);
  `"default"` is no variant, and `session.get` fills `variant: "default"`. Courier: `courier_spawn`
  checks a choice against `model.list()` first (`models.available()`, the enabled models, each with
  its `variants`). Where: `src/index.ts`, `src/tree/model.ts`.
- **Configured models get default variants.** Host: a configured model given neither
  `capabilities.reasoning` nor `variants` gets its package's defaults: `low`, `medium` and `high` for
  an OpenAI-compatible one, each the setting `reasoningEffort`, which reaches the provider as
  `reasoning_effort`. Courier: the live suite's `mock/chat` and `mock/other` have them. Where:
  `e2e/run.sh`.
- **A session may name no model.** Host: a session `opencode run` without `--model`, or the API,
  creates has no `model`; the runner takes `model.default()`. Courier: reads that default itself
  (`ctx.model.default()`, the plugin's own location) and passes it to `session.create` as such a
  parent's model, so a `variant` alone has a model to apply to and the child is pinned to it; with the
  agent's lookup failed it passes none, since OpenCode then applies the agent's own model. Where:
  `src/index.ts`, `src/tree/model.ts`.
- **Agent and provider listings.** Host: `agent.get` takes `location`; `provider.list` waits for
  plugin activation; `agent.list` does not and returns the agents loaded so far. Courier: looks up
  the agent with `agent.get`. Where: `src/tree/model.ts`.
- **A request's model can differ from the session's.** Host: the `experimental.model.resolve` session
  hook lets a plugin serve one request with another model of the same provider (GitHub Copilot's Auto
  does); the session keeps its selection. Courier: reads and sets the session's selection. Where:
  `src/tree/model.ts`.

## Creating a worktree from a given commit

`worktree.create`, `.remove` and `.list` take `projectID` (`location.project.id`); `create` takes
optionally `from`, `branch`, `directory` and `name`:

- **`from` is a source directory, not a ref.** Host: one the project knows, else
  `SourceDirectoryNotFoundError`. Courier: passes the parent's worktree. Where: `src/tree/spawn.ts`.
- **`branch` is a starting ref, not a new branch.** Host: it runs
  `git worktree add --detach -- <dir> <branch ?? HEAD>`, so a commit works, HEAD is always detached,
  and uncommitted changes are not carried over. Courier: for a nested isolated child passes the
  parent's worktree HEAD, recorded as the roster entry's `base`. Where: `src/tree/spawn.ts`.
- **Worktrees share one repository.** Host: commits and branches are visible across a project's
  worktrees. Courier: the parent merges a child's branch from its own checkout.

## Keyed session instructions

`ctx.session.instructions.entry.put({ sessionID, key, value })`, `.list({ sessionID })` and
`.remove({ sessionID, key })`, since `@opencode/plugin@2.2.0`; over HTTP
`GET /api/experimental/session/:id/instructions/entries` and `PUT` or `DELETE …/entries/:key`
(`packages/protocol/src/groups/session.ts`; the plugin API's path has no `experimental`). The SDK's
`client.session.instructions` is a deprecated alias of `client.experimental.session.instructions`,
and the plugin context's path may move with it, so a pin bump checks it in
`packages/core/src/session/instruction-entry.ts`. Which entries the courier writes:
[architecture.md](architecture.md#instruction-entries).

- **Rendering.** Host: an entry is one block, `<context key="<key>">`, the value, `</context>`: a
  string as it is, any other JSON pretty-printed. The key matches `^[a-z0-9][a-z0-9._-]*$` (stored as
  `api/<key>`), and the value's JSON is at most 256 KiB (`InstructionEntryValueTooLargeError`, 413).
  A `put` of the value already stored changes nothing and announces nothing. Courier: puts `role` and
  `standing` as strings. Where: `src/tree/spawn.ts`, `src/tree/standing.ts`.
- **Where it lands.** Host: the entries are the last of OpenCode's instruction sources, after the code
  mode catalog, MCP instructions, references, the skill listing, AGENTS.md and the built-ins, all
  rendered into one *baseline*: the second system part, after the agent's system prompt and before
  anything a `context` hook pushes; the hook's `event.system` is that pair. The part also carries
  each source's text in `metadata.experimental.instructions` as `{ key, text }`, an entry under its
  stored key (`api/role`), not updated when a hook edits `text`. Courier: a part it adds comes after
  the block; since that metadata is experimental, it reads the `role` entry through `entry.list`.
  Where: `src/tree/context.ts`.
- **The baseline is fixed at the session's first step** and moved only by a compaction or a revert
  that removes an instruction update or the epoch start. Host: an entry put between `session.create`
  and the first prompt is in the system prompt from the first request, and the first `put` after
  spawn moves no cached prefix. An entry put after the first step is announced at the next step
  boundary as a `session.instructions.updated` event whose `text` is the block (a new key), "The
  context under "<key>" changed and supersedes the previous value:" with the block (a changed one)
  or "The context under "<key>" no longer applies. Disregard it." (a removal). It is stored as a
  `system` message (`description` `Instructions updated: api/<key>`, every key changed since the last
  step in one message, sorted: `api/role, api/standing` when a fork drops both; in a turn a courier
  message starts, it comes before that message), which goes to the model at its place in the
  transcript, after the tool result that put the entry, as a **user** message: `<system-update>`, the
  text with `&`, `<` and `>` escaped, `</system-update>` (AI SDK routes do not all allow the system
  role after history). So the block arrives as `&lt;context key="role"&gt;`. The baseline stays, so
  the prefix before the update holds. The plugin API's event carries that `text` and the keys'
  hashes (`delta`), never the value; the first sync after the first step has no text. Courier: puts
  `role` before the first prompt to keep the cache; a mock keyed on "the last message is a tool
  result" must skip the update. Where: `src/tree/spawn.ts`; `e2e/mock-model.mjs` skips it and logs
  the role it arrives as (`updateRole`); `e2e/run.sh` checks the fork's sorted keys.
- **A compaction keeps it.** Host: after a compaction the entry's current value is in the baseline,
  and the transcript replays from the compaction message, so the update message is no longer sent. A
  compaction's own model request carries the baseline too, so its model sees the block; it also
  carries the session's whole tool list and runs the `compaction` hook, not `context`, so a leaf's
  compaction model sees all eight courier tools (its prompt says to call no tool). The summary must
  hold a line equal to one of the template's headings (`## Objective`, …): a reply without one is
  nudged once ("did not fill in the required summary template"), then the compaction fails
  (`session.compaction.failed`, no `ended`). Courier: relies on it. Where: `e2e/mock-model.mjs`.
- **What inherits it.** Host: `session.fork` copies the parent's entries and baseline; a native child
  (`parentID`) and `session.create` do not. Courier: `courier_cleanup` and a forgotten child leave
  entries alone: they belong to the session and go with it. Where: `src/tree/cleanup.ts`.
- **A fork is announced.** Host: after the copy, `Session.fork` runs the `fork` session hook
  (`SessionHooks.fork: { sessionID }`, since 2.3.0) with the fork's `sessionID`, in the fork's
  location, failures logged and ignored; the built-in `fork-notice` plugin uses it to admit a
  `<fork-notice>` synthetic with `resume: false` (background work and notifications stay with the
  original), which waits in the fork's inbox for its first prompt. The fork's `Session.Info` names
  the original in `fork.sessionID` and carries the original's `metadata`, the courier's
  `courier.parentID` of a spawned child included; its `parentID` is empty. Courier: registers the
  hook last, a refusal logged; `onFork` removes the fork's `role` and `standing` entries and admits
  its own `resume: false` notice after the host's
  ([forking a session in a tree](../reference.md#roster)). Where: `src/index.ts`, `src/tree/fork.ts`.
- **What a fork's first request looks like.** Host: the fork's baseline is seeded from the original's
  *current* entry values, not from the original's baseline, and the copied transcript keeps its
  instruction updates. So a fork of a session whose entries have not moved since its first step, a
  spawned child with its `role`, has the original's system prompt byte for byte; a fork of one whose
  entries moved after it, a root named at its first spawn or any parent with a `standing` entry,
  starts from a baseline the original never sent, whatever a plugin does. A `remove` in the hook
  leaves that baseline alone: the fork's first step announces it as one appended update ("The
  context under "role" no longer applies. Disregard it.", `Instructions updated: api/role` or
  `api/role, api/standing`), after the copied messages, like the two notices. The stale block stays
  in the fork's baseline until a compaction. Courier: `context.ts` finds a role line there and pushes
  no part, so the request's system prompt and copied messages stay the original's; what differs is
  the tool list of a fork of a leaf: with no roster entry it is a top session, and none of the four
  tools hidden from a leaf is hidden from it. Where: `src/tree/context.ts`, `src/tree/fork.ts`.
- **Reading it.** Host: `put`, `list` and `remove` need the session to exist
  (`Session.NotFoundError`) but boot no location. The request hooks' `messages` carry each stored
  message's `metadata`, for reading only (`SessionRequestMessage`). Courier: the `context` hook uses
  neither and reads nothing of the value; the text itself only shows in the model's request. Where:
  `src/tree/context.ts`; `e2e/mock-model.mjs` logs `roleEntry` and `rolePart`.

## Skills

- **Registering.** Host: `ctx.skill.transform((editor) => editor.add(info))` with `id`, `name`,
  `description`, `autoinvoke`, `path` and `content`. `path`'s directory is named to the model; a
  `skill://<id>/…` path names `skill://<id>` as the directory, and the `read` tool serves
  `skill://<id>/SKILL.md` from the registry, after the `skill` and `read` permissions.
  `Skill.Info.path` is a branded string with no shape check. The host's editor takes extra in-memory
  files beside such a skill; the plugin API's `SkillEditor.add` passes none. The same id from several
  locations is one entry. Courier: a skill without files gives its own path,
  `skill://courier-orchestrate/SKILL.md`, as the built-ins' is `skill://opencode/SKILL.md`, so a model
  that reads the directory it was told about gets the content. Where: `src/skill.ts`, `src/index.ts`.
- **Listing.** Host: every skill with a `description`, `autoinvoke` not `false` and not denied by a
  `skill` rule is listed in every system prompt (`<available_skills>`, sorted by id); a change
  reaches a running session as a delta. `GET /api/skill?directory=…` lists them. Courier: relies on
  it. Where: `src/skill.ts`.
- **Loading.** Host: `skill({ id })` asks the `skill` permission (with `save: [id]`); its result is
  `<skill_content name="…">` with the content and the base directory; files are listed only when the
  path's basename is `SKILL.md`. Courier: relies on it. Where: `src/skill.ts`.
- **A person's own skills.** Host: OpenCode reads `<name>/SKILL.md` under `skill/` and `skills/` of
  each config directory (`~/.config/opencode`, a project's `.opencode`), and a project's
  `.claude/skills/` and `.agents/skills/`. They load after the server answers, so a list read at once
  can lack them. Courier: documents the locations for users. Where:
  [reference.md](../reference.md#the-courier-orchestrate-skill).
- **Activating.** Host: the TUI's `/skills` attaches `skills: [{ id }]` to the prompt, and the text
  goes first in that message; a compaction keeps it. Courier: relies on it.
- **Managed policy:** see [Managed policy](#managed-policy).

## OpenCode's schedules

- **A schedule is invisible to the plugin.** Host: the `opencode_schedule_*` tools (the `schedules`
  [feature flag](#feature-flags), one server per database through the `schedule:leader` row of the
  `kv` table) let a session prompt itself later. The plugin API has no schedule domain and schedules
  publish no events, so no `Waits` supplier can see one. Courier: a child that schedules a wake and
  ends its turn would read as ended without a report, so every spawned session is created with
  `CHILD_RULES`: `opencode_schedule_*` denied on `*`; a root keeps the tools. Where:
  `src/tree/spawn.ts`.
- **They are Code Mode tools.** Host: namespace `opencode`, in `execute`'s catalog rather than tools
  of their own while `execute` is not wholly denied, so the `context` hook cannot drop them.
  `Tool.snapshot` (`packages/core/src/tool.ts`) drops a tool whose action, its id (`opencode_` and
  the name), a rule wholly denies, from the direct tools and the catalog alike; the session's rules
  come after the agent's. Courier: denies them by rule, not in the hook. Where: `src/tree/spawn.ts`.
- **The catalog may count them without naming them.** Host: the catalog names only the tools that fit
  its budget, picked in path order within each namespace, and counts the rest:
  `- opencode (13 tools, 7 shown)`. The schedule tools sort late, so a root's catalog may count them
  without naming them; the model finds them with `search`. A session they are denied has that many
  fewer tools in the namespace. Courier: nothing to do.
- **A plugin cannot reach schedules.** Host: no schedule domain, not under `ctx.experimental` either,
  and the plugin is not given the server's address or password for its HTTP routes. A firing is a
  plain steered prompt (`delivery: "steer"`, `metadata: { schedule }`) without the sender's
  envelope. Courier: `courier_later` keeps its own scheduler
  ([architecture.md](architecture.md#courier_laters-scheduler)). Where: `src/scheduling/later.ts`.

## `/goal`'s idle reviewer

`/goal` (`packages/core/src/plugin/goal.ts`, a built-in plugin) judges on `experimental.idle`, and
courier children are invisible to it ([reference](../reference.md#goal-and-courier-children)).

- **`background` lists only host jobs.** Host: the runner fills `background` from
  `SessionBackground.outstanding`: the host's running jobs under the session, which are task-tool
  subagents, image jobs and shells. A native courier child has a `parentID` but is not a job.
  `outstanding` can add the descendants with a running execution (`active`), but only the subagent
  report passes them, not the idle hook. `GET /api/experimental/job` lists the same jobs over HTTP
  only; a plugin cannot add one. Courier: cannot declare its children.
- **`/goal` continues unless its own work runs.** Host: `goal.ts` returns early only for a `subagent`
  or `image` entry of the session itself, and offers `wait` only while one of its own shells runs.
  Otherwise `continue` admits a synthetic continuation in the same execution; `MAX_STALLS` (3) rounds
  in a row with the same reason or no tool call pause the goal. Courier: the reference tells users
  not to set a goal on a session that waits on children. Where:
  [reference.md](../reference.md#goal-and-courier-children).
- **A courier idle hook could not change it.** Host: `/goal`'s hook runs first
  ([The idle hook](#the-idle-hook)), so the verdict and its continuation are in before the courier's
  hook runs, and a later hook can add input but not take any back. Courier: nothing to do; a fix needs
  OpenCode to let a plugin declare background work, which
  [an upstream request](https://github.com/anomalyco/opencode/issues/60860) asks for.

## Web search's form

- **Web search asks for a provider.** Host: `websearch` first asks the `websearch` permission. With
  no provider chosen it shows "Web Search" (`metadata: { kind: "websearch.provider" }`, one field
  `choice`: `allow`, `choose`, `disable`), and on `choose` a second form with a field `provider`.
  After a minute, or a dismissal, the call fails with "Web search cancelled", ending the call, not
  the turn. The choice is global (`websearch:provider` in OpenCode's KV), and `disable` drops the tool
  everywhere. Two children are asked one after the other. Courier: relays the form to the top
  session. Where: `src/person/form.ts`.
- **A plugin can add a provider** with
  `ctx.websearch.transform((editor) => editor.add({ id, name, execute }))`. Courier: the live suite's
  provider. Where: `e2e/search-plugin`.

## Two servers on one data directory

OpenCode keeps everything in one SQLite database (`$XDG_DATA_HOME/opencode/opencode.db`), which any
number of servers can open. Plugin storage is a slice of its `kv` table
(`plugin:<hex plugin id>:<key>`), shared; process memory (claims, the event bus, pending requests)
is not. What the plugin does about it: [architecture.md](architecture.md#two-servers).

- **Both schedulers deliver.** Host: without a lock, both servers deliver a due message (seen for none
  to all of ten). Courier: one server owns the scheduler (`OWNER_KEY`). Where: `src/platform/hub.ts`.
- **A turn's events stay in its server.** Host: a child's turn runs in the server that queued its
  prompt, and only that server sees its `permission.asked` or `execution.failed`. Courier: tells a
  request or failure once, from that server. Where: `src/person/events.ts`, `src/tree/events.ts`.
- **Answers reach a request only from its server.** Host: `courier_answer` reaches a request only from
  the server where the child waits. Courier: documents it. Where:
  [reference.md](../reference.md#two-servers-on-one-data-directory).
- **Inbox events stay in their server.** Host: a session's `enqueued`, `delivered` and `cancelled` are
  seen by the server that queued its prompt only. Courier: the fan-up of typed text happens in that
  server. Where: `src/tree/relay.ts`.

`e2e/two-servers.sh` (not in CI; run as in [development.md](development.md)) checks these and exits
1 when one differs. It does not cover the question relay.

## TUI and RPC packaging

- **Found by export.** Host: `Host.resolve` (`packages/plugin/src/host.ts`) resolves `<name>/server`
  (else the package), `<name>/tui` and `<name>/rpc`. A local directory whose `package.json` has a
  `name` and `exports` resolves like a package; without them, `index.js`, `tui.js` and `rpc.js` sit
  at its root. A local plugin given as a file path gets `server` only. Courier: exports all three.
  Where: `package.json`.
- **The server runs only `server`**, recording `features: { server, tui, rpc }` (in
  `GET /api/plugin`); `opencode plugin add` adds a package with `server` to the global config.
  Courier: the TUI part loads from the server's plugin list. Where: `src/index.ts`, `src/tui.tsx`.
- **The TUI loads `tui`** with a plain `import()` for each plugin with `features.tui`; it
  default-exports `{ id, setup }`. Courier: `src/tui.tsx` does. Where: `src/tui.tsx`.
- **The host provides the TUI's imports:** `effect`, `@opencode/plugin/*`, `@opentui/core`,
  `@opentui/core/testing`, `@opentui/solid`, its `components`, `jsx-runtime` and `jsx-dev-runtime`,
  `solid-js` and `solid-js/store`, without resolving them on disk; OpenCode patches its `solid-js`.
  Courier: imports nothing else at runtime (not `solid-js/web` or `@opencode/theme`); unit tests run
  the unpatched `solid-js`. Where: `src/tui.tsx`, `src/*/tui.tsx`.
- **No peers for them.** Host: an exact optional peer `@opentui/core` broke `opencode plugin add` with
  ERESOLVE; `@opencode/plugin`'s own optional `@opentui/*` peers are ranges. Courier: they are
  devDependencies at the versions of OpenCode's root catalog at the pinned tag, and `@opencode/theme`
  at the pin. Where: `package.json`.
- **JSX must be compiled before publishing.** Host: transforms `.tsx` only outside `node_modules`.
  Courier: `script/build-tui.ts` bundles with `createSolidTransformPlugin()` and
  `packages: "external"`; `@arethetypeswrong/cli` flags an export without types, hence
  `tsconfig.tui.json` for `dist/tui.d.ts`. Where: `script/build-tui.ts`, `tsconfig.tui.json`.
- **RPC.** Host: a plugin cannot add an HTTP route: `rpc.register` sits behind authenticated
  `/api/rpc` with a JSON envelope. `Rpc.define` (`@opencode/plugin/rpc`) takes
  `{ id, methods, events }`; `rpc.*` names are reserved. Registration and `client.rpc` take Standard
  Schema. One service per location; the last registration of an id answers. Over HTTP:
  `POST /api/rpc/:rpcID/:method?directory=…` with `{ "input": … }`. Courier: one definition serves
  both halves. Where: `src/rpc.ts`, `src/tree/rpc.ts`, `src/person/rpc.ts`.
- **`rpc.call` does not wait for plugins.** Host: until the location's plugins have loaded it answers
  `rpc.unavailable` (HTTP 400). Courier: the footer's read asks again each `UNAVAILABLE_MS` while it
  gets that (`whenLoaded`), and a live script waits for an output after it starts a server. Where:
  `src/tree/tui.tsx`; `rpc_ready` in `e2e/tui.sh`.

## The TUI plugin API

- **Options.** Host: `ctx.options` is the TUI's own `cli.json` entry; a plugin loaded from the
  server's list enters bare, so `opencode.json` options never reach it; the TUI's `animations`
  setting is not on the plugin API. Courier: has its own `animations` option. Where:
  `animationsOn` in `src/tree/tui.tsx`.
- **The context.** Host: `ctx.client` is the TUI's client. `ctx.location` may be `undefined`. The
  footer slot shows on the home screen too, with no `sessionID`. `data.session.permission` has no
  `reply`. `data.session.form.reply` resolves only once the form is gone. The client throws an RPC
  error as a plain `{ type, message }`. OpenCode sounds `permission` and `question` for every request
  and form itself. Courier: falls back to `ctx.data.location.default()`; the inbox uses
  `client.permission.reply`, and `client.session.form.list` and `client.session.form.reply` for
  forms; plays no sound of its own for them. Where: `src/person/tui.tsx`, `src/tree/tui.tsx`.
- **Rendering errors are contained.** Host: a slot that renders bare text, or a dialog that throws
  while rendering, gets a crash toast and the dialog closed; a slot still renders only elements.
  Courier: slots render elements only. Where: `src/tree/tui.tsx`.
- **A dialog replaces the one open.** Host: the open `select` resolves `undefined`, as on `esc`.
  `select` takes no starting query, so a changed list means a new `select` with an empty search.
  `current` matches by deep equality. Courier: the inbox reopens its `select` when the list changes.
  Where: `src/person/tui.tsx`.
- **A select's rows** are one line. Host: title (cut at 61), description, and a right-aligned footer
  that squeezes them; `large` is 88 columns, `xlarge` 116; a `disabled` option is left out. Courier:
  sizes the inbox's rows for it. Where: `src/person/tui.tsx`.
- **The panel belongs to one session.** Host: `ui.panel.open` targets the route's session, and the app
  closes it when the route leaves that session; a new panel takes the keyboard. Courier: the tree
  panel reopens itself after a route change, and hands the keyboard back with
  `keymap.dispatch("pane.focus.left")` when it did not have it. Where: `src/tree/tui.tsx`.
- **Session tabs are routes.** Host: a tab opens `data.session.root` of its session, OpenCode's own
  root, so a `courier_spawn` child, which has no `parentID`, gets a tab of its own; the `+` tab routes
  to the home screen. Courier: the tree panel sees both as route changes. Where: `src/tree/tui.tsx`.
- **A panel splits from 108 columns, less the vertical tabs** (`canSplit`). Host: the plugin cannot
  read the tabs' width. Courier: notes the split only at a `renderer.width` of 108 or more. Where:
  `src/tree/tui.tsx`.
- **Keys OpenCode takes after `<leader>`.** Host (`packages/tui/src/config/keybind.ts`; the legacy
  names in `config/v1/keybind.ts`): `a b c e g i l m n q r s t u w x y`, the digits, `return` and the
  arrows. Courier: the inbox takes `<leader>k`. Where: `src/person/tui.tsx`.
- **A span's colour is not cleared by `undefined`.** Host: `@opentui/solid` keeps the old `bg` and
  `fg`, and `attributes` only gain bits; a `<box>`'s `backgroundColor` does clear. Courier: Digby's
  spans are reused through `<Index>`, so every cell gets a `bg`, `DIGBY_UNDER` where it has none.
  Where: `src/tree/tui.tsx`.
- **Testing.** Host: OpenTUI's `testRender`; the TUI logs to
  `$XDG_DATA_HOME/opencode/log/opencode.log`. Courier: unit tests use `testRender`, with
  `bunfig.toml` preloading `@opentui/solid/preload`; the live check reads `tmux capture-pane -p`, and
  CI installs `tmux`. Where: `test/tui.test.tsx`, `e2e/tui.sh`.
