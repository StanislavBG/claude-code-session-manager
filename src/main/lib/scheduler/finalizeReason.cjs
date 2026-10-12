'use strict';

/**
 * finalizeReason.cjs — the statusHistory reason for a job's running→terminal
 * finalize transition. Pure; no I/O.
 */

/**
 * @param {{
 *   effectiveStatus: string,
 *   verifyResult?: { verdict?: string, reason?: string } | null,
 *   sigtermOverrideReason?: string | null,
 *   exitCode?: number | null,
 * }} input
 * @returns {string}
 */
function finalizeReasonFor({ effectiveStatus, verifyResult, sigtermOverrideReason, exitCode }) {
  if (sigtermOverrideReason) return sigtermOverrideReason;
  if (effectiveStatus === 'completed' && verifyResult?.verdict === 'already_satisfied_on_main') {
    return String(verifyResult.reason);
  }
  if (effectiveStatus === 'needs_review' && verifyResult?.verdict) {
    return verifyResult.reason
      ? `needs_review: ${verifyResult.verdict} — ${verifyResult.reason}`
      : `needs_review: ${verifyResult.verdict}`;
  }
  return `run finished with exit ${exitCode}`;
}

module.exports = { finalizeReasonFor };
