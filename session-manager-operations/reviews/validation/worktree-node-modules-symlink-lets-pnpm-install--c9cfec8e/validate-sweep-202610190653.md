# Validation: pnpm-worktree-out-of-repo-file-deps (PRD 2046)

Base: 6341012c. Commit for this PRD: `67862593` (touches only the two PRD files). PRD file: `prds-archived/2046-pnpm-worktree-out-of-repo-file-deps.md`.

## pnpm-worktree-out-of-repo-file-deps — VERIFIED

- AC1 (find specifiers, importers, outside-main only): `worktreeDeps.cjs` `lockImporters` scans `importers:` keys (quotes stripped, `.` included); `localSpecs` reads dependencies/devDependencies/optionalDependencies for `file:`/`link:`, ignoring absolute; `linkOutOfRepoLocalDeps` resolves against MAIN importer dir and skips `within(mainCwd, target)` and missing targets. Called just before `installPnpmModules` in the pnpm branch.
- AC2 (symlink only where nothing exists, never in main, never overwrite): skip when `within(mainCwd, linkPath) || within(worktreeCwd, linkPath) || exists(linkPath)`; `symlinkSync` after `mkdirSync(dirname)`; per-dep try/catch.
- AC3 (header documents link outside worktree and why): header comment added in the same commit.
- AC4 (new test): +30 lines in `worktreeDeps.test.cjs` (sibling `../sibling/pkg`, separate worktree parent); asserts installed contains node_modules, real directory, main sentinel untouched.
- AC5 (existing tests green, never throws): helper wrapped in nested try/catch.
- Gate `timeout 300 npx vitest run src/main/lib/git/__tests__/worktreeDeps.test.cjs` re-run: 1 file, 10/10 tests passed.

## Findings

### Critical
none

### Important
none

### Minor
- `worktreeDeps.cjs` `linkOutOfRepoLocalDeps`: a spec with more `..` hops than the worktree is deep would place the link at/near the filesystem root (only if the target exists and root is writable). Unlikely; specs come from the repo's own package.json and nothing is overwritten.
- Links created outside the worktree are not cleaned up on worktree removal (documented design, shared across worktrees of the same hash dir).
- `/code-review` and `/security-review` were not run; self-reviewed the commit diff: no shell invocation, no secrets, paths derived from the repo's own package.json, no overwrite.
