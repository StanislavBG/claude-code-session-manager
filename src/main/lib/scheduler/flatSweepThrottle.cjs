'use strict';

/** Retired flat `scheduler/prds/` sweep runs at most once per hour per process. */
const FLAT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * @param {number} nowMs
 * @param {number | null} lastRunMs null = never ran this process (always run)
 * @param {number} [intervalMs]
 * @returns {boolean}
 */
function shouldRunFlatSweep(nowMs, lastRunMs, intervalMs = FLAT_SWEEP_INTERVAL_MS) {
  if (lastRunMs === null || lastRunMs === undefined) return true;
  return nowMs - lastRunMs >= intervalMs;
}

module.exports = { shouldRunFlatSweep, FLAT_SWEEP_INTERVAL_MS };
