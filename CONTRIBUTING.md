# Contributing

Thanks for helping with opencode-courier. Questions and ideas go to
[Discussions](https://github.com/ivopogace/opencode-courier/discussions), bugs and feature requests
to [issues](https://github.com/ivopogace/opencode-courier/issues/new/choose). For a larger change,
open an issue first so we can agree on the shape before you write it.

## Before you start

- [README.md](README.md) and [docs/reference.md](docs/reference.md) describe what the plugin does;
  a change in behaviour updates them.
- [docs/maintainers/development.md](docs/maintainers/development.md) has the commands, the live
  suites and CI.
- [docs/maintainers/architecture.md](docs/maintainers/architecture.md) has the layout and the import
  rules, which a unit test checks.
- [docs/maintainers/plugin-api-notes.md](docs/maintainers/plugin-api-notes.md) lists the OpenCode
  plugin API's traps. Read it before changing the plugin.
- [CLAUDE.md](CLAUDE.md) holds the project's rules in one place, for people and coding agents alike.

## A pull request

- Put `Closes #N` in the body and fill in the template.
- The unit job's checks pass locally: `bun run typecheck`, `bun test`, `bun run build`, and
  `bun script/compat-table.ts --check` after `git fetch --tags`.
- A behaviour change comes with unit tests and a live scenario: in `e2e/run.sh`, which runs against
  a real OpenCode server with a scripted model and needs no API key, or in `e2e/tui.sh` for the
  terminal part. It also updates README.md and `docs/reference.md`.
- A change to a string the model sees (`src/**/text.ts`, `src/kernel/protocol.ts`, `src/skill.ts`, a
  tool description) shows up in `test/__snapshots__/`; update it with `bun test --update-snapshots`
  and check the diff. Say so in the PR: such a change also needs a run against a real model
  (`e2e/real-model.sh`), which a maintainer does if you have no API key.
- The plugin API is pinned to an exact OpenCode version, and no experimental OpenCode API is used.
- Keep the change to what the issue needs. Code comments only where the code cannot say it itself.
- Describe what was wrong, what you changed and why it works, in your own words. A large, clearly
  AI-generated description may get the PR closed.

CI runs the unit tests and the live suites; a PR that changes only documentation skips the live
suites. The SonarCloud scan runs only on branches of this repository, so a fork's PR has none until
it is merged. Pull requests from outside contributors also get an automated review by Claude Code,
which reads the diff and runs none of its code. A maintainer reviews and merges.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
