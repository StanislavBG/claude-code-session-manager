# Validation: watchdog-always-relaunches

Base: 2f6b5e091c683af63917ad15f65a1c86c0c91d34. PRD files found in `prds-archived/` (2229, 2231, 2235).
Gates re-run (foreground, SM_CHAT_SESSION_ID unset): all three exit 0 (56, 36 and 33 tests passed).

## watchdog-relaunch-escapes-oneshot-cgroup — VERIFIED (commit b50f26f5)
- AC1 `relaunchInvocation` pure and exported: watchdogHelpers.cjs `relaunchInvocation` builds `--user --collect --quiet --unit=session-manager-relaunch-<now> -p KillMode=process -p StandardOutput=append:… -p StandardError=append:… --setenv=PATH=… -- cmd args`. Otherwise it returns `detached`.
- AC2 `defaultSpawnRelaunch`: `findOnPath('systemd-run', env.PATH)` with no shell. `spawnSync` runs with timeout 15000 and stdio ignore. On error or non-zero status it logs `systemd-run failed (...) — falling back to detached spawn` and returns `detached-fallback`. Minor deviation: success returns `{mode, ok:true, unit}`. Failure never returns `ok:false`, because it falls back. This is behaviorally equivalent.
- AC3 `ELECTRON_RUN_AS_NODE` is deleted from the copied env when `spec.packaged`, before wrapping. The detached path is unchanged when INVOCATION_ID is unset.
- AC4 The attempt log line names the mode (`via systemd-run unit …` or `detached`).
- AC5 The tests are in `describe('relaunchInvocation')` (watchdog-relaunch.test.cjs:413-450). They cover exact arg order, INVOCATION_ID unset, null systemdRunPath, packaged wrapping, and the status-1 fallback with injected spawnFn/spawnSyncFn.
- AC6 packagedRelaunch.test.cjs changed by 1 line: it now passes an explicit `env`. It passes, and tests use tmp log paths.
- `src/main/index.cjs` is untouched, as the PRD required.

## watchdog-rearm-and-bounded-backoff — VERIFIED (commit 0fe39da7)
- AC1 `resetRelaunchState` is exported, and scheduler-watchdog.cjs main() calls it on the fresh branch when `degraded !== true`, inside try/catch. It writes `{lastAttemptTs:null, attemptCount:0}` only when the state is not already zeroed.
- AC2 `DEFAULT_CAPPED_RETRY_MS = 30*60_000` is exported. `maybeRelaunchApp` retries when the window has elapsed, else returns `{reason:'backoff', attemptCount, nextRetryInMs}`.
- AC3 The give-up line is replaced by a `backoff:` line, throttled by `lastBackoffLogTs` to once per window (test at watchdog-relaunch.test.cjs:135).
- AC4 The months-old `{attemptCount:3}` state re-arms on the first stale tick (test at :192).
- AC5 `nextAlertState` alerts on entering backoff and again at >= 60 min (`REALERT_MS`). It persists `lastAlertTs`, treats a legacy `capped` like `backoff`, and a fresh tick clears it. ALERT_BODY mentions retrying every 30 min. The test is at :336.
- AC6 The tests cover reset-on-fresh (:209), backoff skip, retry after window (:173), months-old re-arm, and the hourly re-alert; the debounce and restarting-marker tests stay green.

## history-finalize-resumable-cursor — VERIFIED (commit 513c95df)
- AC1 `historyRollupCursorPath()` exists in schedulerPaths.cjs:122 and is exported. It is wrapped in `assertNotLiveRoot`.
- AC2 `finalizeClosedDays({budgetMs, dryRun, cursorPath})` reads the cursor with `readJsonOrSync`. It filters dirs to names strictly greater than `lastDir`. `walkedLast` advances only after a directory is fully walked. It writes with `writeJsonAtomic` at the end of the call.
- AC3 Partial calls append plain lines. Finalized markers are pushed only when `!partial`, and the cursor is removed on completion. `dryRun` skips the cursor write. Cursor `dates` carries earlier partial calls' dates so the completing call stamps them.
- AC4 A partial call is followed by a call that starts after `lastDir`. The test at historyFinalizeResume.test.cjs:76 covers resume, no re-parse, markers only on completion, and reset. DEFAULT_FINALIZE_BUDGET_MS is not edited.
- AC5 Tests at :76, :97 (dryRun) and :102 (missing or corrupt cursor).
- Key fact checked: historyAggregator.cjs:808 says rollup is last-write-wins per key, so there is no double count (NEEDS_HUMAN not triggered).

## Combined diff review (self-review; no files outside the PRDs' `# Files` lists)
No shell interpolation: `systemd-run` args are passed as an array. No secrets. Cursor and state paths come from schedulerPaths. Edge: `lastDir` is compared with `localeCompare` on both the sort and the filter, so they are consistent.

## Findings
### Critical
- none
### Important
- none
### Minor
- watchdogHelpers.cjs (`defaultSpawnRelaunch`): the `{ok:false}` shape in the AC text is never returned, because failure falls back to detached. This is harmless.
- historyAggregator.cjs (`finalizeClosedDays`): a cursor write failure is swallowed and only causes a re-walk. It is intentional, but silent.
- A cursor from a prior cycle persists when the corpus changes (new dirs sorting before `lastDir` are picked up only next cycle). Their data is still finalized by their next walk, so this is acceptable.
- Live kill -9 drill remains a human step, as the PRD notes. It was not run here.
