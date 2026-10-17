# Validation: remote-app-sas-suppress-only-on-real-ready

Base: 8b66e238. Commit in range: b9b93986 (touches only store.ts, App.tsx, remote-ready.spec.tsx — matches PRD Files).

## remote-app-sas-suppress-only-on-real-ready — VERIFIED

- AC1 `stopAwaitingDesktop` (store.ts:57 type, :110): sets only `awaitingDesktopConfirm:false` and `refreshKey+1`; no `remoteReady`, no `pendingSas` change. `markRemoteReady` (store.ts:106-108) unchanged.
- AC2 App.tsx:109 `createReadyFallback(stopAwaitingDesktop)`; the only `markRemoteReady()` call is in the `event:remote:ready` handler (App.tsx:158); both in effect deps (:169).
- AC3 store.ts:85 `setWsConnected` sets `remoteReady:false` when `false`.
- AC4 remote-ready.spec.tsx: fallback test asserts `pendingSas` retained and `remoteReady` false; new test `setWsConnected(false) after ready re-enables the banner`; existing ready-then-sas suppression test passes.
- AC5 Gate re-run (after `npm --prefix web/remote-app ci`, deps absent in worktree): 4 files, 22 tests passed, exit 0.

## Review of combined diff
3 files, +25/−9. No unsafe input, secrets, paths, or duplicated helpers. `setPendingSas` still suppresses only when `remoteReady` is true.

## Findings
- Critical: none
- Important: none
- Minor: store.ts:55 doc comment on `markRemoteReady` still says "(or the fallback fired)"; now stale. `stopAwaitingDesktop` (store.ts:57) has no doc comment.
- Minor: untracked 0-byte `<path>` file in worktree (known sqlite MCP placeholder); not committed.
