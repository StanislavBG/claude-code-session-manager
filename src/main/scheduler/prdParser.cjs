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
const { deriveEpicIdFromPrdPath } = require('../lib/prdLocations.cjs');

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
    // Optional traceability back to the PromptTicket.id (PRD 748) that was
    // classified 'develop' and spawned this PRD (PRD 749). Additive — absent
    // on every PRD authored before this field existed. When frontmatter
    // omits it, fall back to the owning Epic dir name (PRD 830) — a PRD's
    // file location already IS its Epic membership, so hand-authored PRDs
    // dropped straight into an Epic's prds/ dir still get real linkage
    // instead of null.
    sourcePromptId: fm.sourcePromptId || deriveEpicIdFromPrdPath(filePath) || null,
    // The Epic this PRD actually belongs to, derived purely from its location
    // (epic dir name == epic id, 1:1 by design — prdLocations.deriveEpicIdFromPrdPath).
    // Deliberately separate from sourcePromptId: that field is *intent* and
    // can be stale or hand-written wrong in frontmatter (real rows in
    // queue.json exist where sourcePromptId and sourceTabId disagree), while
    // this one is *fact* on disk. Every surface that shows "which Epic is this
    // from" reads this, so Scheduler and Epics can't drift apart.
    epicId: deriveEpicIdFromPrdPath(filePath),
    // Optional traceability back to the chat tab that queued this PRD (PRD
    // 761) — read back at job completion to route a status prompt via
    // enqueueExternalPrompt (PRD 753). Additive — absent on every PRD
    // authored before this field existed.
    sourceTabId: fm.sourceTabId || null,
    // Explicit cross-PRD ordering (PRD 832): `dependsOn: [<slug>, <slug>]`
    // or a comma-separated string. Replaces the retired shared-NN-means-
    // parallel convention — a job is eligible only once every listed slug's
    // queue row is completed (a slug with no row is treated as already
    // done/archived, matching retireCompletedSlugs semantics).
    dependsOn: parseDependsOn(fm.dependsOn),
    // Provenance stamp (PRD-authoring lockdown): set only by prdCreate.cjs's
    // buildPrdBody (create) or the update-prd route's legacy-adopt patch
    // (migration/manual adopt). A PRD discovered on disk with no value here
    // was never written through the sanctioned API path — reconcile()
    // quarantines it instead of queuing it to run.
    createdVia: fm.createdVia || null,
    issuedAt: fm.issuedAt || null,
    body: body.trim(),
  };
}

/** `[a, b]` / `a, b` / `a` → ['a','b']; anything else → []. */
function parseDependsOn(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => /^[A-Za-z0-9][\w.-]*$/.test(s));
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

// Auto-archiving completed PRDs (see queueOps.cjs's autoArchiveCompleted)
// moves old `NN-*.md` files out of prdsDir into prds-archived/, which would
// let maxParallelGroupInUse's directory scan regress once the highest-NN
// files age out — a later allocation could then reissue an already-used NN
// and collide with an archived group. A high-water-mark sidecar closes that:
// once a scan or allocation has seen NN, the allocator never returns
// anything ≤ NN again, even if every file at or above NN is later archived.
// Sidecar (not queue.json) so this module stays self-contained and testable
// against a bare tmp dir, matching the `.reserved-NN` marker convention.
const MAX_GROUP_FILE = '.max-allocated-group';

async function readHighWaterMark(prdsDir) {
  try {
    const raw = await fsp.readFile(path.join(prdsDir, MAX_GROUP_FILE), 'utf8');
    const n = Number(raw.trim());
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function writeHighWaterMark(prdsDir, n) {
  // Re-read immediately before writing so two concurrent allocations that
  // both raced past the caller's earlier read can't have the smaller `n`
  // land last and regress the persisted mark below the larger one. Narrows
  // (does not fully eliminate) the race; the reservation markers remain the
  // authoritative concurrency guard, this file is a best-effort backstop
  // for after files are archived away.
  const current = await readHighWaterMark(prdsDir);
  if (n <= current) return;

  const dest = path.join(prdsDir, MAX_GROUP_FILE);
  // `n` itself is unique per concurrent caller (the reservation marker each
  // caller holds guarantees no two callers ever share a candidate), so it
  // doubles as a collision-free tmp-file suffix — process.pid + Date.now()
  // is NOT safe here since concurrent allocateParallelGroup calls in the
  // same process can land in the same millisecond.
  const tmp = `${dest}.tmp-${n}-${process.pid}`;
  await fsp.writeFile(tmp, String(n), 'utf8');
  await fsp.rename(tmp, dest);
}

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
async function allocateParallelGroup(prdsDir, { extraFloor = 0 } = {}) {
  await fsp.mkdir(prdsDir, { recursive: true });
  const scanMax = await maxParallelGroupInUse(prdsDir);
  const highWater = await readHighWaterMark(prdsDir);
  // extraFloor (PRD 832): the caller's max across OTHER dirs sharing the
  // project's number space (epic prds/ dirs, prds-archived) — numbers are
  // unique per project, never merely per directory.
  const floor = Math.max(scanMax, highWater, extraFloor);
  let candidate = floor + 1;
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
    // Persist the new floor before returning so a later archive of every
    // NN-*.md file (including this one) can never regress the allocator
    // below it.
    if (candidate > highWater) {
      await writeHighWaterMark(prdsDir, candidate);
    }
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
