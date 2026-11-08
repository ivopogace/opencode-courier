# Passing typed words up the tree

* **Author:** Ivo Pogace
* **Status:** Draft
* **Date:** 2026-11-08

--------------------------------------------------------------------------------

## Overview

opencode-courier (below: the plugin) lets OpenCode sessions spawn, message and wake each other.
Sessions form a tree: a root and the children it starts with `courier_spawn`; children report to
their parent with `courier_send`. The person steers a running tree by typing into any of its
sessions, from the `/courier tree` panel or any client.

The plugin passes such text up the tree itself. When a `user` item that the plugin did not send
is delivered to a spawned session while the tree is at work, the plugin sends the text, as written,
to every session above it in an envelope only the plugin writes, which names the session it
arrived in and the route it came by. The sections below call this the fan-up and the message the
envelope.

Terms used below, each defined in the reference:

* **Roster**: the plugin's record of each spawned child under its parent, with an index from each
  child to its ancestors ([Roster](../reference.md#roster)). A *roster session* has an entry; the
  root has none.
* **Report**: a child's one `courier_send` to its parent with a `status`. A child *owes* a report
  from its prompt until it reports, fails or is interrupted; a `blocked` report waits on the
  parent's answer; an *unowed* item is one whose delivery makes the session owe nothing new
  ([A child's report](../reference.md#a-childs-report), [A child that ends without a
  report](../reference.md#a-child-that-ends-without-a-report)).
* **Live**: the limits' rule for a session that still counts: its turn runs, it owes a report, it
  is `blocked`, a message waits in its inbox, or a session below it is live
  ([Session trees and their limits](../reference.md#session-trees-and-their-limits)).
* **Join group, held report**: parts started together report as one; a member's report is held
  until the group is complete, then one release message wakes the parent
  ([Join groups](../reference.md#join-groups)).
* **Native child**: a child whose OpenCode `parentID` is its courier parent, so OpenCode's own
  `subagent` tool can address it ([Native child sessions](../reference.md#native-child-sessions)).
* **The hub**: the process-wide state the plugin's instances share; two of them follow the event
  stream at once, and each event is claimed once before any instance acts on it
  ([architecture.md](../maintainers/architecture.md#several-copies-in-one-process)).
* **The prompt route**: OpenCode's prompt endpoint, which every client uses: the TUI, `opencode
  run`, the API, a slash command, a plugin, OpenCode's `subagent` tool.

## The Problem

Words typed into a child travel up as model text. The child brief tells a spawned session to send
what the person writes to its parent, quoting it as the person's, and to pass on the person's
words that a session below relays. The skill tells every orchestrator that a session's account of
what the person told it is the person's word: pass it on, do not judge it against the task, never
tell a session to undo it.

That account is free text with no provenance, and the rule binds every ancestor to it. A session
misled by a file, a tool result or a web page can put words under it. A session can also invent it
with no injection. In one real-model run of `recursive-fault` with the skill denied (the owner's
sandbox, plugin commit 476df67, the half for `numbers/b.txt`), a sub-orchestrator's child sent its
parent, right after its `partial` report, a "status correction, on instruction of the person",
saying it should write no file; after the parent told it to finish, it reported `blocked`, saying
"the person wrote to me directly (outside a courier envelope)". The saved transcripts and the event
log of that run hold no message from the person: the session's inbox received its task and two
courier messages, nothing else. Its parent refused the claim, and the rule says parents must not.

Two facts let the plugin do more than prose. `session.inbox.enqueued` carries each inbox item's
type and, for a `user` item, its text and metadata, and OpenCode copies a prompt's `metadata` into
that item, so the plugin can mark its own task prompt and tell it from every other `user` item. And
in ten real-model runs of `recursive-finding` in which the words reached the root only through
such an envelope, with no instruction in the brief or skill to send them up, they reached every
part in every run: five runs with a rule line in the envelope and five without, six on a
self-hosted model behind an OpenAI-compatible endpoint and four on OpenCode's free tier, three and
two per arm, all three files holding the change in each run, and no session telling another to undo
the words. What the
plugin cannot do is tell who typed: the person at the TUI, an API client, another plugin, a
session above through the `subagent` tool and a shell holding the server's password all arrive
alike. So the envelope attests the route and the session, not the person.

## Goals

* A `user` item that the plugin did not send, delivered to a roster session while the tree is at
  work, reaches every session above it as one envelope each, with the text as written, with no
  model composing the message.
* The envelope states what the plugin knows and nothing more: the session, the time, the route,
  and that the plugin cannot say who typed. It says that the named session has the text and acts on
  it, that every session above the named one has the same envelope, and that the receiver sends the
  text to the parts it changes.
* No sentence in the brief, the skill or the reference makes a session's account of the person's
  words binding, or asks a model to relay or quote them. The `role` instruction entry is unchanged.
  The `test/notices.test.ts` snapshot is the record of the resulting text.
* One mock e2e scenario covers the fan-up, its gate and its absence; the real-model suite covers
  every scenario, since the brief and the skill change; one real-model scenario settles the one open
  wording.

## Non-Goals

* Proving who typed. The envelope says it cannot.
* Carrying the words downward through the plugin. A part hears from its parent, which has
  authority over it, and a part started after the words arrive gets them in its task text.
* Confirming a change with the person. The answer would come over the same route as the prompt
  and prove nothing more.
* Relaying attached files, agents or skills, or the typed-in session's own reading of the words.
* A private channel to one session, a rate limit, or an option to turn the fan-up off.
* Telling the plugin's prompts from other `user` items by anything but the plugin's own metadata
  and the brief's fixed first line, or skipping other items by anything but OpenCode's own
  `schedule` metadata.

## Open Questions

* **The "undo" clause.** The envelope says that the named session has the text and acts on it. The
  slot after that sentence is open:
  1. "It decides what the text means for its part."
  2. Nothing: the text is information, and the sessions above decide.

  A clause that forbids telling the named session to undo the text "unless the person says so" is
  not a candidate: the envelope says the plugin cannot tell who typed, a session can cause one
  through `subagent` on a native child or a shell holding the password, and such a clause would
  shield that text from correction on a condition the plugin cannot verify.

  The premise for choosing: for text the plugin relayed, a session above telling the named session
  to drop it and do its task as given is the failure the wording is chosen to avoid; a session
  above stays free to report the conflict to its own parent or to the person. A session's own claim
  about the person arrives in no such envelope and binds nobody, so the clause never applies to it.
  The ten runs of `recursive-finding` above, five with a rule line and five with the slot empty,
  could not separate the two, because that scenario's words contradict no session's task and
  nothing provoked a pushback, and the three points the slot-empty arm lost were a repeated message,
  a heads-up about wiped files and a tree-shape miss, none about the words.
  [Settling the undo clause](#settling-the-undo-clause) describes a scenario built to provoke a
  pushback. While the question is open, the slot is empty (candidate 2), and with the slot empty
  the envelope asks nothing that binds a receiver to the text.

  Decided by the author: the scenario runs in two arms, one per candidate, ten runs and about 350
  model requests in all, before the wording is final.

## Critical User Journeys (CUJs)

### CUJ 1: The person changes the job from inside a part

* **Given**: A root `ses_root` has split a job into a "count" part (`ses_count`) and a "numbers"
  part (`ses_numbers`), which has two halves of its own. Every session is at work.
* **When**: The person opens `ses_count` from the tree panel and types that every file the job
  writes must end in ` checked`.
* **Then**: The plugin delivers one envelope
  `<courier from="courier" route="prompt" in="ses_count">` with those words to `ses_root`, at the
  step where `ses_count` reads them. With the skill, `ses_root` then sends the words to
  `ses_numbers` and to no other session, `ses_numbers` sends them to its halves or starts a half
  with them in its task, and `ses_count` acts on them itself. Each file ends in ` checked`.

### CUJ 2: A session claims the person said something

* **Given**: A half `ses_b`, whose task says to print a number and write it to a file, has read a
  page that says the person wants no file written.
* **When**: `ses_b` sends its parent a message without a status: "the person told me not to write
  the file".
* **Then**: The message arrives as `<courier from="ses_b">`, like any message. No envelope marks
  it as arrived over the prompt route, no brief or skill sentence makes it binding, and the parent
  weighs it as it weighs any claim: it can tell `ses_b` to finish its task.

### CUJ 3: The person types into a finished tree

* **Given**: Every child of `ses_root` has reported, `ses_root` has ended its turn, and nothing
  waits in any inbox.
* **When**: The person opens a child and types a follow-up.
* **Then**: The child acts on it. The plugin sends no envelope and logs one line: words typed into
  that session reached nobody because the tree has finished. If the child spawns or reports, those
  wake its parent as usual.

### CUJ 4: A parent prompts its native child through OpenCode's `subagent` tool

* **Given**: `ses_mid` started a native child `ses_leaf` with `courier_spawn`; the tree is at work.
* **When**: `ses_mid` calls `subagent` with `ses_leaf`'s session id and a prompt.
* **Then**: The prompt arrives in `ses_leaf` as a plain `user` item. `ses_mid` and every session
  above it receive it as `route="prompt" in="ses_leaf"`, since the plugin cannot tell it from the
  person's typing. The reference says so.

## Technical Plan (Architecture)

This section describes the plugin once the change has landed. The
[implementation plan](#detailed-implementation-plan) says which parts are new.

### The flow

```text
 person / client / parent's subagent / child's shell
          │  POST to the prompt route: a user item, no courier metadata
          ▼
 OpenCode: session.inbox.enqueued ──────────► noteTyped (tree/relay.ts)
   (type, payload.text, payload.metadata)       roster session, user item, text present,
                                                no source "courier", no schedule, not the brief
                                                → storage typed/<session>/<inboxID> { at, text }
          │
          │  the typed-in session's next step
          ▼
 OpenCode: session.inbox.delivered ─────────► relayTyped (tree/relay.ts)
   (sessionID, inboxID)                         row present? claim once in this process
                                                tree at work? (the gate)
                                                → session.synthetic to each ancestor, parent
                                                  first, root last; noteSent after each
                                                → remove the row; one log line
 OpenCode: session.inbox.cancelled ─────────► forgetTyped: remove the row
 OpenCode: session.deleted ─────────────────► the roster's own forgetting removes the rows
```

The use case is one file, `src/tree/relay.ts`, routed from `src/tree/events.ts` beside
`noteEnqueued` and `notePrompt`. Storage goes through `childStore` in `src/tree/store.ts`, the
only file that knows the key. The model-facing text is in `src/tree/text.ts`. No new port:
`WatchPorts` has `storage`, `session.synthetic`, `session.get` and `session.context`, which every
hub member carries, so the hub version is unchanged.

### Detection

`handOver` in `src/tree/spawn.ts` sends the task prompt with
`metadata: { source: "courier", task: true }`. OpenCode copies a prompt's `metadata` into the inbox
item's user payload, so `session.inbox.enqueued` shows it
([plugin-api-notes.md](../maintainers/plugin-api-notes.md#the-inbox-and-wakes)). A `user` item
counts as arrived over the prompt route when all of these hold:

* the session has a roster parent (`indexedParent` is defined);
* `item.type` is `user`;
* `payload.text` is a string with something other than whitespace;
* `payload.metadata` has no `source` equal to `courier` and no `schedule` key;
* the text does not start with the brief's fixed first line, `You were started by session `.

The `source` rule excludes the plugin's own task prompt and nothing else: a `source` set by
another plugin or client is relayed, so an unknown client never silences the person. The
`schedule` rule excludes OpenCode's schedules, which carry no sender. The first-line rule covers a
process in which an older copy of the plugin, loaded beside this one, spawns without the metadata:
the text of the brief is the plugin's own, and no person types it. What is relayed:

| `user` item | Relayed |
|---|---|
| Typing at the TUI, `opencode run --session`, a POST to the prompt route | yes |
| A slash command template (`/init`, `/review`, a project command): the whole template | yes |
| A prompt with a skill attached: the typed `text`; `skills[].text` is not part of it | yes |
| A `/goal` kickoff with attachments (`source: "goal"`) | yes |
| A parent's `subagent` call with its native child's session id | yes, to that parent too |
| A POST from a child's own shell, where the shell has the server's password | yes |
| The `!` shell command at the TUI | to confirm against OpenCode v2.2.6 whether it is an inbox item |
| The plugin's task prompt (`source: "courier"`) | no |
| OpenCode's schedules (`metadata.schedule`) | no |

Files, agents and skills attached to an item never travel; only `text` does. No text heuristic
recognises a command template: project commands say anything, and a wrong match would silence the
person, while an extra envelope reads as what it is, since it names the route and not the person.

### The stored row

At `enqueued` the plugin writes `typed/<sessionID>/<inboxID>` holding `{ at, text }`: `at` is the
event's `created`, or the plugin's clock when the event has none; `text` is the item's text
clipped at 4000 characters by `clipText`, which appends how many characters were cut. The row
exists because `delivered` carries only the two ids, a queued item waits a whole turn, and
OpenCode keeps inbox rows across a restart, so a `delivered` after a restart is a real delivery
whose text would otherwise be gone. Both hub subscriptions write the row, which is idempotent, and
both remove it at `delivered`, whether or not they won the claim, so a late `enqueued` from the
second subscription leaves nothing behind. The relay reads the row through the same subscription
that wrote it, and the hub awaits each handler in event order, so the row is in place when
`delivered` arrives. A row is also removed on `session.inbox.cancelled`, with the session's report
rows when it leaves the roster, and at load for sessions with no roster entry. A row left by a
crash between sending and removal never fires again, since `delivered` comes once.

### Firing on delivery

At `session.inbox.delivered` for a roster session the plugin reads the row. No row means the item
was not one of the above. Otherwise it claims `typed <sessionID> <inboxID>` in the hub's shared
`seen` set, so the two subscriptions send once, reads the ancestors from the roster index (parent
first, root last; a session with no index entry is read through `lineage`, the roster scan), reads
the typed-in session's title from its roster entry, and decides [the gate](#the-gate).

Firing on delivery rather than enqueue means an item steered into a running session is relayed at
the step where that session reads it, a queued one when its turn comes, and a cancelled one never.
The envelope is sent as the typed-in session's step begins; the sessions above have it at their
next step. A `session.synthetic` call steers a running ancestor and wakes an idle one.

### The gate

The tree is at work while any session under its root other than the typed-in one is live or
`blocked` by the limits' rule (`live` in `src/tree/limits.ts`, over every roster entry whose
lineage ends at the root, as `admit` reads them), or the typed-in session owes a report, is
`blocked` or has another courier message waiting in its inbox, or the root's turn is running
(`session.get`, then `runs` in `src/tree/running.ts`, which reads the transcript only when the
times cannot tell). One predicate serves the limits and the gate, so they agree on what a tree at
work is; the root's turn is added because the root has no roster entry and `live` never reads it.
The typed-in session is judged by its state before the item and never by its own turn: the gate
runs at its `delivered`, when the item has started its turn, so its `time.busy` is stamped and its
transcript ends on the new message, and `live` would call it running whatever it was doing before.

The root's turn is what keeps the gate open after the last report: the root is verifying and
merging, no row owes anything, and words typed into a child then would otherwise reach nobody,
while the brief tells the child not to send them up. What the gate silences is one case: the root
has ended its turn, every child has reported, nothing waits in any inbox, and the person opens a
child under that root. A sibling's subtree still at work keeps the gate open, since `live` counts a
session whose descendant is live. A held group report does not keep it open by itself: a member
whose report is held has reported; the gate stays open while another member owes its report or the
released group message waits in the parent's inbox. Stalled wakes do not count, as in `live`.

Errors: a rejected `session.get` on a session counts it as not running and is logged; a rejected
storage read counts as at work, so a read failure never silences the person. `runs` takes the
plugin's clock.

### The envelope

To each ancestor, sequentially from the parent to the root, `session.synthetic` with
`delivery: "steer"`, `metadata: { source: "courier", route: "prompt", in: "<sessionID>" }`,
`description` set to `Text typed into <sessionID>`, and the text from
`envelope("courier", typedNotice(sessionID, title, at, now, text), { route: "prompt", in: sessionID })`:

```text
<courier from="courier" route="prompt" in="ses_count">
At 14:32 UTC this text arrived in session ses_count ("count the lines"), a session under yours,
over the prompt route: courier did not send it and cannot tell who did, whether the person, a
client, a session above it through OpenCode's subagent tool, or a shell with the server's password.
Courier passes it on as written. ses_count has the text and acts on it. Where the text changes
other parts of the job, send it to the sessions you started that those parts are under, and only to
them: ses_count already has the text, and every session between it and you and every session above
you already has this envelope.

every file this job writes must hold its number followed by a space and the word checked
</courier>
```

`from="courier"` follows the sender convention of every envelope; `route="prompt"` is the
attestation; `in=` names the session, and the body repeats it. The open clause goes after "acts on
it." once settled. The time is the item's enqueue time rendered by `clock(at, now)` in
`src/tree/text.ts`, with `now` the plugin's clock as the envelope is built, so the date is added
when the item was enqueued on another day than it is sent. The title comes from the typed-in
session's roster entry; when
the entry is gone, the quoted title is left out. `envelope()` escapes the body, so a `<courier` in
the text or the title reads `&lt;courier`; attribute values are not escaped, and both are session
ids. The rule about where to send the text excludes the named session, the sessions between it and
the receiver, and the sessions above the receiver, so no two receivers forward the same text to the
same part, and nobody sends it up.

`kindOf` in `src/tree/events.ts` names a courier synthetic whose `metadata.route` is `prompt` as
the kind `typed`, checked after the courier-synthetic guard and before the status-less idiom, and
`typed` is unowed: the envelope is progress for the session above, not a prompt that makes it owe
a report again. `watchWake` takes the envelope like any courier message, so a missed wake is
re-sent, and `noteSent` writes the wake row right after the call, as `courier_send` does. An idle
ancestor is woken by the envelope and is live for the limits until it takes it, as with any courier
message; it is woken because the root may be idle while a sibling's subtree works, and the root is
the one receiver that reaches every part.

After a `synthetic` call fails for one ancestor, the plugin logs `courier fan-up: could not pass
text typed into <id> to <ancestor>: <error>` and continues with the next. After the loop it logs
`courier fan-up: text typed into <id> passed to <n> sessions`, counting successful sends, or
`courier fan-up: text typed into <id> reached nobody: the tree has finished`, and removes the row
in both cases.

### What the prose says

No sentence in the brief, the skill or the reference says that a session's account of the person's
words is the person's word, or asks a model to relay or quote them. A session's account of what
the person said is a message like any other; what binds a receiver is an envelope the plugin wrote,
to the extent its text says.

The brief's person sentence, as the string in `childBrief` reads (`src/tree/text.ts`):

```text
Courier passes what the person writes in your session, outside a <courier> envelope, to the
sessions above you, in an envelope marked route="prompt". Do not send it up yourself: act on it,
and say in your report what you did because of it.
```

The skill's step 3 bullet (`src/skill.ts`), in full:

```text
- When a message changes what other parts need (a wrong assumption of the split, a shared file or
  API that behaves otherwise, a decision of the person's), courier_send it at once, only to the
  sessions it affects, and, below the root, also to the session that started you when it reaches
  past your part, as your brief says; if it breaks the split, courier_stop those parts or send them
  a corrected task. Text typed into a session under you arrives from courier in a route="prompt"
  envelope that every session above you also has: pass it only to the sessions you started that it
  changes, as the envelope says.
```

The README tip, replacing the steering bullet:

```text
- To steer a running tree, open a child from the `/courier tree` panel and type: courier passes
  what you write to the sessions above it, and a parent with the skill passes it to the parts it
  changes ([details](docs/reference.md#steering-a-running-tree)).
```

In `docs/reference.md`, [Steering a running tree](../reference.md#steering-a-running-tree) is the
one home of the fan-up: the detection table, the gate, the envelope, and that a parent's
`subagent` follow-up into its native child comes back to it as `route="prompt"`. The brief
paragraph under [Session trees and their limits](../reference.md#session-trees-and-their-limits),
step 3 and the "Without the skill" paragraph under
[The courier-orchestrate skill](../reference.md#the-courier-orchestrate-skill), and
[OpenCode's subagents](../reference.md#opencodes-subagents) state the text above and link there.

### Settling the undo clause

`COURIER_SCENARIO=recursive-conflict`, run by `e2e/real-model.sh` with the checker
`e2e/real-model-recursive.mjs --conflict`. The prompt is `recursive-finding`'s: the recursive job
whose three leaf commands wait on `.go-count` and `.go-halves`. The checker creates `.go-count` as
soon as the "count" session runs. It finds the half for `numbers/b.txt` at depth 2 by
`/2 \*\* 10|numbers\/b\.txt/` in its task, and once that half has an assistant message and no
settled report, POSTs to its prompt route, as the person:

```text
Do not write numbers/b.txt. Print the number and report it to the session that started you; that
file is handled outside this job.
```

then creates `.go-halves`. The words contradict the half's task and what the "numbers" session
and the root expect to merge. The item is delivered at the half's step after its wait loop ends,
which is the step where the half reads the words and the envelope leaves for the "numbers" session
and the root, so the ancestors read the envelope after the half has started acting on the words.
That is the case the undo clause governs: the half has already followed the text, and the question
is what a session above does about it. Creating `.go-halves` later would not change this, since
nothing is delivered while the loop runs.

Checks kept from the recursive set: the root spawned at least two children in its first turn and
ended it; no orchestrator polled; at least one child spawned at least two of its own in one turn
and no sub-orchestrator started exactly one; no session went past `maxDepth`; every spawned
session reported with a status; each sub-orchestrator reported upward once after its children. In
place of the file and reply checks: `numbers/a.txt` and `count/total.txt` hold `391` and `42`, and
`numbers/b.txt` does not exist; the half's report to its parent contains `1024`; the root's final
reply matches `/b\.txt/i` and `/typed|told|instruct|outside|person/i`. The scenario's own checks:
the words reached the half as a `user` item; the plugin's envelope naming the half reached the
"numbers" session and the root; no session wrote `numbers/b.txt`. Every message to the half after
the envelope is quoted in the notes, and those matching `/write .*b\.txt/i`, `/as your task
says/i`, `/finish your task/i` or `/still required/i` are marked as possible countermands there,
not counted as a check, since a message that repeats the person's words ("do not write
numbers/b.txt") matches the first pattern too. A person reads the quoted messages and records the
count of countermands per run in `real-model.md`; that count, not the regex marks, is what the
arms are compared on.

Arms: two commits on the implementation branch that differ only in the clause sentence of
`typedNotice`, one with candidate 1 and one with the slot empty; `e2e/real-model.sh` exports
`COURIER_COMMIT` from `git rev-parse --short HEAD` and the checker writes it into `summary.json`.
Five runs per arm, about 35 requests each, about 350 in all. Candidate 1 is chosen when its total
of recorded countermands and `numbers/b.txt` replacements is at least two below the empty slot's;
otherwise the slot stays empty. No option or variable selects the arm, so nothing of the
measurement ships.

### Risks and mitigations

* **Every `user` item fans out**, "ok" and "why?" included, to at most `maxDepth` ancestors, each
  woken if idle. The gate silences only a finished tree. Accepted; a rate limit is a non-goal.
* **A session can make the plugin emit an envelope with text of its choosing**: by spawning a
  native child and calling `subagent` on it, or from a shell that holds the server's password. The
  envelope names those routes, binds nobody to the text, and the sessions above weigh it as they
  weigh a message. Whether a real install puts the password in a session's environment is to be
  confirmed; the harness exports it.
* **Whether OpenCode's TUI sets `metadata.source` on a typed prompt** is to be confirmed against
  `packages/tui` at v2.2.6 before implementation. The rule skips only `source: "courier"`, so a TUI
  that set a `source` of its own would still be relayed; the e2e TUI check below covers typing from
  the tree panel.
* **A mixed-copy window at an update**: the older copy's `courier_spawn` sends the brief without
  metadata, the newer copy's events see a `user` item without `source`. The first-line rule skips
  it.
* **Two servers on one data directory**: a session's inbox events are published by the server that
  queued its prompt, and only that server's instances see them, so one fan-out per item. To be
  confirmed with `e2e/two-servers.sh`, which gains a typed prompt into a child.
* **Compaction at an ancestor** drops the envelope from its transcript, as it drops any message.
  The skill and the brief survive; the brief says only that courier passes words up.
* **An ancestor is gone or refuses the call**: that send fails and is logged; the others are sent.
* **The host changes how prompt metadata travels** (a pin bump): the first-line rule would still
  skip the task prompt, and the `source` check would be lost as the second guard, so a brief whose
  first line changed would be relayed to the parent at every spawn. A pin bump re-checks that
  `SessionPrompt.prepare` copies `metadata` into the item, as `plugin-api-notes.md` lists.

## Alternatives Considered

### Alternative A: A `person: true` mark on messages a model composes

* **Pros**: No new event handling; the child says what it heard.
* **Cons**: A session that heard from the person can be injected afterwards and put false words
  under a real mark; a forwarded mark proves custody, not origin.
* **Reason for Rejection**: The mark carries exactly the claim the design stops trusting.

### Alternative B: The same, verified against the recorded prompt text

* **Pros**: A quote that matches the stored prompt is the person's.
* **Cons**: The child can surround the quote with anything; a paraphrase silently demotes real
  words; the plugin reads transcripts on every send.
* **Reason for Rejection**: Verifying a quote does not verify the message around it.

### Alternative C: Re-emit the envelope downward on a `relay` parameter of `courier_send`

* **Pros**: A sibling's subtree sees the plugin's envelope, not a parent's paraphrase.
* **Cons**: A part hears from its parent, which has authority over it; `courier_spawn` carries no
  relay, so a part started later gets the words unmarked anyway; filing the re-emission as unowed
  contradicts the rule that a parent's message makes a reported child owe again.
* **Reason for Rejection**: A parameter and a storage key for a case the measured incident did not
  have.

### Alternative D: The root confirms a change with the person through its question tool

* **Pros**: A typed change is acknowledged by the person before the tree acts.
* **Cons**: Several ancestors would ask about one sentence; the answer comes over the same API as
  the prompt and proves nothing more; the real-model checker has no answering path, so a compliant
  root hangs a run.
* **Reason for Rejection**: The answer travels the route the prompt travelled and proves nothing
  more.

### Alternative E: Detect the task prompt as the first `user` item in a roster session

* **Pros**: No metadata on the prompt.
* **Cons**: Needs a note per child; misreads a child whose task prompt the plugin never saw; a
  restart between spawn and delivery loses the note.
* **Reason for Rejection**: The request's `metadata` reaches the inbox item, so the detection needs
  no state of its own.

### Alternative F: Recognise command templates by their text and skip them

* **Pros**: Fewer envelopes for `/init` and `/review`.
* **Cons**: Project commands say anything; a wrong match silences the person; the list would track
  OpenCode's templates.
* **Reason for Rejection**: An extra envelope misleads nobody; a missed one loses the person's
  words.

### Alternative G: Escape envelopes and change nothing else

* **Pros**: Closes the forged-envelope hole with no new behaviour; already in place.
* **Cons**: Escaping stops a forged envelope; it does not stop the prose from making a fabricated
  claim binding.
* **Reason for Rejection**: The prose is the problem stated above.

### Alternative H: Change only the prose

* **Pros**: Deleting the binding sentences from the brief, the skill and the reference, and keeping
  the model-composed upward relay, removes the vulnerability with no new code, storage or event
  handling. It can land as a small change on its own, before the fan-up.
* **Cons**: The upward relay still depends on a model remembering to send: in one of ten
  `recursive-finding` runs the "count" session applied the change and told nobody, so two files
  lacked it ([real-model.md](../maintainers/real-model.md#a-finding-passed-on)). Route attestation
  is lost: a session above cannot tell relayed words from a session's own claim.
* **Reason for Rejection**: The fan-up does not depend on a model's memory, and the one run in ten
  is the case it exists for. The prose change lands first, as [phase 0](#phase-0-the-prose-patch)
  of the plan, so the binding sentences do not wait for the fan-up.

### Alternative I: Keep the text in the in-process inbox map instead of storage

* **Pros**: `noteEnqueued` already keeps a bounded map from inbox id to kind; a sibling map for
  the clipped text needs no key, no sweep and no prefix guard.
* **Cons**: A restart between `enqueued` and `delivered` loses the text, while OpenCode keeps the
  item and delivers it; the two servers' maps are separate.
* **Reason for Rejection**: A delivered item whose text the plugin has lost is a person's words
  dropped with no sign; one key is the price of not dropping them.

### Alternative J: The words never go up; the tree panel prompts the root on the person's behalf

* **Pros**: The person's intent is stated at the root directly.
* **Cons**: A bare API client gets nothing; the person loses one-stop steering from a child.
* **Reason for Rejection**: Half the clients would be left out.

### Alternative K: The `prompt` hook as the seam

* **Pros**: The hook sees the text before the item exists.
* **Cons**: It edits what the person wrote in their own transcript; a second detection path beside
  the event.
* **Reason for Rejection**: It changes the person's transcript and duplicates the event path.

### Alternative L: A keyed instruction entry per ancestor instead of a message

* **Pros**: No inbox item; survives compaction.
* **Cons**: Needs a wake beside it, so saves nothing over a message; hosts 2.2.0 and later only;
  entries carry state, not content.
* **Reason for Rejection**: It needs the message anyway.

--------------------------------------------------------------------------------

## Non-Functional Requirements

* **Security.** The envelope is the plugin's and escaped at the boundary, so no session can forge
  one in a message, an artifact or a title. A session can cause one through `subagent` on a native
  child or a shell holding the password, as the risks say; the envelope then names that route and
  binds nobody. Nothing in the design reads the password or a session's environment.
* **Performance.** Per typed item: one storage write at enqueue. At delivery: the roster index,
  the typed-in session's entry, the gate (the limits' walk over the tree: every roster entry under
  the root, its report rows and wake rows, and one `session.get` each, as `admit` pays per spawn)
  plus one `session.get` for the root, then per ancestor one `session.synthetic` and `noteSent`'s
  two transcript reads. Storage holds at most 4000 characters plus the clip suffix per waiting
  item; the per-session prefix scan that removes rows runs when a session leaves the roster.
* **Prompt cache.** The envelope is a message, not a system part or an instruction entry, so no
  cached prefix moves. The `role` entry is unchanged.
* **Rollout and rollback.** A minor release. In the mixed-copy window the first-line rule holds.
  Older copies ignore `typed/` rows and do not remove them; this copy's load sweep does. Rolling
  back to the release before this one leaves orphaned `typed/` rows that nothing reads. No option,
  no flag.

--------------------------------------------------------------------------------

### Additional Resources

* [Steering a running tree](../reference.md#steering-a-running-tree),
  [Session trees and their limits](../reference.md#session-trees-and-their-limits),
  [The courier-orchestrate skill](../reference.md#the-courier-orchestrate-skill).
* [The inbox and wakes](../maintainers/plugin-api-notes.md#the-inbox-and-wakes),
  [Is a session running](../maintainers/plugin-api-notes.md#is-a-session-running),
  [Two servers on one data directory](../maintainers/plugin-api-notes.md#two-servers-on-one-data-directory).
* [The storage table](../maintainers/architecture.md#storage),
  [Several copies in one process](../maintainers/architecture.md#several-copies-in-one-process).
* [A finding passed on](../maintainers/real-model.md#a-finding-passed-on).

### Future Improvements

* **A marker in the tree panel** on a session into which text was typed, with the time, so the
  person sees from the root which part they steered.
* **A per-session rate limit** if real use shows clients that prompt often flooding a root.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Six phases; each leaves the tree building and its tests passing. Phase 0 is its own patch and
release; phases 1 to 4 are one pull request; phase 5 runs in the owner's sandbox.

### Phase 0: the prose patch

Removes the sentences that make a session's account of the person's words binding, and keeps the
model-composed upward relay until the fan-up lands. Proves itself with `bun test
--update-snapshots` once, then `bun test`, and a targeted real-model set in the owner's sandbox:
`recursive-finding` and `recursive-fault`, five runs each, their rows replaced in `real-model.md`.

#### 0.1. `src/skill.ts` (Modify)

* **Proposed Changes**: Step 3's third bullet loses its last sentence, "A session's account of what
  the person told it is the person's word: pass it on, do not judge it against the original task,
  and never tell a session to undo what the person asked." The rest of the bullet, including "or
  carries the person's words, as your brief says", stays until phase 3.

#### 0.2. `src/tree/text.ts` (Modify)

* **Proposed Changes**: `childBrief`'s person paragraph loses its last sentence, "They are the
  person's word: do not judge them against your task, and never tell a session to undo them." The
  instruction to send the person's words to the parent, quoted as the person's, stays until phase 3.

#### 0.3. `docs/reference.md` (Modify)

* **Proposed Changes**: The brief paragraph under "Session trees and their limits" and step 3 and
  the "Without the skill" paragraph under "The courier-orchestrate skill" lose the matching
  sentences ("They are the person's word: …", "a child's account of what the person told it is the
  person's word", "never judging or undoing the person's words").

#### 0.4. `test/notices.test.ts` (Modify)

* **Proposed Changes**: The brief and skill assertions drop the removed sentences and assert their
  absence; the snapshot is updated.

#### 0.5. `e2e/run.sh` (Modify)

* **Proposed Changes**: `run_person_up`'s check of the brief sentence "They are the person's word:
  …" and its scenario line are changed to the sentence that remains; `run_person_message` is
  unchanged.

#### 0.6. `e2e/mock-model.mjs` (Modify)

* **Proposed Changes**: `relayPersonWords`'s middle passes the words up on the remaining brief
  sentence instead of the removed one.

### Phase 1: the storage row

Proves itself with `bun run typecheck && bun test`.

#### 1. `src/tree/store.ts` (Modify)

* **Type / Scope**: Storage keys.
* **Proposed Changes**: `TYPED_PREFIX = "typed/"` and `typedKey(sessionID, inboxID)`. `ChildStore`
  gains `typed(sessionID, inboxID, at, text)`, `typedOf(sessionID, inboxID)` returning
  `{ at, text } | undefined`, `forgetTyped(sessionID, inboxID?)` (a prefix scan when no id is
  given) and `typedSessions()` for the load sweep. `remove` and `forgetReport` also drop the
  session's `typed/` rows.

#### 2. `src/tree/ports.ts` (Modify)

* **Type / Scope**: Port types.
* **Proposed Changes**: The `ChildStore` methods above and a `Typed` row type `{ at, text }`.

#### 3. `src/tree/roster.ts` (Modify)

* **Type / Scope**: Load-time sweep.
* **Proposed Changes**: `pruneExpired` reads `typedSessions()` in the same `Promise.all` as
  `reported()`, before `children.all()`, and drops the rows of sessions with no roster entry
  beside `dropOrphanedReports`.

#### 4. `test/imports.test.ts` (Modify)

* **Type / Scope**: Import and key guard.
* **Proposed Changes**: The prefix regex gains `typed`, so only `tree/store.ts` names it.

#### 5. `test/store.test.ts` (Modify)

* **Type / Scope**: Storage key pin.
* **Proposed Changes**: `typed/ses_child/msg_1 {"at":…,"text":"…"}` written, read and removed
  with the child's other rows.

### Phase 2: the fan-up

Proves itself with `bun run typecheck && bun test`. Before it starts, one check on a real server
in the owner's sandbox, on the `probe-prompts` branch, whose probe plugin logs each inbox item's
metadata: `handOver` there sends `metadata: { source: "courier", task: true }` on the task prompt,
and the item's `metadata` must show it. The result goes into `docs/maintainers/plugin-api-notes.md`
(item 20). The pin-bump re-check in the risks stays as written.

#### 6. `src/tree/relay.ts` (Create)

* **Type / Scope**: One use case.
* **Proposed Changes**: `noteTyped(ports, event)` applies [the detection rule](#detection) and
  writes the row with the text clipped at `TYPED_MAX = 4000`. `relayTyped(ports, seen, event)`
  reads the row, claims `typed <sessionID> <inboxID>`, reads the ancestors and the title, runs
  `atWork(ports, root)`, sends the envelope to each ancestor sequentially with `noteSent` after
  each, logs as [the envelope](#the-envelope) says, and removes the row in a `finally`.
  `forgetTyped(ports, sessionID, inboxID)` for `session.inbox.cancelled`. `atWork` reuses `live`
  from `src/tree/limits.ts` (exported for it) over the tree's entries except the typed-in session,
  reads that session's `reportOf` and `waitsInInbox` (its own row left out) instead, then `runs`
  on the root with `ports.now()`, with the error rules of [the gate](#the-gate).

#### 7. `src/tree/events.ts` (Modify)

* **Type / Scope**: Event routing.
* **Proposed Changes**: `routeTree`'s `enqueued` branch runs `noteTyped` after `noteEnqueued` and
  returns `noteEnqueued`'s result; the `delivered` branch runs `relayTyped` before `notePrompt`;
  a `cancelled` branch calls `forgetTyped`; `deleted` is unchanged, since `forgetReport` drops the
  rows. `kindOf` returns `typed` for a courier synthetic with `metadata.route === "prompt"`, and
  `UNOWED` gains `typed`. `InboxEnqueued` is replaced by `wake.ts`'s `Enqueued`, which already has
  `created`, `text` and `metadata`, with `Enqueued`'s metadata widened to
  `{ readonly [key: string]: unknown }` so that `kindOf`'s reads of `group`, `scheduled`, `from`,
  `scheduledAt` and `route` typecheck; `watchWake`'s reads of `source` and `resume` are unchanged.

#### 8. `src/tree/spawn.ts` (Modify)

* **Type / Scope**: The task prompt.
* **Proposed Changes**: `handOver` passes `metadata: { source: "courier", task: true }` to
  `session.prompt`.

#### 9. `src/tree/text.ts` (Modify, the envelope)

* **Type / Scope**: Model-facing text.
* **Proposed Changes**: `typedNotice(sessionID, title, at, now, text)` builds the body shown in
  [the envelope](#the-envelope), with `clock(at, now)` for the time and the title clause left out
  when `title` is undefined; `BRIEF_FIRST_LINE` exported for the detection rule.

#### 10. `test/fixtures/events.ts` (Modify)

* **Type / Scope**: The fake plugin context.
* **Proposed Changes**: `fakePorts` gains `session.get` reading a `times: Map<sessionID,
  BusyTimes>` and a `context` keyed by session id, so the gate's legs can be set per session.

#### 11. `test/watch.test.ts` (Modify)

* **Type / Scope**: Unit tests.
* **Proposed Changes**, one test each:
  * a `user` item in a roster session writes the row; delivery with a tree at work sends one
    envelope per ancestor, parent first, with the metadata, a wake row each and the row removed;
  * `source: "courier"` is not stored; `source: "goal"` and a `schedule` item are handled as the
    table says; whitespace-only text is not stored; a skill-attached prompt relays the text only;
  * the brief's first line is not stored; the `handOver` prompt through the fake is not stored;
  * the gate: a live sibling subtree alone, a `blocked` child alone, a waiting wake alone, the
    root's turn through `time.busy` and through the transcript; a stalled wake alone does not
    hold; the typed-in session's own started turn (`time.busy` stamped, transcript ending on the
    item) does not hold when it has reported and nothing else is at work; all false logs
    `reached nobody`, sends nothing and removes the row;
  * a rejected `session.get` counts as not running; a rejected storage read counts as at work;
  * `cancelled` removes the row; two subscriptions send once and both remove the row;
  * a failing `synthetic` to one ancestor does not stop the others and is logged;
  * clipping at 4000 with the cut count; a `<courier` in the text is escaped;
  * `notePrompt` treats the envelope as unowed at the ancestor.

#### 12. `test/courier.test.ts` (Modify)

* **Type / Scope**: Tool tests.
* **Proposed Changes**: `courier_spawn`'s prompt call carries `metadata.source === "courier"` and
  `task === true`.

#### 13. `test/notices.test.ts` (Modify, the envelope)

* **Type / Scope**: Text snapshot.
* **Proposed Changes**: `typedNotice` snapshots with a title and without, with a body holding
  `<courier`, and with an enqueue time on the day before the send time.

### Phase 3: the prose

Proves itself with `bun test --update-snapshots` once, then `bun test`, and `test/links.test.ts`.

#### 14. `src/tree/text.ts` (Modify, the brief)

* **Proposed Changes**: `childBrief`'s person sentences read as
  [What the prose says](#what-the-prose-says) quotes.

#### 15. `src/skill.ts` (Modify)

* **Proposed Changes**: Step 3's third bullet reads as quoted there.

#### 16. `test/notices.test.ts` (Modify, the assertions)

* **Proposed Changes**: The brief contains the new sentence at every depth and not `the person's
  word`; the skill contains `pass it only to the sessions you started that it changes` and not
  `or carries the person's words, as your brief says` nor `A session's account of what the person
  told it`.

#### 17. `docs/reference.md` (Modify)

* **Proposed Changes**: As [What the prose says](#what-the-prose-says) lists, with the detection
  table, the gate and the envelope under "Steering a running tree".

#### 18. `README.md` (Modify)

* **Proposed Changes**: The steering bullet reads as quoted.

#### 19. `docs/maintainers/architecture.md` (Modify)

* **Proposed Changes**: The storage table gains `typed/<sessionID>/<inboxID>`: `{ at, text }`, a
  `user` item typed into a spawned session, from its enqueue until its fan-up is sent or skipped.

#### 20. `docs/maintainers/plugin-api-notes.md` (Modify)

* **Proposed Changes**: Under "The inbox and wakes": a prompt's `metadata` is copied into the inbox
  item's user payload by `SessionPrompt.prepare` (`packages/core/src/session/prompt.ts`), as the
  check before phase 2 showed on a real server, which is how the plugin tells its task prompt from
  other `user` items; a `user` item says nothing about
  its origin, and prompts through `opencode run` and the API arrive with `metadata: null`;
  `/goal`'s kickoff carries `source: "goal"`; `session.inbox.cancelled` is published for an item
  withdrawn before delivery; what the TUI sends, once confirmed. Under "OpenCode's subagent tool":
  `subagent` accepts an existing session whose `parentID` is the caller and prompts it as a plain
  `user` item. Under "Two servers on one data directory": a session's inbox events are seen by the
  server that queued its prompt only. Each is a trap a pin bump re-checks.

### Phase 4: the live suite

Proves itself in the sandbox with `E2E_GROUPS="person-up person-message" e2e/run.sh`, then the
full suite; `e2e/tui.sh` for the panel check.

#### 21. `e2e/run.sh` (Modify)

* **Proposed Changes**: `run_person_up` is the fan-up scenario. The root spawns a middle
  (`CHILD-RELAYS-PERSON`), which spawns a leaf (`CHILD-PERSON-WORDS`); the leaf's first reply is
  `LEAF WAITS`, a turn ended without a report, so the leaf owes one and the tree is at work.
  `prompt_in "$leaf" "PERSON-SAYS: print the number, do not write a file"`. Checks: the root and
  the middle each hold exactly one synthetic starting
  `<courier from="courier" route="prompt" in="$leaf">` and containing `PERSON-SAYS`; the leaf holds
  no `<courier from="$mid"`; the leaf's brief holds `Do not send it up yourself` and not `the
  person's word`; the root replied `ROOT HEARD TYPED` and the middle `RELAYER HEARD TYPED`. Then
  the leaf reports done, the middle reports done, and once the root has replied `ROOT GOT REPORT`
  and `turn_ended "$root"` holds, `prompt_in "$leaf" "PERSON-LATE"`; the barrier is a new
  `wait_log "reached nobody: the tree has finished" 30` helper, a loop over `grep -qF` on
  `$WORK/server.log` in the pattern of the existing waits; then one check that the root holds no
  synthetic containing `PERSON-LATE`. `run_person_message`'s brief check names `Do not send it up
  yourself`. The `SUITE` weight of `person-up` is updated from the run log.

#### 22. `e2e/mock-model.mjs` (Modify)

* **Proposed Changes**: `relayPersonWords`: the leaf replies `LEAF WAITS` first, reports done on a
  `PERSON-SAYS` user message, and replies `LATE HEARD` to `PERSON-LATE`; the middle replies
  `RELAYER HEARD TYPED` to a `route="prompt"` envelope, `RELAYER WOKE` to an
  `ended="without-report"` envelope, and reports done once the leaf has; the root replies
  `ROOT HEARD TYPED` and `ROOT GOT REPORT`. `decide` calls `relayPersonWords` with the messages
  as they are, and only after it drops a trailing `route="prompt"` envelope from the messages the
  later branches see, so those branches decide as if the envelope were not there. This is
  defensive: in the other scenarios that prompt a child (`PERSON-ASKS`, `CHILD-ROLE-AGAIN`,
  `COURIER-TEST` into a child) an unhandled envelope draws a text reply that no check reads.

#### 23. `e2e/tui.sh` (Modify)

* **Proposed Changes**: One check: a line typed into a child opened from the tree panel produces a
  `route="prompt"` envelope at the root.

#### 24. `e2e/two-servers.sh` (Modify)

* **Proposed Changes**: A typed prompt into a child queued on one server produces exactly one
  envelope at the root.

#### 25. `docs/maintainers/development.md` (Modify)

* **Proposed Changes**: The paragraph on checks that something did not happen names `wait_log` as
  a barrier on a server log line.

### Phase 5: the real model

Runs in the owner's sandbox only. Before the pull request of phases 1 to 4 is merged: five
`recursive-finding` runs on its branch with the final envelope body, since the ten runs above used
a shorter body with a different attribute. After it is merged: every scenario, and the two arms of
`recursive-conflict`.

#### 26. `e2e/real-model.sh` (Modify)

* **Proposed Changes**: A `recursive-conflict)` arm with `recursive-finding`'s `PROMPT`,
  `COURIER_EXPECT="391 42"`, `COURIER_FILES="numbers/a.txt count/total.txt"`,
  `CHECKER=real-model-recursive.mjs`, `CHECKER_FLAGS=--conflict`; the `*)` message and the list
  at the file's end name it; `export COURIER_COMMIT=$(git rev-parse --short HEAD)`.

#### 27. `e2e/real-model-recursive.mjs` (Modify)

* **Proposed Changes**: The finding checks read the plugin's envelope: a helper
  `typedAt(list, sessionID)` finds the first synthetic whose text starts with
  `<courier from="courier" route="prompt" in="<id>">` (`sendersOf` returns `courier` for it);
  the four checks are: the words reached the "count" session; the root holds the envelope; the
  root sent the other part a message without a status after it; that part passed the words down.
  A note quotes every message to the "count" session after the envelope. `--conflict` and the
  `conflict` summary field; the half detector, the POST, the file order, the checks and the notes
  of [Settling the undo clause](#settling-the-undo-clause); `commit` in `summary.json` from
  `COURIER_COMMIT`.

#### 28. `test/real-model-recursive.test.ts` (Modify)

* **Proposed Changes**: Fixtures with the plugin's envelope at the root for the finding checks, and
  fixtures for the conflict checks: a countermand, a replacement, a clean run.

#### 29. `docs/maintainers/real-model.md` (Modify)

* **Proposed Changes**: The `COURIER_SCENARIO` row names `recursive-conflict`; "A finding passed
  on" describes the envelope-based checks; a section for `recursive-conflict` with the arms, the
  margin rule and the person's classification step; the result rows of every scenario after the
  re-run.

### Verification Plan

* **Compilation/Build**: `bun run typecheck`, `bun run build`.
* **Unit Tests**: `bun test`; items 0.4, 4, 5, 11, 12, 13, 16 and 28 above; `bun test
  --update-snapshots` once in phase 0 and once in phase 3.
* **Static Analysis**: SonarCloud in CI.
* **Test Coverage Requirement**: none beyond the tests named.
* **E2E/Integration**: the live suite's four shards, `e2e/tui.sh` and `e2e/two-servers.sh` in the
  sandbox. Real model, in the owner's sandbox: after phase 0, `recursive-finding` and
  `recursive-fault`, five runs each (about 350 requests); before phase 2, the metadata check on the
  `probe-prompts` branch; before the merge of phases 1 to 4, five `recursive-finding` runs on that
  branch (about 175 requests); after it, `e2e/real-model.sh` on every scenario (about 20 runs, 700
  requests, in batches on the free tier or on a paid key) and `recursive-conflict` in two arms,
  five runs each (about 350 requests).

--------------------------------------------------------------------------------

*Drafted with EGM*
