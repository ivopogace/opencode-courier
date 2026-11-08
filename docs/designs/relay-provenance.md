# Courier passes words typed into a session up the tree

* **Author:** Ivo Pogace
* **Status:** Draft
* **Date:** 2026-11-08

--------------------------------------------------------------------------------

## Overview

opencode-courier lets OpenCode sessions spawn, message and wake each other. Sessions form a tree: a
root and the children it starts with `courier_spawn`; children report with `courier_send`. The
person steers a running tree by typing into any of its sessions, from the `/courier tree` panel or
any client.

This design has the plugin carry such words up the tree itself. When a `user` item that courier did
not send is delivered to a spawned session, and the tree is still at work, the plugin sends the text
as written to every session above it, in an envelope only the plugin writes. The envelope says what
the plugin knows: that the text arrived in that session over the prompt route, when, and that
courier cannot tell who typed it. It says that the typed-in session has the words, and that a
session above should send them to the parts they change. The child brief and the
`courier-orchestrate` skill stop asking models to relay or quote the person, and no prose makes a
session's own account of the person's words binding on anyone.

## The Problem

Today words typed into a child travel up as model text. The child brief tells a spawned session to
send what the person writes to its parent, quoting it as the person's, and to pass on the person's
words a session below relays. The skill tells every orchestrator that a session's account of what
the person told it is the person's word: pass it on, do not judge it against the task, never tell a
session to undo it.

That claim is free text with no provenance, and the rule makes it binding on every ancestor. A
session misled by a file, a tool result or a web page can put words under it. A session can also
invent it with no injection at all: in one measured real-model run a sub-orchestrator's child
reported that "the person wrote to me directly (outside a courier envelope)" and refused the second
half of its task, when no message from the person existed; its parent's pushback was right, and the
rule tells parents not to push back.

The plugin can do better than prose because it sees the host's events. `session.inbox.enqueued`
carries each item's type and, for a `user` item, its text and metadata; the plugin can tag its own
task prompt and so tell its prompt from every other `user` item. It cannot tell who typed the
others: the person at the TUI, an API client, another plugin, or a parent through OpenCode's
`subagent` tool all look the same. So the envelope attests the route, not the person.

## Goals

* Words that arrive in a spawned session over the prompt route, not sent by courier, reach every
  session above it without a model composing the message, in an envelope only the plugin writes,
  while the tree is at work.
* The envelope states only what the plugin knows: the route, the session, the time, and that
  courier cannot say who typed it. It tells the receiving sessions that the typed-in session has the
  words and that they go to the parts they change.
* The child brief and the skill stop asking models to relay or quote the person's words, and lose
  the sentence that makes a session's account of them binding. The remaining text is no longer than
  today's. The `role` instruction entry is untouched.
* One mock e2e scenario covers the relay, its gate and its absence; the real-model suite covers
  the brief and skill change on every scenario; a new real-model scenario settles the one open
  wording.

## Non-Goals

* Proving who typed. A parent through the `subagent` tool, an API client and the person look the
  same to the plugin, and the envelope says so.
* Carrying the words downward. A part hears from its parent, which has authority over it, and a
  part started after the words arrive gets them in its task text.
* Confirming a change with the person. The person's answer would come over the same route as the
  prompt and prove nothing more.
* Relaying attached files, agents or skills, or the typed-in session's own reading of the words.
* A private channel to one session, a rate limit, or an option to turn the relay off.
* Telling courier's prompts from other `user` items by anything but courier's own metadata.

## Open Questions

