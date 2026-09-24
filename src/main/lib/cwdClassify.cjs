'use strict';

/**
 * cwdClassify.cjs — THE one answer to "what project is this path?".
 *
 * activeSessions.projectRootOf, ephemeralCwd.isEphemeralCwd and
 * opsOwnership.resolveProjectRoot each used to re-derive that answer and each
 * failed OPEN: when a worktree's `.git` FILE survives but its admin-dir
 * back-reference is gone, worktreeMainRootOf returned null, projectRootOf
 * handed the worktree path back unchanged, isLinkedWorktreeRoot said false, and
 * resolveOpsRoot built `<worktree>/session-manager-operations` — the shape
 * behind the lost-Epics incidents. classifyCwd reports BOTH facts (which
 * project, and how sure we are) so a caller can refuse WRITES for the
 * unprovable case (`unknown`) while dispatch and reads carry on.
 *
 * Kinds:
 *   worktree  — `.git` is a FILE whose gitdir sits under `<main>/.git/worktrees/`
 *               AND the main tree's admin dir back-references it (round trip).
 *               projectRoot = <main>.
 *   project   — `.git` is a directory, OR a FILE whose gitdir is NOT under a
 *               worktrees/ dir (separate-git-dir / submodule), OR no `.git` at
 *               all. projectRoot = the dir holding `.git` (else the cwd).
 *   ephemeral — os.tmpdir() itself, or inside a managed job/epic worktree root,
 *               and not provably a live worktree.
 *   unknown   — a `.git` FILE we cannot resolve (garbled, unreadable, worktrees
 *               gitdir with a missing/mismatched back-reference). projectRoot is
 *               the (ops-truncated) cwd unchanged; ops WRITES must be refused.
 *
 * Two ops-root facts are returned and deliberately NOT unified:
 *   outermostOpsRoot — first `session-manager-operations` segment (indexOf).
 *       activeSessions truncates here: a stray nested ops root is itself the bug.
 *   innermostOpsRoot — last segment (lastIndexOf). opsOwnership.assertOpsWrite
 *       derives the project a write targets from here.
 *   Both are null when the path is not inside an ops root.
 *
 * Pure fs, synchronous, never throws. Must stay light — required by
 * scripts/hooks/guard-inline-implementation.cjs (via nearestGitEntry) and
 * activeSessions.cjs; no gitWorktree/config requires.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const schedulerPaths = require('./schedulerPaths.cjs');

const OPS_DIRNAME = 'session-manager-operations';
const WORKTREES_MARKER = `${path.sep}.git${path.sep}worktrees${path.sep}`;
// Bound on the ancestor walk — past any real fs depth, guarantees termination.
const MAX_WALK = 40;

/**
 * nearestGitEntry(cwd) → { dir, isFile } for the nearest ancestor-or-self that
 * has a `.git` entry (`isFile` true = linked worktree / submodule pointer file),
 * or null. The tiny pure helper for callers that must not load git tooling.
 */
