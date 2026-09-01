'use strict';

// activeSessions.cjs — returns distinct on-disk project cwds with an active
// session within maxAgeMin minutes. Used by the feedback sweep (PRD 102) to
// narrow scanning to projects the user is actually working in.
//
// Detection is transcript-based only (scans ~/.claude/projects/*/*.jsonl
// mtimes). It has zero dependency on ~/.claude/knowledge-log/prompts.jsonl,
// which PRD 356-retire purges along with its capture hook.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { KIND_CONFIG: WORKTREE_KIND_CONFIG } = require('../../src/main/lib/gitWorktree.cjs');

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
  prefixDropRoots: [WORKTREE_KIND_CONFIG.job.root, WORKTREE_KIND_CONFIG.epic.root],
};

// Transcript reads only need the last line with a `cwd` field — a few dozen
// lines is always enough. 64 KB keeps peak RSS proportionate.
const TAIL_BYTES = 64 * 1024;

// Safety cap on distinct cwds to bound result set size. O(1) extra space.
const MAX_CWDS = 50;

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
const OPS_DIRNAME = 'session-manager-operations';

// Bound on the ancestor walk in worktreeMainRootOf — well past any real
// filesystem depth, purely to guarantee termination without relying on
// reaching '/' (e.g. a symlink loop or an unusually deep path).
const MAX_WORKTREE_WALK = 40;

const WORKTREES_MARKER = `${path.sep}.git${path.sep}worktrees${path.sep}`;

/**
 * worktreeMainRootOf(cwd) → the main tree's root when cwd sits inside a
 * linked `git worktree` (job/epic worktrees under os.tmpdir(), or a
 * user-made one anywhere). Walks UP from cwd looking for a `.git` entry:
 *   - `.git` is a FILE (linked worktree) whose first line is
 *     `gitdir: <main>/.git/worktrees/<name>` → returns <main>.
 *   - `.git` is a DIRECTORY (already the main tree) → returns that ancestor.
 *   - nothing found within MAX_WORKTREE_WALK levels → returns null.
 * Pure fs, synchronous, never throws — any unexpected shape (garbled file,
 * unreadable entry, gitdir path without the worktrees marker) yields null so
 * the caller leaves the cwd unchanged rather than guessing.
 */
function worktreeMainRootOf(cwd) {
  let dir = cwd;
  for (let i = 0; i < MAX_WORKTREE_WALK; i++) {
    const gitPath = path.join(dir, '.git');
    let stat;
    try {
      stat = fs.statSync(gitPath);
    } catch {
      stat = null;
    }
    if (stat) {
      if (stat.isDirectory()) return dir;
      if (stat.isFile()) {
        let body;
        try {
          body = fs.readFileSync(gitPath, 'utf8');
        } catch {
          return null;
        }
        const firstLine = body.split('\n', 1)[0].trim();
        const prefix = 'gitdir:';
        if (!firstLine.startsWith(prefix)) return null;
        const gitdir = firstLine.slice(prefix.length).trim();
        const markerIdx = gitdir.indexOf(WORKTREES_MARKER);
        if (markerIdx <= 0) return null;
        const candidateMain = gitdir.slice(0, markerIdx);
        const worktreeName = gitdir.slice(markerIdx + WORKTREES_MARKER.length).split(path.sep)[0];
        // Round-trip verification: gitdir's content is a plain file that
        // anything on disk could have written (e.g. a nested `.git` file
        // tracked inside an untrusted repo), so it must not be trusted to
        // redirect callers to an arbitrary attacker-chosen absolute path.
        // A genuine linked worktree's admin dir back-references the exact
        // `.git` FILE we are resolving via its own `gitdir` pointer file —
        // require that round trip before accepting candidateMain.
        if (!worktreeName) return null;
        const adminGitdirFile = path.join(candidateMain, '.git', 'worktrees', worktreeName, 'gitdir');
        let backRef;
        try {
          backRef = fs.readFileSync(adminGitdirFile, 'utf8').trim();
        } catch {
          return null;
        }
        if (path.resolve(backRef) !== path.resolve(gitPath)) return null;
        return candidateMain;
      }
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * projectRootOf(cwd) → the project root for a cwd that may sit inside an ops
 * tree and/or a linked git worktree. Returns cwd unchanged when neither
 * applies. Only the FIRST ops-dir occurrence matters — a nested stray ops
 * root is itself the bug, never a project. The ops-dir truncation runs
 * first, then the worktree resolution, so a cwd deep inside a worktree's OWN
 * ops tree still lands on the real project's main root.
 */
function projectRootOf(cwd) {
  const parts = cwd.split(path.sep);
  const i = parts.indexOf(OPS_DIRNAME);
  const truncated = i > 0 ? (parts.slice(0, i).join(path.sep) || path.sep) : cwd;
  const mainRoot = worktreeMainRootOf(truncated);
  return mainRoot || truncated;
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
 * activeProjectCwds(maxAgeMin = 90, opts?) → string[]
 *
 * Returns distinct, on-disk project cwds that have an open/active session
 * within the last maxAgeMin minutes.
 *
 * Sole detection path: scan ~/.claude/projects/*​/  for transcript *.jsonl
 *   files modified within maxAgeMin, read `cwd` from the last parseable line
 *   of the newest transcript per project dir.
 *   Complexity: O(P × L) over P project dirs, each bounded-tail read (64 KB).
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
    const cwd = projectRootOf(rawCwd);
    // Must be ABSOLUTE. A relative fragment would pass the statSync below
    // whenever it happens to resolve against THIS process's own cwd, and
    // every consumer (queueStore.projectStateDir, prdLocations) then joins
    // it into an ops-root path that lands somewhere arbitrary. Callers key
    // whole per-project state off these strings — a project is a cwd, and a
    // cwd is an absolute path.
    if (!path.isAbsolute(cwd)) return;
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

  // Scan ~/.claude/projects/*/  transcript *.jsonl files.
  let slugs;
  try { slugs = fs.readdirSync(projectsDir); } catch { return result; }

  for (const slug of slugs) {
    if (result.length >= maxCwds) break;
    const projDir = path.join(projectsDir, slug);
    let entries;
    try {
      entries = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
    } catch { continue; }

    // Find the most recently modified transcript in this project dir.
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

    if (!newestPath || newestMtimeMs < cutoffMs) continue;

    // Read `cwd` from the last parseable line of the transcript.
    const tlines = readTailLines(newestPath, TAIL_BYTES);
    for (let i = tlines.length - 1; i >= 0; i--) {
      let row;
      try { row = JSON.parse(tlines[i]); } catch { continue; }
      if (row.cwd) { addCwd(row.cwd); break; }
    }
  }

  return result;
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

module.exports = { activeProjectCwds, allProjectCwds, projectRootOf, worktreeMainRootOf };
