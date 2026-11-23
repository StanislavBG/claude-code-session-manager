'use strict';
// @ts-check

/**
 * cancelledRow — the ONE definition of "did a human cancel this queue row?"
 * Pure, requires nothing, so every layer (scheduler, queueOps, lib/epic,
 * lib/prd) can import it without dragging in scheduler deps.
 *
 * The rule: a row is cancelled when its status is a cancel status AND at
 * least one cancel marker holds.
 *
 * Why two statuses: remote.cancelJob (scheduler.cjs) parks a cancelled row as
 * 'failed', except when the killed run's landedCommit resolves — then it parks
 * 'needs_review' so the landed work is verified before anyone trusts it. Both
 * are a human cancel. Any other status (pending, running, completed, …) is
 * never cancelled, even if it still carries a stale marker.
 *
 * Why three markers (any one is enough):
 *  1. `cancelledAt` (non-empty string) — stamped by remote.cancelJob (and its
 *     dependents cascade) since 2026-10-19; the primary marker.
 *  2. The newest statusHistory entry whose `to` equals the row's current
 *     status has source 'remote:cancelJob' — covers rows cancelled before
 *     `cancelledAt` existed. Only the newest matching entry counts, so a row
 *     cancelled, reset, then failed for real reads as a real failure.
 *  3. `error` starts with 'cancelled via admin API' — the oldest rows, which
 *     carry neither of the above.
 *
 * A revived row never reads as cancelled: resetJobFields deletes `cancelledAt`
 * and overwrites `error`, and the reset moves status off failed/needs_review.
 */

/** Statuses remote.cancelJob writes for a cancelled row. */
const CANCEL_STATUSES = new Set(['failed', 'needs_review']);
/** statusHistory source remote.cancelJob stamps. */
const CANCEL_SOURCE = 'remote:cancelJob';
/** Prefix of every error string remote.cancelJob writes. */
const CANCEL_ERROR_PREFIX = 'cancelled via admin API';

/**
 * @param {unknown} row a queue row (ScheduleJob-shaped) or anything else
 * @returns {boolean} true only for a human-cancelled row
 */
function isCancelledRow(row) {
  if (!row || typeof row !== 'object') return false;
  const r = /** @type {Record<string, any>} */ (row);
  if (!CANCEL_STATUSES.has(r.status)) return false;
  if (typeof r.cancelledAt === 'string' && r.cancelledAt.length > 0) return true;
  if (typeof r.error === 'string' && r.error.startsWith(CANCEL_ERROR_PREFIX)) return true;
  const hist = Array.isArray(r.statusHistory) ? r.statusHistory : [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (h && h.to === r.status) return h.source === CANCEL_SOURCE;
  }
  return false;
}

module.exports = { isCancelledRow, CANCEL_STATUSES, CANCEL_SOURCE, CANCEL_ERROR_PREFIX };
