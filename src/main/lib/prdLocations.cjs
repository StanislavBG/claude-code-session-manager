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

const { opsPath, OPS_ROOT_DIR } = require('./opsOwnership.cjs');

// Segments UNDER the ops root; the ops root itself is resolved by
// opsOwnership.opsPath (PRD 1082) — never joined onto a raw cwd here.
const PRD_SUBPATH = ['scheduler', 'prds'];
const EPICS_SUBPATH = ['scheduler', 'epics'];
// Segment count from a project root to an epic's own dir: <ops-root> + EPICS_SUBPATH.
const EPICS_DEPTH_FROM_PROJECT = 1 + EPICS_SUBPATH.length;

/**
 * resolveEpicsRoot(cwd) → `<cwd>/session-manager-operations/scheduler/epics`
 * The per-project root under which every Epic keeps its own prds/ dir.
 */
function resolveEpicsRoot(cwd) {
  if (!cwd || typeof cwd !== 'string') {
    throw new Error('resolveEpicsRoot: cwd is required');
  }
  return opsPath(cwd, ...EPICS_SUBPATH);
}

/**
 * resolveEpicPrdWriteDir(cwd, epicId) →
 *   `<cwd>/session-manager-operations/scheduler/epics/<epicId>/prds`
 * The write destination for every NEW PRD. The flat legacy dir
 * (resolvePrdWriteDir) remains read-only during the transition — new PRDs
 * always belong to an Epic (auto-minted when the dispatch has none).
 */
function resolveEpicPrdWriteDir(cwd, epicId) {
  if (!epicId || typeof epicId !== 'string' || epicId.includes('/') || epicId.includes('..')) {
    throw new Error('resolveEpicPrdWriteDir: epicId must be a plain directory name');
  }
  return path.join(resolveEpicsRoot(cwd), epicId, 'prds');
}

/** Enumerate every existing `epics/<id>/prds` dir under one project cwd. */
function listEpicPrdDirs(cwd) {
  let root;
  try { root = resolveEpicsRoot(cwd); } catch { return []; }
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const dirs = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const prdDir = path.join(root, ent.name, 'prds');
    if (fs.existsSync(prdDir)) dirs.push(prdDir);
  }
  return dirs;
}

/**
 * Every `prds-archived/` dir for one project cwd: the retired flat layout's
 * sibling archive plus each Epic's own sibling archive. Consumed by the
 * scheduler's archived-twin stale-queue-row guard, so a PRD archived under
 * its Epic (the layout every new PRD uses) is still found.
 */
function listArchivedPrdDirs(cwd) {
  let dirs;
  try { dirs = [opsPath(cwd, ...PRD_SUBPATH, '..', 'prds-archived')]; } catch { return []; }
  let root;
  try { root = resolveEpicsRoot(cwd); } catch { return dirs; }
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return dirs; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const archiveDir = path.join(root, ent.name, 'prds-archived');
    if (fs.existsSync(archiveDir)) dirs.push(archiveDir);
  }
  return dirs;
}

/**
 * resolvePrdWriteDir(cwd) → `<cwd>/session-manager-operations/scheduler/prds`
 * Pure path join, no I/O. Throws on a missing/non-string cwd so a caller
 * never silently resolves a project-scoped path against `undefined`.
 */
function resolvePrdWriteDir(cwd) {
  if (!cwd || typeof cwd !== 'string') {
    throw new Error('resolvePrdWriteDir: cwd is required');
  }
  return opsPath(cwd, ...PRD_SUBPATH);
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
    // Epic-scoped dirs (the write layout for all new PRDs) are first-class
    // scan sources alongside the legacy flat dir.
    for (const epicDir of listEpicPrdDirs(cwd)) add(epicDir);
  }

  // Active projects are added unconditionally: a brand-new project has no
  // prds/ dir yet, and callers that resolve a write destination must still
  // find it. Scans over a non-existent dir are a harmless ENOENT no-op.
  for (const cwd of activeProjectCwds(maxAgeMin, opts)) {
    try { add(resolvePrdWriteDir(cwd)); } catch { /* unusable cwd */ }
    for (const epicDir of listEpicPrdDirs(cwd)) add(epicDir);
  }

  return dirs;
}

/**
 * resolveArchivedPrdsDirs(maxAgeMin?, opts?) → string[]
 *
 * The `prds-archived/` counterpart of resolvePrdsDirs — every archive dir
 * (the flat per-project sibling plus each Epic's own sibling, per
 * listArchivedPrdDirs) that exists on disk, across every historical AND
 * currently-active project. Same "not recency-filtered" rationale as
 * resolvePrdsDirs: a quiet project's completed-PRD history is still real
 * history, not something list-prds should stop counting.
 */
function resolveArchivedPrdsDirs(maxAgeMin, opts) {
  const dirs = [];
  const seen = new Set();
  const add = (dir) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    dirs.push(dir);
  };

  for (const cwd of allProjectCwds(opts)) {
    for (const dir of listArchivedPrdDirs(cwd)) {
      if (fs.existsSync(dir)) add(dir);
    }
  }
  for (const cwd of activeProjectCwds(maxAgeMin, opts)) {
    for (const dir of listArchivedPrdDirs(cwd)) {
      if (fs.existsSync(dir)) add(dir);
    }
  }

  return dirs;
}

/**
 * deriveEpicIdFromPrdPath(filePath) → epicId | null
 *
 * A PRD's file location already IS its Epic membership (epic id == parent
 * dir name, 1:1 by design). Given an absolute PRD file path, walk back up
 * `EPICS_SUBPATH.length` segments from the epics root implied by the path's
 * own `.../prds/<slug>.md` shape and confirm it round-trips through
 * `resolveEpicsRoot` — i.e. the path really is
 * `<projectCwd>/session-manager-operations/scheduler/epics/<epicId>/prds/<slug>.md`,
 * not some other `prds/` dir (e.g. the retired flat layout). Returns null for
 * any path that doesn't match this shape.
 */
function deriveEpicIdFromPrdPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const prdsDir = path.dirname(filePath);
  // Accept both an Epic's live `prds/` dir and its sibling `prds-archived/`
  // dir — archived PRDs still belong to the Epic they were dispatched from,
  // and callers (parsePrdRaw, list-prds) need epicId for archived files too.
  const dirName = path.basename(prdsDir);
  if (dirName !== 'prds' && dirName !== 'prds-archived') return null;
  const epicDir = path.dirname(prdsDir);
  const epicId = path.basename(epicDir);
  if (!epicId || epicId === '.' || epicId === path.sep) return null;
  let projectCwd = path.dirname(epicDir); // epicsRoot (.../scheduler/epics)
  for (let i = 0; i < EPICS_DEPTH_FROM_PROJECT; i++) projectCwd = path.dirname(projectCwd);
  let epicsRoot;
  try { epicsRoot = resolveEpicsRoot(projectCwd); } catch { return null; }
  if (path.join(epicsRoot, epicId, dirName) !== prdsDir) return null;
  return epicId;
}

module.exports = {
  resolvePrdWriteDir,
  resolvePrdsDirs,
  resolveArchivedPrdsDirs,
  resolveEpicsRoot,
  resolveEpicPrdWriteDir,
  listEpicPrdDirs,
  listArchivedPrdDirs,
  deriveEpicIdFromPrdPath,
  PRD_SUBPATH,
  EPICS_SUBPATH,
};
