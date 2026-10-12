# Validation: errors-logs-hardening (PRDs 1871–1882)

Base: `6911e7734984cbc0d66a97a6596556458d9568a4` (known). PRD files read from `prds-archived/`.
Combined diff: 32 files, +1104/−205. Commits `77a1fb68`…`6857cb6a`, one feat/fix commit per PRD.

Gates (run in foreground, scratch TMPDIR, `node_modules` symlinked into the worktree):
- `npx vitest run` over all 15 gate test files → **15 files / 172 tests passed**.
- `npm run typecheck` (tsc app + main) → clean, no output.
- `npm run lint` (incl. selectors, hooks, doc hierarchy, e2e budget) → all checks OK.

## credentials-cli-refresh-only (1871) — VERIFIED
- `tryOAuthRefresh` / `OAUTH_TOKEN_URL` gone from `src/main/lib/credentials.cjs` (diff removes both); `refreshIfNeeded` now calls `tryCliFallback()` directly after the futile-refresh short-circuit.
- Post-fallback re-read returns `{kind:'ok'}` only if `!isExpired`; `cli_fallback_ok/failed` log events kept.
- Futile short-circuit unchanged; `credentials-futile-refresh.test.cjs` passes (1 OAuth stub line removed).
- `credentials-cli-refresh.test.cjs` present and passing; typecheck green.

## supervisor-probe-verdicts (1872) — VERIFIED
- `runProbe` args: `--model claude-haiku-5-5`, `--max-budget-usd 0.50` literals (`src/main/supervisor.cjs`).
- `parseProbeOutput` exported, returns `{verdictObj,costUsd,errorSubtype}`; runProbe resolves `probe_error:<subtype>` / verdict ok / action none.
- `supervisor-probe-parse.test.cjs` + `scheduler-supervisor-record.test.cjs` pass.

## config-watch-per-path-validation (1873) — VERIFIED
- `config.cjs:watch` try/catches per path, warns once per distinct path (`warnedRejectedPaths`), continues, returns `{watched,rejected}`.
- `activeSessions.cjs` `isSstHarnessCwd` drops `<tmpdir>/sst-*`, keeps non-sst tmp HOMEs.
- `config-watch-partial.test.cjs` passes (batch A, tmp path, B; sst drop / non-sst keep).

## needs-review-real-reason (1874) — VERIFIED
- `lib/scheduler/finalizeReason.cjs` `finalizeReasonFor`: sigterm override → already_satisfied reason → `needs_review: <verdict> — <reason>` → `run finished with exit N`; used at `scheduler.cjs` finalize site.
- `finalizeReason.test.cjs` passes.

## webremote-invalid-token-terminal (1875) — VERIFIED
- `webRemote.cjs:394-401`: `invalid_token`/`HTTP 401` → `cancelReconnect`, `_repairNeeded=true`, broadcast, no `scheduleReconnect`; one warn logged just above; other errors still `scheduleReconnect()`.
- Status exposes `linkState: 'repair-needed'`; flag cleared on successful ticket (`webRemote.cjs:405`) and at reset; `SettingsRemote.tsx` renders a plain-text hint; `api.d.ts` updated.
- `web-remote-invalid-token.test.cjs` passes; lint green.

## reconcile-flat-sweep-throttle (1876) — VERIFIED
- `flatSweepThrottle.cjs` exports `shouldRunFlatSweep` + `FLAT_SWEEP_INTERVAL_MS = 3_600_000`; `scheduler.cjs` gates `consolidateAllFlatPrds` on it, records `lastFlatSweepMs`, `phaseMs.flatPrdSweep = 0` when skipped; comment documents the one-interval guarantee.
- `flatSweepThrottle.test.cjs` passes.

## loop-stall-threshold (1877) — VERIFIED
- `loopDelay.cjs`: `LOOP_STALL_WARN_MS = 1000`; test updated (626 ms not a stall, 1500 ms is). grep of `src/main/scheduler.cjs`/loopDelay finds no leftover hard-coded 250 ms stall threshold.

