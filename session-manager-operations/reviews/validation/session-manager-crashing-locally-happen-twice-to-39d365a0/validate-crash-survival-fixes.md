# Validation: crash-survival fix wave

Base: 16f7151fe68f82a991de21bf358c060d01c231b7 (known). Environment: all SM_* unset. Combined diff: 19 files, +254/-80.
Gates re-run (all exit 0): the per-PRD vitest sets, `npm run typecheck`, `npm run lint:docs`.
**Full `npm run test:unit` is NOT green: 1 failed / 8055 passed (850 files).** See Finding 1.

## identity-survives-scope-exec (2469, commit 48921b98) — VERIFIED
- isDifferentProcess compares pid and startTicks only: procIdentity.cjs:162-165. Incomplete/null returns false: lines 160-161.
- Header comment states the exec and `systemd-run --scope` reason: procIdentity.cjs:19-25.
- classifyAdoption adopt / foreign-pid cases: jobSupervisorRecord.test.cjs (new test, ✓ in run).
- superviseAdoptedRun exec case: scheduler-adopted-run-supervision.test.cjs "exec case…" ✓.
- procIdentity-exec.test.cjs RAN, not skipped, on this systemd host: verbose output shows `✓ … same pid + startTicks after exec is not a different process 60ms`.
- Gate (4 files, 29 tests) green; typecheck green.
- The PRD's own scope is satisfied, but its change breaks a test outside its Files list (Finding 1).

## unit-tests-run-without-real-scopes (2470, e8461e54) — VERIFIED
- schedulerSandbox.cjs:23-24 sets SM_JOB_MEMORY_MAX_MB='0' with a comment.
- chatRunner.cjs executeRun calls memoryLimitsFor first, then `limits && scopeSupported()`; scheduler.cjs planJobScope does the same (limits first, supported only if limits non-null).
- tests/unit/chatRunner.spec.ts not in the diff and passes.
- New "null limits" tests exist in chatRunner-memory-scope and scheduler-memory-scope. Gate (72 tests) green.

## scope-stop-never-blocks-main (2471, 834f8a26) — VERIFIED
- memoryScope.cjs stopScope uses child_process.spawn with `systemctl --user stop --no-block <unit>.scope`, stdio ignore, detached true, then unref.
- It attaches an 'error' listener, and the sync throw is swallowed.
- scheduler.cjs:615 still calls stopScope once, in finalizeJobScope; its return value is not used.
- memoryScope.test.cjs asserts the argv, unref, error listener and throw path. Gate green.

## chat-turns-keep-background-processes (2472, 0260a6bf) — VERIFIED
- `grep stopScope src/main/chatRunner.cjs` has no hit; stopAttemptScope, scopeUnit and scopeStopped are gone.
- The wrap path is unchanged apart from the limits-first order. The comment at the wrap site is present.
- The test asserts `stops` equals [] ("stopScope never called"). Gate green.

## boot-recovery-reads-session-jsonl (2473, a5c8bca9) — VERIFIED
- classifyTurnTail is exported and matches the spec: chatBootRecovery.cjs:33-54.
- settleDead clears silent/finished/missing entries and re-runs only 'unfinished', under the 24h guard.
- index.cjs:1103-1111 resolves the path via resolveEpicTranscriptPath, reads the tail with readTranscriptTail (now exported), and returns 'missing' on any failure.
- The notify dep and both chat:run:recovered sends are removed.
- Tests cover end_turn, tool_use, a trailing user line, trailing bookkeeping lines, empty and silent. Gate green.

## doc-crash-count-corrected (2474, 2553785a) — VERIFIED
- conventions.md says six deaths from five OOM kills (four OOM scope-stops, two silent exits) and that the 09:48 kill hit an orphaned scope.
- It says 09:09 is proven by stderr and ~11:40 is inferred because stderr was not captured.
- It says job scopes are stopped and chat scopes are not, with the reason, and that identity is pid + start time because exec changes cmdline.
- `npm run lint:docs` ok.

## chat-turns-run-in-memory-scope (2456) — VERIFIED (wrap criteria; stop-on-settle superseded by 2472)
- startAttempt wraps via wrapInMemoryScope when limits are non-null and scopeSupported() is true, with unit `sm-chat-<sid>-<attempt>-<ts>` (chatRunner.cjs ~766-771).
- The unwrapped path is unchanged. argv0 is dropped on the wrapped path only.
- The stdin, NDJSON and killTree tests are in the passing chatRunner-memory-scope suite.
- The stop-once criterion is intentionally removed by 2472.

## Findings

### Important
1. **Full test:unit is red.** `src/main/__tests__/procname-claude-spawn-sites.test.cjs:225` (test "pid-recycling migration…") asserts that `isDifferentProcess` is true for records that differ only in cmdline. 2469 made that false by design, and the test is outside the 2469 Files list, so it was never updated. It is a stale assertion, not a product regression. Fix: change it to differ on startTicks or pid (e.g. `{ ...recorded, startTicks: recorded.startTicks + 1 }`). Per the implementation notes ("must be fully green"), the wave is incomplete until this lands. I report it and do not fix it, per validator rules.

### Minor
2. `src/main/lib/process/__tests__/procIdentity-exec.test.cjs:19-22`: the poll loop exits on timeout as well as on a cmdline change, and the test never asserts the cmdline did change. It passes even if exec never happened (60 ms run). Add a comment or assertion for the observed change.
3. `src/main/chatRunner.cjs:~764`: a leftover bare `{ … }` block wraps the `if (limits && scopeSupported())`. It is harmless but should be flattened.
4. Scheduler job scopes are stopped asynchronously (`--no-block`), so the return value is gone. Nothing relied on it (checked: scheduler.cjs:615).
5. No cross-PRD interaction problems beyond Finding 1. 2469 and 2471 touch different code, and 2470's limits-first order is consistent in both call sites.
