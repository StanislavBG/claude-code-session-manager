# Validation: needs-you-post-accepts-missing-external-ref (PRD 3479)

Base 18f804d7. Commits: 35b0b6a6 (fix), b6159625 (installed-package drift test; extra, out of the PRD's file list but harmless).
Installed zod (node_modules/zod/package.json): **4.6.7** — the check counts.

## needs-you-post-accepts-missing-external-ref — VERIFIED
- AC1: needsYouStore.cjs refSchema now `z.unknown().optional().transform(...)` (line ~35); transform still maps undefined/null to null via normalizeExternalRef. Tests for absent/null/valid pass (needsYouStore.test.cjs:103-110, 94-99).
- AC2: invalid-ref message unchanged (`label` replacement kept); id still `refSchema('id', true)` → "id is required." (needsYouStore.cjs:36-39).
- AC3: the four named files run: 4 files, 74 tests passed, none weakened (diff touches no existing expectation).
- AC4: new test needsYouAdminRoutes.test.cjs:96-101 posts {app,id,title}, expects 200, created true, externalRef null.
- AC5: diff is only refSchema (shared by id/externalRef); why/link/options schemas unchanged; withdraw/answer use KeySchema whose required check still fires on undefined.
- Gate: `none`; I also re-ran the PRD's vitest command: green.

## Full unit suite (npm run test:unit, zod 4.6.7)
Test Files 1125 passed; Tests 11515 passed, 1 skipped. **Failing tests: none.**

## Review
Self-review of diff (needsYouStore.cjs, tests, installedPackagesMatch.test.cjs): no unsafe input handling, secrets, or path traversal; no helper duplication.

## Findings
- Critical: none
- Important: none
- Minor: none