* **The "undo" clause.** The envelope says that the typed-in session has the words and answers
  them. Whether it also says what a session above may not do is open. Candidates, in the sentence
  slot after "has the words and answers them":
  1. "Do not tell it to undo them unless the person says so."
  2. "It decides what they mean for its part."
  3. No clause: the words are information, and the parts above decide.

  The one measured case of a parent countermanding its child's "person said" was a parent rightly
  refusing a fabricated claim; under this design that claim arrives in no envelope and binds
  nobody, so the clause only ever applies to words courier itself relayed. Ten real-model runs of
  `recursive-finding` with and without a rule line could not separate the arms, because that
  scenario's words contradict no session's task, so nothing provoked a pushback. The
  [`recursive-conflict` scenario](#the-recursive-conflict-scenario) below is written to provoke one;
  the wording is final once it has run, and the envelope ships with the slot empty (candidate 3)
  until then.
* **What a child's shell has in its environment.** In the live harness a POST from a child's shell
  to the prompt route went through because the harness exports `OPENCODE_PASSWORD`. Whether a real
  install puts the password in a session's environment is not known. The design relays such a POST
  as typed from outside either way; the answer changes only how the docs describe the threat.
* **Whether OpenCode's TUI sends `metadata` with a typed prompt.** Prompts through `opencode run`
  and the API arrive with `metadata: null`. The detection rule skips only items whose metadata names
  a `source` or a `schedule`, so a TUI prompt with other metadata is still relayed; a TUI that set
  `source` would not be, and the rule would need that name as an exception.

## Critical User Journeys (CUJs)

### CUJ 1: The person changes the job from inside a part

* **Given**: A root has split a job into a "count" part and a "numbers" part, which has two halves
  of its own. Every session is at work.
* **When**: The person opens the "count" session from the tree panel and types that every file the
  job writes must end in ` checked`.
* **Then**: At the next step of the "count" session, the root receives one envelope
  `<courier from="courier" typed="outside" in="<count>">` with those words. The "count" session
  acts on them. The root sends them to the "numbers" session, and only there; that session sends
  them to its halves, or starts a half with them in its task. No session messages the "count"
  session about them. Each file ends in ` checked`.

### CUJ 2: A session claims the person said something

* **Given**: A half of a job, whose task says to print a number and then write it to a file, has
  read a page that says the person wants no file written.
* **When**: It sends its parent a message without a status: "the person told me not to write the
  file".
* **Then**: The message arrives as `<courier from="<half>">`, like any message. No envelope marks
  it as typed from outside, no brief or skill sentence makes it binding, and the parent weighs it
  as it weighs any claim: it can tell the half to finish its task.

### CUJ 3: The person types into a finished tree

* **Given**: Every child has reported, the root has ended its turn, nothing waits in any inbox.
* **When**: The person opens a child and types a follow-up.
* **Then**: The child acts on it. Nothing is relayed; the server log has one line saying words
  typed into that session reached nobody because the tree has finished. If the child spawns or
  reports, those wake its parent as usual.

### CUJ 4: A parent prompts its native child through OpenCode's `subagent` tool

* **Given**: A parent started a native child with `courier_spawn` and the tree is at work.
* **When**: The parent calls `subagent` with the child's session id and a prompt.
* **Then**: The prompt arrives in the child as a plain `user` item. The parent and every session
  above it receive it as `typed="outside"` into that child, since the plugin cannot tell it from
  the person's typing, and the docs say so.

## Technical Plan (Architecture)

### The flow

```text
 person / client / parent's subagent / child's shell
          │  POST prompt (user item, no courier metadata)
          ▼
 OpenCode: session.inbox.enqueued ─────────────► tree/relay.ts: noteTyped
   (type "user", payload.text, payload.metadata)     roster session? user item?
                                                     text non-empty? no source/schedule?
                                                     → storage typed/<session>/<inboxID> { at, text }
          │
          │  next step of the typed-in session
          ▼
 OpenCode: session.inbox.delivered ────────────► tree/relay.ts: relayTyped
   (inboxID only)                                    row found? claim once in this process
                                                     tree at work? (gate below)
                                                     → session.synthetic to each ancestor,
                                                       parent first, top last; noteSent each
                                                     → remove the row; one log line
 OpenCode: session.inbox.cancelled, session.deleted → remove the row(s)
```

The new use case lives in `src/tree/relay.ts`, routed from `src/tree/events.ts` beside
`noteEnqueued` and `notePrompt`. It reads and writes storage through `childStore` in
`src/tree/store.ts`, the only file that knows the key. Its model-facing text is in
`src/tree/text.ts`. It needs no new port: `WatchPorts` already has `storage`, `session.synthetic`,
`session.get` and `session.context`, which every hub-v2 member carries, so the hub version does not
change.

### Detection: courier's own metadata on its task prompt

`handOver` in `src/tree/spawn.ts` sends the task prompt with
`metadata: { source: "courier", task: true }`. OpenCode copies a prompt's `metadata` into the
inbox item's user payload, so `session.inbox.enqueued` shows it. The plugin treats a `user` item as
typed from outside when all of these hold:

- the session has a roster parent (`indexedParent` is defined);
- `item.type` is `user`;
- `payload.text` is a string with something other than whitespace;
- `payload.metadata` has no `source` and no `schedule` key.

The `source` rule excludes courier's task prompt and any plugin that names itself, such as `/goal`
(`source: "goal"`). The `schedule` rule excludes OpenCode's schedules. Everything else that lands
as a `user` item is relayed, and the docs list what that includes:

| `user` item | Relayed as typed from outside |
|---|---|
| Typing at the TUI, `opencode run --session`, a POST to the prompt route | yes |
| A slash command template (`/init`, `/review`, a project command): the whole template | yes |
| A prompt with a skill attached: the typed `text` only; `skills[].text` is not relayed | yes |
| A parent's `subagent` call with its native child's session id | yes, to that parent too |
| A POST from a child's own shell, where it has the password | yes |
| Courier's task prompt (`source: "courier"`) | no |
| `/goal` kickoff with attachments (`source: "goal"`) | no |
| OpenCode's schedules (`metadata.schedule`) | no |
| Files, agents or skills attached to any item | never; only `text` travels |

No text heuristic recognises a command template: project commands can say anything, and a wrong
guess would silence the person. Relaying a template to the sessions above costs them one envelope
and misleads nobody, since the envelope names the route and not the person.

### The stored row

At `enqueued` the plugin writes `typed/<sessionID>/<inboxID>` with `{ at, text }`, where `at` is
the event's `created` and `text` is the item's text clipped at 4000 characters (`clipText`, which
appends how many characters were cut). The row exists because `delivered` carries only the inbox
id and may come after a restart, and because a queued item can wait a whole turn. It is removed
once the relay has been sent or skipped, on `session.inbox.cancelled` for that id, with the
session's report rows when the session leaves the roster, and at load for sessions no longer on
the roster. A row that outlives a crash between sending and removal never fires again, since
`delivered` comes once.

### Firing on delivery

At `session.inbox.delivered` for a roster session the plugin reads the row. If there is none, the
item was not typed from outside. Otherwise it claims `typed/<inboxID>` in the process-wide `seen`
set, so the hub's two subscriptions send once, reads the ancestors from `roster-by-child/` (parent
first, top last) and decides the gate.

