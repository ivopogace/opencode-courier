# Releasing

A release starts from GitHub and ends with a maintainer's 2FA approval on npm. No tag is made by
hand.

1. **Start a release:** Actions → Start a release → Run workflow, from `main`, or
   `gh workflow run release-start.yml -f version=patch`. `version` is `patch`, `minor`, `major` or
   an exact version such as `0.2.0-beta.1`. It bumps `package.json`, updates the version tables, and
   opens the pull request "Release X.Y.Z" from the branch `release-X.Y.Z`.
2. In that pull request, select **Approve workflows to run** in the merge box. Review it and
   squash-merge it.
3. **Tag the release** runs on the push to `main`. It tags the commit `vX.Y.Z` and dispatches
   **Release** on the tag.
4. **Release** runs CI, checks the tag against `package.json`, builds, and runs
   `npm stage publish` with a provenance attestation. A prerelease is staged for the `next`
   dist-tag. It then creates a **draft** GitHub release with generated notes.
5. Approve the staged version with 2FA: on npmjs.com under Staged Packages, or with
   `npm stage list` and `npm stage approve <id>`. The version is live from then.
6. Publish the draft: `gh release edit vX.Y.Z --draft=false`.

The flow needs **Allow GitHub Actions to create and approve pull requests** (Settings → Actions →
General → Workflow permissions). If a release pull request shows no checks and no approval banner,
close and reopen it.

## Dry runs

- Start a release with `dry_run` shows the bump and pushes nothing.
- `gh workflow run release-tag.yml --ref release-X.Y.Z` (dry run by default when run by hand) checks
  the version and tag, builds, and runs `npm stage publish --dry-run`.
- `gh workflow run release.yml --ref vX.Y.Z -f dry_run=true` packs the package and stages nothing.

## When a step fails

- **Tag the release failed:** tag the merge commit yourself, and the tag push runs Release:
  `git fetch origin && git tag -a vX.Y.Z -m vX.Y.Z origin/main && git push origin vX.Y.Z`.
- **Release did not start:** `gh workflow run release.yml --ref vX.Y.Z`.
- **Staging failed:** nothing reached npm. A re-run uses the workflow file at the tag, so after
  fixing `release.yml`, move the tag: `git push origin :refs/tags/vX.Y.Z`, then tag and push again.
  A change to a repository variable needs only a re-run.
- **E403 although "Check the npm token" passed:** the package's Publishing access on npmjs.com
  disallows tokens.
- **npm refuses the provenance attestation:** set the repository variable `NPM_PROVENANCE` to
  `false` and re-run.

To stage by hand (npm 11.15.0 or later, Node 22.14 or later):

```bash
git checkout vX.Y.Z
npm install && npm run build
npm login
npm stage publish --access public   # add --tag next for a prerelease
```

Approve it with 2FA, then `gh release create vX.Y.Z --verify-tag --generate-notes` (add
`--prerelease` for one). A version staged by hand has no provenance attestation.

Nothing moves `next` after a stable release. `npm dist-tag rm opencode-courier next` removes it.

## The npm token

The repository variable `NPM_AUTH` picks how Release authenticates: `token` (the default) or `oidc`.

With `token`, `NPM_TOKEN` is a secret of the `npm` environment (Settings → Environments → `npm`). It
is an npm granular access token (npmjs.com → Access Tokens → Granular Access Token) with:

- read and write on `opencode-courier` only;
- **Bypass two-factor authentication off**, so the token can stage but not publish;
- an expiry date. When it expires, the job stops at "Check the npm token"; replace the secret.

Limit the `npm` environment to the tag pattern `v*` (Deployment branches and tags), so no other
branch can read the secret. A tag ruleset on `v*` that restricts creation needs the GitHub Actions
app in its bypass list. A rule against deletion blocks moving a tag for anyone not in that list.

**Trusted publishing** (`oidc`) does not work for this repository yet: npm rejects GitHub's OIDC
subject claims for repositories created after 2026-07-15
([npm/cli#9969](https://github.com/npm/cli/issues/9969)). Once npm fixes that:

1. On npmjs.com, add a trusted publisher: this repository, workflow `release.yml`, environment
   `npm`, allowed to stage only.
2. Set `NPM_AUTH` to `oidc` and release. The job logs its OIDC claims, so a mismatch shows, and
   stages with `--loglevel verbose`. A failed exchange falls back to setup-node's placeholder token
   and fails with E401.
3. Then revoke the token and delete `NPM_TOKEN`. To go back, set `NPM_AUTH` to `token`.

## The plugin API pin

`@opencode/plugin` is pinned to one exact version, as peer and devDependency. `effect` is pinned to
the version that `@opencode/plugin` depends on. CI installs `@opencode/cli` at the same version.

`latest.yml` opens an issue, "OpenCode X.Y.Z is out", for each newer OpenCode release. To bump the
pin:

1. Move `@opencode/plugin`, `@opencode/cli` and `effect`. Move `@opentui/core`, `@opentui/solid`
   and `solid-js` to the versions in OpenCode's root `package.json` catalog at the new tag, and
   `@opencode/theme` to the pin.
2. Run both live suites.
3. Move the version README.md names: the Quickstart, the Install section's "tested on" line and
   install command, and the terminal part's line under the table.
4. Update the affected traps in [plugin-api-notes.md](plugin-api-notes.md).
5. Release a patch, so the published package names the new version and hosts on it stop logging
   the version line.

The version tables in README.md (newest three rows, `rows=3` in the marker) and
[reference.md](../reference.md#the-opencode-version) (every row) are generated from the release tags
by `bun script/compat-table.ts`. Start a release runs it. Never edit them by hand. CI checks them
with `bun script/compat-table.ts --check`, which needs `git fetch --tags`.
