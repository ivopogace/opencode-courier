# Child-session prompt template

Fill every bracket. CLAUDE.md carries the repo's commands and rules, so the prompt only adds what
is specific to this issue and this wave.

```text
Implement issue #<N> of ivopogace/opencode-courier: "<issue title>" (<issue url>). Read the issue
first; its "Done when" is your acceptance bar.

## Context (from the orchestrator, session <orchestrator session id>)
- main is at <sha>: <what is merged that this issue builds on>.
- <What the owner already decided for this issue, verbatim.>
- <Design freedom: which open questions the child decides and records in the PR body and
  README, and which go back as NEEDS USER DECISION (how the owner runs or exposes it, money,
  publishing, secrets).>
- <Issues that will build on this one, and what they need from it (entry shapes, exported
  helpers).>
- Siblings in flight: <#M: one-line scope, for each>. Expect conflicts in <shared files, down to
  the part each edits>. Resolve them by `git fetch origin main` and merging origin/main, keeping
  both sides; never rebase or force-push.

## How to work
- Follow CLAUDE.md: read README.md, docs/reference.md and docs/plugin-api-notes.md first, read the pinned
  plugin API's types instead of guessing, and run typecheck, unit tests, build and the live e2e
  test before every push. Add an e2e scenario for the new behaviour.
- Work on branch <issue-N-slug> in small, well-described commits. Open a PR to main whose body
  says what changed, the decisions you made, how it was tested, and `Closes #<N>`. Never push to
  main and never merge.
- Get CI green on the PR head. Then review the PR with the code review plugin: the
  `code-review:code-review` skill with the PR number, not the built-in `code-review` skill. It
  posts its findings on the PR as a `### Code review` comment, and posts nothing when no finding
  reaches its confidence bar. Where it says `gh`, use the GitHub MCP tools instead (gh's GraphQL
  is blocked in cloud sessions). Fix what it finds, re-run the checks and push. A behaviour change
  after that round gets another round; tell the plugin its earlier comment covers an older head,
  or it skips the PR as already reviewed.
- Update README.md in the same PR.

## Talking to the orchestrator
End a turn that needs the orchestrator with one of these blocks, and also send the same block
with `send_message` to session `@parent`:
- `READY TO MERGE`: PR number, head sha, CI result on that sha, the review round (the sha it
  reviewed, and its comment's link or "no findings posted") and what it changed.
- `NEEDS USER DECISION`: the question, 2–4 options with trade-offs, and your recommendation.
  Don't use AskUserQuestion.
- `BLOCKED`: exactly what is wrong and what you need.
After the orchestrator merges your PR it will tell you; then you are done.
```