Firing on delivery, not on enqueue, means a message steered into a running session is relayed at
the step where that session reads it, a queued one when its turn comes, and a cancelled one never.
Delivery precedes the typed-in session's step, so the sessions above hear before it acts. The
`synthetic` call to a running ancestor steers it; to an idle ancestor it wakes it.

### The gate: the tree is at work

Words are relayed while any ancestor, from the parent to the top, meets one of:

- a child of it owes a report or last reported `blocked` (`reportOf` over `children(ancestor)`;
  the typed-in session's own row is among the parent's);
- a courier message waits in its inbox (`waitsInInbox`, the `wake/` rows);
- its turn is running (`session.get`, then `runs` in `src/tree/running.ts`, which reads the
  transcript only when the times cannot tell).

The checks stop at the first that holds, so a tree at work costs a few storage reads and at most
one `session.get` per ancestor. What the gate silences is a tree whose root has ended its turn with
every child reported and nothing waiting, and a child re-opened under it later. The running-turn
check exists for the root that is verifying and merging after the last report, when no row owes
anything; without it, words typed then would reach nobody while the brief tells the child it need
not send them up.

A held group report counts through the parent's other members or the release waiting in the
parent's inbox, never through the held member itself. A blocked child counts, since it is the one
a person is most likely to open.

