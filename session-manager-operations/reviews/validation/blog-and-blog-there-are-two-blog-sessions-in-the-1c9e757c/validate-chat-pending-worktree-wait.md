# Validation: chat-pending-worktree-wait-in-run (PRD 2345)

Base: a450649b28d5e091c37649e79285120760aee3f7. PRD: `prds-archived/2345-chat-pending-worktree-wait-in-run.md`. Fix commit: 5c181d4c.

## chat-pending-worktree-wait-in-run — VERIFIED

- AC1 `hasPendingEpicWorktree`: src/main/lib/epic/epicWorktreeMint.cjs:77-80 (sync, try/catch, `pendingMints.has(mintKey(..))`); exported at :116.
- AC2 `executeRun` sync: src/main/chatRunner.cjs:499 `function executeRun({..., worktreeDirHint})` (no async/await); hint passed to `planEpicSpawn` at :603.
- AC3 `run()`: :417-431 pending-mint branch sets `pendingStart` (:421), waits via `awaitPendingEpicWorktree`, re-runs with `worktreeDirHint` (:427); `pendingStart.has` in `tabBusy` (:409); no pending mint falls through to the original path.
- AC4 `cancel()`: :971-978 removes the parked entry, broadcasts 'cancelled while queued' unless silent, returns resolved promise; `pendingStart.clear()` in `__resetQueueForTests` (:362).
- AC5 tests: tests/unit/chatRunner.spec.ts not in the diff (unchanged); execcwd test has 'cancel during a pending mint never spawns' (:175); epicWorktreeMint.test.cjs:133 covers `hasPendingEpicWorktree`.
- Gate 1 (6 gate files): 6 files, 81 tests passed, exit 0 (latch test now green).
- Gate 2: `npm run typecheck` exit 0; `npm run lint` exit 0.

## Full unit suite (all SM_* unset, `npx vitest run`)

825 files: 824 passed, 1 failed. 7752 tests: 7745 passed, 6 failed, 1 skipped. No smells/page-surface flakes appeared this run.

## Findings

- **Important** — src/main/__tests__/scheduler-notify-originating-tab.test.cjs:197 (6 tests, reproduces alone): `sendPrompt` is now called with a third arg `{ origin: 'scheduler' }` and new text "PRD 814-notify finished: completed. Check Scheduler for details."; the test asserts the old 2-arg/old-text form. Cause: the scheduler-origin / no-questions plan (874a2abc, 8df4f4cd), NOT this plan. Belongs to the no-questions-automation plan (see validate-no-questions-automation.md).
- **Minor** — chatRunner.cjs:421-430: a cancelled-then-resubmitted run for the same tab during a pending mint is correctly guarded by identity check on `opts`; no issue, noted only because the parked silent run is not reported anywhere.
- Review of combined diff (self-review; no secrets, path traversal or unsafe input found in the chat/mint changes). Other-plan changes in the diff (remote fence, scheduler) are covered by their own records.
