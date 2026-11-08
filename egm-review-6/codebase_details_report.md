# Codebase-details report, round 4

**Reviewer:** `egm:egm-codebase-details`. **Read:** `CLAUDE.md`, the round-3 report, the diff 2dacfe4..98c64cf, `src/skill.ts`, `src/tree/{text,limits,report,events,send,group,stop,wake,forget,cleanup}.ts`, the matching lines of `src/tree/tools.ts`, every `metadata: { source: "courier" ... }` site in `src/`, `docs/reference.md:145-434`, `:520-530`, `docs/maintainers/plugin-api-notes.md:60-160`. Line numbers on 98c64cf. Nothing was run.

## 1. Baseline status

| Item | Status | Evidence |
| --- | --- | --- |
| R3-F1 | Resolved by #529 | `src/tree/text.ts:388` (`HOLDS_GROUP` `:375`). True: a `blocked` report puts the member back out (`src/tree/send.ts:47`, `unholdForBlocked` `src/tree/group.ts:92-98`); an idle stop settles nothing (`src/tree/stop.ts:160-169`). Reference `docs/reference.md:524-527`. |
| R3-F2 | Resolved in code by #531 | `live` returns `"blocked"` (`src/tree/limits.ts:23`, `src/tree/report.ts:35`); `check` counts the session but not its ancestors (`src/tree/limits.ts:47-55`); refusals `src/tree/text.ts:177`; reference `docs/reference.md:162-163`. The refusals' remedy was not changed to match: K-1. |
| R3-F3 | Resolved by #531 | `src/tree/text.ts:180` matches `owes` (`src/tree/report.ts:28-34`). |
| R3-F4 | Resolved by #531 | `src/tree/text.ts:190`, `docs/reference.md:152-154`. |
| R3-F5 | Resolved by #530 | `docs/reference.md:397-398`. |

## 2. Findings

### K-1 (minor): the limit refusals count a blocked child, but their only remedy is to wait for a report it will not send until the caller answers

- `childrenRefusal` (`src/tree/text.ts:183`): "... are running, blocked or still owe a report ... Do this part yourself, or end your turn and start it once one of them has reported, not in a loop." `totalRefusal` with `yours > 0` (`:190`): "end your turn and try again once one of the sessions you started has reported". `docs/reference.md:150-151` says the same.
- An idle blocked child counts in `mine` (`src/tree/limits.ts:51-52`, `:59-60`). It runs again only when its parent answers (`notePrompt`, `src/tree/events.ts:126`); its blocked report was already delivered.
- Scenario: `maxChildren` 2, rolling mode. A and B both send `blocked`. The root starts part C before answering, as "start the next as each report frees a slot" (`src/skill.ts:27`) suggests; refused; it ends its turn as told; nothing wakes it.
- Placement: `src/tree/text.ts:183`, `:190` and `docs/reference.md:150-151`: "(answer a blocked one first: it reports only after your answer)"; or `src/skill.ts:27`, "a blocked report frees no slot".

## 3. Checked and dropped

- **A blocked session whose turn still runs** reads as running (`inTurn` needs `reportedAt`, which `blocked` never sets), so `"live"`; once idle, `"blocked"`; a new message makes it owe again. Consistent.
- **"A session also counts while one it started is live" when the one below is only blocked:** the code does not count the session above; needs a session that reported before answering its child, against its brief; a model would only overestimate the count.
- **"Unless it failed or was interrupted"** matches `owes` / `ended`.
- **`maxTotal` from the top:** blocked entries counted anywhere in the tree, no ancestors added; matches the reference.
- **`liveBelow` leaving out blocked sessions** (`src/tree/limits.ts:74`): used only by `failureNotice`'s `belowLine`, where including them would be false. Residue (a failed sub-orchestrator's blocked child holds a `maxTotal` slot until cleanup) is low-stakes; section 5 already says to clean up.
- **`totalRefusal` `yours === 0`, "only reports already held for a group can still wake you":** an own blocked child makes `yours > 0`; a stalled inbox item, the person, or a `courier_later` could still wake it, but none is a report and "do this part yourself" stays right.
- **`kindOf` / `ownAfterReport` (`src/tree/events.ts:87-103`):** exactly `{source, from}` comes only from `courier_send` without a status (`src/tree/send.ts:42`); every other courier synthetic has a third key or no `from` (`src/person/events.ts:27,46`, `src/person/form.ts:37,62`, `src/person/permission.ts:113`, `src/person/question/answer.ts:26,158`, `src/tree/events.ts:61,183`, `src/tree/stop.ts:178`, `src/tree/group.ts:149`, `src/scheduling/later.ts:108`, `src/tree/nudge.ts:49`, `src/tree/wake.ts:125`). A downward message with a dropped status fails `indexedParent(from) === sessionID`; so does a sibling's. A legacy child without `reports: "status"` is exempt though its message counts as its report: legacy only.
- **Relay below the root after #530:** the brief still tells a reported sub-orchestrator to forward its child's message (`src/tree/text.ts:23-28`), as does skill section 3 (`src/skill.ts:40-44`); the reminder it no longer gets asked for a report, not a relay.
- **`HOLDS_GROUP` for an owing target:** true unless a held member was messaged before the release, then went silent and was stopped; worst outcome an unneeded cleanup.
- **`stopText`'s `IDLE_STOPPED`** names only the owing case; nothing false; close to the accepted limits item.
