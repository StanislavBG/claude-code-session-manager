---
name: builder
description: Release the current project's npm package — diff HEAD against the last published version, pick the semver bump from conventional-commit prefixes, run the project's gates, publish from an isolated git worktree (never the live working directory), keep a Field Manual in step when the project has one, then report. Use when the user says "/builder" or asks to publish, release, cut a release, bump the version, ship to npm, update the manual, or whether anything is unpublished.
---

# builder

Release pipeline for whatever npm package the current project publishes. Configuration comes
from `session-manager-operations/architecture/build-target.json` (`packageName`, `registry`,
`versionBumpPolicy`, `gates`). When that file is absent, use `package.json`'s `name`,
conventional-commit bumps and no declared gates, and say in the report which source you used.

The decision to release was made when this skill was invoked. Once a diff exists and the gates
pass, run straight through to publish without asking again. Stop only where a step below says
stop.

## 1. Diff — what is unpublished

1. Last published point: `npm view <packageName> version` (the registry, not a local tag — a
   tag can exist for a publish that failed). No network, or a 404 because the package was never
   published: `git describe --tags --abbrev=0`.
2. Resolve that version's tag (`git tag -l 'v<version>'`). If no local tag matches, compare
   against `git describe --tags --abbrev=0` and note the discrepancy in the report.
3. `git log <tag>..HEAD --oneline`. Empty → stop and report "nothing to publish".

## 2. Classify and bump

Take the highest bump the whole commit list implies:

- `BREAKING CHANGE:` in a body, or `!:` after the type/scope (`feat(api)!:`) → **major**.
- Any `feat:` / `feat(scope):` → **minor**.
- Any `fix:` / `fix(scope):` → **patch**.
- Only `chore:`, `docs:`, `refactor:`, `test:`, `ci:` and the like → **patch** (a release was
  requested; these still ship in it).

If a meaningful share of commits has no `type:` prefix at all (a bare "wip", "updates"), do not
guess: list the unclassifiable commits and ask which bump to apply. A wrong semver bump is hard
to walk back once published.

## 3. Gate

Run each name in `build-target.json`'s `gates` as `timeout 300 npm run <gate>`, in order,
against `HEAD`, with no `--skip` flags. With no `gates` entry, run the pre-commit checks the
project's `CLAUDE.md` or README requires; with none documented, say so in the report. Any
failure → stop: report the command and its real output, and that no bump, tag or publish
happened.

## 4. Publish from an isolated worktree

A dirty main working tree does not block this: the build and publish run in a clean worktree
checked out at the release tag, so nothing uncommitted in the main tree reaches the artifact.
Run in this order:

1. `npm version <bump> --no-git-tag-version` — updates `package.json` / `package-lock.json`
   without a tag, so the tag below carries the release commit.
2. `git add package.json package-lock.json` — only these two, never `-A`.
3. Commit, listing the release's commits:
   ```
   git commit -m "chore(release): bump to v<version>

   - <commit subject>
   - ..."
   ```
4. `git tag v<version>`
5. `mkdir -p "$HOME/.cache/sm-publish" && git worktree add "$HOME/.cache/sm-publish/v<version>" v<version>`
   — never under `/tmp` or `os.tmpdir()`: some test suites (this repo's included) treat those
   paths as fixtures and fail there.
6. In the worktree: `npm ci`, then the gates again (step 3), then the project's build. Check
   every `files` entry in `package.json` exists before publishing; stop on any failure.
7. `npm publish` from inside the worktree, so `prepublishOnly` builds there too.
   A 403 saying two-factor authentication or a bypass-2FA granular token is required is not a
   login problem (`npm whoami` can succeed). Don't retry `npm login` or `npm publish`: run
   `npm profile get` and `npm token list`, stop, and report the exact 403 and both results so a
   human can supply an OTP or a token (the CLI cannot mint a granular token). An E409 "staged"
   response means the publish waits for a human to approve it on npmjs.com — report that.
8. Back in the main repo: `git push origin main` and `git push origin v<version>`.
9. `git worktree remove "$HOME/.cache/sm-publish/v<version>" --force`
10. Verify the registry. `npm view` lags for minutes, so read a cache-busted packument and the
    tarball first:
    ```
    curl -s "https://registry.npmjs.org/<packageName>?t=$(date +%s)"
    curl -sI <versions["<version>"].dist.tarball>
    npm view <packageName> version dist-tags
    ```
    `dist-tags.latest` is `<version>`, the version is listed, the tarball returns 200. A stale
    `npm view` with a current packument is lag, not failure — never republish.
11. If `.github/workflows/release.yml` exists, the tag push started it. Wait on that run with a
    bounded blocking watcher, then read the assets once:
    ```
    timeout 1200 gh run watch "$(gh run list --workflow release.yml --branch v<version> --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
    gh release view v<version> --json assets --jq '.assets[].name'
    ```
    Report the installer assets found (here: `.dmg`, `.exe`, `.AppImage`) and any missing. If
    no run is listed yet, say so instead of polling.

On any failing step: stop there and report the step and its output. Once the worktree exists,
leave it only when its state is evidence for the failure; otherwise remove it (step 9) so a
retry doesn't collide with a stale path.

## 5. Manual (only when `session-manager-operations/manual/manual.json` exists)

Follow [`manual.md`](manual.md). The npm publish has already landed; a manual failure never
undoes it.

## 6. Report

One plain-text report, whether the pipeline finished or stopped:

- **Version** previous → new, and the bump kind.
- **Commits covered**, grouped by the rule that classified each.
- **Gates** and their results.
- **Registry**: packument `dist-tags` / version and tarball status.
- **Git**: both pushes confirmed, worktree removed.
- **Installer release**: assets found and missing, or "no release workflow".
- **Manual**: `manual.md`'s report, "no content change", or "no manual".
- **Stopped early?** Which step, why, its output, and anything a retry must account for
  (a leftover worktree or local tag).
