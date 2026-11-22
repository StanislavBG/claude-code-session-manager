# Validation: dev-plugin-readiness-checks-loaded-copy (PRD 3536)

Base: 81fda522 (used). Implementing commit: 5585461f (touches delegationReadiness.cjs, its test, plugins/CLAUDE.md, tests/helpers/delegationHome.cjs).

## dev-plugin-readiness-checks-loaded-copy — VERIFIED

1. No read under installPath; early ok:false kept: the old `skillFile` check under installPath is deleted (diff of delegationReadiness.cjs ~L365). enabled / record / marketplace-registered / folder-exists checks remain, in order, with unchanged details and fix.
2. Loaded copy resolved from manifest: `readDevPluginSourceDir` (delegationReadiness.cjs ~L328-341) finds the 'session-manager-dev' entry, `path.resolve(marketplacePath, source)`; ok only if `<dir>/skills/develop/SKILL.md` exists; success detail `... sessions load it from ${sourceDir}`.
3. Missing/malformed manifest, no entry or non-string source, or missing SKILL.md -> ok:false, detail names manifest/skill path, fix = DEV_PLUGIN_REINSTALL_FIX; `readJsonOrSync` with null fallback does not throw (malformed test passes).
4. id/label/shape unchanged; requires list (lines 19-28) has neither pluginInstall.cjs nor seedDevPlugin.cjs.
5. Tests (a)-(e) present in delegationReadiness.test.cjs: healthy+detail names loaded copy, loaded SKILL.md missing, cache SKILL.md deleted -> ok, malformed manifest no throw, manifest without entry (plus non-string source).
6. plugins/CLAUDE.md: one added line after the seedDevPlugin paragraph stating in-place loading, never the cache snapshots, plugin.json bump only refreshes shown version.

Gate re-run:
- `npx vitest run ...delegationReadiness.test.cjs ...delegationSelfHeal.test.cjs` -> 2 files, 75 tests passed.
- `npm run lint:docs` -> ok (22 junctions, 38 files linted).

## Findings

### Critical
none
### Important
none
### Minor
- tests/helpers/delegationHome.cjs (writeDevPluginInstall, ~L45-64) was changed but is not in the PRD's # Files list (the fixture lives there, not in the test file); the change is necessary and sound, but undeclared. Also added `DEV_PLUGIN_REINSTALL_FIX` to module.exports (delegationReadiness.cjs ~L896) for test use; unlisted but harmless.
- plugins/CLAUDE.md diff also reworded ~10 unrelated lines (trimmed PRD 3140 reference, dates, wording) beyond the "at most two lines" addition; no facts lost that matter, but unrequested churn.
- Code/security self-review (no /code-review tool output beyond reading diff): manifest `source` is resolved with path.resolve and only used for an fs.existsSync read check; no traversal write, no shell, no secrets. No issues.
