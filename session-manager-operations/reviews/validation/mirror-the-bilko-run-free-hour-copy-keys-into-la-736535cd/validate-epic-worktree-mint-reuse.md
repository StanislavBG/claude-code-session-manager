# Validation: epic-worktree-mint-reuses-live-worktree

Base: d73210494ddd (given). Landed commit: 9d19bc49 (gitWorktree.cjs +28, gitWorktree.test.cjs +38). PRD file: prds-archived/2658-...md.

## epic-worktree-mint-reuses-live-worktree — VERIFIED

- AC1: gitWorktree.cjs:878-888 — for `kind === 'epic'`, `fs.existsSync(epicDir)` + `isRegisteredWorktreeOnBranch` (l.803-811, `git worktree list --porcelain`, realpath compare, branch match) returns `{ok:true, dir, branch, baseCwd: cwd, reused:true}`; baseCwd matches success path (l.940). No remove/delete/add called before return.
- AC2: reuse block (l.878-888) sits before the reserveWorktreeSlot step; test (b) confirms count unchanged.
- AC3: non-registered dir or job kind falls through to the unchanged path (helper returns false on any error); test (c) confirms leftover replaced.
- AC4: epicWorktreeMint.cjs untouched by the commit; it reads dir/branch/baseCwd, which the reuse result supplies.
- AC5: tests at gitWorktree.test.cjs ~818-854: (a) same dir, reused:true, untracked file intact, branch tip unchanged; (b) epic count equal; (c) leftover replaced, `reused` undefined.
- Gate: `timeout 300 npx vitest run gitWorktree.test.cjs epicWorktreeMint.test.cjs` → 2 files, 136 tests passed.

## Findings

- Critical: none. Important: none.
- Minor: reused result omits `carriedPaths`/`baseBranch`/`setup` (gitWorktree.cjs:886); mintEpicWorktree consumers reading carriedPaths get undefined on reuse — acceptable per PRD, worth a glance.
- Minor: only changed-file diff reviewed by self-review (no injection/path issues: args passed to execGit as array, paths derived by worktreeDirFor).
