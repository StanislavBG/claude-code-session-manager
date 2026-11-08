# Validation: Competitor matrix fix wave (F1, F2)

Base: 4a2e69d1c8e85bcaaeabfe22a647d149eb180cec. Commits: 758c8b4f (api surface), e9300a88 (personas). Each touches exactly its one declared file.

## competitor-matrix-api-surface-entry — VERIFIED
- Row `{ns:projectPages, method:matrix, channel:project-pages:matrix, kind:invoke, remote:read}` added after the mdNetwork row: `src/preload/apiSurface.json` ~line 1388 (git show 758c8b4f, +7 lines, same formatting).
- Gate `npx vitest run apiSurface + preload-surface + remoteIpcDispatch`: 3 files, 70 tests passed.
- No other file changed (`git log --stat` shows only apiSurface.json).

## competitor-matrix-seed-validator-personas — VERIFIED
- `ALL_PERSONAS` at `src/main/__tests__/seedValidatorPersona.test.cjs:58` now ends `'competitive-researcher', 'competitive-analyst'`; matches `PERSONAS` at `src/main/seedAgentPersonas.cjs:83` in order.
- Gate `npx vitest run seedValidatorPersona + seedAgentPersonas`: 2 files, 46 tests passed.
- Only the test file changed.

## Plan-level
- `npm run test:unit` (SM_* unset except SM_PROJECT_ROOT): 985 files, 984 passed, 1 failed; 9519 passed / 1 failed / 1 skipped.
  - Failure: `src/main/__tests__/supervisor-probe-stdin.test.cjs` (ENOENT on seen.json in a tmp sandbox). Re-run alone: passes (1/1). Load flake; the file is outside this Epic's changes.
  - epicMint.test.cjs passed in the full run.
- `npm run typecheck`: exit 0. `npm run lint`: clean (page-stewards clean, e2e budget 18/19).

## Findings
- Critical: none. Important: none.
- Minor: supervisor-probe-stdin.test.cjs is red once under full-suite load, green alone (flake; consider settling/await on the stub's output write).
