# Validation: webremote-remove-relay-ping-watchdog

Base: 5bb2169b (known). Commit in range: 25617ce3 (touches only src/main/webRemote.cjs and tests/unit/webRemoteRelayLiveness.spec.ts).

## webremote-remove-relay-ping-watchdog — VERIFIED

- AC1 (symbols removed): `grep -nE "RELAY_PING_SILENCE_MS|_lastRelayPingAt|checkRelayLiveness|setLastRelayPingAt" src/main/webRemote.cjs` returned no matches (exit 1). The diff removes the `startHeartbeat` call. The `ws.on('ping')` handler at `src/main/webRemote.cjs:~487` now only does `_missedPongs = 0`.
- AC2 (comment): `src/main/webRemote.cjs:~484-486` says relay protocol pings are not guaranteed to reach the desktop through the bilko.run front proxy (none in 120s on 2026-10-17) and must never be used as a liveness requirement. The orphaned-conn claim is gone.
- AC3 (`__test` exports): the three exports are removed in the diff, and the grep is clean.
- AC4 (regression spec): `tests/unit/webRemoteRelayLiveness.spec.ts` asserts all three symbols are `undefined` on `__test`. It also sets a fake OPEN socket (readyState 1, `terminate` is `vi.fn`) via `setWs` and asserts `terminate` was not called.
- AC5 (app-level ping/pong unchanged): the diff has no hunks touching the JSON `ping` send, `_pongTimer` or `MAX_MISSED_PONGS` logic.
- AC6 (gate): `timeout 300 npx vitest run <5 webRemote specs>` gave 5 files / 39 tests passed. `npm run typecheck` exited 0.

## Findings

### Critical
- none

### Important
- none

### Minor
- `tests/unit/webRemoteRelayLiveness.spec.ts:~21`: the second test only calls exported zero-arg functions whose names match `^(check|liveness)`. None exist now, so it exercises nothing today. It catches a re-added watchdog only if that watchdog follows the naming and is exported on `__test`. Behavioral coverage of the heartbeat interval (fake timers, no silent-ping termination) would be stronger.
- `/code-review` and `/security-review` were not run. I self-reviewed instead. The diff only deletes code and adds no input handling, secrets or paths, and I found no issues.
