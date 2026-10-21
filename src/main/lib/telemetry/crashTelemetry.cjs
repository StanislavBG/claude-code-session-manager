'use strict';

/**
 * crashTelemetry.cjs — the electron-free tap crashDiagnostics.cjs's
 * render-process-gone / child-process-gone hooks and unclean-shutdown
 * postmortem call into. Split out so it's unit-testable under plain vitest —
 * crashDiagnostics.cjs itself requires 'electron' at module scope (it always
 * has; that's why it has never had a unit test), so the tap logic lives here
 * instead of inline in that file.
 *
 * Named 'crash.<reason>' so an OOM report (reason: 'oom'), a renderer segfault
 * (reason: 'crashed'), and the unclean-shutdown postmortem (reason:
 * 'unclean-shutdown') are distinguishable in aggregate without parsing free
 * text. telemetryClient.reportError already stamps the full attribution
 * (appVersion/platform/arch/machineDigest) on every record — that's the
 * whole reason this module exists: these reports are frequently the ONLY
 * thing ever received from a machine that just got OOM-killed, so losing the
 * build/spec attribution on them is close to useless.
 */

function reportCrash({ reason, meta, deps } = {}) {
  try {
    const telemetryClient = (deps && deps.telemetryClient) || require('./telemetryClient.cjs');
    // Returned (not awaited here) so callers/tests can await delivery
    // acceptance; telemetryClient.reportError is itself fail-inert, so a
    // rejected/throwing implementation still can't escape this try/catch.
    return telemetryClient.reportError({
      name: `crash.${reason || 'unknown'}`,
      msg: String(reason || 'unknown'),
      context: meta || {},
    });
  } catch {
    return undefined; // crash diagnostics must never break on a telemetry failure
  }
}

// A 10 s+ main-loop stall means the main thread was wedged (the 2026-10-19
// hang death showed 23 s stalls at 972 MB, far below any memory pressure), so
// a stall outranks memory when picking the likely cause.
const HANG_LOOP_DELAY_MS = 10000;
const MEMORY_PRESSURE_MB = 3000;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Turns the previous run's last sample into a likely cause. silentGapSec is
 * accepted for the caller's meta but does not change the verdict.
 * @param {{ lastLoopDelayMaxMs?: unknown, lastTotalMb?: unknown, silentGapSec?: unknown }} [sample]
 * @returns {'main-hang' | 'memory-pressure' | 'unknown'}
 */
function classifyUncleanShutdown({ lastLoopDelayMaxMs, lastTotalMb } = {}) {
  if (isNum(lastLoopDelayMaxMs) && lastLoopDelayMaxMs >= HANG_LOOP_DELAY_MS) return 'main-hang';
  if (isNum(lastTotalMb) && lastTotalMb >= MEMORY_PRESSURE_MB) return 'memory-pressure';
  return 'unknown';
}

/**
 * Routes a Chromium child-process-gone event. Chromium restarts the Utility
 * 'Network Service' itself, so a non-oom exit there is a warn log line; all
 * else is a crash error via reportCrash. Fail-inert: never throws.
 */
function reportChildProcessGone({ details, lastTotalMb, deps } = {}) {
  try {
    const d = details || {};
    const type = d.type;
    const name = d.name || d.serviceName;
    if (type === 'Utility' && name === 'Network Service' && d.reason !== 'oom') {
      const telemetryClient = (deps && deps.telemetryClient) || require('./telemetryClient.cjs');
      return telemetryClient.logLine({
        level: 'warn',
        msg: 'crash.child-restartable',
        fields: { type, name, reason: d.reason, exitCode: d.exitCode, lastTotalMb },
      });
    }
    return reportCrash({
      reason: d.reason || 'unknown',
      meta: { type, name, exitCode: d.exitCode, lastTotalMb },
      deps,
    });
  } catch {
    return undefined;
  }
}

module.exports = { reportCrash, classifyUncleanShutdown, reportChildProcessGone };