function nearestGitEntry(cwd) {
  let dir = cwd;
  for (let i = 0; i < MAX_WALK; i++) {
    let stat = null;
    try { stat = fs.statSync(path.join(dir, '.git')); } catch { /* none here */ }
    if (stat) return { dir, isFile: stat.isFile() };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Classify the git shape at/above `start`. O(depth) stats + ≤2 small reads.
 * → { shape: 'none' | 'gitdir' | 'worktree' | 'separate' | 'unknown', dir, mainRoot, reason }
 */
function inspectGit(start) {
  const entry = nearestGitEntry(start);
  if (!entry) return { shape: 'none', dir: null, mainRoot: null, reason: 'no .git found' };
  if (!entry.isFile) return { shape: 'gitdir', dir: entry.dir, mainRoot: null, reason: '.git is a directory' };

  const gitPath = path.join(entry.dir, '.git');
  let body;
  try {
    body = fs.readFileSync(gitPath, 'utf8');
  } catch (e) {
    return { shape: 'unknown', dir: entry.dir, mainRoot: null, reason: `unreadable .git file: ${e?.code || e?.message}` };
  }
  const firstLine = body.split('\n', 1)[0].trim();
  if (!firstLine.startsWith('gitdir:')) {
    return { shape: 'unknown', dir: entry.dir, mainRoot: null, reason: '.git file has no "gitdir:" line' };
  }
  const gitdirRaw = firstLine.slice('gitdir:'.length).trim();
  if (!gitdirRaw) {
    return { shape: 'unknown', dir: entry.dir, mainRoot: null, reason: '.git file has an empty gitdir' };
  }
  // Submodules point at a RELATIVE gitdir; resolve against the file's own dir.
  const gitdir = path.resolve(entry.dir, gitdirRaw);
  const markerIdx = gitdir.indexOf(WORKTREES_MARKER);
  if (markerIdx === -1) {
    // Not a linked worktree: separate-git-dir / submodule. Its own project.
    return { shape: 'separate', dir: entry.dir, mainRoot: null, reason: 'gitdir is not under .git/worktrees/ (separate-git-dir or submodule)' };
  }
  if (markerIdx <= 0) {
    return { shape: 'unknown', dir: entry.dir, mainRoot: null, reason: 'gitdir worktrees marker has no main root above it' };
  }
  const candidateMain = gitdir.slice(0, markerIdx);
  const worktreeName = gitdir.slice(markerIdx + WORKTREES_MARKER.length).split(path.sep)[0];
  if (!worktreeName) {
    return { shape: 'unknown', dir: entry.dir, mainRoot: null, reason: 'gitdir names no worktree' };
  }
  // Round-trip: the .git file is plain text anything could have written, so it
  // must not redirect callers to an arbitrary path. The main tree's own admin
  // dir must point back at THIS .git file.
  const adminGitdirFile = path.join(candidateMain, '.git', 'worktrees', worktreeName, 'gitdir');
  let backRef;
  try {
    backRef = fs.readFileSync(adminGitdirFile, 'utf8').trim();
  } catch {
    return { shape: 'unknown', dir: entry.dir, mainRoot: null, reason: `worktree admin back-reference missing (${adminGitdirFile})` };
  }
  if (path.resolve(backRef) !== path.resolve(gitPath)) {
    return { shape: 'unknown', dir: entry.dir, mainRoot: null, reason: `worktree admin back-reference points elsewhere (${adminGitdirFile})` };
  }
  return { shape: 'worktree', dir: entry.dir, mainRoot: candidateMain, reason: 'linked worktree, back-reference verified' };
}

/**
 * worktreeMainRootOf(cwd) → the main tree's root when cwd sits inside a
 * verified linked worktree, the ancestor itself when `.git` is a directory,
 * else null (no git, separate-git-dir, or anything unprovable).
 */
function worktreeMainRootOf(cwd) {
  const g = inspectGit(cwd);
  if (g.shape === 'worktree') return g.mainRoot;
  if (g.shape === 'gitdir') return g.dir;
  return null;
}

function isExactlyTmpdir(absCwd) {
  return absCwd === path.resolve(os.tmpdir());
}

function isUnderManagedWorktreeRoot(absCwd) {
  return ['job', 'epic'].map((k) => path.resolve(schedulerPaths.worktreeRoot(k))).some((root) => {
    const rel = path.relative(root, absCwd);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/**
 * classifyCwd(cwd) → { kind, projectRoot, outermostOpsRoot, innermostOpsRoot, reason }
 * See the file header. A non-string/empty cwd is `unknown` with a null root.
 */
function classifyCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') {
    return { kind: 'unknown', projectRoot: null, outermostOpsRoot: null, innermostOpsRoot: null, reason: 'cwd is not a non-empty string' };
  }
  // Must run BEFORE inspectGit: nearestGitEntry walks ancestors via
  // fs.statSync, which silently resolves a relative `dir` against
  // process.cwd() — so a relative cwd that happens to be a real subpath of
  // WHATEVER PROCESS IS RUNNING THIS CODE (not the transcript's actual
  // project) can walk up into a real `.git`, including a linked worktree's
  // `.git` FILE, and return that worktree's real main-tree root as if it
  // were the relative fragment's own project. The 'worktree' branch below
  // returns early on g.shape alone with no absolute check of its own, so
  // this guard cannot be deferred to after inspectGit runs (confirmed via
  // opsRootAbsoluteCwd.test.cjs: reproduces in every git worktree, not just
  // job worktrees — process.cwd() there is a worktree whose .git FILE
  // resolves back to the real main tree root).
  if (!path.isAbsolute(cwd)) {
    return { kind: 'unknown', projectRoot: null, outermostOpsRoot: null, innermostOpsRoot: null, reason: 'cwd is not an absolute path' };
  }
  const parts = cwd.split(path.sep);
  const first = parts.indexOf(OPS_DIRNAME);
  const last = parts.lastIndexOf(OPS_DIRNAME);
  const opsAt = (i) => (i >= 0 ? (parts.slice(0, i + 1).join(path.sep) || path.sep) : null);
  const outermostOpsRoot = opsAt(first);
  const innermostOpsRoot = opsAt(last);
  // Outermost truncation (the activeSessions law). i === 0 is a relative
  // fragment, never truncated.
  const truncated = first > 0 ? (parts.slice(0, first).join(path.sep) || path.sep) : cwd;

  const g = inspectGit(truncated);
  const facts = { outermostOpsRoot, innermostOpsRoot };
  if (g.shape === 'worktree') {
    return { kind: 'worktree', projectRoot: g.mainRoot, ...facts, reason: g.reason };
  }
  if (path.isAbsolute(cwd)) {
    const abs = path.resolve(cwd);
    if (isExactlyTmpdir(abs) || isUnderManagedWorktreeRoot(abs)) {
      return { kind: 'ephemeral', projectRoot: truncated, ...facts, reason: 'tmpdir or managed job/epic worktree root' };
    }
  }
  if (g.shape === 'unknown') {
    return { kind: 'unknown', projectRoot: truncated, ...facts, reason: g.reason };
  }
  if (g.shape === 'none') {
    return { kind: 'project', projectRoot: truncated, ...facts, reason: g.reason };
  }
  return { kind: 'project', projectRoot: g.dir, ...facts, reason: g.reason };
}

module.exports = { classifyCwd, nearestGitEntry, worktreeMainRootOf, OPS_DIRNAME };
