# Releasing

A release starts from GitHub and ends with a maintainer's 2FA approval on npm; no tag needs
creating or pushing by hand. Three workflows under `.github/workflows/` take turns:

1. **Start a release** (Actions → Start a release → Run workflow, from `main`, or
   `gh workflow run release-start.yml -f version=patch`). `version` is `patch`, `minor`, `major`
   or an exact version such as `0.2.0-beta.1`. The workflow bumps `version` in `package.json`,
   checks that the current version is tagged, that the new one is higher and that neither a
   `vX.Y.Z` tag, a `release-X.Y.Z` branch nor npm has it, then pushes the branch `release-X.Y.Z`
   and opens the pull request "Release X.Y.Z".
2. GitHub holds the checks of a pull request that GitHub Actions opened: select **Approve
   workflows to run** in its merge box, review it, and squash-merge it like any other pull
   request (`main` takes nothing else).
3. **Tag the release** runs on every push to `main` that touches `package.json`. When the version
   there has no tag yet, it tags the commit `vX.Y.Z` and dispatches **Release** on that tag. A
   version whose tag exists is left alone.
4. **Release** (`release.yml`), on the tag, runs the CI workflow, checks that the tag matches the
   `version` in `package.json`, builds, and runs `npm stage publish` from the `npm` environment,
   authenticated as the repository variable `NPM_AUTH` says: with the `NPM_TOKEN` secret
   (`token`, the default) or through npm trusted publishing (`oidc`), both below. It adds a
   provenance attestation, which links the package to the workflow run that built it, unless
   `NPM_PROVENANCE` turns it off. A prerelease (`0.2.0-beta.1`) is staged for the `next`
   dist-tag.
5. It then creates a **draft** GitHub release with generated notes (marked as a prerelease for
   one), so nothing is announced yet.
6. A maintainer reviews the staged version and approves it with 2FA: on npmjs.com under Staged
   Packages, or with `npm stage list` and `npm stage approve <id>`. The version is live from then.
7. Publish the draft release: `gh release edit vX.Y.Z --draft=false`, or Publish release on
   GitHub.

The tag is dispatched rather than pushed into `on: push: tags` because GitHub starts no workflow for
an event made with the workflow's `GITHUB_TOKEN`, `workflow_dispatch` excepted. The dispatch names
the tag as its ref, so `GITHUB_REF` is the tag, which the `npm` environment's `v*` rule and Release's
tag check look at. A tag pushed by hand still triggers Release.

**Dry runs.** Start a release with `dry_run` computes the bump and shows the diff, pushing nothing.
Tag the release with `dry_run` (the default when run by hand; it runs on any branch) checks the
version and the tag, builds and runs `npm stage publish --dry-run`, which also refuses a version npm
already has: `gh workflow run release-tag.yml --ref release-X.Y.Z` rehearses a release. Release takes
a `dry_run` on a tag cut with this flow (v0.1.2 onward), `gh workflow run release.yml --ref vX.Y.Z
-f dry_run=true`: the environment admits the tag, the token is checked in token mode (a missing one
is a warning there), the package is packed and nothing is staged or released.

The flow needs the repository setting **Allow GitHub Actions to create and approve pull requests**
(Settings → Actions → General → Workflow permissions); without it Start a release stops at opening
the pull request. Should a release pull request show neither checks nor the approval banner, close
and reopen it: that is an event a person made, and CI runs on it.

**By hand**, should a step fail. The bump is an ordinary pull request that changes `version` in
`package.json`. If Tag the release failed on it, tag the merge commit yourself and the tag push runs
Release:

```bash
git fetch origin && git tag -a vX.Y.Z -m vX.Y.Z origin/main && git push origin vX.Y.Z
```

If the tag exists but Release did not start: `gh workflow run release.yml --ref vX.Y.Z`. If staging
fails, nothing reached npm and the version is still free. Re-running the job reuses the workflow
file at the tag, so after fixing `release.yml` move the tag to the fixed commit instead:
`git push origin :refs/tags/vX.Y.Z`, then tag and push again (or re-run Tag the release on
`main` with `dry_run` off). Repository variables are set under Settings → Secrets and variables →
Actions → Variables, and a re-run of the job picks a change up without moving the tag.

**The token** (`NPM_AUTH` unset or `token`). `NPM_TOKEN` is a secret of the `npm` environment
(repository Settings → Environments → `npm` → Environment secrets). It holds an npm granular
access token, made on npmjs.com under Access Tokens → Generate New Token → Granular Access Token,
with:

