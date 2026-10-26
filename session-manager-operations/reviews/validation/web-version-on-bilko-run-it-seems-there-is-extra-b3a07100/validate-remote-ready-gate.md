# Validation: remote-app-ready-gated-first-fetch (PRD 2290)

Base: 51eb7ce0 (given). Commit: 1e460728 `fix(remote-app): gate first projects fetch on desktop ready`.
PRD file found at epics/<epic>/prds-archived/2290-remote-app-ready-gated-first-fetch.md.

## remote-app-ready-gated-first-fetch — VERIFIED
- AC1 (no request before ready, Loading state): `ProjectsScreen.tsx` effect sets `loading` then returns early when `!ready` (~l.37-39); Cockpit passes `ready = remoteReady || readyFallbackExpired || !needsE2E` (Cockpit.tsx ~l.33). Test "sends no request before ready…" present.
- AC2 (auto fetch on ready; error re-fetch): `markRemoteReady` store.ts sets `remoteReady:true` and bumps `refreshKey` for the active device; `ready` and `refreshKey` are effect deps. Test "re-fetches once when ready arrives while in the error state".
- AC3 (fallback armed on waiting start): App.tsx new effect arms `fallbackRef` when `online && devicePubKey && wsConnected && !remoteReady`, clears otherwise; `stopAwaitingDesktop` sets `readyFallbackExpired:true`. Test "fallback expiry issues the request".
- AC4 (switch device): `setActiveDevice` recomputes `remoteReady` from `readyDeviceIds` and resets `readyFallbackExpired`. Tests "already-ready device requests immediately" / "not-ready device waits".
- AC5 (test file): `readyGate.test.tsx` has 6 tests covering all five required cases plus one extra.
- AC6 (desktop untouched): `git diff <base>..HEAD --stat -- src/main` is empty; no webRemote.cjs change.
- Gate re-run: `npm --prefix web/remote-app ci` exit 0; `typecheck` exit 0; `test` exit 0 (27 files, 175 tests passed).

## Findings
- Critical: none. Important: none.
- Minor: the App.tsx fallback-arming effect (App.tsx ~l.217-226) is not exercised end to end; the test drives `stopAwaitingDesktop` directly rather than mounting App. The executor also reported writing tests alongside code (no red-first run).
- Minor: SessionsScreen does not wait for ready after reconnect (allowed by the PRD; it re-fetches via the `refreshKey` bump).
- Self-review (code-review / security-review skills not run): no secrets, no input handling or path changes; no duplicated helper (reuses `createReadyFallback`, `stopAwaitingDesktop`).
