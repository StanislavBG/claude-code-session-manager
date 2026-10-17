# Validation: remote-app-suppress-sas-when-pinned-ready (PRD 2012)

Base: 25617ce3 (given). Commit for PRD: `e31d8d1c fix(remote-app): suppress SAS banner once desktop signals remote:ready`
(touches only store.ts, App.tsx, remote-ready.spec.tsx).

## remote-app-suppress-sas-when-pinned-ready — VERIFIED (with Important finding below)

Evidence per criterion:
- `remoteReady` boolean, default false: `web/remote-app/src/store.ts:33` (type), `:76` (init false). `markRemoteReady` sets `remoteReady: true, pendingSas: null, awaitingDesktopConfirm: false, refreshKey+1`: `store.ts:106-108`.
- `setPendingSas` no-op while ready: `store.ts:100-104` (`if (s.remoteReady && pendingSas) return {}`).
- Reset: `reset()` sets `remoteReady: false` (`store.ts:97`); `clearRemoteReady` action (`store.ts:58,109`); called in the `event:device:status` non-connected branch beside `socket.resetE2E(deviceId)` (`App.tsx:124-127`).
- First-time pairing: test "first-time pairing: setPendingSas shows the banner" (`remote-ready.spec.tsx`, asserts pendingSas set + awaitingDesktopConfirm true); store logic `store.ts:103`.
- Tests: ready-then-sas, sas-then-ready, clearRemoteReady, reset re-enable all present in `remote-ready.spec.tsx` (new `describe('remoteReady suppresses the SAS banner')`).
- Gate (`npm --prefix web/remote-app test -- remote-ready store await-desktop-confirm e2e-rehandshake`): 4 files, 21 tests passed. Note: the job worktree has no `web/remote-app/node_modules`; I ran it via a temporary symlink to the main checkout's modules (removed afterwards). Without it the gate fails on `@testing-library/jest-dom` resolution — an environment gap, not a code defect.

## Combined diff review
`git diff 25617ce3..HEAD --stat`: 3 source files (+~70/-4) plus a prior validation record. No secrets, no input handling, no crypto/pinning change; no duplicated helper.

## Findings

### Critical
- none

### Important
- `web/remote-app/src/App.tsx:43-50,109,150` + `store.ts:106`: the version-skew `createReadyFallback` (20s) calls the same `markRemoteReady`. For an older desktop that never sends `event:remote:ready`, the SAS banner is now cleared after 20s and `remoteReady` becomes true (suppressing any later SAS), where previously the code stayed visible. An unpinned pairing against an old desktop therefore loses the verification prompt after 20s. Suggest a separate action for the fallback (refresh/stop-waiting only), reserving `remoteReady` for the real event.
- `App.tsx:124-127`: `remoteReady` is cleared only on `event:device:status` != connected. If the relay WebSocket itself drops and reconnects to a new unpinned/rotated session without a device-status event, `remoteReady` stays true and a genuine `sas:pending` is suppressed. `ws.ts:303` (`resetE2E()` on socket loss) has no matching store clear; consider clearing on `setWsConnected(false)`.

### Minor
- Not shipped: the phone bundle still needs vendoring to bilko.run (declared out of scope).
- Stray 0-byte `<path>` file in cwd is the known sqlite MCP placeholder, unrelated.