### The envelope

To each ancestor, `session.synthetic` with `delivery: "steer"`,
`metadata: { source: "courier", typed: "outside", in: "<sessionID>" }`, `description`
`Words typed into <sessionID>`, and the text built by `envelope("courier", typedNotice(...), { typed: "outside", in: sessionID })`:

```
<courier from="courier" typed="outside" in="ses_count">
Someone outside the tree typed this into session ses_count ("count the lines"), a session under
yours, at 14:32 UTC. Courier passes it on as written and cannot tell who typed it. That session has
the words and answers them. Where they change another part, send them to that part's session, and
only there.

every file this job writes must hold its number followed by a space and the word checked
</courier>
```

`from="courier"` follows the sender convention of every envelope; the typed-in session is named
in `in=` and in the body. The body is escaped by `envelope()`, so a `<courier` in the typed text
reads `&lt;courier`; the title is escaped with it. The open clause goes after "answers them." once
settled. The envelope asks nothing that binds an ancestor to the text: no "follow it", no "do not
judge it".

`kindOf` in `src/tree/events.ts` names an item with `metadata.typed === "outside"` as the kind
`typed`, which is unowed: a relay from below is progress for the session above, not a prompt that
makes it owe a report again. `watchWake` takes the relay like any courier message (source
`courier`, a text), so a missed wake is re-sent, and `noteSent` writes the wake row right after
the call, as `courier_send` does.

### What the prose says

The rule that a session's account of the person's words is the person's word is removed from the
skill, the brief and the reference. A session's account of what the person said is a message like
any other; what binds is an envelope courier wrote, and only to the extent its text says.

- `childBrief` (`src/tree/text.ts`): the person sentence becomes "What the person writes in your
  session, outside a `<courier>` envelope, courier itself passes to the sessions above you while
  the tree is at work, marked typed="outside". You need not send it up: act on it, and say in your
  report what you did because of it." The finding sentence stays.
- The skill (`src/skill.ts`, step 3): the bullet's list of what changes what other parts need
  gains "words typed into a session under you, which courier passes you marked typed="outside"",
  loses "or carries the person's words", and the sentence "A session's account of what the person
  told it is the person's word: …" goes. The clause about the typed-in session, if any, is the
  envelope's and not repeated here.
- `docs/reference.md`: the brief paragraph under "Session trees and their limits", step 3 and the
  "Without the skill" paragraph under "The courier-orchestrate skill", and "OpenCode's subagents"
  are shortened to match; "Steering a running tree" is the one home for the relay: what is
  relayed, the table above, the gate, the envelope, and that a parent's `subagent` follow-up into
  its native child comes back to it as typed from outside.
- README.md: the steering tip says that courier passes what the person types into a child to the
  sessions above it.

### Failure modes

- **Every `user` item fans out**, "ok" and "why?" included, to at most `maxDepth` ancestors. The
  gate silences only a finished tree. Accepted; a rate limit is a non-goal.
- **Compaction at an ancestor** drops the envelope from its transcript. Only the skill and the
  brief survive, and the brief's sentence says courier passes words up, nothing about what arrives.
- **An ancestor is gone or refuses the call**: that `synthetic` fails, is logged, and the others
  are still sent.
- **The relay waits in an idle ancestor's inbox**: the ancestor is live for the limits until it
  takes it, as with any courier message, and the missed-wake watch re-sends it.
