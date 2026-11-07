# Validation: launcher-respawn-on-exit-not-close (PRD 2828)

Base: 2a56c643. Commit: 563d860b (bin/cli.cjs +21, cli-launcher-smoke.test.cjs +93). Gate re-run:
`timeout 120 npx vitest run cli-launcher-smoke + cli-supervise` -> 2 files, 14 tests passed (12 baseline + 2 new).

## launcher-respawn-on-exit-not-close — VERIFIED

- AC1: bin/cli.cjs:81-114 — `settled` flag guards `settle()`; triggered from `child.on('exit')` (:110); 2000 ms grace (:64, :112) with `close` shortcut (:113); `child.stderr.destroy()` at :86.
- AC2: :94-100 still gates on `sup.shouldRespawn` then `sup.checkCrashLoop`; signal forwarding loop :117-126 untouched; clean exit does `process.kill(signal)` / `process.exit(code ?? 0)` (:106-107).
- AC3/AC4: two new tests present in cli-launcher-smoke.test.cjs (background `sleep 30` holding stderr; single-record and respawn-once cases); both pass in the gate run.
- AC5: existing tests unchanged and green (14/14); cleanup of sleep pids is in the added tests' diff.

## Review focus

- Settle twice (exit + close + grace timer): not possible. The `settled` flag at :83 makes the second caller return. Node always emits 'exit' before 'close'; a late 'close' after the timer fired (triggered by our own stderr.destroy) hits the guard. The stray grace timer after an early 'close' is cleared at :113.
- Respawn twice: only one `setTimeout(launch)` per settle, so one per child. Crash-loop guard intact (max 5 per window).
- Deliberate restart: the old launcher reads the sentinel at exit time (:94). `runShutdownCleanup()` calls `markCleanShutdown()` (index.cjs:1676), writing open:false before `app.exit(0)` (packaged path :433-434), so `shouldRespawn` is false and the old launcher does not respawn a second Electron. Not exercised end to end here (no live restart probe).

## Findings

- Critical: none.
- Important: none.
- Minor: bin/cli.cjs:103 — a SIGTERM during the 2 s RESPAWN_DELAY window is handled by `process.exit(0)` because `current` is already dead; fine, but there is no test for it.
- Minor: restart-path safety depends on the app writing the closed sentinel before exit. That is pre-existing behaviour. The new code reads the sentinel earlier (at 'exit' instead of 'close'), but the sentinel write precedes process exit, so there is no new race.
