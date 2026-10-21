# Validation: telemetry error triage (plans 2082, 2083, 2085, 2086, 2087)

Base: a3c9cdc1 (from PRD notes). Commits: cdec107d (2082), 14e8ccf8 (2083), f1ddf934 + 0ee5e7ce (2085), bb72aa42 (2086), 8795c230 (2087).
Gates re-run (scratch TMPDIR, SM_CHAT_CONCURRENCY unset): vitest on opsErrorLogTelemetryTap, opsErrorLog, crashTelemetry, delegationReadiness, chat-cancel-terminal, chatRunner-session-flag-retry, crashDiagnostics-crashpad = 7 files / 101 tests pass; `npm run typecheck` exit 0.
PRD files found in prds-archived/. Review: self-review of the combined diff (no new secrets, no path handling added, `code` is regex-validated before reaching logs/telemetry).

## 2082 ops-error-level-routing-and-code — VERIFIED
- opsErrorLog.cjs:121 `if (level !== 'error' && level !== 'warn') return;`; warn -> logLine (≈:139), else reportError; writeLocalLine untouched by level.
- CODE_RE/normalizeCode at :49-53; invalid dropped, never thrown; local line gets `code` + `code:<code>` tag (:68,:79); context.code (:136).
- Label `opsError:<scope>:<code>` at :133; message stays under `message` only.
- Tests added in opsErrorLogTelemetryTap.test.cjs (+68 lines); pass.

## 2083 crash-telemetry-classify-helpers — VERIFIED
- crashTelemetry.cjs: classifyUncleanShutdown (>=10000 main-hang, >=3000 memory-pressure, else unknown; non-numbers ignored); reportChildProcessGone routes Utility/Network Service non-oom to logLine warn `crash.child-restartable`, else reportCrash; try/catch inert; reportCrash unchanged; both exported.
- Tests +70 lines pass.

## 2087 chatrunner-ops-error-classification — VERIFIED
- chatRunner.cjs:500 emitTerminal(channel,payload,diag={}); appendError gets level/code (:510-511); payload not mutated.
- ceiling kill {warn,'ceiling-kill'} (:682); cancel {info,'cancelled'} (:899); spawn-failed, result-error, child-error, session-flag-rejected, exit-no-result, stdout-line-overflow all present; plan.code path (:580) falls back to payload.code. All 7 chat:run:error sites covered (grep).
- chat-cancel-terminal.test.cjs +22 lines pass.

## 2085 delegation-readiness-ops-error-code — VERIFIED
- delegationReadiness.cjs:674 `code: guard-install-${action}:${guard}`; levels unchanged; logAutoInstallEvent exported (:800). Test +15 lines passes.

## 2086 crash-diag-wire-classification — VERIFIED
- crashDiagnostics.cjs: sentinel `loop` payload from lastLoop set in heartbeat (:144,:157); checkPreviousRun computes silentGapSec/likelyCause (:189-192), added to both meta objects; message `previous session ended UNCLEANLY (likelyCause=...; no graceful quit)`; hint mentions journalctl and main-loop stall; child-process-gone calls reportChildProcessGone (:260); render-process-gone untouched.

## Findings
### Critical
- none
### Important
- none
### Minor
- crashDiagnostics.cjs:190 silentGapSec is `undefined` rather than computed when lastSample.ts is missing/unparseable (reasonable; PRD silent on it).
- crashDiagnostics.cjs has no unit coverage (per PRD, by design); its wiring was verified by reading only.
- opsErrorLog.cjs:96-101 doc comment line is overlong (cosmetic).
