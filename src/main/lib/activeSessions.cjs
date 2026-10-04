'use strict';

// activeSessions.cjs — returns distinct on-disk project cwds with an active
// session within maxAgeMin minutes. Used by the feedback sweep (PRD 102) to
// narrow scanning to projects the user is actually working in.
//
// Detection is transcript-based only (scans ~/.claude/projects/*/*.jsonl
// mtimes). It has zero dependency on ~/.claude/knowledge-log/prompts.jsonl,
// which PRD 356-retire purges along with its capture hook.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { KIND_CONFIG: WORKTREE_KIND_CONFIG } = require('./gitWorktree.cjs');
const { OPS_ROOT_DIR } = require('./opsOwnership.cjs');
const { classifyCwd, worktreeMainRootOf } = require('./cwdClassify.cjs');

const HOME = os.homedir();
const TMPDIR = os.tmpdir();

// The last-resort drop targets for addCwd's tmp guard.
//   - exactDropCwds: dropped only on an EXACT match — os.tmpdir() itself
//     (e.g. `/tmp`). NOT a prefix match: this codebase's own test suite
//     routinely stubs HOME to a tmp dir and nests a fake project cwd
//     underneath it, a legitimate, unrelated use of os.tmpdir() that a
//     blanket prefix match would wrongly drop.
//   - prefixDropRoots: dropped on an exact match OR any nested path — the two
//     managed worktree roots (both live under os.tmpdir() per gitWorktree
//     .cjs's KIND_CONFIG). Nothing but managed worktree checkouts is ever
//     created under these roots, so a prefix match here is safe. A resolvable
//     worktree (managed or user-made, anywhere on disk) is already handled by
//     worktreeMainRootOf above; this guard only catches what that resolution
//     could not — e.g. a bare, .git-less worktree-root directory.
const TMP_DROP_ROOTS = {
  exactDropCwds: [TMPDIR],
  get prefixDropRoots() { return [WORKTREE_KIND_CONFIG.job.root, WORKTREE_KIND_CONFIG.epic.root]; },
};

// Transcript reads only need the last line with a `cwd` field — a few dozen
// lines is always enough. 64 KB keeps peak RSS proportionate.
const TAIL_BYTES = 64 * 1024;

// Safety cap on distinct cwds to bound result set size. O(1) extra space.
const MAX_CWDS = 50;

// The disk scan (readdirSync of every dir under ~/.claude/projects — 2209
// dirs / 8.8 GB observed — plus a statSync per transcript, ~270 ms warm) is
// the expensive part. allProjectCwds() and activeProjectCwds() used to each
// pay their own full scan under separate (projectsDir, maxAgeMin, maxCwds)
// cache keys even though they read the same on-disk facts. Now the scan runs
// ONCE per projectsDir and is cached as a flat per-project record
// {rawCwd, newestMtimeMs}; every view (any maxAgeMin/maxCwds combination)
// filters/sorts that one record in memory instead of touching disk again.
//
// Invalidation: projectsDir's own mtime (bumps when a project DIRECTORY is
// added/removed — NOT when an existing transcript gains a line, which is
// fine: a project already in the list stays in the list) plus a short TTL
// as the backstop for everything else. Same mtime-keyed idiom as
// scheduler/prdParser.cjs's dirCache and queueHistory.cjs's historyCacheKey.
// TTL sits above the 60 s dispatch-loop interval (scheduler POLL_INTERVAL_MS) so
// one pass never re-scans cold. Cached arrays are frozen — shared, never mutated.
// Stale-while-revalidate: once a projectsDir has been scanned at least once,
// an expired cache entry is served to the (synchronous) caller as-is, and at
// most one background fs.promises rescan is kicked off to refresh it. Only
// the very first scan of a given projectsDir pays the synchronous cost —
// every expiry after that is a cache read plus a fire-and-forget refresh.
const CACHE_TTL_MS = 120_000;
// Bounds how many project dirs the async rescan reads concurrently.
const RESCAN_CONCURRENCY = 32;
const EMPTY_CWDS = Object.freeze([]);
const rawScanCache = new Map(); // projectsDir -> { dirMtimeMs, cachedAt, records, refreshPromise }

/** Forces the next activeProjectCwds/allProjectCwds call to rescan. */
function bustProjectCwdCache() {
  rawScanCache.clear();
}

