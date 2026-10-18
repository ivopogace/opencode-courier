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

https://github.com/user-attachments/assets/74a50b9c-462a-43f5-8737-bc7dd1917988

The edge cases on the live terminal UI, narrated ([what it shows](#demos)).

## Quickstart

```bash
npm install -g @opencode/cli@2.0.32   # OpenCode V2, at the version courier is tested on
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
(`@opencode-ai/plugin`), and needs OpenCode V2. Each release is pinned to one V2 version and tested
against it end to end; the current one is tested on **OpenCode 2.0.32**. CI also runs the live
suite on the newest OpenCode release, on `main` and nightly, so a host release that breaks the
plugin shows up there first. Older releases and their versions: [every release](docs/reference.md#the-opencode-version).

## Courier or the built-in subagent tool?

OpenCode V2 has its own [`subagent` tool](https://opencode.ai/v2/docs/agents): it starts an agent
with fresh context in a child session, and the parent either waits for its final answer or, with
`background: true`, carries on and is notified when the child finishes; passing the child's
`sessionID` back prompts it again. Use it when one result back is all you need: a search, a review,
a self-contained task that needs nothing from you on the way. Use courier when the work needs more:

- **Messages from the child, mid-run:** a child reports progress, or asks its parent something,
  whenever it likes with `courier_send`, and any session can message any other.
- **Waking an idle session from anywhere:** a message from a child, a schedule (`courier_later`) or
  a [webhook](#webhooks) (GitHub reviews, comments and CI runs, or any signed POST) starts a new turn
  in a session that has ended its own.
- **Worktree isolation:** `isolate: true` gives a child its own git worktree, so children can edit
  files in parallel; each commits on `courier/<its session ID>` and reports that branch for its
  parent to merge ([nested isolation](docs/reference.md#nested-isolation)).
- **Relaying to you:** a child's permission requests and questions reach you through the parent:
  a request is approved in OpenCode's own permission prompt in the parent's session, never by its
  model, and your answers go back; a form only you can answer is pointed out to you.

## How it works

A parent session calls `courier_spawn`, gets a session id back immediately and ends its turn. The
child works on its own and, when it is done or stuck, calls `courier_send` with the parent's id, a
status and what it produced. That message lands in the parent's inbox and OpenCode starts a new turn
for the parent if it is idle. There is no polling anywhere: a message is admitted into the target
session's inbox through OpenCode's own API, the way OpenCode's background subagents report to their
parent. Delivery is `steer` by default (injected into the target's running turn, or starts one if
idle); `queue: true` waits until the current turn ends.

## Demos

The video at the top (1:46, narrated) is the TUI driven in `tmux` on the scripted stand-in model of
the live test, with `e2e/tui.sh`'s setup, so each scene is real plugin behaviour:

- **A join group:** one member reports and its report is held with the group, while the other waits
  on a permission request, so the footer says one is waiting on you. You allow it from the asks inbox
  (`ctrl+x k`), and both reports reach the parent in one message.
- **A child whose turn fails:** OpenCode shows "Session failed", the parent is told, and the
  `/courier tree` row reads `failed`.
- **A child that ends its turn without a report:** the parent is told, and the row says so.
- **`/courier stop`:** pick the session, confirm, and it is stopped.
- **A form only you can answer:** a child's web search shows a form; the footer, the panel row and
  the asks inbox point to it, and answering it there wakes the parent.

## Recursive orchestration

A session can split a goal across child sessions, each child deciding in turn whether to split its
part again, with the results checked and integrated at every level on the way back up. The plugin
ships the playbook as an OpenCode skill, `courier-orchestrate`, listed in every session: models are
told to load it at the start of an implementation task that may have independent parts, and
`/skills` in the TUI attaches it to your prompt. What it says: [the
reference](docs/reference.md#the-courier-orchestrate-skill).

## Install

### Supported OpenCode version

Requires OpenCode V2: the `opencode` command from `@opencode/cli` (also installed as `opencode2`).
Each release is built and tested against exactly one OpenCode V2 version; a row lists the releases
pinned to its version. OpenCode never checks it:
the plugin installs and loads on any V2 host, and on a version other than the pinned one writes one
line to the server log naming both ([more](docs/reference.md#the-opencode-version)).

<!-- compat-table:start rows=3: generated by script/compat-table.ts from the release tags -->
| opencode-courier | OpenCode V2 (`opencode` and `@opencode/plugin`) |
|---|---|
| 0.7.3 | 2.0.32 |
| 0.7.2 | 2.0.31 |
| 0.7.1 | 2.0.30 |
<!-- compat-table:end -->

Older releases and their versions: [every release](docs/reference.md#the-opencode-version).

The [terminal part](#in-the-terminal) relies on the host to provide its UI modules and is tested on
OpenCode 2.0.32 only; the server part works as before on older V2 hosts from 2.0.4 on.

Check yours with `opencode --version`, and install the matching CLI with:

```bash
npm install -g @opencode/cli@2.0.32
```

### The plugin

```bash
opencode plugin add opencode-courier
```

This installs the package from npm and adds `"opencode-courier"` to `plugins` in the global
configuration (`~/.config/opencode/opencode.json`); its options ([session trees](#session-trees),
[webhooks](#webhooks)) go in the object form of that entry. Install it by name, without a version:
OpenCode only checks plugins for updates when their entry is not an exact version, so
`opencode-courier@0.2.1` is never offered a newer release ([moving such an
entry](docs/reference.md#updating-the-plugin)).

From a local clone, `bun install && npm run build`, then list its `dist` **directory** in
`opencode.json` (V2 uses `plugins`, plural; a path to a file is ignored with a warning):

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-courier/dist"]
}
```

## Using it

1. Keep the background server running so sessions can be woken while you are away (`opencode
   service start`), and run one OpenCode server per data directory where you can: a second one, such
   as `opencode serve` next to it, cannot pass your answer on to a child the other runs
   ([why](docs/reference.md#two-servers-on-one-data-directory)).
2. Give the agents that run children the permissions their work needs: a child that hits an approval
   prompt waits until you answer OpenCode's prompt for it in the parent's session. Let them use the `question` tool if they
   should be able to ask you. Choose a web search provider before children search the web (run one
   web search in your own session, or use OpenCode's "Third-party search" setting), or the first
   child to search shows that prompt in its own session, which only you can answer there.
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
| `courier_status` | One look at a session: outcome, idle time, last reply and what it waits on. For check-ins, not for waiting. |
| `courier_children` | Lists the sessions this one (or a given one) started, with their state, worktree and join group. |
| `courier_tree` | Lists the whole tree under a session, depth first, with each one's depth and report state. |
| `courier_stop` | Interrupts a session below you and everything under it, and cancels their scheduled messages; `cleanup: true` removes their worktrees too. |
| `courier_cleanup` | Removes an isolated child's worktree, unless it holds unsaved work, and forgets the child. |
| `courier_answer` | Answers a permission request that a session under this one waits on, after OpenCode has asked you in this session, or passes your answer to its question. |
| `courier_later` | Schedules a message for a session (this one by default) in `delayMinutes` or `at` a time. |
| `courier_cancel` | Drops a message scheduled with `courier_later`. |
| `courier_subscribe` | Subscribes a session to webhook deliveries for a topic (`owner/repo`, `owner/repo#12` or a name). |
| `courier_unsubscribe` | Drops one topic, or all of a session's. |
| `courier_recall` | One look at what earlier session trees in this project did: how each was split and how its parts went, and the lesson its orchestrator left; with `sessionID`, one tree's [record](#memory) in full. |
| `courier_note` | Writes the one lesson of this session tree, a line of at most 300 characters, on its [record](#memory), for the next orchestrator in the project; a second call replaces it. From the top or a sub-orchestrator, never a leaf. |

Each tool's parameters: [the reference](docs/reference.md#the-tools).

## How children reach you

- **A child reports once, with a status**: `done`, `partial`, `blocked` (it needs a decision from
  its parent, and says what) or `failed`, with its artifacts (branch, commits, files, checks) listed
  in the message. A message without a status is progress, not the report.
  [More](docs/reference.md#a-childs-report).
- **A join group wakes you once.** Start a batch of sessions with the same `group` name, and their
  `done`, `partial` and `failed` reports are held until the last one is in and your turn has ended,
  then delivered in one message. A `blocked` report, a failure, a question or a permission request
  still reaches you at once. A member that will not report holds the others back: drop it with
  `courier_cleanup`, and the group is released without it. [More](docs/reference.md#join-groups).
- **A child that fails, or ends its turn without reporting, is reported** to its parent by the
  plugin, with the error or its last reply, waking it if idle; one that waits on a request, its own
  children, a scheduled message or a webhook is not, nor is one that answers what you typed in its
  session. [More](docs/reference.md#a-child-that-fails).
- **A message that fails to wake its session is sent again.** A report, notice or scheduled message
  (but not a note that a request was answered elsewhere) that waits in an idle session's inbox for 30 seconds without a turn starting for it is sent once
  more under the same inbox id, which OpenCode takes for the same message, not a second one. If the
  session still does not take it, the footer and the tree panel show it as `stalled`, for you to
  prompt it. [More](docs/reference.md#a-missed-wake).
- **Permission requests and questions reach you.** A child's request or question is passed to the
  session at the top of its tree, any number of levels down. For a request, that session proposes an
  answer with `courier_answer`, and OpenCode asks you in its own permission prompt, in that session
  and under its rules, before anything is passed on: its model cannot approve, only propose. For a
  question, it asks you and passes your answer back, or links its own question to the child's so your
  pick goes straight to it. Whichever answer comes first counts, and the other is withdrawn.
  A request starts a turn in the top session if it is idle; if you answer it somewhere else, the
  note that it is settled waits for that session's next turn, usually the child's report or its
  silence, instead of starting one of its own. [More](docs/reference.md#a-child-that-asks-for-permission).
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

`courier_spawn` refuses a spawn past a limit, naming it and saying what to do instead: do the work
itself, or wait for a child to report. A session counts while it is live: its turn runs, it owes
its parent a report (its task or a message reached it after it last reported, failed or was
interrupted), or a session below it is live. One that has reported, with nothing live below it,
does not. Each spawned session's brief says when to split its task and when to do it itself
([more](docs/reference.md#session-trees-and-their-limits)).

## Memory

What an orchestrator learns about splitting work in a project would otherwise die with its transcript,
so the plugin keeps **one record per session tree**, in the project (every worktree of a repository
shares it), from facts it already has: when the tree started and last
moved, the top session's title and its `split:` line, whether and when the top called `courier_recall`,
and for each session started in the tree its title, depth, isolation, join group, status (`done`,
`partial`, `blocked`, `failed`, `interrupted`, `stopped`, `stalled` or `out`, still owing its report),
how long it ran, what it cost, how full its context got and how many of its spawns were refused. Never a
report's body or artifacts: they can hold code and secrets, and the parent has verified the work. A
record is written again as each turn in the tree ends, so it stands on its own once the
[roster](docs/reference.md#roster) has forgotten the children, and a tree reads as finished once no
session in it runs and every part has settled.

The one thing a model writes into it is **the tree's lesson**: one line of at most 300 characters,
with `courier_note`, from the session that verified the tree, what the next orchestrator in the project
should know about splitting work here that the facts do not say. It is kept dated on the record, a
second note replaces it, a sub-orchestrator's is marked with its depth, and a leaf cannot write one: a
child never writes memory. A lesson is history, not a rule: one that holds every time belongs in
AGENTS.md or the skill, which the tool and the skill say to leave to the person.

`courier_recall` reads them back: one line per tree, newest first, the lesson after the facts, or one
record in full. The `courier-orchestrate` skill's first step asks for one call before the split
decision, and its last for one `courier_note` before the top replies, none when there is nothing; a root
that has started no sessions is pointed to the first, and a leaf sees neither tool. Each project keeps
its newest 30 records and none that last moved over 90 days ago. `"memory": false` in the plugin's
`options` turns it off: nothing is written, `courier_recall` says so and `courier_note` is refused.
In the [terminal](#in-the-terminal), `/courier memory` shows the records and forgets one, or only its
lesson ([more](docs/reference.md#memory)).

## In the terminal

The package ships a part for OpenCode's terminal UI, which the TUI loads from the server's plugin
list; the server half behaves the same whether or not a TUI is attached. In a session that started
sessions, the prompt's footer shows what the tree under it is doing: how many wait on you (a
permission request, a question or a form they show), are [stalled](docs/reference.md#a-missed-wake),
run or are idle, and for each [join group](docs/reference.md#join-groups) how many of its members have
reported:

```
courier 1 waiting on you · 2 running · group pair 1/2
```

`/courier tree` opens a panel beside the session with the tree under it, a row per session indented
by depth, with a mark and colour from your theme for its state (`✓` reported, a spinner `⠋` while it runs, `●` waiting on you, `!` stalled,
`✗` failed or interrupted), what it does, its report and its group's standing; a session waiting on you gets a line per
request or form (`shows a form: Web Search`), a stalled one since when its message waits, a session that started others gets
a bar of the parts reported, a leaf how long it ran, its last tool call, how full its context is (`ctx 31%`, in the warning colour past 80%) and its cost. A tree that has
started more than `maxTotal` sessions over time is listed live ones first, then newest, and the header
says how many older ones are left out; the footer counts them all. `↑`/`↓` select,
`enter` or a click opens the session, a row under the pointer is highlighted, `s` stops it and everything under it after you confirm, as `courier_stop`
would, `x` forgets a `gone` session after you confirm, removing its worktree by `courier_cleanup`'s
rules, and `q` closes the panel; `/courier stop <session>` stops from the prompt. While open, the panel
follows you between sessions: into one of its tree it keeps that tree, the session on screen marked
`(on screen)`; elsewhere it shows that session's tree, or hides while you are in a session without one,
or on the home screen, and shows again once you are back in one; only `q` closes it for good.
A row whose report arrives flashes in your theme's success colour and fades back over 1.5 s, and the header's bar
grows to its new length; nothing in the footer moves. Next to the header's title digs Digby, the courier's mole, drawn
in your theme's colours, whose state follows the tree's: a breathing mound while all is idle, a trembling one while
children run, up with a blinking sign while one waits on you, slumped while one is stalled, popping up with a letter
for a report and raising mounds for a spawn. Where the panel has room the tree does not use, on an empty panel or 10
rows free below the last row, a larger Digby, 16 by 8, shows the same state there instead, paws, sign, letter and all
([more](docs/reference.md#in-the-terminal)).
To keep the panel still (`•` for a running row, no flash, the bar at once, Digby in each state's first frame), give the TUI part `"animations": false` in OpenCode's terminal config, `~/.config/opencode/cli.json`:
the TUI passes options to its plugins only from there, not from the server's `opencode.json`, and has no animations
setting a plugin can read ([more](docs/reference.md#in-the-terminal)).

```jsonc
{
  "plugins": [{ "package": "opencode-courier", "options": { "animations": false } }]
}
```

`ctrl+x k` (the leader key, then `k`), `/asks` (or `/ask`), the palette's "Courier: what waits on you" or a click
on "waiting on you" opens the asks inbox: every permission request, question and form waiting
anywhere in the tree, however many sessions it has, oldest first, after the top session's own permission
requests, such as the prompt `courier_answer` has OpenCode show there, with where it comes from, kept current
while it is open as asks arrive or are settled elsewhere, answered in a dialog with no model in between; the session that started the tree hears once that you settled it. The TUI plays OpenCode's
sounds for a child's report and a group's release, and OpenCode's own for a new ask, which the courier
adds a notification to for a native child ([more](docs/reference.md#in-the-terminal)).

While a permission prompt or form is shown in the session, OpenCode hides the footer, so open the
inbox with `ctrl+x k` (or `/asks` once the prompt is back).

`/courier memory` (or the palette's "Courier: memory") lists the project's [tree records](#memory), newest
first, one row each: the day the tree started and its title, its parts counted by status, how long it ran
and what its parts cost, with its lesson on the line under it. `enter` shows one in full, the tree's facts,
each part's status, duration, cost and context use, and the lesson; `x` forgets the record under the row
after you confirm, or, in the record on its lesson's rows, only the lesson, keeping the facts; `q` closes.
With `"memory": false` it says memory is off in this project. Nothing a model sees changes but what
`courier_recall` lists ([more](docs/reference.md#the-memory-view)).

## Native child sessions

Off by default. With `"nativeChildren": true` in the plugin's `options`, a child started without
`isolate` is also created with OpenCode's own `parentID`, so OpenCode treats it as the parent's
subagent: the TUI's view of the top session lists and answers the permission requests and forms of
every session under it, and the paired web, desktop or mobile app's request dock answers a
grandchild's ask from the top session, on a phone too. Isolated children are created as before, and
the courier's own tree, limits and relays work as without the option. What changes
([more](docs/reference.md#native-child-sessions)):

- **Deleting a session deletes its native children**, as OpenCode does with subagents.
- **A child does not take its parent's session rules**: courier passes it an empty ruleset, so it
  may do what it could without the option.
- **Providers see a subagent**: the child's model requests carry its parent's id for cache routing
  and two headers naming the parent; **on GitHub Copilot**, which meters such requests differently
  from a person's, courier was not tested.
- **A child's asks show in the top session's view**, not in its own, and it leaves the TUI's session
  lists. Its permission requests and questions are answered once, in OpenCode's own prompt there; the
  top session's model is only told. `opencode run` and the TUI's auto-accept mode answer them as their
  own subagents'.
- **Turn it on only with OpenCode's TUI or the paired app**, which show those prompts; with a bare
  API client nobody prompts you, and only `courier_answer` is left, which prompts you in the top
  session before it passes anything on.

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

The options, which events wake whom, the tunnels, the signing scheme and status codes: [the
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
