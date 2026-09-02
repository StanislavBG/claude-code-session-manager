'use strict';

/**
 * queueHealth.cjs — pure per-project rollup for the periodic queue-health
 * sweep (PRD 1109). Kept separate from scheduler.cjs so it can be unit
 * tested without importing electron/ipcMain, matching reaperHelpers.cjs.
 */

// Non-terminal statuses that mean a row is parked waiting on a human rather
// than actively progressing (pending/running are expected to move on their
// own; investigating is mid-flight and already tracked by
// findStrandedInvestigations).
const STUCK_STATUSES = new Set(['needs_review', 'quarantined']);

/**
 * computeQueueHealth(jobs) → [{ cwd, neverRan, looksDone, stuck }]
 *
 * Read-only: never mutates a row. Counts, per project cwd, how many rows
 * carry `gateOutcome === 'never_ran'`, how many carry a `looksDone`
 * annotation, and how many sit in a stuck (parked, non-terminal) status.
 * Only projects with a non-zero total are returned — the sweep logs one
 * line per non-zero project, nothing for a clean queue.
 */
function computeQueueHealth(jobs) {
  const byCwd = new Map();
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!j) continue;
    const cwd = j.cwd || '(unknown)';
    if (!byCwd.has(cwd)) byCwd.set(cwd, { cwd, neverRan: 0, looksDone: 0, stuck: 0 });
    const bucket = byCwd.get(cwd);
    if (j.gateOutcome === 'never_ran') bucket.neverRan += 1;
    if (j.looksDone) bucket.looksDone += 1;
    if (STUCK_STATUSES.has(j.status)) bucket.stuck += 1;
  }
  return [...byCwd.values()].filter((b) => b.neverRan + b.looksDone + b.stuck > 0);
}

module.exports = { computeQueueHealth, STUCK_STATUSES };
