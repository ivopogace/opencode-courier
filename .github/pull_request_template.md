### Issue

Closes #

### Type of change

- [ ] Bug fix
- [ ] New feature or behaviour
- [ ] Refactor
- [ ] Documentation
- [ ] OpenCode pin bump or release

### What does this PR do?

What was wrong or missing, what you changed, and why it works. If you are not sure why it works,
say so. A large, clearly AI-generated description may get the PR closed.

### How did you verify it?

<!-- e.g., bun test, an e2e/run.sh scenario, e2e/tui.sh, a real-model run -->

### Screenshots / recordings

_For a change to the terminal part (tree panel, asks inbox, memory view)._

### Checklist

- [ ] `bun run typecheck` and `bun test` pass
- [ ] A behaviour change comes with unit tests and an `e2e/run.sh` scenario
- [ ] README.md and `docs/reference.md` are updated where behaviour changed
- [ ] A change to a model-facing string (`src/**/text.ts`, `src/kernel/protocol.ts`, `src/skill.ts`, a tool description) updates `test/__snapshots__/`
- [ ] No unrelated changes
