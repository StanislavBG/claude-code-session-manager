# Validation: crash-survival suite green

Base: 75ce7f64 (`git log 75ce7f64..HEAD`: 128aa6a6, 7b75b8cd, 350497ca). Env: `SM_*` unset via `env -u` for the full runs. No Electron launched.

## scheduler-tests-use-fixed-host-memory — VERIFIED (stub/fixture; real vitest processes)
- `readMemInfo` reads `process.env.SM_MEMINFO_PATH || '/proc/meminfo'`, tests-only comment, fails open off Linux/on error: src/main/scheduler.cjs:484-497.
- globalSetup writes `<sandbox>/meminfo` (MemAvailable 64 GB, swap 0) and publishes `SM_MEMINFO_PATH`: tests/setup/schedulerSandbox.globalSetup.cjs:25-32.
- 1 GB fixture → memory-deferred test, env restored: scheduler-shard-quarantine.test.cjs:70-88.
- readMemInfo fixture assertion: scheduler-memory-gate-swap.test.cjs:28-40.
- tick-wedge deletes the variable around its /proc/meminfo stub: scheduler-tick-wedge.test.cjs:118-129.
- Gate: 4 files, 28 tests passed; `npm run typecheck` exit 0.

## copy-flash-timer-cleared-on-unmount — VERIFIED (jsdom + fake timers)
- `useCopiedFlash(ms)` returns [copied, flash], one ref timer, restart on repeat, cleared on unmount: ChatTranscriptTurn.tsx:38-55.
- Used at lines 58, 125, 523; no bare `setTimeout(() => setCopied(false)` remains (grep for it returned only the hook's inner setTimeout at the hook).
- 'Copy failed' toast kept at lines 64, 134, 553.
- UrlCallout.test.tsx: timer counts 1/0 (lines 78-88, 105) and 1100 ms clear (91-95).
- Gate: UrlCallout 9 tests passed; `lint:hooks` OK; typecheck exit 0.

## doc-memory-scope-line-wording — VERIFIED (docs read)
- scheduler-operations.md:258 says the `[scheduler] memory scope` line "gives that job's peak memory and `oom_kill` count"; limits are named separately as MemoryMax/MemoryHigh from memoryScope.cjs, not claimed as recorded by the line.
- Gate: `npm run lint:docs` exit 0 (doc-hierarchy ok).

## identity-survives-scope-exec — VERIFIED (real vitest, whole suite)
- `npm run test:unit` with all SM_* unset: run 1 exit 0, run 2 exit 0. Each: 851 files passed, 8073 tests passed, 1 skipped. "unhandled" count in both logs: 0.

## Findings
- Critical: none. Important: none.
- Minor: none. (Host MemAvailable was ~6.2 GB during runs; the fixture makes results independent of it.)