// The ops-root folder name. A transcript's `cwd` can point INSIDE it whenever
// an agent `cd`s into an artifact directory (a PRD folder, prompt-sessions,
// scheduler/state) — Claude Code records the new absolute cwd on every
// subsequent row, and this scan reads the LAST such row. Left unnormalized,
// that subdirectory is handed to consumers as if it were a project, and
// queueStore.writeSplit materializes a whole second ops root beneath it:
// `<project>/session-manager-operations/scheduler/epics/<id>/prds/session-
// manager-operations/scheduler/state/queue.json`, holding `{"jobs": []}`.
// Observed live on 2026-08-30 in starry-night-ships: 14 such stubs, mtimes
// spanning 8 days, one per directory an agent had cd'd into.
//
// Truncating at the segment is strictly better than dropping the row: the
// ancestor IS the project the agent was working in, so the active-project
// signal survives instead of being silently lost.
const OPS_DIRNAME = OPS_ROOT_DIR;

/**
 * projectRootOf(cwd) → the project root for a cwd that may sit inside an ops
 * tree and/or a linked git worktree. Returns cwd unchanged when neither
 * applies, or when the worktree cannot be proven (kind `unknown` — callers that
 * WRITE must consult classifyCwd; this stays total so dispatch never breaks).
 * The classification itself (outermost ops truncation, then worktree
 * resolution) lives in cwdClassify.cjs.
 */
function projectRootOf(cwd) {
  return classifyCwd(cwd).projectRoot ?? cwd;
}

/**
 * readTailLines(filePath, maxBytes) → string[]
 * Reads at most maxBytes from the END of filePath and splits into non-empty lines.
 * O(1) in file size (bounded read). Returns [] on any I/O error.
 */
function readTailLines(filePath, maxBytes) {
  let buf;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return [];
    const readSize = Math.min(maxBytes, stat.size);
    const fd = fs.openSync(filePath, 'r');
    try {
      buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  return buf.toString('utf8').split('\n').filter((l) => l.trim());
}

/**
 * scanOneProjectDirSync(projDir) → {rawCwd, newestMtimeMs} | null
 * Newest *.jsonl's mtime plus its last parseable `cwd`, for one project dir.
 */
function scanOneProjectDirSync(projDir) {
  let entries;
  try {
    entries = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
  } catch { return null; }

  let newestPath = null;
  let newestMtimeMs = 0;
  for (const tf of entries) {
    const fp = path.join(projDir, tf);
    try {
      const st = fs.statSync(fp);
      if (st.mtimeMs > newestMtimeMs) {
        newestMtimeMs = st.mtimeMs;
        newestPath = fp;
      }
    } catch { continue; }
  }
  if (!newestPath) return null;

  const tlines = readTailLines(newestPath, TAIL_BYTES);
  let rawCwd = null;
  for (let i = tlines.length - 1; i >= 0; i--) {
    let row;
    try { row = JSON.parse(tlines[i]); } catch { continue; }
    if (row.cwd) { rawCwd = row.cwd; break; }
  }
  return rawCwd ? { rawCwd, newestMtimeMs } : null;
}

/**
 * scanProjectsDir(projectsDir) → {rawCwd, newestMtimeMs}[] | null
 *
 * The first scan of a given projectsDir is synchronous (readdirSync of
 * projectsDir, then per project dir as above) and its result is cached.
 * Every call after that is stale-while-revalidate: a fresh cache entry is
 * returned as-is; an expired one is ALSO returned as-is (the stale record),
 * while startAsyncRefresh kicks off at most one background fs.promises
 * rescan to refresh it for the next caller. Returns null when projectsDir is
 * missing/unreadable and no record has ever been cached for it.
 */
function scanProjectsDir(projectsDir) {
  let dirMtimeMs;
  try {
    dirMtimeMs = fs.statSync(projectsDir).mtimeMs;
  } catch {
    // Missing/unreadable dir: any prior cache entry must not survive to be
    // handed back once the dir later appears — drop it rather than caching
    // this empty result.
    rawScanCache.delete(projectsDir);
    return null;
  }
  const cached = rawScanCache.get(projectsDir);
  const now0 = Date.now();
  if (cached && cached.dirMtimeMs === dirMtimeMs && now0 - cached.cachedAt < CACHE_TTL_MS) {
    return cached.records;
  }

  // A prior successful scan exists: serve it stale and refresh in the
  // background rather than blocking this synchronous caller.
  if (cached) {
    startAsyncRefresh(projectsDir);
    return cached.records;
  }

  // First-ever scan of this projectsDir: must be synchronous, since no
  // record exists yet to serve stale.
  let slugs;
  try { slugs = fs.readdirSync(projectsDir); } catch { rawScanCache.delete(projectsDir); return null; }

  const records = [];
  for (const slug of slugs) {
    const rec = scanOneProjectDirSync(path.join(projectsDir, slug));
    if (rec) records.push(rec);
  }

  Object.freeze(records);
  rawScanCache.set(projectsDir, { dirMtimeMs, cachedAt: now0, records, refreshPromise: null });
  return records;
}

/**
 * readTailLinesAsync(filePath, maxBytes) → Promise<string[]>
 * fs.promises counterpart of readTailLines, used only by the async rescan.
 */
async function readTailLinesAsync(filePath, maxBytes) {
  let buf;
  let fh;
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size === 0) return [];
    const readSize = Math.min(maxBytes, stat.size);
    fh = await fsp.open(filePath, 'r');
    buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, stat.size - readSize);
  } catch {
    return [];
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  return buf.toString('utf8').split('\n').filter((l) => l.trim());
}

