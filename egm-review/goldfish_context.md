# Goldfish context for the EGM review of the courier-orchestrate skill

## What the target is

`/home/user/opencode-courier/egm-review/courier-orchestrate.SKILL.md` is the exact text that a model
session loads at run time when it loads the `courier-orchestrate` skill of the opencode-courier plugin
(lines 1-4 are the skill's front matter: its name and the description the model sees in its skill
list before loading it). It is generated from `/home/user/opencode-courier/src/skill.ts`, the
maintained source; `/home/user/opencode-courier/egm-review/line_map.tsv` maps each rendered line to
its line in `src/skill.ts`. Review the rendered file and cite its line numbers.

The document is not a design document. It is an operating procedure: instructions a model follows
while it uses a set of tools. So the "implementer" and the "competent engineer unfamiliar with the
codebase" of the standards is a fresh model session that has this text, the tools' own descriptions
and schemas, and its own task, and nothing else of this project. The question every standard reduces
to here is: can that session act correctly, at the right time, using only this text and the tool
descriptions, without guessing? Template headings of the standards (Goals, Non-Goals, Alternatives,
file-change lists, test plans) do not apply as headings. Apply each standard's core principle and
rules, not its section template.

## Who reads it, and when

- A session in OpenCode (an AI coding agent host) that has opencode-courier's tools: `courier_spawn`,
  `courier_send`, `courier_answer`, `courier_stop`, `courier_cleanup`, `courier_children`,
  `courier_tree`, `courier_later`, `courier_cancel`, `courier_recall`, `courier_note` and others.
- Either the root session, started by the person, or a child session another session spawned. A child
  gets a "brief" (a role instruction) from the plugin at spawn time; the root gets a role line in its
  system prompt instead. The text of both is in `/home/user/opencode-courier/src/tree/text.ts` and
  `/home/user/opencode-courier/src/tree/context.ts`.
- The skill is loaded into the model's context, so every line costs tokens on every later request of
  that session. Length has a price; so does an omission that makes a session act wrongly.

## Project facts a reviewer should challenge, not assume

- The maintainers' stated scope (in `/home/user/opencode-courier/CLAUDE.md`): the skill is "the
  tools' mechanics; planning and reviewing the parts is left to the person's own skills".
- The maintainers say the skill repeats the brief's split rule on purpose, because the root session
  has no brief. Treat this as a claim to test, not a settled fact.
- `docs/reference.md` is meant to state each behaviour once, in long form. The skill should agree
  with it and with the code; where they differ, the code is the truth.

## Reading list (all absolute paths)

Primary:
- `/home/user/opencode-courier/egm-review/courier-orchestrate.SKILL.md` (the target)
- `/home/user/opencode-courier/src/skill.ts` (its source)
- `/home/user/opencode-courier/test/__snapshots__/notices.test.ts.snap` (a snapshot of every tool's
  description and input schema, every model-facing notice, and the skill: what the model sees)
- `/home/user/opencode-courier/docs/reference.md` (the long form of every behaviour)

Behaviour and strings in code:
- `/home/user/opencode-courier/src/kernel/protocol.ts` (statuses, the split line, envelopes)
- `/home/user/opencode-courier/src/tree/text.ts`, `/home/user/opencode-courier/src/tree/context.ts`
  (briefs, role line, notices of reports, failed turns, silent ends)
- `/home/user/opencode-courier/src/tree/tools.ts`, `/home/user/opencode-courier/src/person/tools.ts`,
  `/home/user/opencode-courier/src/scheduling/tools.ts`, `/home/user/opencode-courier/src/memory/tools.ts`
  (the tools' schemas and descriptions)
- `/home/user/opencode-courier/src/person/text.ts`, `/home/user/opencode-courier/src/scheduling/text.ts`,
  `/home/user/opencode-courier/src/memory/text.ts`

Orientation:
- `/home/user/opencode-courier/README.md`, `/home/user/opencode-courier/CLAUDE.md`,
  `/home/user/opencode-courier/docs/maintainers/architecture.md`

Reviewers may search the rest of `/home/user/opencode-courier/src` and `/home/user/opencode-courier/docs`
with Grep and Glob. Do not read `/home/user/opencode-courier/egm-review/*_report.md` unless the task
names one.