- Packages and scopes: Read and write, for `opencode-courier` only;
- **Bypass two-factor authentication left off.** Such a token can stage a version but not publish
  one, so nothing goes live without a maintainer's 2FA approval, even if the token leaks;
- an expiry date. When it has expired or been revoked, the job stops at "Check the npm token", and
  a new token replaces the secret.

Limit the `npm` environment to version tags (Deployment branches and tags → Selected branches and
tags → the tag pattern `v*`), or a workflow on any branch that names the environment can read the
secret. A tag ruleset on `v*` closes the remaining gap: a rule that restricts creation needs the
GitHub Actions app in its bypass list, since Tag the release creates the tags with the workflow's
token, and a rule against deletion blocks the move-the-tag recovery above for anyone not in that list.

If "Check the npm token" passes but staging fails with E403, look at the package's Publishing
access on npmjs.com (the package's Settings): the option that disallows tokens refuses this one too.

The job stages with `--provenance`, signed through GitHub's OIDC token and Sigstore. Should npm
refuse the attestation, set the repository variable `NPM_PROVENANCE` to `false` and re-run the job,
which then stages without one; any value other than `true` or `false` (in any case) stops the job.

**Trusted publishing** (`NPM_AUTH` set to `oidc`) needs no stored token, but does not work for this
repository yet: npm rejects the immutable OIDC subject claims GitHub issues for repositories
created after 2026-07-15 ([npm/cli#9969](https://github.com/npm/cli/issues/9969)), with `OIDC token
exchange error - package not found`. Once npm fixes that:

1. On npmjs.com, give the package a trusted publisher: this repository, workflow `release.yml`,
   environment `npm`, allowed to stage only.
2. Set the repository variable `NPM_AUTH` to `oidc` and release. The job then passes no
   `NPM_TOKEN`, so a failed exchange falls back to the placeholder token setup-node configures and
   fails with E401. Before staging it logs its OIDC token's claims (repository, workflow,
   environment, ref), so a mismatch with the trusted publisher shows, and it stages with
   `--loglevel verbose`, where npm reports a failed exchange. Trusted publishing adds the provenance
   attestation itself.
3. Once a release has been staged that way, revoke the token on npmjs.com and delete the
   `NPM_TOKEN` secret. To go back, set `NPM_AUTH` to `token` or delete the variable.

To stage by hand instead (npm 11.15.0 or later, Node 22.14 or later):

```bash
git checkout vX.Y.Z
npm install && npm run build
npm login
npm stage publish --access public   # add --tag next for a prerelease
```

Approve the staged version with 2FA as above, then create the release:
`gh release create vX.Y.Z --verify-tag --generate-notes` (add `--prerelease` for a prerelease). A
version staged by hand has no provenance attestation.

Nothing moves `next` after a stable release, so it can point at an older version than `latest`;
`npm dist-tag rm opencode-courier next` removes the tag until the next prerelease sets it again.

CI also checks the package as published: `publint` for `package.json` and `exports`, and
`@arethetypeswrong/cli` for the type declarations.

## The plugin API pin

The plugin API is pinned to an exact version in `package.json`, as devDependency and as peer
dependency, and CI installs the OpenCode CLI at that version; so is `effect`, equal to the one that
plugin API version depends on (a unit test checks both).

`latest.yml` runs the live suites on each new OpenCode release nightly and opens one issue,
"OpenCode X.Y.Z is out", saying whether they passed. The pin bump closes it: move the plugin API,
the CLI and `effect`, re-run both test suites, move the version the README names in its Quickstart,
its OpenCode V2 native section, its install command and the line under the Supported OpenCode
version table, and update the affected traps in [plugin-api-notes.md](plugin-api-notes.md). Then
release a patch, so that the published package names the new version and a host on it no longer logs
the version line.

The Supported OpenCode version tables are generated from the release tags by
`bun script/compat-table.ts`: each `vX.Y.Z` tag's `package.json` names its pin, consecutive releases
on one pin share a row, and prereleases are left out. The README holds the newest three rows (the
`rows=3` in its start marker) and links to the full table in
[reference.md](../reference.md#the-opencode-version). Start a release runs it, so the new version
joins its pin's row, or opens a row when the pin moved; neither a pin bump nor anyone else edits
the tables. CI's unit job checks both with `bun script/compat-table.ts --check`, which needs the tags
(`git fetch --tags`).