## run-log-retention-default-on (1878) — VERIFIED
- `runLogRetention.cjs`: `DEFAULT_RUN_LOG_RETENTION` = enabled, 14 d, keep 3 (module's own key names `maxAgeDays`/`keepPerSlug`); `resolveRetentionConfig` falls back when setting absent; explicit `enabled:false` stays dry-run; live/running protections untouched (not in diff).
- `runLogRetention.test.cjs` passes (default-applies and explicit-false cases).

## atomic-tmp-boot-sweep (1879) — VERIFIED
- `atomicFs.cjs:sweepStaleTmpFiles`: direct children only, `/\.tmp-(\d+)-/`, mtime > 1 h, pid dead (kill -0 probe, EPERM = alive), skips `.corrupt`/`.bak`, never throws.
- `index.cjs` calls it on `~/.claude/session-manager` after ready, logs count at info.
- `atomicFs.test.cjs` passes (old+dead removed, fresh/live/.corrupt kept).

## watchdog-capped-alert-prune (1880) — VERIFIED
- `scripts/scheduler-watchdog.cjs`: `nextAlertState` alerts once on capped, re-arms on alive; `sendDesktopNotification` uses `notify-send`/`osascript` via `spawn` without shell, errors ignored; `shouldLogDecision` suppresses repeat alive lines (hourly heartbeat); `pruneOldLogs` / `selectPrunableLogs` 14-day, once per run.
- `watchdog-relaunch.test.cjs` + `watchdog-helpers.test.cjs` pass.

## telemetry-log-send-failures (1881) — VERIFIED
- `telemetryClient.cjs`: `telemetry send failed` {channel,status,consecutiveFailures,backoffMs} and `telemetry disabled for process` {status} via `logWarn`; flush catch logs `telemetry flush threw` with the error message. `telemetryClient.test.cjs` passes (503 and 400 cases).

## telemetry-notice-global-banner (1882) — VERIFIED
- `TelemetryNotice.tsx` carries the copy, OK / Turn off, `data-testid="telemetry-first-run-notice"`; `App.tsx` mounts `TelemetryNoticeBanner` once; hidden until config loads and when `noticeAckedAt` set; fixed corner banner on `Z.dialog` (`z-50`) < `Z.recording` (`z-[1000]`); no modal or focus trap. `SettingsTelemetry.tsx` reuses the component (−45/+… lines). No hooks below early return (`TelemetryNotice` has none; Banner returns after hooks). `TelemetryNotice.test.tsx` passes; lint green.

## Findings

### Critical
- none

### Important
- none

### Minor
1. `src/main/supervisor.cjs` (runProbe, ~error branch): the `probe_error:<subtype>` result is only taken when no verdict was parsed (`(!verdictObj || !verdictObj.verdict) && errorSubtype`). The 1872 AC reads "whenever is_error/subtype≠success"; a result with both an error subtype and an embedded verdict keeps the verdict. Arguably safer; noting the literal deviation.
2. `src/main/lib/scheduler/finalizeReason.cjs`: `sigtermOverrideReason` now beats the `already_satisfied_on_main` reason (previously the reverse). Matches the 1874 AC wording; behavior change only when both are set.
3. `src/main/lib/scheduler/runLogRetention.cjs:56-60`: policy key is `keepPerSlug`, not the AC's `keepPerPrd`; the AC explicitly allows the module's existing names.
4. `src/main/lib/credentials.cjs`: `writeKeychainRaw` / `writeCredentials` / `atomicFs` import were removed as dead code after the OAuth path went; not listed in the PRD but safe (typecheck/tests green).
5. Review hygiene: a stray 0-byte `<path>` file exists in the worktree (known sqlite-MCP placeholder, untracked, not part of any PRD).

Self-review of the diff (the /code-review skill was not run as a separate agent): no secrets, no `shell: true`, notification args passed as an array, sweep restricted to direct children with `lstat` + `isFile`, no path traversal introduced; `config:watch` still validates every path before watching.
