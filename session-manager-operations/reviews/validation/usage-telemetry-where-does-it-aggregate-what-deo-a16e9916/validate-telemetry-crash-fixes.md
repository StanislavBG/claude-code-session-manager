# Validation: telemetry crash-fix plan

Base: 62e7b144. Commits: 8d9f5f1d (3063), 2cd1605f (3064), 8b34fd62 (3065).
Gates re-run: the three vitest files pass (13/13), `npm run typecheck` is clean, and `lint:selectors` reports OK (756 files).
/code-review and /security-review were not run as skills. I self-reviewed the diff instead.

## list-prds-single-flight-cwd — VERIFIED
- The IPC handler takes an optional `{cwd}` and calls `listPrdsShared` (scheduler.cjs, `schedule:list-prds`).
- `createSingleFlight` (lib/prd/listPrdsSingleFlight.cjs) shares one promise per key. The key is the normalized cwd, or `'*'` when cwd is absent. The slot clears on both resolve and reject, so a rejected scan is retried.
- `flattenPrdEntry` is applied to each entry when it is built, and `archivedStatus` is flattened too.
- `listPrdsSingleFlight.test.cjs` covers 5 concurrent calls → 1 scan, separate cwds → separate scans, and rejection → rescan. It passes.

## list-prds-renderer-shared-fetch — VERIFIED
- The preload sends `{cwd}` only when a cwd is given, and `api.d.ts` has `listPrds(cwd?)`.
- `useScheduledPrds.ts` keeps a module-level per-cwd entry with a 250 ms coalesce window (≤500 ms) and at most one call in flight.
- The three hook callers (SchedulePanel, EpicDetail, EpicsWorkspace) pass their cwd, and SchedulerPrdsView passes `scopeCwd`. With no cwd, the call is machine-wide.
- `lint:selectors` passes.
- `useScheduledPrds.test.tsx` was added and passes.
- `ipcSchemas.cjs` has no list-prds entry, so it needed no change.

## main-window-null-listener-crash — VERIFIED
- In index.cjs, `did-start-navigation`, `will-frame-navigate` and `context-menu` use the `wc` and `win` captured at registration.
- The only remaining `mainWindow` uses are synchronous code in `createWindow` (lines 548 and 550), the `closed` handler, and `sendIfAlive`, which is null-safe.
- `mainWindowListenersNullSafe.test.cjs` passes.

## Findings
- Critical: none.
- Important: none.
- Minor: `src/renderer/lib/epicDerive.ts:168` has a stale doc comment that mentions `listPrds()` without a cwd.
- Minor: `SchedulerPrdsView` still calls `listPrds` directly instead of using the shared hook. That is outside the AC, but those calls bypass the coalescing.
