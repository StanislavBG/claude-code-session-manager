# Validation: stdio-guard-primitive, stdio-guard-wire-boot

Base: 6a5ab82437d56d7341d612075297d81d0a5a969a. Commits: 6b5503ed (primitive), d0b8675e (wire). ebce2290 (macro scriptStart) is in range but unrelated to this plan.
Review commands: /code-review and /security-review not run as separate skills; self-reviewed the diff (see Findings).

## stdio-guard-primitive — VERIFIED
- guardStdio, default streams, one listener, idempotent via WeakMap, never throws: stdioGuard.cjs:68-93; test "idempotent" (listenerCount 1, unchanged) passes.
- Dead codes -> write no-op calling fn arg via nextTick, returns true; log once per stream; throwing log swallowed; other codes logged once per code, write untouched: stdioGuard.cjs:50-54,77-90; in-process tests pass.
- isDeadStdioWriteError / createUncaughtReportFilter truth tables: stdioGuard.cjs:96-111; test passes.
- Child-process test (process.execPath, stdio ['ignore','pipe','pipe','ipc']): unguarded control >=1 uncaught; guarded 0 uncaught, <=1 log call; dead stderr case 0: stdioGuard.test.cjs:35-56 (uses fixtures/stdioGuardChild.cjs; 10 console calls + 2 direct writes).
- lib-layout.json `"stdioGuard": "process"` (diff line 142); header comment explains incident + Node mechanism: stdioGuard.cjs:3-30.
- Gate: `npx vitest run .../stdioGuard.test.cjs` — passed (part of 13/13 tests, exit 0).

## stdio-guard-wire-boot — VERIFIED
- guardStdio({log}) is first statement, in try/catch with silent catch, before SM_BOOT_DIAG: index.cjs:1-13 (stderr.write at :21, require('electron') at :18/:31).
- log lazily requires ./logs.cjs and writes the exact warn line with meta {stream, code}; no console/stdio: index.cjs:6-10.
- uncaughtException handler gated by `shouldReportUncaught(err)` from createUncaughtReportFilter(): index.cjs ~1355-1365; other errors unchanged; unhandledRejection untouched.
- stdioGuardBoot.test.cjs asserts ordering and filter use (3 tests pass).
- conventions.md Avoid entry added (diff line 106) with incident figures.
- Gate: vitest of both files — 2 files, 13 tests pass, exit 0; `npm run typecheck` exit 0.

## Extra check: Electron binary (ELECTRON_RUN_AS_NODE=1)
Binary node_modules/electron/dist/electron present. Same fixture, stdout reader destroyed: control child `uncaught: 9`; guarded child `uncaught: 0`, one log {stdout, EPIPE}. Matches the node child.

## Findings
- Critical: none.
- Important: none.
- Minor: index.cjs ~1355 — the filter is created inside `app.whenReady().then(...)` next to the handler, not at true module level as the PRD worded it; still once per process, so behavior is as specified. Errors thrown before whenReady are not routed through the handler anyway.
- Minor: the guard only logs the first dead write at warn level; subsequent dead writes are silent by design (no gap).
- Security: no secrets, no path input handling, no shell use; the fixture path is resolved from __dirname.