/**
 * scanOneProjectDirAsync(projDir) → Promise<{rawCwd, newestMtimeMs} | null>
 * fs.promises counterpart of scanOneProjectDirSync, used only by the async rescan.
 */
async function scanOneProjectDirAsync(projDir) {
  let entries;
  try {
    entries = (await fsp.readdir(projDir)).filter((f) => f.endsWith('.jsonl'));
  } catch { return null; }

  let newestPath = null;
  let newestMtimeMs = 0;
  for (const tf of entries) {
    const fp = path.join(projDir, tf);
    try {
      const st = await fsp.stat(fp);
      if (st.mtimeMs > newestMtimeMs) {
        newestMtimeMs = st.mtimeMs;
        newestPath = fp;
      }
    } catch { continue; }
  }
  if (!newestPath) return null;

  const tlines = await readTailLinesAsync(newestPath, TAIL_BYTES);
  let rawCwd = null;
  for (let i = tlines.length - 1; i >= 0; i--) {
    let row;
    try { row = JSON.parse(tlines[i]); } catch { continue; }
    if (row.cwd) { rawCwd = row.cwd; break; }
  }
  return rawCwd ? { rawCwd, newestMtimeMs } : null;
}

/**
 * rescanProjectsDirAsync(projectsDir) → Promise<{dirMtimeMs, records}>
 * The background counterpart of the first-scan branch in scanProjectsDir:
 * same semantics, entirely fs.promises, with the per-project-dir reads
 * bounded to RESCAN_CONCURRENCY in flight at once. A top-level failure
 * (missing dir, unreadable) is left to throw/reject — startAsyncRefresh's
 * caller catches it, logs once, and keeps the old cached record.
 */
