# Validation: telemetry test traffic (PRDs 2089–2092)

Base: 0ee5e7ce269d2aa64cc3d9937eb960717a49a0b7. PRD files found in `prds-archived/`. Commits: c818e8ea (2089), 2dd9ea8f (2090), 8ab0d871 (2091), 9501781e (2092).

## 2089 telemetry-profile-real-app-version — VERIFIED
- `src/main/lib/machineProfile.cjs:120-121`: `appVersion === process.versions.electron` → null, then existing `resolvePackageVersion()` fallback applies.
- A real value differing from Electron's is untouched (guard is equality only).
- `src/main/__tests__/machineProfile.test.cjs`: two new tests (Electron-version → package.json version; `'9.9.9'` kept).
- Gate: `vitest run machineProfile.test.cjs` — passed (with telemetryClient: 2 files, 69 tests).

## 2090 telemetry-env-test-for-e2e-runs — VERIFIED
- `src/main/lib/telemetry/telemetryClient.cjs:152`: `SM_TELEMETRY_SPOOL` still returns false first; `|| process.env.SM_E2E === '1'` added.
- `currentEnv()` / `buildInstallWire().env` → 'test' asserted in `telemetryClient.test.cjs` (new test also asserts spool precedence and restores env vars in `finally`).
- Gate: `vitest run telemetryClient.test.cjs` — passed.

## 2091 e2e-launch-telemetry-opt-out — VERIFIED
- `tests/e2e/_helpers/launchApp.ts:43` `SM_TELEMETRY: '0'` in sandboxEnv; spread at line 64 precedes `opts.env` (line 65), so overridable.
- `tests/e2e/supervisor.spec.ts:164` has `SM_TELEMETRY: '0'`.
- Gate: `npm run typecheck` exit 0; both `rg -q SM_TELEMETRY` checks ok. `telemetrySettings.cjs:148` confirms `SM_TELEMETRY=0` is the hard kill switch.

## 2092 smoke-launch-telemetry-opt-out — VERIFIED
- `tests/smoke/packaged-boot.spec.ts:38` and `tests/smoke/darwin-boot.spec.ts:37` set `SM_TELEMETRY: '0'` in the launch env.
- Gate: typecheck exit 0; both rg checks ok. Suites not run (per instructions).

## Combined diff review
`git diff base..HEAD --stat` also includes the earlier error-triage plan (chatRunner, crashDiagnostics, validation record) — out of this plan's scope and not reviewed here. In-scope changes: minimal, no secrets, no path/input handling, no duplicated helper. Self-review only (no `/code-review` run).

## Findings
- Critical: none.
- Important: none.
- Minor: `telemetryClient.cjs` newly exports `_currentEnv` / `_buildInstallWire` (test-only seams, underscore convention matches existing exports) — acceptable.
- Minor: effects are untested end-to-end (e2e/smoke were deliberately not run); existing bad rows on bilko.run remain (declared out of scope).
