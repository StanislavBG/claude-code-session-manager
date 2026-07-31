/**
 * prdLocations.cjs — resolves per-project PRD-source directories.
 *
 * PRD 808 (1 of the 808→809→810→811 chain moving PRD storage out of the
 * single global `~/.claude/session-manager/scheduled-plans/prds/` into each
 * active project's own `<cwd>/session-manager-operations/scheduler/prds/`,
 * for consistency with how feedback and HUMAN_LEARN already scope
 * per-project operational state under `session-manager-operations/`.
 *
 * Global scheduler bookkeeping (queue.json, history.jsonl, runs/) is
 * untouched by this module — it only resolves where PRD *source* .md files
 * live. Active-project discovery reuses activeSessions.cjs's
 * activeProjectCwds (the same discovery watchdogHelpers.cjs's sweep() uses)
 * rather than re-implementing transcript scanning here.
 */
'use strict';

const path = require('node:path');
const { activeProjectCwds } = require('../../../scripts/lib/activeSessions.cjs');

const PRD_SUBPATH = ['session-manager-operations', 'scheduler', 'prds'];

/**
 * resolvePrdWriteDir(cwd) → `<cwd>/session-manager-operations/scheduler/prds`
 * Pure path join, no I/O. Throws on a missing/non-string cwd so a caller
 * never silently resolves a project-scoped path against `undefined`.
 */
function resolvePrdWriteDir(cwd) {
  if (!cwd || typeof cwd !== 'string') {
    throw new Error('resolvePrdWriteDir: cwd is required');
  }
  return path.join(cwd, ...PRD_SUBPATH);
}

/**
 * resolvePrdsDirs(maxAgeMin?, opts?) → string[]
 * One `<cwd>/session-manager-operations/scheduler/prds` dir per active
 * project cwd (activeProjectCwds' default window is 90 minutes). `opts` is
 * forwarded to activeProjectCwds (e.g. `projectsDir` override for tests).
 */
function resolvePrdsDirs(maxAgeMin, opts) {
  const cwds = activeProjectCwds(maxAgeMin, opts);
  return cwds.map(resolvePrdWriteDir);
}

module.exports = { resolvePrdWriteDir, resolvePrdsDirs, PRD_SUBPATH };
