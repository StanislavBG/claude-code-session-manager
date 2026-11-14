# Validation: telemetry follow-ups (3077, 3078, 3079)

Base: 74c4207c12cc1f73fa540e138fdef641b8e40991. Commits: 610042f9 (3077), f82a5acc (3078), 5d046d6b (3079).
Review: `/code-review` and `/security-review` were not run as commands; I self-reviewed the combined diff instead. Nothing touches secrets, paths or user input.

## crash-fix-tests-no-source-text — VERIFIED
- `config.cjs` exports `bindWatchReleaseOnNavigation`, which captures `webContents.id` at registration and registers `did-start-navigation` (src/main/config.cjs ~496-506, export ~554).
- `index.cjs` createWindow calls `configMgr.bindWatchReleaseOnNavigation(wc)`. `will-frame-navigate` and `context-menu` are untouched (the `context-menu` comment block was only moved).
- New test `config-watch-release-navigation.test.cjs` uses a fake EventEmitter. It checks that only the bound sender's watches are released, and that release still works after other references are dropped and `id` would throw.
- `mainWindowListenersNullSafe.test.cjs` is gone (`ls` reports no such file). The source-text `it()` is removed from `listPrdsSingleFlight.test.cjs` (10 lines deleted).
- `git diff` shows no change to `tests/quality/smell-allowlist.json`.
- Gate: vitest on the two files passed, 8/8. `npm run lint:test-smells` printed "smells --check: OK".
- **`npm run lint` exited 0 at HEAD** (final line "check-scroll-into-view: OK").

## scheduler-prds-view-coalesced-fetch — VERIFIED
- `SchedulerPrdsView.tsx` has no `schedule.listPrds` call left. The three former call sites (~109, 240, 275) use `requestScheduledPrds(scopeCwd ?? undefined)`. The remaining grep hits for `listPrds` are comments only.
- The `epicDerive.ts` doc comment (~168) now describes the cwd-scoped shared fetch.
- `useScheduledPrds.test.tsx` has a new case: two `requestScheduledPrds('/p')` calls inside the window make one `listPrds` call.
- Gate: `npm run typecheck` exit 0, `lint:selectors` exit 0, and vitest on `useScheduledPrds.test.tsx` passed.

## boot-upsert-records-seeds — VERIFIED
- `telemetryBoot.cjs` adds `seedsJson()`, used by both `bootSequence` and `reportSeedsIfChanged`. `bootSequence` saves `lastSeedsReported` with `lastMachineReportAt` and `lastMachineReportVersion` only inside the `accepted` branch (~126-134).
- `telemetryMachineSeeds.test.cjs` adds two tests: accepted boot upsert then unchanged seeds gives 1 call total, and a rejected upsert saves nothing so `reportSeedsIfChanged` still sends.
- Gate: vitest on `telemetryMachineSeeds` and `telemetryBoot` passed. Together with `useScheduledPrds.test.tsx`, 25/25 tests.

## Findings
- Critical: none.
- Important: none.
- Minor:
  - `SchedulerPrdsView.tsx` ~240 and ~275 (`refreshPrds` and the post-create refresh) now wait up to 250 ms (`LIST_PRDS_COALESCE_MS`) before fetching. Correctness is preserved: `fire` chains behind any in-flight scan, so a refresh after create sees the new PRD.
  - `bootSequence` skips saving `lastSeedsReported` when seeds are null, as intended.
