# Validation: epic turn-1 isolation (PRDs 2326, 2327)

Base: fe0d566e. Commits: c42adad7 (2326), e7853de7 (2327). PRD files found in prds-archived/.

## epic-worktree-pending-mint-hint — VERIFIED
- Map registered synchronously, cleared on settle: epicWorktreeMint.cjs `pendingMints`, `createEpicWorktreeViaIpc` (set before any await; `p.finally` deletes if still same promise). validatePath failure still rejects as before.
- `awaitPendingEpicWorktree`: returns null when nothing pending; Promise.race with unref'd, cleared timer; logs "pending mint timed out after Nms"; `p.catch(()=>null)` so it never rejects.
- `worktreeDirHint` in epicSpawnPlan.cjs: used only when `!resolved || !resolved.existsAnywhere` and isDir; returns `{ok:true, execCwd:hint, useResume:false, transcriptPath:null}`; otherwise falls through unchanged; epic_closed check still first.
- Tests present in both named test files.
- Gate re-run: epicWorktreeMint/epicSpawnPlan/chatRunner-epic-worktree-execcwd vitest 38/38 pass (with the other 2 chatRunner files); `npm run lint` exit 0.

## chat-turn1-waits-for-epic-worktree — REFUTED
- chatRunner.cjs `executeRun` now awaits `awaitPendingEpicWorktree(opts.cwd, opts.tabId)` before planning/slot work, passes `worktreeDirHint` to planEpicSpawn (the AC items hold; cwd for ops/model/effort unchanged). 3 new cases in chatRunner-epic-worktree-execcwd.test.cjs pass.
- Gate re-run (5 chatRunner/epicSpawnPlan files, typecheck, lint): all green.
- BUT the change regresses an existing test outside the PRD's gate: `tests/unit/chatRunner.spec.ts > per-sessionId in-flight latch > cancel then immediate re-run of the same sessionId waits for the slow exit, then starts with --resume` fails deterministically (3/3 runs: "expected length 2 but got 1"). It passes at c42adad7 (the commit before this PRD). Cause: `executeRun` became `async` and awaits unconditionally, so even with nothing pending the run body (spawn/latch registration) is deferred by microtask(s); `cancel()` issued right after `run()` no longer sees the run and the cancel→re-run ordering breaks. Violates "with no mint pending this adds no wait".

## Full unit suite (all SM_* unset, `npx vitest run`)
- Run 1: 823/825 files passed; 3 tests failed — `src/main/lib/scheduler/__tests__/reaperHelpers.test.cjs` (findLiveProcessForJob pid matches; environmental/flaky — passed in run 2; not in this plan's files).
- Run 2: 824/825 files, 7713 passed, 1 failed, 1 skipped — `tests/unit/chatRunner.spec.ts` (belongs to plan PRD 2327 chat-turn1-waits-for-epic-worktree).

## Findings
- **Important** — src/main/chatRunner.cjs `executeRun` (~line 449-457): unconditional `await` adds async delay even when nothing is pending, breaking tests/unit/chatRunner.spec.ts (cancel-then-rerun latch). Fix: only await when a mint is pending (e.g. sync `hasPendingEpicWorktree` check, or call the sync path when `awaitPendingEpicWorktree` would return null), and add tests/unit/chatRunner.spec.ts to the PRD gate.
- **Minor** — reaperHelpers.test.cjs flakes under load (stray process pid match); unrelated to this plan.
