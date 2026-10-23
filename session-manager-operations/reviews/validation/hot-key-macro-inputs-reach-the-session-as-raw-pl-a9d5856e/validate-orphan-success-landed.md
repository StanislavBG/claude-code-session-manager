# Validation: 2125-orphan-success-requires-landed-commit

Base: 6e0151fd. Commits: 2e3b0286 (merged e02d1a34), touching src/main/scheduler.cjs and scheduler-boot-orphans.test.cjs. Reachable from main.

## 2125 — VERIFIED
- AC1: scheduler.cjs:2898-2905 — success completes only if `confirmedLandedCommit || artifactOnly`; evidence branch sets `job.landedCommit`. The artifact check (`deliverable==='artifact'` + non-empty `artifactPaths`) mirrors runVerify's exemption.
- AC2: scheduler.cjs ~2924-2940 — success without evidence falls to the shared requeue/fail branch; `noLanded` suffix "run reported success but no landed commit was found" is in the requeue reason and the failed error. Cap is `ORPHAN_REQUEUE_CAP`.
- AC3: `failed` branch is unchanged apart from the shared suffix, which is empty for non-success. The sole call site (scheduler.cjs:10320) is unchanged. The evidence-collection guard just above it (~10308) did change (see Findings).
- AC4: the test file covers all four cases: success+commit→completed with landedCommit; success+no evidence→pending with the new reason; success at the cap→failed; artifact-only success→completed.
- Gate: `vitest run scheduler-boot-orphans + scheduler-cancel-durable` → 2 files, 14 tests passed. `npm run typecheck` → exit 0.
- Own completion is backed by a commit on main touching scheduler.cjs: 2e3b0286.

## Findings
### Critical
- none
### Important
- none
### Minor
- scheduler.cjs ~10308: the PRD said not to change boot evidence collection, but the diff removed `bootOutcomes.get(j.slug) === 'success' ||` from the skip guard. This is required for the feature, since success jobs now need landed-commit evidence resolved. It costs one extra git resolve per orphaned success row that has a `landedCommit`. Behaviour is correct.
- Review was a self-review (no unsafe input, secrets or paths added; the evidence is resolved before mutate()).
