/**
 * refireCap.cjs — pure decision for a job the post-run verifier downgraded
 * back to `pending` (verdict `halt` / `deps_unmet`).
 *
 * Why: scheduler.cjs re-fired such jobs with no counter, so any verifier
 * disagreement re-ran a billed `claude -p` forever (Bilko-Launch-Kit,
 * 2026-10-11: 125 runs, 846 turns, $28 in 3.5 hours). This helper decides,
 * from the job's consecutive-downgrade count, whether to re-fire or park.
 *
 * Pure: no I/O, no mutation of inputs. Complexity O(1).
 */

'use strict';

/** Max consecutive post-run downgrades that are still re-fired. */
const MAX_CONSECUTIVE_VERIFY_REFIRES = 2;

/**
 * @param {{ verifyRefireCount?: unknown }} job
 * @param {{ verdict?: string, reason?: string }} verifyResult
 * @param {{ cap?: number }} [opts]
 * @returns {{ action: 'refire', nextCount: number }
 *   | { action: 'park', nextCount: number, verdict: 'refire_capped', reason: string }}
 */
function decideVerifyDowngrade(job, verifyResult, { cap = MAX_CONSECUTIVE_VERIFY_REFIRES } = {}) {
  const raw = job && job.verifyRefireCount;
  const count = Number.isInteger(raw) && raw > 0 ? raw : 0;
  const nextCount = count + 1;
  const effectiveCap = Math.max(0, cap);
  if (nextCount <= effectiveCap) return { action: 'refire', nextCount };
  const vr = verifyResult || {};
  return {
    action: 'park',
    nextCount,
    verdict: 'refire_capped',
    reason: `re-fire cap: ${nextCount} consecutive post-run downgrades (${vr.verdict}: ${vr.reason})`,
  };
}

module.exports = { MAX_CONSECUTIVE_VERIFY_REFIRES, decideVerifyDowngrade };
