# Validation: d2d-pairing-plain-error-copy + release-gate-stale-expectations

Base: not recorded in the validate PRD (no `Base:` line). Commits found from main history by path: `aef5cafb` (1813), `74a9b88b` + `3a287b29` (1814).

## 1813-d2d-pairing-plain-error-copy — VERIFIED
- AC1: `RemoteMachinesSection.tsx:24` exports `pairingErrorCopy`; the map above it holds the five codes; fallback is `Pairing failed (${code})` (line 27).
- AC2: `onPair` toasts `pairingErrorCopy(r.error ?? 'unknown')` (line 146) after the `UNAVAILABLE` branch; `onFind` does the same (line 161).
- AC3: the `revoked` state is set on reason `token_revoked` (line 277) and cleared when `readAuth` sees paired (line 268). Notice `remote-client-revoked` with the required text is at lines 213-216.
- AC4: tests added at test.tsx:250 (code_expired), :254 (invalid_code), :235/:265 (revoked shown, cleared).
- Gate: vitest 1 file / 20 tests passed; `npm run typecheck` exit 0; `npm run lint` exit 0.

## 1814-release-gate-stale-expectations — VERIFIED
- AC1: `require('electron-updater')` at `src/main/updaterIpc.cjs:26`; allowlist now includes `electron-updater`.
- AC2: `ALLOWED_COMMANDS` expectation is 15. `cmd:session:create` is in `MUTATE_COMMANDS` (`ipcSchemas.cjs:1203`), which `webRemote.cjs:1014` blocks unless `remoteControlEnabled`, so no logic change was needed.
- AC3: `ci-windows-job.test.cjs` expected list updated. `ci.yml:91` already runs `autoUpdater.test.cjs` on Windows.
- AC4: `SchedulerTopBands.tsx` now returns early on `!r.data`; SchedulerControlWiring has no unhandled errors.
- AC5: full suite result below.
- Gate: 4 files / 90 tests passed; typecheck exit 0.

## Full unit suite (`npx vitest run`, SM_CHAT_CONCURRENCY and SM_SCHEDULER_JOB_* unset, scratch TMPDIR)
700 files passed, 0 failed; 6761 tests passed, 1 skipped; no unhandled errors reported. rc=0. `scheduler-shard-quarantine` passed. The run used a `node_modules` symlink to the main checkout (untracked).

## Findings
- Critical: none.
- Important: none.
- Minor: the validate PRD carried no `Base:` line, so commits were located by path history rather than a base range.
- Minor: the Files list of 1814 includes `webRemote.cjs`, `historyTotals.ts` and `autoUpdater.test.cjs`; none were needed, and none were changed.
- Review of the combined diff (self-review; the diff is small): no unsafe input handling, secrets or path handling. `pairingErrorCopy` uses `hasOwnProperty`, so `__proto__` and similar codes are safe.
