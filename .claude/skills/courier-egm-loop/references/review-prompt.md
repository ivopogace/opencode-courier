# Review-session prompt template

Fill every bracket.

```text
Run round <K> of the EGM review of the plugin's built-in skill, `courier-orchestrate`, as it is
on `origin/main` at <sha>. Branch from `origin/main` explicitly: other sessions share the
checkout.

## Scope
- The text under review: `SKILL_DESCRIPTION` and `SKILL_CONTENT` in `src/skill.ts`, read with
  the texts it relies on: the brief and role lines (`childBrief`, `rolePart` in
  `src/tree/text.ts`), the split-line forms (`src/kernel/protocol.ts`), the tool descriptions
  (`src/*/tools.ts`) and the notices and refusals a model gets at the moment of use
  (`src/**/text.ts`). `docs/reference.md` ("The courier-orchestrate skill") states what the
  skill is meant to add.
- Baseline: <round 1: none | the previous round's draft PR #<P>, branch <branch>, folder
  `egm-review-<K-1>/`; read it with `git fetch` and `git show`, never merge it>.
- Fixed since the baseline: <issues and the PRs that fixed them, one line each>.
- Declined, not to raise again: <the roster's declined list, finding and reason, one line each>.
- Known and out of scope: <open issues the review should not report>.

## What to produce
1. For each finding of the baseline: resolved (by which PR), still open, or no longer
   applicable.
2. New findings on the current text, each checked against the code before it is reported: a
   claim the code contradicts; a rule stated twice in conflicting ways; a rule a model needs at a
   moment where no text it reads carries it. A rule another text already carries at the moment
   of use is not a finding: the skill keeps only what no other text says.
3. The egm comprehension, codebase-details and zoom-out reviewer agents, plus any you judge
   useful; one synthesis pass.

## Delivery
- Reports in `egm-review-<K>/` on your branch, and a draft PR with them titled "EGM round <K>
  of courier-orchestrate" (local `gh`).
- Final message: per confirmed finding, a severity (blocking, major, minor), the file:line
  evidence, and a proposed issue (title, body, suggested placement). Say "no findings" if none
  holds. File nothing and change no product code: the orchestrator files and fixes.
- Never run `e2e/real-model.sh` or opencode against a real model.
```
