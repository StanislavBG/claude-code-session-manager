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
 *
 * CACHING NOTE (PRD adding mtime-keyed memoization to this module): what's
 * cached here is only WHICH DIRECTORIES EXIST, never their CONTENTS. A new
 * PRD .md file dropped into an already-known `prds/` dir does not change
 * that dir's own existence, so it needs no cache invalidation here at all —
 * `schedule:rescan` (scheduler.cjs's `ipcMain.handle('schedule:rescan', …)`)
 * still reports it because the actual file-listing happens one layer down,
 * in scheduler/prdParser.cjs's `listPrdFiles(dir)`, which has its OWN
 * separate mtime cache keyed on that specific dir's mtime (bumped by the new
 * file) and is unaffected by anything cached in this module.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { activeProjectCwds, allProjectCwds } = require('./activeSessions.cjs');

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

// listEpicPrdDirs' readdir-the-Epics-root-plus-existsSync-per-subdir walk is
// the expensive half of prdLocations' per-reconcile()-pass cost (159/166
// dirs, ~430ms/~400ms measured). A new Epic's prds/ dir is always created in
// the SAME recursive mkdirSync call that creates `epics/<newId>/` itself
// (epicMint.cjs's ensureEpic, both the mint branch and the join branch's
// belt-and-suspenders mkdirSync) — so a brand-new `epics/<id>/prds` dir
// first coming into existence always bumps the Epics root's OWN mtime (a
// new directory entry under it), never just an existing subdir's mtime.
// Cache keyed on that mtime, same dir-mtime idiom as
// scheduler/prdParser.cjs's dirCache — no TTL, so the very next call after a
// mint sees the new dir with no wait.
const epicPrdDirsCache = new Map(); // epicsRootPath -> { mtimeMs, result }

/** Enumerate every existing `epics/<id>/prds` dir under one project cwd. */
function listEpicPrdDirs(cwd) {
  let root;
  try { root = resolveEpicsRoot(cwd); } catch { return []; }
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(root).mtimeMs;
  } catch {
    // Missing/unreadable root: nothing to scan, and any prior cache entry
    // must not survive to be handed back once the dir later appears.
    epicPrdDirsCache.delete(root);
    return [];
  }
  const cached = epicPrdDirsCache.get(root);
  if (cached && cached.mtimeMs === mtimeMs) return cached.result;

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    epicPrdDirsCache.delete(root);
    return [];
  }
  const dirs = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const prdDir = path.join(root, ent.name, 'prds');
    if (fs.existsSync(prdDir)) dirs.push(prdDir);
  }
  epicPrdDirsCache.set(root, { mtimeMs, result: dirs });
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

// resolvePrdsDirs/resolveArchivedPrdsDirs each redo a fs.existsSync(dir) +
// listEpicPrdDirs(cwd) walk across EVERY project on every call, and
// reconcile() calls each of them once per pass. Cache the assembled result
// keyed on the caller's own (maxAgeMin, opts) tuple — a call with an
// explicit `{ projectsDir }` opts object is a DIFFERENT key from the
// no-opts default, so the two never read or write each other's entry — PLUS
// a freshness key built from every visited project's Epics-root mtimeMs,
// same composite-mtime-key idiom as queueHistory.cjs's historyCacheKey. The
// freshness key is cheap to rebuild every call (one statSync per project,
// far cheaper than the readdir+existsSync-per-Epic walk it guards), so a
// cache hit still costs O(projects) stats but skips the expensive walk
// entirely — "one filesystem walk" per reconcile() pass, not the full
// listEpicPrdDirs cost N times over.
//
// The Epics-root mtime alone has a real blind spot: `prds-archived/` is
// created (archiveCompletedPrd, scheduler.cjs) as a NEW entry INSIDE an
// ALREADY-EXISTING `epics/<id>/` dir — unlike a brand-new Epic's `prds/`,
// which is always created in the SAME mkdirSync call as `epics/<id>/`
// itself (see listEpicPrdDirs's header), that does not bump the Epics
// root's own mtime. Re-stating every Epic subdirectory's own mtime on every
// call to close that gap would cost about what the walk itself costs,
// defeating the cache — so this cache pairs the mtime key (instant
// invalidation for the case the non-negotiable freshness test covers: a
// brand-new Epic's `prds/` dir) with the SAME short TTL backstop
// src/main/lib/activeSessions.cjs's cwdScanCache already established for
// this exact module chain, bounding the archived-dir blind spot to one
// TTL window instead of leaving it stale indefinitely. Nothing reads
// resolveArchivedPrdsDirs off the dispatch-correctness path — the
// archived-twin stale-queue-row guard (scheduler.cjs's archivedTwinExists)
// calls listArchivedPrdDirs directly, uncached — so this is purely a
// reporting-freshness bound (schedule:list-prds's per-Epic PRD/run counts).
// Above the 60 s dispatch-loop interval (scheduler POLL_INTERVAL_MS).
const ASSEMBLED_DIRS_CACHE_TTL_MS = 120_000;
const assembledPrdsDirsCache = new Map(); // callerKey -> { freshnessKey, cachedAt, result }
const assembledArchivedPrdsDirsCache = new Map();

