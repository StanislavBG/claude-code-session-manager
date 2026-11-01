# Validation: leftover-sweep-fails-closed + spawn-sites-test-waits-for-parseable-capture

Base: 3e7d2797. Commits: 3a07345e (PRD 2514), 85a11908 (PRD 2515). PRD files found in prds-archived/ (2514-, 2515-).

## leftover-sweep-fails-closed — VERIFIED
- AC1: `src/main/scheduler.cjs:~8281` `if (process.env.VITEST && !deps.scan) return [];` sits before `scan()`; test asserts `vi.spyOn(jobLeftovers,'scanJobProcesses')` has 0 calls.
- AC2: scheduler.cjs state check now includes `state.unreadable`; new test uses `{ jobs: [], unreadable: 'x', unreadableCwds: [] }`, asserts `[]` and no `stop`.
- AC3: both tests present in `scheduler-job-leftover-sweep.test.cjs`; existing null-state test kept (diff shows additions only).
- AC4: comment at guard names the reason and `assertNotLiveRoot` in `lib/scheduler/schedulerPaths.cjs` (exists, line 57).
- AC5: reap-dead-running-jobs and pollLoop-dispatch-on-failure files unchanged in diff and pass (24/24 incl. leftover-sweep file run).
- Gate: 3-file vitest run passed; `npm run typecheck` exit 0.
- **Real decoy probe:** started `SM_SCHEDULER_JOB_SLUG=validate-decoy-255107 setsid sleep 170` (pid 255110, marker confirmed in /proc/<pid>/environ). Ran `scheduler-reap-dead-running-jobs` + `pollLoop-dispatch-on-failure` with SM_CHAT_SESSION_ID/SM_PROJECT_ROOT unset: 2 files, 24 tests passed. Afterwards `kill -0` → **DECOY ALIVE**; then killed with `kill -9`. Not refuted.

## spawn-sites-test-waits-for-parseable-capture — VERIFIED
- AC1: `procname-claude-spawn-sites.test.cjs:~278-286` waitFor callback reads+parses in try/catch, returns parsed object or null; `expect(captured.comm).toBe('sm-claude-chat')`.
- AC2: diff adds no sleep; waitFor helper untouched.
- AC3: gate `vitest run procname-claude-spawn-sites.test.cjs` passes (re-run with load-gate file: 19/19).

## Full suite (`env -u SM_CHAT_SESSION_ID -u SM_PROJECT_ROOT timeout 300 npx vitest run`)
862 files: 860 passed, 2 failed; 8160 tests passed, 3 failed, 1 skipped (123 s).
Reds: `scheduler-load-gate-tick.test.cjs` (2: saturated hold at yield window; endHold on drained/paused tick — log showed host memory gate available=1024 MB during run) and `procname-claude-spawn-sites.test.cjs` "native (ELF) binary shows the smArgv0 label". Re-run of those two files alone: 19/19 pass. Neither file is touched by the plan's diff.

## Findings
### Critical
- none
### Important
- Full-suite flakes under load (not caused by this plan, but a new red per the brief): `src/main/__tests__/scheduler-load-gate-tick.test.cjs` (memory-gate-sensitive; depends on host available memory) and the ELF case in `procname-claude-spawn-sites.test.cjs` (a different test in the file PRD 2515 fixed — same load-sensitivity class, still not hardened).
### Minor
- Sweep guard keys on `deps.scan` injection; any future test that injects `scan` but not `stop` could act on real pids — inherent to the design, noted only.
- Self-review of diff: no secrets, no path handling, no new helper duplication.
