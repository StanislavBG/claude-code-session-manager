# Validation: starvation + memory gate plan

Base: 8eeb6056 (from PRD notes). Commits in range for the plan: a3d062cc (2047), 0a60aaf4 (2048), 023978e0 (2049). PRD files found under `prds-archived/`.

## 2047-fairness-oldest-dispatchable-row — VERIFIED
- oldestPendingMs filters `pickable(j) && !findBlockingDep(j, projectJobs, satisfied)`; all-blocked project → reduce seed Infinity: `src/main/lib/scheduler/schedulerBatch.cjs:582-585`.
- FAIRNESS CONTRACT step 2 now says "oldest DISPATCHABLE" + 2026-10-18 Game-Academy/Self note: `schedulerBatch.cjs:433-438`.
- Test (A blocked 00:00 + dep 02:00, B 01:00 → picks B): `schedulerBatchFairness.test.cjs` "an old dep-blocked row does not win…".
- 4-tick simulation test, both projects start: same file, "4 ticks at freeSlots=1…".
- Gate: `vitest run` of the 3 fairness/cap/cross-project files → 3 files, 25 tests passed; `npm run typecheck` clean.

## 2048-proc-group-rss-helper — VERIFIED
- `processGroupRssMb(pgid, opts)` with injectable procRoot/pageSizeKb, floor MB: `src/main/lib/process/procGroupRss.cjs:30-59`.
- Returns 0 for non-positive/non-integer pgid, non-linux, missing root; per-entry try/catch: `procGroupRss.cjs:31-33,41-55`.
- Splits after last ')' (pgrp idx 2, rss idx 21): `procGroupRss.cjs:46-49`; test uses comm `(a b) c)`.
- Header comment with 2026-10-18 rationale, `// @ts-check` line 1, listed in `tsconfig.main.json` include.
- Gate: procGroupRss.test.cjs 2 tests passed; typecheck clean.

## 2049-memory-gate-credit-consumed-rss — VERIFIED
- `memoryLimitedBatchSize(..., consumedMb = 0)`; credit clamped to [0, minPerJob*runningCount]; condition `availableMb < minPerJob*(running+allowed) - credit`: `src/main/scheduler.cjs:488-497`.
- tickBody sums `Math.min(processGroupRssMb(pid), MIN_FREE_MB_PER_JOB)` over running rows, pid from `runtime.pid ?? pid`, skipped when memory unknown; missing pid / 0 read → no credit: `scheduler.cjs:~7355-7365`. spawnJob stores `runtime.pid` (`scheduler.cjs:6011`).
- Log line, lastMemGate and recordTick report credited threshold + `consumed=<n> MB`: `scheduler.cjs:~7372-7382`.
- MIN_FREE_MB_PER_JOB comment updated (peak headroom, resident credited): `scheduler.cjs:418-421`.
- Tests (a), (b), (c) + negative case added: `tests/unit/schedulerMemoryGate.spec.ts:66-90`; existing cases untouched.
- Gate: schedulerMemoryGate.spec.ts 17 passed; typecheck clean.

## Findings
### Critical
- none
### Important
- none
### Minor
- Range also contains two unrelated commits (67862593, 6341012c: worktreeDeps.cjs + test) not part of this plan; not reviewed as plan work.
- `scheduler.cjs` credit is per-tick synchronous /proc scan over all pids per running job (O(running × procs)); acceptable at tick cadence, noted per PRD.
- Credit uses pgid == job pid, valid because jobs spawn `detached: true`; a job whose `runtime.pid` is the executor of a re-parented group would simply get 0 credit (fail-safe).
- Self-review (no /code-review tool run): no secrets, no shell, no path traversal (procRoot only injected in tests; entries filtered by `^\d+$`).