async function rescanProjectsDirAsync(projectsDir) {
  const dirMtimeMs = (await fsp.stat(projectsDir)).mtimeMs;
  const slugs = await fsp.readdir(projectsDir);

  const records = [];
  let nextIdx = 0;
  async function worker() {
    for (;;) {
      const i = nextIdx++;
      if (i >= slugs.length) return;
      const rec = await scanOneProjectDirAsync(path.join(projectsDir, slugs[i]));
      if (rec) records.push(rec);
    }
  }
  const workerCount = Math.min(RESCAN_CONCURRENCY, slugs.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  Object.freeze(records);
  return { dirMtimeMs, records };
}

/**
 * startAsyncRefresh(projectsDir) → Promise<void>
 * Kicks off at most one in-flight background rescan per projectsDir — later
 * calls while one is in flight get back the same promise instead of starting
 * another. On success the cache entry is swapped atomically; on failure the
 * old record is kept and the error is logged once. Never throws/rejects
 * into a synchronous caller — scanProjectsDir never awaits this.
 */
function startAsyncRefresh(projectsDir) {
  const entry = rawScanCache.get(projectsDir);
  if (!entry) return Promise.resolve();
  if (entry.refreshPromise) return entry.refreshPromise;

  const promise = rescanProjectsDirAsync(projectsDir)
    .then((result) => {
      const current = rawScanCache.get(projectsDir);
      if (!current) return; // busted mid-flight; nothing to swap into
      rawScanCache.set(projectsDir, {
        dirMtimeMs: result.dirMtimeMs, cachedAt: Date.now(), records: result.records, refreshPromise: null,
      });
    })
    .catch((err) => {
      console.error(`[activeSessions] async rescan of ${projectsDir} failed, keeping stale record: ${err.message}`);
      const current = rawScanCache.get(projectsDir);
      if (current) current.refreshPromise = null;
    });

  entry.refreshPromise = promise;
  return promise;
}

/**
 * __waitForPendingRefresh(projectsDir) → Promise<void>
 * Test-only hook: awaits the in-flight async rescan for projectsDir, if any.
 * Resolves immediately when no refresh is in flight.
 */
function __waitForPendingRefresh(projectsDir) {
  const entry = rawScanCache.get(projectsDir);
  return entry && entry.refreshPromise ? entry.refreshPromise : Promise.resolve();
}

/**
 * deriveCwds(records, maxAgeMin, maxCwds, tmpDropRoots) → string[]
 *
 * Filters/sorts a scanProjectsDir() record into the view activeProjectCwds/
 * allProjectCwds promise: age cutoff, ops-root/worktree normalization,
 * dedup, existence check, and the maxCwds cap — identical semantics to the
 * old per-call scan, now performed in memory against the shared record.
 */
function deriveCwds(records, maxAgeMin, maxCwds, tmpDropRoots) {
  // maxAgeMin === Infinity means "every project ever seen, no recency filter"
  // (allProjectCwds below). Date.now() - Infinity is -Infinity, which every
  // mtime clears — spelled out here because it reads like an accident.
  const cutoffMs = Date.now() - maxAgeMin * 60 * 1000;
  const seen = new Set();
  const result = [];

  function addCwd(rawCwd) {
    if (!rawCwd || typeof rawCwd !== 'string') return;
    // Normalize an ops-internal cwd up to its project root BEFORE any of the
    // checks below — the stray-ops-root incident (see OPS_DIRNAME above) got
    // through precisely because such a path is absolute and does exist.
    const classified = classifyCwd(rawCwd);
    // `unknown` (a .git file we cannot resolve) is non-registrable: registering
    // it would hand every consumer a project whose ops writes are refused.
    if (classified.kind === 'unknown') return;
    const cwd = classified.projectRoot;
    // Must be ABSOLUTE. A relative fragment would pass the statSync below
    // whenever it happens to resolve against THIS process's own cwd, and
    // every consumer (queueStore.projectStateDir, prdLocations) then joins
    // it into an ops-root path that lands somewhere arbitrary. Callers key
    // whole per-project state off these strings — a project is a cwd, and a
    // cwd is an absolute path.
    if (!cwd || !path.isAbsolute(cwd)) return;
    // Drop-guard of last resort: a cwd that is (or sits inside) a known
    // worktree-scratch root after projectRootOf's normalization is one
    // worktreeMainRootOf could not resolve to a main tree — never a real
    // project.
    if (tmpDropRoots.exactDropCwds.includes(cwd)) return;
    const isUnderPrefixDropRoot = tmpDropRoots.prefixDropRoots.some((root) => {
      if (cwd === root) return true;
      const rel = path.relative(root, cwd);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    if (isUnderPrefixDropRoot) return;
    if (seen.has(cwd) || result.length >= maxCwds) return;
    // Must exist AND be a directory — a transcript naming a since-deleted
    // path, or a file, is not a project.
    try { if (!fs.statSync(cwd).isDirectory()) return; } catch { return; }
    seen.add(cwd);
    result.push(cwd);
  }

  for (const { rawCwd, newestMtimeMs } of records) {
    if (result.length >= maxCwds) break;
    if (newestMtimeMs < cutoffMs) continue;
    addCwd(rawCwd);
  }

  return Object.freeze(result);
}

/**
 * activeProjectCwds(maxAgeMin = 90, opts?) → string[]
 *
 * Returns distinct, on-disk project cwds that have an open/active session
 * within the last maxAgeMin minutes.
 *
 * Sole detection path: scan ~/.claude/projects/*​/  for transcript *.jsonl
 *   files modified within maxAgeMin, read `cwd` from the last parseable line
 *   of the newest transcript per project dir.
 *   Complexity: O(P × L) over P project dirs, each bounded-tail read (64 KB) —
 *   paid once per TTL window (see scanProjectsDir), shared across views.
 *
 * opts (for testing):
 *   projectsDir   — override the default ~/.claude/projects path
 *   tmpDropRoots  — override the tmp guard's drop roots (default TMP_DROP_ROOTS)
 */
function activeProjectCwds(maxAgeMin = 90, {
  projectsDir = path.join(HOME, '.claude', 'projects'),
  maxCwds = MAX_CWDS,
  tmpDropRoots = TMP_DROP_ROOTS,
} = {}) {
  const records = scanProjectsDir(projectsDir);
  if (!records) return EMPTY_CWDS;
  return deriveCwds(records, maxAgeMin, maxCwds, tmpDropRoots);
}

/**
 * allProjectCwds(opts?) → string[]
 *
 * Every project cwd this machine has ever opened a Claude session in, with NO
 * recency filter — the same transcript scan, minus the cutoff.
 *
 * Recency is the right question for "which projects should I sweep for new
 * feedback". It is the WRONG question for "which projects own PRDs": a
 * project that has been quiet for 90 minutes still owns its queued work, and
 * treating its PRD dir as non-existent makes reconcile() read absence as
 * deletion. (2026-07-31: 142 PRDs across 6 quiet projects went unscannable.)
 *
 * The cap is raised well above activeProjectCwds' 50 because this list is
 * historical rather than "currently in flight".
 */
function allProjectCwds(opts = {}) {
  return activeProjectCwds(Infinity, { maxCwds: 500, ...opts });
}

module.exports = {
  activeProjectCwds,
  allProjectCwds,
  projectRootOf,
  worktreeMainRootOf,
  bustProjectCwdCache,
  __waitForPendingRefresh,
};
