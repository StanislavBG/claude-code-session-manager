# Validation: validator budget sizing (plan 2527-2533)

Base d61dc3fb. Commits: 46d07f71, 42edd284, 38e0bafd, 588f3566, 3e015f65, 51c53bb8, 9ebd0670 (plus merges). 15 files, +681/-27.

Gates re-run in the job worktree (SM_* unset):
- `npx vitest run` on gateTimeoutMs, readEpicPrdTexts, epic-ancestor-prd-lookup, epicValidationHook, epicSweepValidator, scheduler-job-budget: 6 files, 82 tests, all pass.
- `npm run typecheck`: exit 0.
- `npm run lint:docs`: ok (21 junctions, 35 files).
- `npm run test:unit` (full): 866 files passed, 8205 tests passed, 1 skipped.

## Real probe (Bilko-Game-Academy, read only)
```
found [870-td-draw-test-memory, 873-td-e2e-tracks-memory, 872-fix-e2e-no-gpu-suite]
gateMs: 1800000, 900000, 2850000
gate minutes 92.5
estimateMinutes 36  budgetExempt undefined  carried 0
computeJobBudgetMs = 108 minutes
```
Gate sum 92.5 and budget 108 (at least 107.5) match the expected values. The shell-syntax gate of 872 is read, not zero.

## gate-timeout-sum — VERIFIED
gateTimeoutMs handles shell-syntax gates; the probe gave 2850 s for 872-fix. Its test file passes.

## read-epic-prd-texts — VERIFIED
readEpicPrdTexts in src/main/scheduler/prdPaths.cjs found all three archived PRDs in the probe. Its tests, including the `../../etc/passwd` slug, pass.

## size-and-split-sweeps — VERIFIED
buildSweepValidatorInput does first-fit by ceiling and sets budgetExempt only for a single PRD over the cap. The slug stamp has seconds (`.slice(0, 14)`). prdCreate.cjs:143 guards budgetExempt on agentType validator and a sweep slug. The probe gave 108 minutes. Tests pass.

## wire-sweep-gate-sizing — VERIFIED
readValidatorGateMs is defined at scheduler.cjs:3308, wired at :3344 and exported at :11813. The incident replay is in epicValidationHook.test.cjs and passes.

## size-planner-validators — VERIFIED
resolveValidatorEstimate is at scheduler.cjs:3320 and awaited at :4835. resolveBudgetEstimate is at :4981, with budget.cjs exporting it. Its tests pass.

## budget-killed-validator-arms-settle — VERIFIED
armSettleAfterValidatorBudgetKill is at scheduler.cjs:3362. The spawnJob path calls it at :7463 and the reaper at :8972, both outside the mutate. Replay tests pass.

## doc-validator-budget — VERIFIED
scheduler-operations.md has the Sweep bullet (seconds stamp, sizing rule, one sweep at a time, budget-exempt single PRD) and the budget-killed validator note. SKILL.md is updated. PRD_AUTHORING.md is stamped v18. lint:docs and the full unit suite pass.

## Findings
- Critical: none.
- Important: none.
- Minor: none. Review was self-review of the diff (no unsafe path joins: slugs are only compared against readdir names).
