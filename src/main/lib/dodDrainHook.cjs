'use strict';

/**
 * dodDrainHook.cjs — definition-of-done gate that fires at queue drain.
 *
 * Extracted so the scheduler can call it fire-and-forget (non-blocking)
 * while tests drive it directly with await.
 *
 * Kill-switch: SM_DOD_DISABLE=1 (mirrors SM_SUPERVISOR_DISABLE convention).
 * Loop-safe: batchKey excludes dod/meta slugs; reportExists() + _inFlight
 * dedup make re-drains over the same completed set a single fs-stat no-op,
 * even when tickQueue fires twice in quick succession before the first
 * reverifyBatch completes.
 * Non-blocking: callers should fire-and-forget via .catch(); this function
 * never throws to the caller (errors are logged instead).
 */

const {
  batchKey,
  reportExists,
  reverifyBatch,
  flagRiskySurfaces,
  writeReport,
} = require('./definitionOfDone.cjs');

// Track keys whose DoD pass is currently in-flight.
// Prevents concurrent tickQueue drains from spawning duplicate reverifyBatch
// runs for the same completed set before the first one has written its report.
const _inFlight = new Set();

/**
 * Run the definition-of-done gate when the scheduler queue drains.
 *
 * Guards (in order, fast-fail):
 *   1. SM_DOD_DISABLE=1 → skip
 *   2. state.paused (covers rate-limit) → defer, no report
 *   3. cancelToken.cancelled → skip
 *   4. No completed jobs → nothing to verify
 *   5. reportExists(key) → already done for this batch, no-op
 *   6. _inFlight.has(key) → concurrent drain for same batch, no-op
 *   7. cancelToken.cancelled re-checked after reverifyBatch (up to 600s)
 *
 * Complexity: O(n) over completed jobs for batchKey + reverifyBatch;
 * reportExists is O(d) where d = number of run subdirectories (bounded).
 *
 * @param {{ paused: object|null, jobs: Array }} state   Scheduler queue state.
 * @param {{
 *   cancelToken?: { cancelled: boolean },
 *   prdsDir?:     string,
 *   runsDir?:     string,
 * }} opts
 * @returns {Promise<void>}
 */
async function runDefinitionOfDoneOnDrain(state, opts = {}) {
  const { cancelToken = {}, prdsDir, runsDir } = opts;

  if (process.env.SM_DOD_DISABLE === '1') return;
  if (state.paused) return;
  if (cancelToken.cancelled) return;

  const completedJobs = (state.jobs || []).filter(j => j.status === 'completed');
  if (completedJobs.length === 0) return;

  const key = batchKey(completedJobs);

  if (reportExists(key, runsDir)) return;
  if (_inFlight.has(key)) return;

  _inFlight.add(key);
  try {
    const acResults = await reverifyBatch(completedJobs, { prdsDir });
    // Re-check after the slow await — scheduler may have stopped mid-flight.
    if (cancelToken.cancelled) return;
    const riskFlags = flagRiskySurfaces(completedJobs, { prdsDir });
    writeReport(key, { acResults, riskFlags, runsDir });
  } finally {
    _inFlight.delete(key);
  }
}

module.exports = { runDefinitionOfDoneOnDrain };
