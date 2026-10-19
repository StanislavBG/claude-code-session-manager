# Validation: pnpm-worktree-update-no-dangling-main-links

Base: 8eeb6056 (PRD file: epics/.../prds-archived/2045-pnpm-worktree-update-no-dangling-main-links.md)
Commit for this PRD: `6341012c` (touches only `src/main/lib/git/__tests__/worktreeDeps.test.cjs`, +30).

## pnpm-worktree-update-no-dangling-main-links — VERIFIED

- AC1: test at `worktreeDeps.test.cjs` ~L151 is `test.skipIf(!hasPnpm)`; uses makePnpmFixture, `git worktree add`, `linkDependencyDirs`, `pnpm(pwt,'update','--offline','lib')`, `git worktree remove --force` (seen in `git show 6341012c`).
- AC2: `danglingLinks()` recurses via `readdirSync(withFileTypes)`, does not follow symlinks, collects `!fs.existsSync`; asserts `[]` and `node_modules/lib/package.json` exists.
- AC3: `TMPDIR=/tmp/sm2051 timeout 180 npx vitest run src/main/lib/git/__tests__/worktreeDeps.test.cjs` → 1 file, 10/10 passed.
- AC4: 6341012c does not touch `worktreeDeps.cjs`. (A later commit `67862593`, a separate fix for out-of-repo `file:` deps, does change it; it is not part of this PRD.)
- Gate (same command as AC3): green.

## Findings

### Critical
none
### Important
none
### Minor
- `worktreeDeps.test.cjs` (new test): never observed red against the old symlink behaviour (reported by the author), so its ability to detect the regression is unproven.
- Self-review only by the author; no `/code-review` was run on 6341012c. Diff is test-only, tmp-dir scoped, no unsafe input handling.
