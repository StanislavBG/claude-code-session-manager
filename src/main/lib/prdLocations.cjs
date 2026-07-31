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

const fs = require('node:fs');
const path = require('node:path');
const { activeProjectCwds, allProjectCwds } = require('../../../scripts/lib/activeSessions.cjs');

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
 *
 * Every `<cwd>/session-manager-operations/scheduler/prds` dir that actually
 * EXISTS on disk, across every project this machine has ever opened — plus
 * the currently-active projects' dirs even if they haven't been created yet
 * (write paths need a destination before the first PRD lands there).
 *
 * Deliberately NOT filtered by recency. This function answers "where do PRD
 * source files live", and a project being quiet says nothing about whether it
 * owns queued work. It used to return only activeProjectCwds' 90-minute
 * window, which made a quiet project's PRDs unscannable — and reconcile()
 * reads an unscannable PRD as a deleted one, silently dropping its queue row
 * (2026-07-31: 142 PRDs across 6 quiet projects). Recency stays where it
 * belongs: the feedback sweep, which genuinely only cares about live work.
 *
 * `maxAgeMin` is still honoured for the active-project half so existing
 * callers and tests keep their semantics; `opts` is forwarded to the
 * underlying scan (e.g. `projectsDir` override for tests).
 */
function resolvePrdsDirs(maxAgeMin, opts) {
  const dirs = [];
  const seen = new Set();
  const add = (dir) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    dirs.push(dir);
  };

  // Every historical project that has a PRD dir on disk — the set that
  // matters for discovery, regardless of when it was last touched.
  for (const cwd of allProjectCwds(opts)) {
    let dir;
    try { dir = resolvePrdWriteDir(cwd); } catch { continue; }
    if (fs.existsSync(dir)) add(dir);
  }

  // Active projects are added unconditionally: a brand-new project has no
  // prds/ dir yet, and callers that resolve a write destination must still
  // find it. Scans over a non-existent dir are a harmless ENOENT no-op.
  for (const cwd of activeProjectCwds(maxAgeMin, opts)) {
    try { add(resolvePrdWriteDir(cwd)); } catch { /* unusable cwd */ }
  }

  return dirs;
}

module.exports = { resolvePrdWriteDir, resolvePrdsDirs, PRD_SUBPATH };