- **The host drops prompt metadata** (a different OpenCode version): courier's own task prompt
  would be relayed to the parent as typed from outside at every spawn. The plugin API is pinned
  exactly, and a pin bump re-checks that `SessionPrompt.prepare` copies `metadata`
  ([plugin-api-notes.md](../maintainers/plugin-api-notes.md#the-inbox-and-wakes)).

## Alternatives Considered

### Alternative A: A `person: true` mark on messages a model composes

* **Pros**: No new event handling; the child says what it heard.
* **Cons**: A session that heard from the person can be injected afterwards and put false words
  under a real mark; a forwarded mark proves custody, not origin.
* **Reason for Rejection**: Rejected by author: the mark would carry exactly the claim the design
  stops trusting.

### Alternative B: The same, verified against the recorded prompt text

* **Pros**: A quote that matches the stored prompt is the person's.
* **Cons**: The child can surround the quote with anything; a paraphrase silently demotes real
  words; the plugin would read transcripts on every send.
* **Reason for Rejection**: Rejected by author: verification of a quote does not verify the message
  around it.

### Alternative C: Re-emit the envelope downward on a `relay` parameter of `courier_send`

* **Pros**: Siblings' subtrees would see the plugin's envelope, not a parent's paraphrase.
* **Cons**: A part hears from its parent, which has authority over it; `courier_spawn` carries no
  relay, so a part started later gets the words unmarked anyway; filing the re-emission as unowed
  contradicts the rule that a parent's message makes a reported child owe again.
* **Reason for Rejection**: Rejected by author: the downward hop adds a parameter and a storage key
  for a case the measured incident did not have.

### Alternative D: The root confirms a change with the person through its question tool

* **Pros**: A typed change is acknowledged by the person before the tree acts.
* **Cons**: Several ancestors would ask about one sentence; the answer comes over the same API as
  the prompt and proves nothing more; the real-model checker has no answering path, so a compliant
  root would hang a run.
* **Reason for Rejection**: Rejected by author.

### Alternative E: Detect the task prompt as "the first `user` item in a roster session"

* **Pros**: No metadata on the prompt.
* **Cons**: Needs a note per child; misreads a child whose task prompt the plugin never saw; a
  restart between spawn and delivery loses the note.
* **Reason for Rejection**: Rejected by author: the request's `metadata` reaches the inbox item,
  which is stateless.

### Alternative F: Recognise command templates by their text and skip them

* **Pros**: Fewer envelopes for `/init` and `/review`.
* **Cons**: Project commands say anything; a wrong match silences the person; the list would track
  OpenCode's templates.
* **Reason for Rejection**: Rejected by author: an extra envelope misleads nobody, a missed relay
  loses the person's words.

### Alternative G: Escape envelopes and change nothing else

* **Pros**: Closes the forged-envelope hole with no new behaviour.
* **Cons**: The prose still makes a fabricated or injected claim binding.
* **Reason for Rejection**: Not the end state. The escaping is in place; this design builds on it.

### Alternative H: The words never go up; the tree panel prompts the top on the person's behalf

* **Pros**: The person's intent is stated at the top directly.
* **Cons**: Bare API clients get nothing; the person loses one-stop steering from a child, which
  `recursive-finding` exists to test.
* **Reason for Rejection**: Rejected by author.

### Alternative I: The `prompt` hook as the seam

* **Pros**: The hook sees the text before the item exists.
* **Cons**: It edits what the person wrote in their own transcript; a second detection path beside
  the event.
* **Reason for Rejection**: Rejected by author.

### Alternative J: A keyed instruction entry per ancestor instead of a message

* **Pros**: No inbox item, survives compaction.
* **Cons**: Needs a wake beside it; 2.2.0 and later only; entries carry state, not content.
* **Reason for Rejection**: Rejected by author.

--------------------------------------------------------------------------------

## Non-Functional Requirements

* **Security.** The envelope is the plugin's and escaped at the boundary, so no session can forge
  one in a message, an artifact or a title. It claims only the route. Nothing in the design reads
  the password or the session's environment; the shell POST is relayed as any other prompt.
* **Performance.** Per typed item: one storage write at enqueue; at delivery one read of
  `roster-by-child/`, per ancestor until the gate holds a scan of its `roster/` children and their
  report rows, a scan of its `wake/` rows and one `session.get`; then one `synthetic` and one
  `noteSent` per ancestor, at most `maxDepth` of them. Storage holds at most 4000 characters per
  waiting item.
* **Prompt cache.** The relay is a message, not a system part or an instruction entry, so no cached
  prefix moves. The `role` entry is unchanged.
* **Rollout and rollback.** A minor release. Older copies in the same process ignore the `typed/`
  rows (an unknown prefix) and do not remove them; the new copy's load sweep does. Rolling back to
  the previous version leaves orphaned `typed/` rows that nothing reads. No option, no flag.

--------------------------------------------------------------------------------

### Additional Resources

* [docs/reference.md](../reference.md), "Steering a running tree", "Session trees and their
  limits", "The courier-orchestrate skill".
* [docs/maintainers/plugin-api-notes.md](../maintainers/plugin-api-notes.md), "The inbox and
  wakes" and "Is a session running".
* [docs/maintainers/architecture.md](../maintainers/architecture.md), the storage table.
* [docs/maintainers/real-model.md](../maintainers/real-model.md), "A finding passed on".

### Future Improvements

* **A marker in the tree panel** on a session into which words were typed, with the time, so the
  person sees from the top which part they steered.
* **A per-session rate limit** if real use shows chatty clients flooding a root.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Target Files to Create/Modify

#### 1. `src/tree/relay.ts` (Create)

* **Type / Scope**: TypeScript module, one use case.
* **Proposed Changes**: `noteTyped(ports, event)` for `session.inbox.enqueued`: applies the
  detection rule and writes the row through `childStore(...).typed(sessionID, inboxID, at, text)`
  with the text clipped at `TYPED_MAX = 4000`. `relayTyped(ports, seen, event)` for
  `session.inbox.delivered`: reads the row, claims `typed/<inboxID>`, reads
  `indexedAncestors`, runs `atWork(ports, ancestors)`, sends the envelope to each ancestor with
  `noteSent` after each, logs one line (`courier relay: words typed into <id> passed to <n>
  sessions` or `… reached nobody: the tree has finished`), removes the row. `forgetTyped(ports,
  sessionID, inboxID?)` for `session.inbox.cancelled` and `session.deleted`. `atWork` reads
  `reportOf` over `children(ancestor)`, `waitsInInbox(ancestor)` and `runs(session, ancestor,
  time)` in that order and stops at the first true.

#### 2. `src/tree/events.ts` (Modify)

* **Type / Scope**: Event routing.
* **Proposed Changes**: `routeTree` calls `noteTyped` on `enqueued` after `noteEnqueued`,
  `relayTyped` on `delivered` before `notePrompt`, `forgetTyped` on `cancelled` and `deleted`.
  `kindOf` returns `typed` for a courier synthetic whose `metadata.typed === "outside"`, checked
  before the status-less idiom, and `UNOWED` gains `typed`. The `InboxEnqueued` payload type gains
  `text` and `metadata` as in `wake.ts`'s `Enqueued`.

#### 3. `src/tree/store.ts` (Modify)

* **Type / Scope**: Storage keys.
* **Proposed Changes**: `TYPED_PREFIX = "typed/"`, `typedKey(sessionID, inboxID)`; `ChildStore`
  gains `typed(sessionID, inboxID, at, text)`, `typedOf(sessionID, inboxID)` returning
  `{ at, text } | undefined`, `forgetTyped(sessionID, inboxID?)`, and `typedSessions()` for the
  load sweep. `remove` and `forgetReport` also drop the session's `typed/` rows.

#### 4. `src/tree/ports.ts` (Modify)

* **Type / Scope**: Port types.
* **Proposed Changes**: The `ChildStore` methods above; a `Typed` row type.

#### 5. `src/tree/roster.ts` (Modify)

* **Type / Scope**: Load-time sweep.
* **Proposed Changes**: `pruneExpired` removes `typed/` rows of sessions with no roster entry,
  after the report rows it already handles.

#### 6. `src/tree/spawn.ts` (Modify)

* **Type / Scope**: The task prompt.
* **Proposed Changes**: `handOver` passes `metadata: { source: "courier", task: true }` to
  `session.prompt`.

#### 7. `src/tree/text.ts` (Modify)

* **Type / Scope**: Model-facing text.
* **Proposed Changes**: `typedNotice(sessionID, title, at, text)` builds the envelope body shown
  above, with the time as `HH:MM UTC` and the clause slot empty; `childBrief` replaces the person
  sentences with the one in "What the prose says".

#### 8. `src/skill.ts` (Modify)

* **Type / Scope**: The `courier-orchestrate` skill.
* **Proposed Changes**: Step 3 as in "What the prose says".

#### 9. `test/watch.test.ts` (Modify)

* **Type / Scope**: Unit tests on the fake plugin context.
* **Proposed Changes**: A typed `user` item in a roster session writes the row and, on delivery
  with a tree at work, sends one envelope to each ancestor, parent first, with the metadata,
  `noteSent` rows and the removed row; the `source` and `schedule` exclusions; whitespace-only
  text; a skill-attached prompt relays the text only; the task prompt from `handOver` is not
  stored; the gate's three legs each alone, and all three false (log line, no send, row removed);
  the root's running turn through `time.busy` and through the transcript; `cancelled` and
  `deleted` remove the row; two subscriptions send once; a failing `synthetic` to one ancestor
  does not stop the others; clipping at 4000 with the cut count; `notePrompt` treats the relay as
  unowed at the ancestor.

#### 10. `test/store.test.ts` (Modify)

* **Type / Scope**: Storage key pin.
* **Proposed Changes**: `typed/ses_child/msg_1 {"at":…,"text":"…"}` written and removed with the
  child's other rows.

#### 11. `test/notices.test.ts` (Modify)

* **Type / Scope**: Text snapshot and assertions.
* **Proposed Changes**: `typedNotice` snapshot with a title and a body holding `<courier`, both
  escaped; the brief contains the new sentence at every depth and not "the person's word"; the
  skill contains the new list item and not the removed sentence.

#### 12. `test/courier.test.ts` (Modify)

* **Type / Scope**: Tool tests.
* **Proposed Changes**: `courier_spawn`'s prompt call carries `metadata.source === "courier"` and
  `task === true`.

#### 13. `e2e/run.sh` (Modify)

* **Type / Scope**: Live suite.
* **Proposed Changes**: `run_person_up` becomes the fan-up scenario: the root spawns a middle,
  which spawns a leaf that waits; `prompt_in "$leaf" "PERSON-SAYS: …"`; the root and the middle each
  hold exactly one `<courier from="courier" typed="outside" in="$leaf">` with the words; the leaf
  holds no `<courier from="$mid"`; the leaf's brief holds the new sentence and not "the person's
  word"; then, once the root has reported the whole job and ended its turn (barrier: its reply
  `ROOT GOT REPORT`), `prompt_in "$leaf" "PERSON-LATE"`, barrier on the server log line `reached
  nobody`, then one check that the root holds no envelope with `PERSON-LATE`. `run_person_message`'s
  brief check names the new sentence. The `SUITE` weight of `person-up` is updated from the run log.

#### 14. `e2e/mock-model.mjs` (Modify)

* **Type / Scope**: The scripted model.
* **Proposed Changes**: `relayPersonWords` is rewritten: the leaf (`CHILD-PERSON-WORDS`) waits
  for a `PERSON-SAYS` user message, then reports done; the middle (`CHILD-RELAYS-PERSON`) replies
  `RELAYER HEARD TYPED` on a `typed="outside"` envelope and sends the leaf nothing; the root
  replies `ROOT HEARD TYPED` and `ROOT GOT REPORT`. Every other root branch ignores a
  `typed="outside"` envelope, so the scenarios that prompt a child (`PERSON-ASKS`,
  `CHILD-ROLE-AGAIN`, the cleanup and stop prompts) keep their replies.

#### 15. `e2e/real-model-recursive.mjs` (Modify)

* **Type / Scope**: Real-model checker.
* **Proposed Changes**: The four finding checks read from the plugin's envelope at the root
  (`sendersOf` sees `from="courier"`, so a helper `typedAt(list, sessionID)` finds the first
  synthetic whose text starts with `<courier from="courier" typed="outside" in="<id>">`): the
  words reached the "count" session; the root received the envelope; the root passed the words to
  the other part without a status after it; that part passed them down. A note quotes every
  message to the "count" session after the envelope. The `recursive-conflict` scenario below.

#### 16. `test/real-model-recursive.test.ts` (Modify)

* **Type / Scope**: Checker tests on fixtures.
* **Proposed Changes**: Fixtures with the plugin's envelope at the root, and the conflict
  scenario's checks.

#### 17. `docs/reference.md` (Modify)

* **Type / Scope**: The behaviour reference.
* **Proposed Changes**: As in "What the prose says".

#### 18. `docs/maintainers/plugin-api-notes.md` (Modify)

* **Type / Scope**: Host facts.
* **Proposed Changes**: Under "The inbox and wakes": a prompt's `metadata` is copied into the
  inbox item's user payload (`SessionPrompt.prepare`), which is how courier tells its task prompt
  from other `user` items; a `user` item says nothing about its origin, and the list in the table
  above all arrive alike; `subagent` accepts an existing session whose `parentID` is the caller;
  `session.inbox.cancelled` is published for an item withdrawn before delivery. Each is a trap a
  pin bump re-checks.

#### 19. `docs/maintainers/architecture.md` (Modify)

* **Type / Scope**: Storage table.
* **Proposed Changes**: The row `typed/<sessionID>/<inboxID>`: `{ at, text }`, a `user` item
  typed into a spawned session, from its enqueue until its relay is sent or skipped.

#### 20. `docs/maintainers/real-model.md` (Modify)

* **Type / Scope**: Real-model scenarios and results.
* **Proposed Changes**: "A finding passed on" describes the envelope-based checks; a new section
  for `recursive-conflict`; the result rows of every scenario are replaced after the re-run.

#### 21. `README.md` (Modify)

* **Type / Scope**: The steering tip.
* **Proposed Changes**: One line, as in "What the prose says".

### The `recursive-conflict` scenario

`COURIER_SCENARIO=recursive-conflict`, in `e2e/real-model-recursive.mjs`: the recursive job of
`recursive-fault`, with its halves waiting on files as `recursive-finding`'s do. Once the half for
`numbers/b.txt` is running, the checker, as the person, prompts that half: "Do not write
numbers/b.txt. Print the number and report it to the session that started you; that file is
handled outside this job." This contradicts the half's task and what the session above expects to
merge. The checker then lets the halves go on.

The checks, after the recursive ones that still apply: the words reached the half; the plugin's
envelope naming the half reached its parent and the root; the half wrote no `numbers/b.txt` and
its report names the number; no session sent the half, after the envelope, a message matching
`/write .*b\.txt/i` or `/as your task says/i` (a countermand; every message to the half is quoted
in a note so a reader can judge a miss); no session wrote `numbers/b.txt` in its place; the root's
reply says the file was left unwritten on an instruction typed into that part, and the job is
reported `partial` or `done` with that said, not `failed`.

Arms: three commits on the implementation branch that differ only in the clause sentence of
`typedNotice`, candidates 1, 2 and 3 of the open question; the checker's summary records the
commit. Five runs per arm, about 35 requests each. The arm with the fewest countermands and
replacements across its runs is the wording; a tie goes to candidate 3, the shortest text. No
option or variable selects the arm, so nothing of the measurement ships.

### Verification Plan

* **Compilation/Build**: `bun run typecheck`, `bun run build`.
* **Unit Tests**: `bun test`, with `bun test --update-snapshots` once for `typedNotice` and the
  brief and skill snapshots; `test/imports.test.ts` and `test/links.test.ts` pass unchanged.
* **E2E/Integration**: the live suite in the sandbox, `person-up` and `person-message` in
  particular, and the shard weights updated. `e2e/real-model.sh` on every scenario in the owner's
  sandbox, since `childBrief` and the skill change: about 20 runs and 700 requests, in batches on
  the free tier or on a paid key; the rows in `real-model.md` are replaced. `recursive-conflict`
  in three arms, five runs each, before the clause wording is final.
* **Static Analysis**: SonarCloud in CI.

--------------------------------------------------------------------------------

*Drafted with EGM*
