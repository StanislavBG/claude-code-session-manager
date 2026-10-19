# Validation: stale-build / dep-links plan

Base: 664325f8. Commits: d6061486 (2053), c074a03f (2054), 759104e6 (2055). PRD files found in `prds-archived/`.
Gates re-run (scratch TMPDIR): `npx vitest run` on health-build-freshness, depHealth, health-main-dep-links → 3 files / 24 tests passed; `npm run typecheck` → clean.
Review: /code-review and /security-review not run as skills; self-reviewed the combined diff (5 files, +289/-10).

## health-stale-build-safety-commits — VERIFIED
- `WORKTREE_SAFETY_PATHS` (4 paths) defined and exported: src/main/health.cjs:658-663, module.exports.
- `evaluateBuildFreshness` accepts `safetyCommitsMissing` (default []), returns it, builds `safetyIssue` (running sha, count, ≤3 shas+subjects, "publish a new release and restart Session Manager"); `ok: true`: health.cjs:665-686.
- Section 6.7 runs `git -C PROJECT_ROOT log --format=%h%x09%s <running>..HEAD -- paths` via execFileSync, timeout 5000, try/catch → []: health.cjs ~1336-1349.
- `safetyIssue` pushed to `status.issues`: health.cjs ~1356.
- Tests: empty/omitted, two commits (ok true), five → three listed, plus path-constant test.

## dephealth-worktree-escaping-links — VERIFIED
- `findWorktreeEscapingLinks(mainCwd,{worktreeRoots})` exported; scans node_modules/* and @scope/* one level, skips dot entries, cap 2000, MAX_MISSING cap, outer try/catch: depHealth.cjs:~40-92.
- Default roots lazy via schedulerPaths job/epic in try/catch → []: depHealth.cjs:31-38.
- `checkMainDependencyHealth(mainCwd, opts)` runs it after .modules.yaml check; `links-into-worktree` then `dangling-links`; rest unchanged: depHealth.cjs:~109-111. Header updated.
- Tests with real symlinks: into-worktree, scoped `@s/x`, dangling, sibling-in-repo ok.

## health-main-dep-links-component — VERIFIED
- `evaluateMainDepLinks` pure, exported; one issue per links-into-worktree/dangling-links with cwd, reason, ≤5 entries, `CI=1 pnpm install --offline --frozen-lockfile`: health.cjs:~688-710.
- Section 6.75 after build section: distinct job cwds, cap 50, existsSync, try/catch, skipped when queueState null, not in criticalComponents: health.cjs ~1362-1376.
- Tests (health-main-dep-links.test.cjs): empty, ok+broken, not-pnpm/unresolved-deps, ok always true.
- Not exercised against a live queue (pure evaluator only) — as the author disclosed.

## Findings
### Critical
- none
### Important
- none
### Minor
- src/main/health.cjs ~1340: `${running}..HEAD` is passed to git log without `--end-of-options`/rev validation; `running` comes from the local heartbeat file (trusted-ish), but a value beginning with `--` would be parsed as an option. Suggest validating `/^[0-9a-f]{4,40}$/`.
- src/main/lib/git/depHealth.cjs:~62: `check()` treats any realpath failure (e.g. EACCES, ELOOP) as "dangling"; acceptable, but could misreport.
- src/main/lib/git/depHealth.cjs: header says "lstat" in PRD; implementation uses `isSymbolicLink()` from Dirent + realpath — equivalent.
