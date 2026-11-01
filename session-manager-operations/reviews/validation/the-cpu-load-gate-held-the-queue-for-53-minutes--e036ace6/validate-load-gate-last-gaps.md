# Validation: load-gate last gaps (PRDs 2522-2525)

Base: fde6ccaa. Plan HEAD: a672592c. Commits: 0b800220 (2522), f64e3992 (2523), e794a62d (2524), a672592c (2525). PRD files found under `prds-archived/`.

## reconcile-skips-uncovered-projects (2522) — VERIFIED
- Guard in mint loop: `src/main/scheduler.cjs:1979-1995` (`covered` set only when `state.sourceCwds` is an array; skip needs `!covered.has(mintCwd)` and `fs.existsSync(queueStore.projectQueuePath(mintCwd))`). The `continue` precedes the quarantine path, so no `prd_quarantined` audit.
- One `bustCwdCache()`, one `console.warn`, one `reconcile_uncovered_project` per project: `scheduler.cjs:2161-2165`.
- No queue file or no `sourceCwds` falls through to the old path (guard conditions above); covered by tests at `scheduler-reconcile.test.cjs:~500-570`.
- Gate: `vitest run scheduler-reconcile + reconcileTiming + scheduler-shard-quarantine` = 3 files / 19 tests pass; `npm run typecheck` exit 0.

## load-gate-tick-tests-settle (2523) — VERIFIED
- `tests/helpers/schedulerSettle.cjs` runs the 7-step sequence in order (attachWindow(null), hold gate, bounded 400x25 ms slot wait that throws naming `inUse()`, tick, broadcast flush, wipe queue.json and PRD files, `bustCwdCache`). `schedulerHarness.cjs` unchanged (`git diff` empty).
- Both test files: exactly one `afterEach` calling `settleScheduler({ scheduler, holdGate, ... })` (tick:107, last-resort:109); `queueStore.bustCwdCache()` after each seeding write; no cross-test leftover reliance (leftover-clearing code removed).
- Header comment and `tests/README.md:50-56` state the reconcile/cached-project-list cause; neither says a job's mutate() overwrites rows.
- Gate: both files 10 tests pass; `lint:test-smells` OK; `lint:docs` ok.

## resume-recovery-one-per-pass-when-saturated (2524) — VERIFIED
- `loadGate.cjs:252-263` `isSaturated()`: win32 false, `isLoadGated` false → false, null sample → false, `busyFraction >= Math.min(th, SATURATED_BUSY)`; touches no hold/audit state. Returned at `:264`.
- `reviewLadder.cjs:1012-1027` `selectResumeRecoveryBatch`, exported.
- `scheduler.cjs:~10030-10033` reads `loadGate.isSaturated()` once, spawns exactly the batch; spawnJob's same-tick call untouched (not in diff).
- Deferred row: selectAutoFixTargets already excludes eligible rows; no new path added.
- Tests: loadGate.test (+13), scheduler-resume-recovery.test (+10), new saturated test (1 launch at 0.95, 3 at 0.13).
- Gate: 3 files / 91 tests pass; typecheck exit 0.

## load-gate-docs-what-can-launch (2525) — VERIFIED
- `scheduler-operations.md:157` lists human Run now (full batch), watchdog (one job), periodic resume recovery (one per pass), same-tick resume recovery (one per finished job), auto-fix investigation (one machine-wide), and says mechanical recovery runs git only.
- `:159` states the reconcile coverage rule with `reconcile_uncovered_project` and that the next read covers the project. Diagnosis table not changed (allowed by AC).
- Gate: `npm run lint:docs` ok.

## Flake check — PASS
Loop from the PRD notes (5 workers x 12 runs, `env -i`, three files: load-gate-tick, load-gate-last-resort, scheduler-resume-recovery-saturated):
`60 exit=0` — 60 of 60 passed; no failing assertion.

## Reconcile real-path check — PASS
Scratch script (outside the repo, `/tmp/val2526/rc.cjs`, temp HOME, 60 s timeout): `readMerged()` first to cache the project list, then created project `late` with transcript, queue.json (running + pending row) and two PRD files. Real read missed it:
- read1 `sourceCwds []`, jobs 0; `reconcile(state)` logged the skip warning; queue.json bytes unchanged: `true`.
- `bustCwdCache()`, read2: `sourceCwds [late]`, jobs 2; reconcile: rows `9102-pending-one:pending, 9101-running-one:running` — two rows, no duplicates.
Limit: reconcile mutates state only; the script did not run the mutate/writeSplit step, so the "no overwrite" proof is the state staying empty (nothing to write) plus unchanged bytes. The unit test covers the same.

## Full suite and lint — PASS
`npm run test:unit` with all SM_* unset (`env -u`): 864 files, 8175 passed, 1 skipped, 0 failed, at a672592c. `npm run lint`: exit 0 (e2e budget 18/19). No failures outside this plan's files.

## Findings
Critical: none.
Important: none.
Minor:
- `scheduler.cjs:1987` — a PRD whose `mintCwd` is null skips the guard (unreachable in practice; the comment's precedent also ignores it).
- `scheduler-reconcile.test.cjs` uncovered-project test asserts `console.warn` via substring `did not cover`; wording change would break it silently-red, not silently-green.
- Review done by self-review (correctness, path handling, secrets, helper duplication); no new input handling, no secrets, `queueStore.projectQueuePath` reused rather than duplicated.
