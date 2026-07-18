/**
 * scheduler/prdParser.cjs — PRD file parsing + dir-mtime cache.
 *
 * Extracted from scheduler.cjs to keep the main scheduler module focused on
 * its state machine + executor. No mutable scheduler state lives here; the
 * cache is module-private and keyed by absolute file path.
 *
 * Two-level cache for reconcile():
 *   - dirCache: keyed by PRDS_DIR mtimeMs — invalidated when files added/removed.
 *   - fileCache: per-PRD parse keyed by individual file mtimeMs — survives across
 *     dir-cache invalidations so adding ONE new PRD doesn't re-parse the other 197.
 * Both layers also bound by ino so a rename + re-create can't alias.
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { splitFrontmatter } = require('../lib/prdFrontmatter.cjs');

/**
 * Expand a PRD `cwd` value to an absolute path.
 * - `~/...` or `~` alone → absolute under os.homedir()
 * - Already-absolute paths pass through unchanged.
 * - Bare relative paths → joined onto os.homedir().
 * null/empty returns null (caller falls back to defaultCwd).
 */
function expandCwd(cwd) {
  if (!cwd) return null;
  if (cwd === '~' || cwd.startsWith('~/')) return path.join(os.homedir(), cwd.slice(1));
  if (path.isAbsolute(cwd)) return cwd;
  return path.join(os.homedir(), cwd);
}

// Hard cap to keep one malformed PRD (e.g. a binary blob accidentally renamed
// .md) from wedging the main thread. PRDs are PRDs, not media files; 1 MB is
// already ~25k lines and well beyond any legitimate authored doc.
const PRD_READ_MAX_BYTES = 1024 * 1024;

let prdDirMtime = -1;
let prdDirFiles = null; // sorted absolute paths
const prdFileCache = new Map(); // path -> { mtimeMs, ino, parsed }

/**
 * Parse a PRD file from disk without any caching. Reads bytes once, decodes
 * frontmatter, and folds in the parallel-group number from the filename when
 * frontmatter doesn't specify one.
 */
async function parsePrdRaw(filePath) {
  const text = await fsp.readFile(filePath, 'utf8');
  const { fm, body } = splitFrontmatter(text);

  const base = path.basename(filePath, '.md');
  const groupFromName = (() => {
    const m = base.match(/^(\d+)-/);
    return m ? Number(m[1]) : null;
  })();

  return {
    slug: base,
    path: filePath,
    title: fm.title || base,
    cwd: expandCwd(fm.cwd || null),
    estimateMinutes: fm.estimateMinutes ? Number(fm.estimateMinutes) || null : null,
    parallelGroup: (fm.parallelGroup ? Number(fm.parallelGroup) || null : null) ?? groupFromName ?? 99,
    body: body.trim(),
  };
}

/**
 * List `.md` PRD files under the given dir. Caches the result keyed by the
 * directory mtime so repeated reconcile() calls don't re-stat every entry.
 * Pass `prdsDir` so the scheduler can keep ownership of its PRDS_DIR path
 * without this module needing to know it.
 */
async function listPrdFiles(prdsDir) {
  let dirMtime;
  try {
    dirMtime = (await fsp.stat(prdsDir)).mtimeMs;
  } catch {
    dirMtime = -1;
  }
  if (dirMtime === prdDirMtime && prdDirFiles) return prdDirFiles;
  let entries;
  try {
    entries = await fsp.readdir(prdsDir);
  } catch {
    entries = [];
  }
  const files = entries
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .map((f) => path.join(prdsDir, f))
    .sort();
  // Drop file-cache entries whose path is no longer on disk so the map
  // doesn't accumulate ghosts after archives/deletes.
  if (prdFileCache.size > 0) {
    const live = new Set(files);
    for (const k of prdFileCache.keys()) {
      if (!live.has(k)) prdFileCache.delete(k);
    }
  }
  prdDirMtime = dirMtime;
  prdDirFiles = files;
  return files;
}

/**
 * Parse a PRD with mtime-aware cache. Returns the cached object when the
 * file's mtime + inode are unchanged. Throws if the file exceeds the size cap.
 */
