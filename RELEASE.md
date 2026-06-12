# Releasing OrbCode CLI to npm

This document covers publishing the `orbcode` package — both the automated
path (release branches + GitHub Actions) and the manual fallback.

## What ships

`npm pack` includes only what `package.json#files` lists:

```
bin/orbcode.js     the executable stub (#!/usr/bin/env node → dist/index.js)
dist/              compiled output (built by prepublishOnly)
README.md          user-facing docs shown on npmjs.com
LICENSE            MIT license text
package.json
```

Source (`src/`), tests, and workflow files are not published.
`prepublishOnly` runs `typecheck + build`, so a publish can never ship a stale
or broken `dist/`. The CLI reads its version from `package.json` at runtime —
bumping the version is all that's needed; no source change required.

## One-time setup

1. **Create an npm Automation token** (npmjs.com → Access Tokens →
   *Automation*) with publish rights for `orbcode`, and save it as the
   `NPM_TOKEN` repository secret on GitHub (Settings → Secrets and variables →
   Actions).

2. If the GitHub repo is **private**, remove `--provenance` from
   `.github/workflows/release.yml` (provenance attestation requires a public
   repo and the `repository` field in package.json — already set to
   `MatterAIOrg/OrbCode`).

## Automated release (recommended)

Releases are gated on a `vX.Y.Z` tag on `main` — publishing requires the
release commit to be **merged into `main`** first, then an explicit tag push.
The workflow is `.github/workflows/release.yml`.

```bash
# 1. cut a release branch off main and bump the version
git checkout -b release/0.2.0
npm version 0.2.0 --no-git-tag-version
git commit -am "release: v0.2.0"

# 2. push, open a PR, get it reviewed and merged into main
git push -u origin release/0.2.0
gh pr create --base main --head release/0.2.0 --title "release: v0.2.0"

# 3. AFTER the PR is merged, tag the merge commit on main and push the tag
git checkout main && git pull
git tag v0.2.0           # tag the current HEAD (the merge commit)
git push origin v0.2.0   # ← this is what actually triggers the publish
```

The workflow then:

1. checks out the tagged commit, installs (`npm ci`), typechecks, and builds;
2. **verifies the tag (`vX.Y.Z`) matches `package.json#version`** — a mismatch
   fails the build instead of publishing a mismatched package;
3. checks npm — if `@matterailab/orbcode@<version>` **already exists, it skips publishing**
   (so re-tagging a published version is a safe no-op);
4. publishes to npm with provenance;
5. creates a **GitHub Release** with auto-generated notes pointed at the tag.

Tag pushes to any branch other than `main` are ignored, so a force-push to a
release branch can't publish anything on its own. `workflow_dispatch` is also
available as a manual fallback (it reads the version from `package.json` and
refuses to publish if the input doesn't match).

### Versioning convention

- **patch** (`0.1.x`) — fixes, small UI tweaks
- **minor** (`0.x.0`) — new commands, new flags, new settings keys
- **major** — breaking CLI or settings.json changes

## Manual release (fallback)

```bash
npm whoami || npm login
npm version patch        # or minor / major / explicit version
npm publish              # prepublishOnly runs typecheck + build
git push && git push --tags
```

`npm pack --dry-run` shows exactly what would be uploaded — worth a glance
before a first-time or unusual release.

## Pre-release checklist

- [ ] `npm run typecheck` and `npm run build` pass locally
- [ ] `node dist/index.js --help` / `--version` look right
- [ ] smoke-test the TUI: launch, send a message, `/model`, `/resume`
- [ ] README.md is current (it's the npm landing page)
- [ ] version bumped in package.json and not already on npm
      (`npm view @matterailab/orbcode versions`)

## After the release

Users install/update with:

```bash
npm install -g @matterailab/orbcode
orbcode --version
```

Local `npm link` development setups are unaffected by published releases —
the linked copy always runs the local `dist/`.
