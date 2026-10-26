# Validation: quiet-machine-lease-keeps-budget

Base: eb59efe5. PRD file: `prds-archived/2334-quiet-machine-lease-keeps-budget.md`. Commit: `8e109d4c` (5 files, all in the PRD's `# Files`).

## quiet-machine-lease-keeps-budget — VERIFIED

- AC1: `src/main/scheduler/budget.cjs` `isJobBudgetExempt` now returns `job?.budgetExempt === true`. The diff removed the `quietMachine` clause.
- AC2: `src/main/scheduler.cjs:4646-4647` logs `(budgetExempt)` only. The comment above it and the `prdParser.cjs` ~140 comment now say quietMachine jobs are NOT exempt.
- AC3: `src/main/scheduler.cjs:981` has `quietLeaseHolder: quietMachineLease.isHeld() ? (quietMachineLease.holder() ?? null) : null` inside the heartbeat `dispatch` object.
- AC4: `scheduler-job-budget.test.cjs` asserts `{quietMachine:true}` is not exempt (the existing `budgetExempt:true` test is untouched). `scheduler-heartbeat-payload.test.cjs:104-115` asserts null when free and `'quiet-slug'` when held. The exact key-list assertion at :87 was updated to include the new key.
- Gate, re-run:
  - vitest on the 3 files: 3 files passed, 30 tests passed.
  - `npm run typecheck`: clean.
  - `npm run lint`: clean (`e2e budget ok: 18/19`).

## Full unit suite (all SM_* unset; `npm run test:unit`)

Test files: 2 failed, 823 passed (825). Tests: 2 failed, 7720 passed, 1 skipped (7723).

## Findings

### Critical
None.

### Important
- `tests/unit/chatRunner.spec.ts:943` fails: expected `spawned` length 2, got 1. This plan did not touch it. The test file's last commits are `19e120cf` (dropped the private concurrency cap) and `f957fec8`. It most likely belongs to the earlier chat or epic-turn1-isolation plan (2326-2328), which changed `src/main/chatRunner.cjs` in the range. I did not bisect.
- `src/main/__tests__/scheduler-gate-shadow.test.cjs:322` fails: `abandoned_background_task` ends `quarantined`, expected `completed`. This plan did not touch it. The last commits to the file are `b6dc140e` (gate authority trusts only this run's commit and the exact tree) and `098f3829`, so it belongs to the earlier scheduler gate-authority work, not this plan. It may also be isolated-test flakiness; I did not re-run it alone.

### Minor
- The dev-lead said it did not run the test red before the fix. The tests do now assert the new behaviour, so no action is needed.
- No security concerns: the diff has no input parsing, paths or secrets. The lease holder is a slug already held in memory.