// Sorted-keys JSON.stringify: a plain JSON.stringify(opts) would key
// { a: 1, b: 2 } and { b: 2, a: 1 } as two different cache entries — a real
// (if currently latent, since every caller today passes at most one opts
// key) correctness trap for a cache key.
function stableStringify(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function callerOptsKey(maxAgeMin, opts) {
  return `${maxAgeMin}::${opts ? stableStringify(opts) : ''}`;
}

// mtimeMs of each visited project's Epics root, joined into one string. Any
// project whose root doesn't exist/isn't readable contributes a stable
// sentinel so the key still changes the moment that root is created.
function epicsRootsFreshnessKey(cwds) {
  return cwds
    .map((cwd) => {
      let root;
      try { root = resolveEpicsRoot(cwd); } catch { return `${cwd}:noroot`; }
      try { return `${root}:${fs.statSync(root).mtimeMs}`; } catch { return `${root}:-1`; }
    })
    .join('|');
}

function memoizedAssembledDirs(cache, maxAgeMin, opts, compute) {
  const callerKey = callerOptsKey(maxAgeMin, opts);
  const allCwds = allProjectCwds(opts);
  const activeCwds = activeProjectCwds(maxAgeMin, opts);
  const cwdUnion = [...new Set([...allCwds, ...activeCwds])];
  const freshnessKey = `${allCwds.join(',')}#${activeCwds.join(',')}#${epicsRootsFreshnessKey(cwdUnion)}`;

  const cached = cache.get(callerKey);
  if (cached && cached.freshnessKey === freshnessKey && Date.now() - cached.cachedAt < ASSEMBLED_DIRS_CACHE_TTL_MS) {
    return cached.result;
  }

  const result = compute(allCwds, activeCwds);
  if (Array.isArray(result)) Object.freeze(result);
  cache.set(callerKey, { freshnessKey, cachedAt: Date.now(), result });
  return result;
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
  return memoizedAssembledDirs(assembledPrdsDirsCache, maxAgeMin, opts, (allCwds, activeCwds) => {
    const dirs = [];
    const seen = new Set();
    const add = (dir) => {
      if (seen.has(dir)) return;
      seen.add(dir);
      dirs.push(dir);
    };

    // Every historical project that has a PRD dir on disk — the set that
    // matters for discovery, regardless of when it was last touched.
    for (const cwd of allCwds) {
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
    for (const cwd of activeCwds) {
      try { add(resolvePrdWriteDir(cwd)); } catch { /* unusable cwd */ }
      for (const epicDir of listEpicPrdDirs(cwd)) add(epicDir);
    }

    return dirs;
  });
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
  return memoizedAssembledDirs(assembledArchivedPrdsDirsCache, maxAgeMin, opts, (allCwds, activeCwds) => {
    const dirs = [];
    const seen = new Set();
    const add = (dir) => {
      if (seen.has(dir)) return;
      seen.add(dir);
      dirs.push(dir);
    };

    for (const cwd of allCwds) {
      for (const dir of listArchivedPrdDirs(cwd)) {
        if (fs.existsSync(dir)) add(dir);
      }
    }
    for (const cwd of activeCwds) {
      for (const dir of listArchivedPrdDirs(cwd)) {
        if (fs.existsSync(dir)) add(dir);
      }
    }

    return dirs;
  });
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

/**
 * deriveProjectCwdFromPrdPath(filePath) → projectCwd | null
 *
 * The inverse of resolvePrdWriteDir/resolveEpicPrdWriteDir: given an absolute
 * PRD file path (flat `prds/`, Epic-scoped `epics/<id>/prds/`, or either's
 * `prds-archived/` sibling), returns the project root it was discovered
 * under — by finding the `session-manager-operations` segment and validating
 * the path round-trips back through the same resolver it walked up from.
 * Returns null for anything that doesn't match one of those shapes (never
 * guesses). Used by reconcile()'s fresh-discovery path so a PRD file with no
 * `cwd:` frontmatter still gets a real project cwd instead of null (which
 * would otherwise fall through to schedulerBatch.js's DEFAULT_PROJECT_CWD
 * and relocate the row into the wrong project's queue.json shard).
 */
function deriveProjectCwdFromPrdPath(filePath) {
  if (!filePath || typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null;
  const segments = filePath.split(path.sep);
  const opsIdx = segments.lastIndexOf(OPS_ROOT_DIR);
  if (opsIdx <= 0) return null;
  const projectCwd = segments.slice(0, opsIdx).join(path.sep);
  const prdsDir = path.dirname(filePath);
  const dirName = path.basename(prdsDir);
  if (dirName !== 'prds' && dirName !== 'prds-archived') return null;
  if (dirName === 'prds') {
    try {
      if (resolvePrdWriteDir(projectCwd) === prdsDir) return projectCwd;
    } catch { /* fall through to the Epic-scoped check below */ }
  }
  if (dirName === 'prds-archived') {
    // Flat legacy archive sibling of resolvePrdWriteDir's flat `prds/` (see
    // listArchivedPrdDirs' first entry: opsPath(cwd, ...PRD_SUBPATH, '..',
    // 'prds-archived')) — round-trip it the same way the flat `prds` branch
    // above does, before falling through to the Epic-scoped check (which
    // can never match a flat path: deriveEpicIdFromPrdPath requires an
    // `epics/<id>/` segment a flat archive dir doesn't have).
    try {
      if (opsPath(projectCwd, ...PRD_SUBPATH, '..', 'prds-archived') === prdsDir) return projectCwd;
    } catch { /* fall through to the Epic-scoped check below */ }
  }
  const epicId = deriveEpicIdFromPrdPath(filePath);
  if (epicId) return projectCwd;
  return null;
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
  deriveProjectCwdFromPrdPath,
  PRD_SUBPATH,
  EPICS_SUBPATH,
};
