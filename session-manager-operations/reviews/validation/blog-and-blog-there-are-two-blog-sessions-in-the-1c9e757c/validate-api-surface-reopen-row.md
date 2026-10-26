# Validation: api-surface-row-for-prompt-sessions-reopen (PRD 2324)

Base: fe0d566e44f60257a2cce40944f9bb7f3e698e86. PRD found at `prds-archived/2324-api-surface-row-for-prompt-sessions-reopen.md`.

## api-surface-row-for-prompt-sessions-reopen — VERIFIED

- AC1 (one row, ns/method/channel/kind/remote): `src/preload/apiSurface.json:1647-1653` has `promptSessions` / `reopen` / `promptSessions:reopen` / `invoke` / `mutate`. `grep -c '"promptSessions:reopen"'` = 1 (exactly one). The manifest data now lives in `apiSurface.json`, not `apiSurface.cjs` (Files list is stale). Placement: it sits after `create` and before `createWorktree`, not after `archiveTranscript` as the PRD said. This is cosmetic (Minor).
- AC2 (apiSurface.test.cjs passes unchanged): the gate run below is green, 26 tests.
- AC3 (no other row changed, index.cjs untouched): `git diff fe0d566e..HEAD -- src/preload/index.cjs` has no `reopen` lines, and `git log` for that file is empty. `git log -S'promptSessions:reopen'` on the manifest shows only 879a6665 and c8ef78d4. The row was not added by a commit attributable to this PRD. The dev-lead run found it already present and made no change, so the fix arrived through the parallel plan's commits. The outcome holds in the tree.
- Gate 1: `npx vitest run apiSurface.test.cjs remoteIpcDispatch.test.cjs epicReopenWiring.spec.ts` gave 3 files, 26 tests passed.
- Gate 2: `npm run typecheck` exited 0.

## Full unit suite (all SM_* unset)

`npm run test:unit`: Test Files 825 passed (825); Tests 7705 passed, 1 skipped (7706). Zero red files, including `src/preload/__tests__/apiSurface.test.cjs`, the one failure at the base SHA.

## Findings

- Critical: none.
- Important: none.
- Minor: `src/preload/apiSurface.json:1647`. Row is placed after `create`, not after `archiveTranscript` as the PRD specified. Functionally irrelevant.
- Minor: The PRD's `# Files` named `apiSurface.cjs`, but the manifest moved to `apiSurface.json`. No commit lands this PRD's change; the row came from other landed work.
