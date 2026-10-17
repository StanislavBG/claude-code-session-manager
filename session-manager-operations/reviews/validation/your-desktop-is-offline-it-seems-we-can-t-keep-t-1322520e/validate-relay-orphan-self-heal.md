# Validation: relay orphan self-heal

Base: 93386ed8. Plan commits: `2d74cfc0` (touches `src/main/webRemote.cjs`, `tests/unit/webRemoteRelayLiveness.spec.ts` only).

## webremote-relay-ping-liveness-watchdog — VERIFIED

Evidence per criterion:
- `_lastRelayPingAt` set on open and in `ws.on('ping')`: `src/main/webRemote.cjs:86`, `:451` (open handler), `:507` (ping handler).
- `RELAY_PING_SILENCE_MS = 100_000` at `webRemote.cjs:57`; `checkRelayLiveness` (`:314-326`) logs warn `relay heartbeat silent — reconnecting` with `meta.silentMs`, calls `_ws.terminate()`; invoked in the heartbeat interval right after the readyState guard (`:333`), independent of pongs.
- App-level pong does not touch `_lastRelayPingAt` (grep: only lines 86, 319, 323, 451, 507, 1577 reference it); pong handler at `:820` still resets `_missedPongs`; the missed-pong timer path is unchanged.
- `__test` exports `checkRelayLiveness`, `setLastRelayPingAt`, `RELAY_PING_SILENCE_MS` (`:1576-1578`).
- New spec covers (a) silence terminates, (b) ping inside window does not, (c) fresh clock / unopened (0) not terminated.
- Gate: 5 spec files, 40 tests passed; `npm run typecheck` exit 0 (both tsc projects).

## Findings

### Critical
- none

### Important
- none

### Minor
- `tests/unit/webRemoteRelayLiveness.spec.ts:36` — case (c) sets the clock directly rather than driving `connect()`, so the `_lastRelayPingAt = Date.now()` line in the `open` handler (`webRemote.cjs:451`) is not itself covered. A regression deleting that line would not fail a test (the 0 = "unchecked" guard would mask it until the first ping).
- `webRemote.cjs:333` — the check runs only on the 30s heartbeat tick, so detection latency is up to ~130s; acceptable per PRD.
- Self-review (no new input handling, file access, secrets, or duplicated helper found).