async function parsePrd(filePath) {
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch {
    // fall back to direct parse (will throw the original ENOENT to caller)
    return parsePrdRaw(filePath);
  }
  if (st.size > PRD_READ_MAX_BYTES) {
    // Evict any stale cached entry so callers see this as a parse miss.
    prdFileCache.delete(filePath);
    throw new Error(`PRD too large (${st.size}B > ${PRD_READ_MAX_BYTES}B): ${filePath}`);
  }
  const cached = prdFileCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.ino === st.ino) {
    return cached.parsed;
  }
  // Evict BEFORE re-parsing so a parse exception leaves the cache empty
  // rather than holding a stale-good entry for the new mtime.
  prdFileCache.delete(filePath);
  const parsed = await parsePrdRaw(filePath);
  prdFileCache.set(filePath, { mtimeMs: st.mtimeMs, ino: st.ino, parsed });
  return parsed;
}

/** Test-only: drop both cache layers so successive runs see fresh disk state. */
function _resetCache() {
  prdDirMtime = -1;
  prdDirFiles = null;
  prdFileCache.clear();
}

// ────────────────────────────────────────────── group allocation
//
// `NN` (the filename prefix, parsed above by groupFromName) is both the
// authoring counter AND the parallel-group key the scheduler groups by.
// Two authors computing "max NN in prds/" concurrently can allocate the
// same NN for unrelated PRDs, which silently merges two projects' work
// into one parallel group (incident 2026-07-14/2026-07-15, PRDs 05-11 vs
// 06-09, then 545 collided again). allocateParallelGroup() closes that
// race with an O(n) full-directory scan (not a caller-narrowed glob — see
// PRD_AUTHORING.md's `'^10[0-9]'` cautionary example) plus an O_EXCL
// reservation file, so two concurrent callers can never walk away with
// the same new NN.
//
// A reservation is a zero-byte `.reserved-<NN>` file created with the
// 'wx' (O_CREAT|O_EXCL) flag — the OS guarantees only one of two racing
// `open()` calls for the same path succeeds. Reservations are counted
// alongside real `NN-slug.md` files when computing the next max, so a
// crash between "reserve NN" and "author NN-slug.md" just permanently
// retires that one NN rather than wedging future allocations. This keeps
// the filesystem itself as the single source of truth (no separate
// `.next-nn`/registry file that could drift out of sync with prds/).
//
// Callers who want an EXISTING group (deliberate parallel siblings, e.g.
// three PRDs sharing 545) never call this — they just write the shared
// `NN-` prefix directly, same as today. This function only mints NEW
// group numbers.

const RESERVATION_RE = /^\.reserved-(\d+)$/;
const GROUP_PREFIX_RE = /^(\d+)-/;
const MAX_RESERVE_ATTEMPTS = 1000;

/**
 * Highest `NN` currently in use under prdsDir, across real `NN-slug.md`
 * PRD files (any digit count, unpadded or not — matches groupFromName
 * above) AND in-flight `.reserved-NN` markers. Full directory scan, no
 * narrowed glob. Returns 0 if the directory is empty/missing.
 */
async function maxParallelGroupInUse(prdsDir) {
  let entries;
  try {
    entries = await fsp.readdir(prdsDir);
  } catch {
    return 0;
  }
  let max = 0;
  for (const name of entries) {
    if (name.startsWith('.')) {
      const rm = name.match(RESERVATION_RE);
      if (rm) max = Math.max(max, Number(rm[1]));
      continue;
    }
    if (!name.endsWith('.md')) continue;
    const m = name.match(GROUP_PREFIX_RE);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * Atomically allocate a brand-new parallel-group number under prdsDir.
 * Returns the reserved NN. Reservation survives a crash mid-allocation
 * (the `.reserved-NN` marker just sits there forever, retiring that one
 * number) and never wedges future callers, since each attempt only needs
 * the marker for its OWN candidate to not already exist.
 */
async function allocateParallelGroup(prdsDir) {
  await fsp.mkdir(prdsDir, { recursive: true });
  let candidate = (await maxParallelGroupInUse(prdsDir)) + 1;
  for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt += 1) {
    const markerPath = path.join(prdsDir, `.reserved-${candidate}`);
    let fh;
    try {
      fh = await fsp.open(markerPath, 'wx');
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        candidate += 1;
        continue;
      }
      throw e;
    }
    await fh.close();
    return candidate;
  }
  throw new Error(`allocateParallelGroup: exhausted ${MAX_RESERVE_ATTEMPTS} reservation attempts starting at ${candidate}`);
}

module.exports = {
  parsePrdRaw,
  parsePrd,
  listPrdFiles,
  allocateParallelGroup,
  maxParallelGroupInUse,
  PRD_READ_MAX_BYTES,
  _resetCache,
};
