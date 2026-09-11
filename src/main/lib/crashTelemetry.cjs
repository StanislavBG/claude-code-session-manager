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

module.exports = { reportCrash };
