---
name: builder:diff
description: Step 0 of builder — determine everything on HEAD that hasn't been published yet. Prefer the project's actual npm registry state over git tags, since a tag can exist without a matching publish (or vice versa); fall back to the last git tag when there's no resolvable package name or no network.
---

# builder:diff

Resolve what "already published" means for this project, then list every commit on `HEAD`
since that point.

## 1. Resolve the build target

Read `session-manager-operations/architecture/build-target.json` via
`resolveBuildTarget(cwd)` in `src/main/lib/buildTarget.cjs` (falls back to `package.json`'s
`name` if no explicit config exists). If `buildTarget.cjs` isn't present yet in this repo,
read `package.json`'s `name` field directly and note in the final report that the config
reader was missing — this does not block the pipeline.

## 2. Determine the last published point

Preferred: `npm view <packageName> version` — the actual registry state, not just a local
tag. This catches the case where a tag was pushed but the publish itself failed partway
(the tag would lie; the registry won't).

Fallback (no network, or `npm view` 404s because the package was never published): use the
last git tag instead — `git describe --tags --abbrev=0`.

## 3. Diff

```
git log <last-published-version-or-tag>..HEAD --oneline
```

If `npm view` returned a version not tagged locally, resolve its tag first (`git tag -l
'v<version>'`); if no matching local tag exists, fall back to comparing against
`git describe --tags --abbrev=0` and note the discrepancy in the report.

## Output

- The resolved package name and last-published version/tag (and which method resolved it —
  registry or git tag).
- The full commit list (subject lines) since that point.
- If the list is empty: stop here and report "nothing to publish" — do not proceed to
  `builder:classify-and-bump`.
