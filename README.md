# opencode-courier

**Your OpenCode session hands work to other sessions, ends its turn, and is woken when they
report.** Multi-session orchestration for OpenCode V2: spawn child sessions, be woken by them. No
polling.

[![CI](https://github.com/ivopogace/opencode-courier/actions/workflows/ci.yml/badge.svg)](https://github.com/ivopogace/opencode-courier/actions/workflows/ci.yml)
[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=ivopogace_opencode-courier&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=ivopogace_opencode-courier)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=ivopogace_opencode-courier&metric=coverage)](https://sonarcloud.io/summary/new_code?id=ivopogace_opencode-courier)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=ivopogace_opencode-courier&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=ivopogace_opencode-courier)
[![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=ivopogace_opencode-courier&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=ivopogace_opencode-courier)
[![npm](https://img.shields.io/npm/v/opencode-courier)](https://www.npmjs.com/package/opencode-courier)
[![Socket Badge](https://badge.socket.dev/npm/package/opencode-courier)](https://socket.dev/npm/package/opencode-courier)
[![License: MIT](https://img.shields.io/npm/l/opencode-courier)](LICENSE)
[![Supported OpenCode V2 version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fivopogace%2Fopencode-courier%2Fmain%2Fpackage.json&query=%24.peerDependencies%5B%27%40opencode%2Fplugin%27%5D&label=opencode&color=blue)](#supported-opencode-version)

https://github.com/user-attachments/assets/d7cf74f8-15b3-4cc1-866e-b75ba0ac3f8a

The tree panel, the asks inbox, the edge cases and memory on the live terminal UI, narrated
([what it shows](#demos)).

## Quickstart

```bash
npm install -g @opencode/cli@2.1.2   # OpenCode V2, at the version courier is tested on
opencode plugin add opencode-courier  # by name, so OpenCode offers new releases
opencode                              # in any folder
```

Paste this prompt:

> Start two helper sessions with courier_spawn and have each report back to you. One runs
> `` `sleep 20; echo $((17 * 23))` ``, the other `` `sleep 40; echo $((2 ** 10))` ``. Do not run the
> commands yourself. When both have reported, reply with one line: RESULTS \<first\> \<second\>

The parent spawns both children and ends its turn. Within a minute the first report starts a new
turn on its own, about 20 seconds later the second does, and the parent replies `RESULTS 391 1024`.
If OpenCode asks to allow a child's command, the parent passes the question to you. Free models
sometimes stall on a request; if nothing moves for a few minutes, send the prompt again. Next:
[Using it](#using-it).

## OpenCode V2 native

Courier is built on OpenCode V2's plugin API (`@opencode/plugin`), not the V1 one
(`@opencode-ai/plugin`). Each release is pinned to one V2 version and tested against it end to end;
the current one is tested on **OpenCode 2.1.2**. CI also runs the live suite on the newest OpenCode
release, on `main` and nightly. Older releases: [every release](docs/reference.md#the-opencode-version).

## Courier or the built-in subagent tool?

OpenCode V2's own [`subagent` tool](https://opencode.ai/v2/docs/agents) starts an agent with fresh
context in a child session; the parent waits for its final answer or, with `background: true`, is
notified when the child finishes. Use it when one result back is all you need. Use courier when the
work needs more:

- **Messages from the child, mid-run:** a child reports progress or asks its parent something
  whenever it likes with `courier_send`, and any session can message any other.
- **Waking an idle session from anywhere:** a message from a child, a schedule (`courier_later`) or
  a [webhook](#webhooks) starts a new turn in a session that has ended its own.
- **Worktree isolation:** `isolate: true` gives a child its own git worktree, so children edit files
  in parallel; each commits on `courier/<its session ID>` and reports that branch for its parent to
  merge ([nested isolation](docs/reference.md#nested-isolation)).
- **Relaying to you:** a child's permission requests and questions reach you through the parent. A
  request is approved in OpenCode's own permission prompt in the parent's session, never by its
  model; a form only you can answer is pointed out to you.

## How it works

A parent calls `courier_spawn`, gets a session id back at once and ends its turn. The child works
on its own and, when done or stuck, calls `courier_send` with the parent's id, a status and what it
produced. The message lands in the parent's inbox through OpenCode's own API, the way OpenCode's
background subagents report, and starts a new turn if the parent is idle. Delivery is `steer` by
default (into the target's running turn, or a new one if idle); `queue: true` waits until the current
turn ends.

## Demos

The video at the top (3:01, narrated) is the TUI driven in `tmux` on the live test's scripted
stand-in model, so each scene is real plugin behaviour, the thing each step points at framed:

- **A join group:** one member reports and its report is held with the group, while the other waits
  on a permission request, so the footer says one is waiting on you. `/courier tree` opens the panel,
  with Digby and a row for each child saying what it waits on.
- **A click opens a child:** a click on a row opens that child's session, the panel following you
  there: one waits on the permission, the other shows the report it sent.
- **The asks inbox:** back on the parent, you allow the permission from the inbox (`ctrl+x k`), and
  both reports reach the parent in one message; the parent notes a lesson with `courier_note`.
- **A child whose turn fails:** OpenCode shows "Session failed", the parent is told, and the
  `/courier tree` row reads `failed`.
- **A child that ends its turn without a report:** the parent is told, and the row says so.
- **`/courier stop`:** pick the session, confirm, and it is stopped.
- **A form only you can answer:** a child's web search shows a form; the footer, the panel row and
  the asks inbox point to it, and answering it there wakes the parent.
- **The memory view:** `/courier memory` lists the project's session trees, each with how it was
  split, how its parts went and its lesson; `p` pins one, listed first and never swept.
- **Recall from another tree:** a new tree's `courier_recall` lists the pinned record first, lesson
  and all.

## Recursive orchestration

A session can split a goal across child sessions, each child deciding in turn whether to split its
part again, with the results checked and integrated at every level on the way back up. The playbook
ships as the OpenCode skill `courier-orchestrate`, listed in every session: models load it at the
start of an implementation task that may have independent parts, and `/skills` in the TUI attaches
it to your prompt ([what it says](docs/reference.md#the-courier-orchestrate-skill)).

## Install

### Supported OpenCode version

Requires OpenCode V2: the `opencode` command from `@opencode/cli` (also installed as `opencode2`).
Each release is built and tested against exactly one OpenCode V2 version; a row lists the releases
pinned to its version. OpenCode never checks it: the plugin loads on any V2 host, and on another
version than the pinned one writes one line to the server log
([more](docs/reference.md#the-opencode-version)).

<!-- compat-table:start rows=3: generated by script/compat-table.ts from the release tags -->
| opencode-courier | OpenCode V2 (`opencode` and `@opencode/plugin`) |
|---|---|
| 0.10.2, 0.10.3 | 2.1.2 |
| 0.10.1 | 2.1.0 |
| 0.7.3, 0.8.0, 0.9.0, 0.10.0 | 2.0.32 |
<!-- compat-table:end -->

Older releases and their versions: [every release](docs/reference.md#the-opencode-version).

The [terminal part](#in-the-terminal) relies on the host to provide its UI modules and is tested on
OpenCode 2.1.2 only; the server part works on older V2 hosts from 2.0.4 on.

Check yours with `opencode --version`, and install the matching CLI with:

```bash
npm install -g @opencode/cli@2.1.2
```

### The plugin

```bash
opencode plugin add opencode-courier
```

This installs the package from npm and adds `"opencode-courier"` to `plugins` in the global
configuration (`~/.config/opencode/opencode.json`); its options ([session trees](#session-trees),
[webhooks](#webhooks)) go in the object form of that entry. Install it by name, without a version:
OpenCode only checks plugins for updates when their entry is not an exact version
([updating](docs/reference.md#updating-the-plugin)).

From a local clone, `bun install && npm run build`, then list its `dist` **directory** in
`opencode.json` (V2 uses `plugins`, plural; a path to a file is ignored with a warning):

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-courier/dist"]
}
```

## Using it

1. Keep the background server running so sessions can be woken while you are away (`opencode
   service start`), and run one OpenCode server per data directory where you can: a second one
   cannot pass your answer on to a child the other runs
   ([why](docs/reference.md#two-servers-on-one-data-directory)).
2. Give the agents that run children the permissions their work needs: a child that hits an approval
   prompt waits until you answer OpenCode's prompt for it in the parent's session. Let them use the
   `question` tool if they should be able to ask you. Choose a web search provider before children
   search the web (run one web search in your own session, or use OpenCode's "Third-party search"
   setting), or the first child to search shows that prompt in its own session, which only you can
   answer there.
3. Your own session's prompts are relayed nowhere, and each one stalls the whole tree until you
   answer it. Before an unattended run, allow the orchestrating session's toolchain up front: one rule
   on `bun run *` or `npm run *` (the skill has checks run through the project's scripts), `git`, and
   whatever else its checks need.
4. Use `isolate: true` whenever children edit files in parallel. The worktree is made from the last
   commit (from an isolated session, its HEAD), so an uncommitted `opencode.json` is not there: keep
   providers and models in the global config, or commit the file. A worktree is kept until you
   `courier_cleanup` it, which refuses to drop uncommitted changes or unbranched commits unless told to.
5. For a long-running child, schedule a `courier_later` check-in for yourself and `courier_cancel` it
   when the child reports: it covers what the plugin cannot see, such as a server that stops while a
   child runs.

## Tools

| Tool | Does |
|---|---|
| `courier_spawn` | Starts a session on the parent's model with the task and a brief, and returns at once; `isolate: true` gives it its own git worktree, `group` holds its report with its siblings'. |
| `courier_send` | Messages a session, waking it if idle; from a child to its parent, a `status` and `artifacts` make it the child's [report](docs/reference.md#a-childs-report). |
| `courier_status` | One look at a session: outcome, idle time, when it was archived, last reply and what it waits on. For check-ins, not for waiting. |
| `courier_children` | Lists the sessions this one (or a given one) started, with their state, worktree and join group. |
| `courier_tree` | Lists the whole tree under a session, depth first, with each one's depth and report state. |
| `courier_stop` | Interrupts a session below you and everything under it, and cancels their scheduled messages; `cleanup: true` removes their worktrees too. |
| `courier_cleanup` | Removes an isolated child's worktree, unless it holds unsaved work, and forgets the child. |
| `courier_answer` | Answers a permission request that a session under this one waits on, after OpenCode has asked you in this session, or passes your answer to its question. |
| `courier_later` | Schedules a message for a session (this one by default) in `delayMinutes` or `at` a time. |
| `courier_cancel` | Drops a message scheduled with `courier_later`. |
| `courier_subscribe` | Subscribes a session to webhook deliveries for a topic (`owner/repo`, `owner/repo#12` or a name). |
| `courier_unsubscribe` | Drops one topic, or all of a session's. |
| `courier_recall` | One look at what earlier session trees in this project did and the lesson each left; with `sessionID`, one tree's [record](#memory) in full. |
| `courier_note` | Writes this tree's one lesson on its [record](#memory), for the next orchestrator in the project: one line of at most 300 characters, naming the job and the reason. A longer one is refused, a second call replaces the first. From the top or a sub-orchestrator, never a leaf. |

Each tool's parameters: [the reference](docs/reference.md#the-tools).

## How children reach you

- **A child reports once, with a status**: `done`, `partial`, `blocked` (it needs a decision from
  its parent, and says what) or `failed`, with its artifacts in the message. A message without a
  status is progress, not the report. [More](docs/reference.md#a-childs-report).
- **A join group wakes you once.** Start a batch of sessions with the same `group` name, and their
  `done`, `partial` and `failed` reports are held until the last one is in, then delivered in one
  message; a `blocked` report, a failure, a question or a permission request still reaches you at
  once. A member that will not report holds the others back: drop it with `courier_cleanup`.
  [More](docs/reference.md#join-groups).
- **A child that fails, or ends its turn without reporting, is reported** to its parent, with the
  error or its last reply, unless it waits on a request, its own children, a scheduled message or a
  webhook. [More](docs/reference.md#a-child-that-fails).
- **A message that fails to wake its session is sent again** after 30 seconds; if the session still
  does not take it, the footer and the tree panel show it as `stalled`, for you to prompt it.
  [More](docs/reference.md#a-missed-wake).
- **Permission requests and questions reach you** through the session at the top of the tree, any
  number of levels down. For a request, that session proposes an answer with `courier_answer`, and
  OpenCode asks you in its own permission prompt there before anything is passed on: its model
  cannot approve, only propose. For a question, it asks you and passes your answer back, or links
  its own question to the child's so your pick goes straight to it.
  [More](docs/reference.md#a-child-that-asks-for-permission).
- **Some forms only you can answer**, such as OpenCode's web search asking for a provider: the top
  session is told, and you answer in the child's session. [More](docs/reference.md#a-child-that-shows-a-form).
- **You can see and stop a whole subtree** with `courier_tree` and `courier_stop`, or in the
  [terminal](#in-the-terminal). [More](docs/reference.md#seeing-and-stopping-a-subtree).

Children, held reports, scheduled messages and open questions survive a compaction or a restart;
entries are dropped after 14 days, or at once when OpenCode deletes the child, unless it is isolated
([roster](docs/reference.md#roster)).

## Session trees

A spawned session may start sessions of its own, so the sessions form a tree, bounded by three
options in the plugin's `options`, in the global config:

```jsonc
{
  "plugins": [{ "package": "opencode-courier", "options": { "maxDepth": 2, "maxChildren": 3 } }]
}
```

| Option | Default | |
|---|---|---|
| `maxDepth` | `3` | How deep the tree goes: your session is depth 0, the sessions it starts depth 1. A session at `maxDepth` cannot start sessions. |
| `maxChildren` | `5` | How many sessions one session started may have live at once. |
| `maxTotal` | `20` | How many spawned sessions may be live at once in one tree. |

`courier_spawn` refuses a spawn past a limit, naming it and saying what to do instead. A session
counts while it is live: its turn runs, it owes its parent a report, a message the plugin sent to
wake it waits undelivered in its inbox (from the moment `courier_send` returns, so a `courier_spawn` in the same step counts it),
or a session below it is live; renaming, archiving or
otherwise changing it in OpenCode does not make it run.
Each spawned session's brief says when to split its task and when to do it itself
([more](docs/reference.md#session-trees-and-their-limits)).

## Memory

The plugin keeps **one record per session tree** in the project, from facts it already has: when the
tree started and last moved, the top session's title and first `split:` line, with up to 3 later ones
that read otherwise (when each was stated, and after how many parts), and for each session started
in the tree its title, depth, isolation, join group, status, duration, cost, context use and spawns
refused; never a report's body or artifacts. A session deleted since keeps its last status and
duration, or reads `gone` when it had not settled, so it never holds its tree at `not finished`.
The one thing a model writes into it is **the tree's
lesson**, with `courier_note`: one line of at most 300 characters, from the session that verified the
tree, with the job it comes from and the reason. `courier_recall` reads the records back, each line
showing the split line as prose (its markdown marks dropped, the asterisks of its globs kept) cut at a
word, then the latest later one (`then, after 1 part: split: 2 parts: …`), and saying how long the tree ran and how long ago it last moved; the `courier-orchestrate` skill asks for
one call before the split decision and one `courier_note` before the top replies. Each record counts
how often other trees' `courier_recall` calls listed it and opened it in full, and when last, so the
person can tell a lesson still read from one nobody reads; a record the person pins in the terminal
is listed first and never swept. Each project keeps 30 unpinned records, those with a lesson first,
and none older than 90 days. `"memory":
false` in the plugin's `options` turns it off ([more](docs/reference.md#memory)).

## In the terminal

The package ships a part for OpenCode's terminal UI, loaded from the server's plugin list; the server
half behaves the same with or without it. In a session that started sessions, the prompt's footer
shows what the tree under it is doing: how many wait on you (a permission request, a question or a
form), are [stalled](docs/reference.md#a-missed-wake), run or are idle, and each
[join group](docs/reference.md#join-groups)'s members reported:

```
courier 1 waiting on you · 2 running · group pair 1/2
```

`/courier tree` opens a panel beside the session with the tree under it, a row per session with a
mark for its state (`✓` reported, a spinner while it runs, `●` waiting on you, `!` stalled, `✗`
failed or interrupted), what it does, its report, its group's standing and, for a leaf, how long it
ran, its last tool call, its context use and its cost. `enter` or a click opens the session, `s`
stops it and everything under it, `x` forgets a `gone` session, `q` closes the panel;
`/courier stop <session>` stops from the prompt. Digby, the courier's mole, digs beside the header,
his state following the tree's. `"animations": false` in the TUI part's options keeps the panel
still; the TUI reads a plugin's options only from its own config, `~/.config/opencode/cli.json`
([more](docs/reference.md#in-the-terminal)):

```jsonc
{
  "plugins": [{ "package": "opencode-courier", "options": { "animations": false } }]
}
```

`ctrl+x k` (the leader key, then `k`), `/asks` (or `/ask`), the palette's "Courier: what waits on
you" or a click on "waiting on you" opens the asks inbox: every permission request, question and form
waiting anywhere in the tree, after the top session's own permission requests, with where each comes
from, kept current while open and answered in a dialog with no model in between.
The TUI plays OpenCode's sounds for a child's report, a group's release and a new ask. While a
permission prompt or form is shown in the session, OpenCode hides the footer, so open the inbox with
`ctrl+x k`.

`/courier memory` (or the palette's "Courier: memory") lists the project's [tree records](#memory),
pinned first, then newest first grouped by the day each tree last moved, one row each with how often
other trees read it and its lesson under it. `enter` shows one in full; `p` pins or unpins the record,
and a pinned one is listed first and never swept; `x` forgets the record under the row, or in a
record on its lesson's rows only the lesson, after a confirm; `esc` goes back and closes. The search
takes every letter but `x` and `p` ([more](docs/reference.md#the-memory-view)).

## Native child sessions

Off by default. With `"nativeChildren": true` in the plugin's `options`, a child started without
`isolate` is also created with OpenCode's own `parentID`, so OpenCode treats it as the parent's
subagent: the TUI's view of the top session, and the paired app's request dock, list and answer the
permission requests, questions and forms of every session under it, and the top session's model is
only told. Deleting a session then deletes its native children, the child gets an empty ruleset
rather than its parent's, and providers see a subagent (not tested on GitHub Copilot). Turn it on
only with OpenCode's TUI or the paired app, which show those prompts
([more](docs/reference.md#native-child-sessions)).

## Webhooks

GitHub reviews, comments, pull requests and completed CI runs, or anything signed posted to
`/hook/<name>`, can wake a session. The receiver is off unless the plugin has a `webhook` option, in
the **global** config, since there is one receiver per OpenCode server (`"webhook": true` takes
every default):

```jsonc
{
  "plugins": [
    {
      "package": "opencode-courier",
      "options": { "webhook": { "port": 4097, "secretFile": "~/.config/opencode/courier-webhook-secret" } }
    }
  ]
}
```

1. Make the secret with `openssl rand -hex 32 > ~/.config/opencode/courier-webhook-secret` and
   `chmod 600` it. It is never read from `opencode.json` (a `secret` key is refused), so the config
   can be committed; without a usable secret the receiver does not start, and the server log says why.
2. On GitHub, add a webhook to the repository (Settings → Webhooks) with content type
   `application/json`, the same secret, the events you want, and `<public URL>/github` as the payload
   URL, forwarded to `127.0.0.1:4097` by a tunnel you trust (`smee`, `cloudflared`, `ngrok`). Only
   signed deliveries are acted on.
3. `courier_subscribe` a session to `owner/repo`, `owner/repo#N` or `<name>`: each matching delivery
   arrives as a short summary marked as outside text, queued behind any running turn and waking the
   session if idle.

The options, which events wake whom, the signing scheme and status codes: [the
reference](docs/reference.md#webhooks).

## Development

Commands, the suites and CI: [docs/maintainers/development.md](docs/maintainers/development.md). How
the code is laid out: [architecture.md](docs/maintainers/architecture.md); what the plugin API does
that courier works around: [plugin-api-notes.md](docs/maintainers/plugin-api-notes.md); releases:
[releasing.md](docs/maintainers/releasing.md).

## Contributing

Questions and bug reports go to the [issues](https://github.com/ivopogace/opencode-courier/issues).
Pull requests are welcome: a change in behaviour comes with a unit test, an `e2e/run.sh` scenario
and its line in this README or [docs/reference.md](docs/reference.md), and CI must be green.

## License

MIT, see [LICENSE](LICENSE).
