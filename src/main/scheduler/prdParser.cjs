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
const path = require('node:path');
const { splitFrontmatter } = require('../lib/prdFrontmatter.cjs');

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
    cwd: fm.cwd || null,
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

module.exports = {
  parsePrdRaw,
  parsePrd,
  listPrdFiles,
  PRD_READ_MAX_BYTES,
  _resetCache,
};
