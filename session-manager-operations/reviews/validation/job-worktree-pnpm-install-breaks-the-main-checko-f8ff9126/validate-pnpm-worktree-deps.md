# Validation: pnpm worktree-local node_modules plan

Base: cf5b9a824d41bda817c4b926f1c642502af59477. Commits: 111355ed (2016), f2e078e5 (2017), 6832149f (2018), 098f3829 (2019). PRD files found under `prds-archived/`.
Gates re-run (scratch TMPDIR, foreground): worktreeDeps 6/6, depHealth 8/8, prdAuthoringSeed 4/4, scheduler-gate-shadow 25/25 (24 existing + 1 new), `npm run typecheck` exit 0. pnpm is installed, so the skipIf pnpm tests ran.
`/code-review` and `/security-review` were not run as separate tools; I self-reviewed the combined diff (9 files, +337/-14).

## 2016 pnpm-worktree-local-node-modules — VERIFIED
- `isPnpmProject` checks pnpm-lock.yaml or node_modules/.modules.yaml, in try/catch: worktreeDeps.cjs:46-51.
- Pnpm branch never symlinks; `execFile` (no shell), CI=1, 180 s timeout, offline/frozen/confirmModulesPurge=false; `installed` vs `skipped`: worktreeDeps.cjs:54-67, 101-105. `.venv`/`venv` still symlink.
- Return shape `{ linked, skipped, installed }`: worktreeDeps.cjs:114. Existing tests untouched (the only removed line in the test diff is the require, extended to also import `isPnpmProject`).
- `node_modules/` exclude written before install via `addExcludeLines`, deduplicated: worktreeDeps.cjs:70-82, 102.
- Both new tests present and passing (sentinel survives, worktree node_modules not a symlink, status clean; isPnpmProject true/false).

## 2017 pnpm-main-modules-health-primitive — VERIFIED
- All check branches (not-pnpm, node_modules-missing, modules-yaml-missing, unresolved-deps capped at 20, no-package-json, ok), sync, never throws: depHealth.cjs:27-60. Deps capped at 200 by slice.
- `repairMainDependencies`: execFile, CI=1, 300 s, resolves `{ok, code, tail<=2000}`, never rejects: depHealth.cjs:67-83.
- depHealth.test.cjs: 8 tests, including dangling symlink and the real pnpm repair case.

## 2018 pnpm-worktree-deps-doc — VERIFIED
- Line 1 reads `<!-- PRD_AUTHORING.md v7 -->`.
- §7 Worktree reach text matches the criteria, includes the Why sentence, and keeps the burrow/absolute-path guidance (diff of PRD_AUTHORING.md).
- prdWorktreeReach.cjs:6-7 header says "symlinked or (pnpm) worktree-local"; comment-only change. prdAuthoringSeed 4/4.

## 2019 pnpm-main-modules-health-wire — VERIFIED
- scheduler.cjs:8756-8775: check, then repair at most once per 10 minutes per cwd via module-level `mainDepsRepairAt`, one `[scheduler] main deps broken in <cwd>: <reason> — repair ok|failed` log line, re-check.
- Still broken: outcome `{status:'unavailable', reason:'main-deps-broken: …[: names]', results: []}` and the gate is skipped; `definitive` is false because the status is not green/red (scheduler.cjs:8786).
- `mainDeps` is spread onto gateShadow only when set (scheduler.cjs:8787). The 24 existing gate-shadow tests pass; the new test uses an SM_PNPM_BIN stub.
- `SM_PNPM_BIN || 'pnpm'` at depHealth.cjs:72. The depHealth.cjs edit is the single line.

## Findings
### Critical
- none
### Important
- none
### Minor
- scheduler.cjs:8756-8775: inside the 10-minute cooldown, a still-broken main skips repair and the gate (unavailable) with `repaired:false`. This is intended, but it means the row stays retryable until the cooldown expires. Not a defect.
- worktreeDeps.cjs:54: `installPnpmModules` hardcodes `pnpm` and ignores SM_PNPM_BIN, so the test seam covers repair only. Consistent with the PRD scope.
- worktreeDeps.cjs:101-105: the pnpm install (up to 180 s) is awaited inside worktree creation (gitWorktree.cjs:899, scheduler.cjs:8848), so dispatch of that job is delayed on slow installs. It is bounded by the timeout, and failure degrades to `skipped`.
- Security: no shell, fixed argv, no user-controlled path or argument in the exec calls; the exclude write only appends a fixed line under the git common dir. No secrets.
