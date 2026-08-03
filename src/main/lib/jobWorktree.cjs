/**
 * jobWorktree.cjs — per-job `git worktree` isolation for concurrent scheduler
 * runs (PRD 994).
 *
 * Problem: once the queue genuinely runs several jobs wide in one project,
 * N headless `claude -p` processes edit the SAME working tree simultaneously.
 * Observed live on 2026-08-02 with only two concurrent writers: a full test
 * run failed on another job's half-written renderer files, a commit had to be
 * hand-staged to avoid sweeping a sibling job's WIP, and a commit was silently
 * rewritten to a new SHA by a concurrent rebase. This module gives each job
 * its own linked worktree — its edits, its test runs, its commit — isolated
 * from every sibling job and from the human's own interactive session in the
 * same repo.
 *
 * ---------- the ops-root hazard (read before touching cwd plumbing) ----------
 *
 * `<cwd>/session-manager-operations/` (PRDs, queue state, run logs) is
 * resolved from a project's cwd by lib/prdLocations.cjs and lib/queueStore.cjs
 * — every function there takes `cwd` as an explicit parameter, never
 * `process.cwd()`. That means the ops root follows WHATEVER cwd value the
 * caller passes in. A prior incident (recorded in this project's memory as
 * `no_schedule_self_e2e`) is exactly this mistake: swapping the job's cwd for
 * a worktree cwd gives the job a different, EMPTY ops root and orphans its own
 * PRD/queue row.
 *
 * The fix here is structural: this module never changes `job.cwd`. It hands
 * back a SEPARATE `execCwd` (the worktree directory) that scheduler.cjs uses
 * ONLY as the spawned child process's `cwd` spawn option. Every PRD-path
 * resolution, queue read/write, and run-log path in scheduler.cjs keeps using
 * `job.cwd` (the main tree) exactly as before — this module is additive, not
 * a cwd substitution.
 *
 * ---------- commit-guard visibility across the worktree boundary ----------
 *
 * scheduler.cjs's commit-guard reads git state (uncommittedChanges/gitHead)
 * from `job.cwd` (the main tree) before and after a run. If a job's commit
 * only ever lands on a throwaway worktree branch, the main tree's HEAD never
 * moves and the guard would wrongly conclude nothing was committed (this is
 * the pre-existing `pass-no-commit-worktree-commit-invisible-at-exit` /
 * RCA 770-pr269 incident class scheduler.cjs already has retry logic for).
 * `integrateJobBranch` closes that gap for OUR managed worktrees: it merges
 * the job's branch into `job.cwd`'s own HEAD (ff-only when possible, a real
 * merge commit otherwise) BEFORE scheduler.cjs runs any post-run git check —
 * so the commit is a real commit on the main tree, not something the guard
 * has to go looking for.
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

// Root under which every job worktree is checked out. Kept OUTSIDE any
// project's own tree (os.tmpdir(), not `<cwd>/.git/...`) so a job's worktree
// never shows up in the main tree's own file listings, `find`, or a tsc
// rootDir scan of `<cwd>`.
const WORKTREE_ROOT = path.join(os.tmpdir(), 'session-manager-job-worktrees');

// Disk estimate for this repo (session-manager): `git worktree add` checks
// out only git-tracked source, not `node_modules`/`dist` — a fresh checkout
// of this repo's tracked tree is ~30-40 MB (measured via `git ls-files | xargs
// du -ch` on the working tree, minus the .git object store the worktree
// shares with the main tree rather than duplicating). At the default cap of
// 4 concurrent worktrees that's under 200 MB — negligible next to the
// multi-GB `node_modules` a job's own `npm install`/build step may add inside
// its worktree (uncounted here; that risk is bounded by MIN_FREE_MB_PER_JOB's
// existing per-job memory gate in scheduler.cjs, not by this cap).
const DEFAULT_MAX_CONCURRENT_WORKTREES = 4;

function isWorktreeDisabled() {
  return process.env.SM_JOB_WORKTREE_DISABLE === '1';
}

function getMaxConcurrentWorktrees() {
  const raw = Number(process.env.SM_JOB_WORKTREE_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_CONCURRENT_WORKTREES;
}

// In-memory count of worktrees currently checked out by THIS process. Reset
// to 0 on every restart by design — a crash can never leave this counter
// permanently wedged above the cap; reconcileWorktreesOnBoot cleans up any
// leaked ON-DISK checkouts separately (see below).
let activeWorktreeCount = 0;

function execGit(args, { cwd, timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stderrText = stderr;
        reject(err);
        return;
      }
      resolve(stdout || '');
    });
  });
}

async function isGitRepo(cwd) {
  if (!cwd) return false;
  try {
    const out = await execGit(['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 10_000 });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/** True when `cwd`'s own working tree (not any worktree) has zero pending changes. */
async function isBaseTreeClean(cwd) {
  try {
    const out = await execGit(['status', '--porcelain'], { cwd, timeout: 10_000 });
    return out.trim().length === 0;
  } catch {
    return false;
  }
}

function hashOf(input) {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 16);
}

function worktreeDirFor(cwd, slug) {
  return path.join(WORKTREE_ROOT, hashOf(cwd), slug);
}

function branchNameFor(slug) {
  return `sm-job/${slug}`;
}

/** Best-effort teardown of one worktree checkout — never throws. */
async function removeWorktreeDir(cwd, dir) {
  try {
    await execGit(['worktree', 'remove', '--force', dir], { cwd, timeout: 15_000 });
  } catch {
    // Not registered (already removed) or dir already gone — fall through to
    // a plain rm so a half-created checkout never leaks disk either.
  }
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Create a linked worktree for one job, on a fresh branch checked out from
 * the main tree's current HEAD. Returns `{ ok: true, dir, branch, baseCwd }`
 * on success, or `{ ok: false, reason }` — the reason is always a short,
 * human-readable string meant to be logged verbatim so a fallback to running
 * in place is never silent.
 *
 * Never throws: every failure mode (not a repo, dirty base, cap reached, git
 * error) is a normal, expected outcome for a project that hasn't opted into
 * — or currently can't support — isolation, not an exceptional one.
 */
async function createJobWorktree({ cwd, slug }) {
  if (isWorktreeDisabled()) return { ok: false, reason: 'disabled via SM_JOB_WORKTREE_DISABLE=1' };
  if (!cwd || typeof cwd !== 'string') return { ok: false, reason: 'no cwd provided' };
  if (!slug || typeof slug !== 'string') return { ok: false, reason: 'no slug provided' };

  if (!(await isGitRepo(cwd))) return { ok: false, reason: 'not a git repository' };

  // A dirty base tree means the job may be depending on the human's own
  // uncommitted WIP in `cwd` — a worktree only ever checks out committed
  // HEAD content, so isolating into one here would silently drop that WIP
  // from what the job sees. Falling back to running in place is strictly
  // safer than guessing.
  if (!(await isBaseTreeClean(cwd))) return { ok: false, reason: 'base working tree has uncommitted changes' };

  if (activeWorktreeCount >= getMaxConcurrentWorktrees()) {
    return { ok: false, reason: `worktree cap reached (${getMaxConcurrentWorktrees()} concurrent)` };
  }
  // Reserve the slot SYNCHRONOUSLY (before any `await` below) so two jobs
  // spawned in the same tick can't both pass the check above and both
  // proceed — without this, the cap is a TOCTOU race: N concurrent callers
  // all read the pre-increment count before either increments it. Released
  // again below on any failure path so a failed create never permanently
  // shrinks capacity.
  activeWorktreeCount++;

  const dir = worktreeDirFor(cwd, slug);
  const branch = branchNameFor(slug);
  try {
    await fsp.mkdir(path.dirname(dir), { recursive: true });
    // Defensive: a same-slug leftover from a prior crashed run (same slug can
    // legitimately re-fire after a transient failure) must not collide with
    // `git worktree add`'s own branch/path checks.
    await removeWorktreeDir(cwd, dir);
    try { await execGit(['branch', '-D', branch], { cwd, timeout: 10_000 }); } catch { /* didn't exist */ }
    await execGit(['worktree', 'add', '-b', branch, dir, 'HEAD'], { cwd, timeout: 30_000 });
  } catch (e) {
    activeWorktreeCount = Math.max(0, activeWorktreeCount - 1);
    return { ok: false, reason: `git worktree add failed: ${(e && (e.stderrText || e.message)) || e}` };
  }
  return { ok: true, dir, branch, baseCwd: cwd };
}

/**
 * Integrate a job's branch back into `cwd`'s current HEAD — fast-forward
 * when possible, a real merge commit when the main tree advanced underneath
 * (a sibling job merged first) since the worktree was created. Returns
 * `{ ok: true, integrated: boolean, ...}` on success (integrated:false means
 * the branch had no new commits — a legitimate no-op job, not a failure), or
 * `{ ok: false, reason }` when neither ff-only nor a real merge could land —
 * e.g. a genuine content conflict between two jobs that touched the same
 * lines. On failure the branch is left un-merged and NOT deleted (see
 * cleanupJobWorktree) so the work is recoverable, never silently discarded.
 */
async function integrateJobBranch({ cwd, branch, slug }) {
  if (!cwd || !branch) return { ok: false, reason: 'missing cwd/branch' };
  let branchHead;
  try {
    branchHead = (await execGit(['rev-parse', branch], { cwd, timeout: 10_000 })).trim();
  } catch (e) {
    return { ok: false, reason: `branch ${branch} not found: ${(e && (e.stderrText || e.message)) || e}` };
  }
  let mergeBase = '';
  try {
    mergeBase = (await execGit(['merge-base', 'HEAD', branch], { cwd, timeout: 10_000 })).trim();
  } catch {
    mergeBase = '';
  }
  if (mergeBase && mergeBase === branchHead) {
    return { ok: true, integrated: false, reason: 'branch has no new commits' };
  }

  try {
    await execGit(['merge', '--ff-only', branch], { cwd, timeout: 30_000 });
    return { ok: true, integrated: true, fastForward: true };
  } catch {
    // Main tree advanced since the worktree branched (a sibling job merged
    // first) — a real merge commit still lands the job's own commit(s).
  }
  try {
    await execGit(['merge', '--no-ff', '--no-edit', '-m', `merge scheduler job ${slug || branch}`, branch], { cwd, timeout: 30_000 });
    return { ok: true, integrated: true, mergeCommit: true };
  } catch (e) {
    // Abort a half-applied merge so `cwd` isn't left in a mid-merge state.
    try { await execGit(['merge', '--abort'], { cwd, timeout: 10_000 }); } catch { /* nothing to abort */ }
    return { ok: false, reason: `merge failed (likely a real content conflict): ${(e && (e.stderrText || e.message)) || e}` };
  }
}

/**
 * Tear down one job's worktree checkout after it has been integrated (or
 * failed to integrate). Always removes the linked-worktree checkout (freeing
 * its disk); only deletes the branch ref when `keepBranch` is falsy — a
 * failed integration keeps the branch around for manual recovery per
 * integrateJobBranch's contract above. Never throws.
 */
async function cleanupJobWorktree({ cwd, dir, branch, keepBranch }) {
  if (dir) await removeWorktreeDir(cwd, dir);
  if (branch && !keepBranch) {
    try { await execGit(['branch', '-D', branch], { cwd, timeout: 10_000 }); } catch { /* already gone */ }
  }
  try { await execGit(['worktree', 'prune'], { cwd, timeout: 10_000 }); } catch { /* best effort */ }
  activeWorktreeCount = Math.max(0, activeWorktreeCount - 1);
}

/** Parse `git worktree list --porcelain` into `[{ worktree, branch }]`. */
function parseWorktreeListPorcelain(text) {
  const entries = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { worktree: line.slice('worktree '.length).trim(), branch: null };
      entries.push(cur);
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
  }
  return entries;
}

/**
 * Boot reconciliation: a job worktree that survives a process crash (app
 * killed mid-run, host reboot) leaks disk and a dangling branch forever
 * unless something cleans it up — this is that something. For each known
 * project cwd, lists every registered worktree, forcibly removes any that
 * live under WORKTREE_ROOT (ours; never touches a worktree a human created
 * for their own purposes), deletes its branch, and prunes stale registrations.
 * Never throws — a project that isn't a git repo, or has no worktrees, is a
 * silent no-op.
 */
async function reconcileWorktreesOnBoot(cwds) {
  const list = Array.isArray(cwds) ? cwds.filter(Boolean) : [];
  for (const cwd of list) {
    if (!(await isGitRepo(cwd))) continue;
    let out = '';
    try {
      out = await execGit(['worktree', 'list', '--porcelain'], { cwd, timeout: 15_000 });
    } catch {
      continue;
    }
    const entries = parseWorktreeListPorcelain(out);
    for (const entry of entries) {
      if (!entry.worktree || !entry.worktree.startsWith(WORKTREE_ROOT + path.sep)) continue;
      await removeWorktreeDir(cwd, entry.worktree);
      if (entry.branch) {
        try { await execGit(['branch', '-D', entry.branch], { cwd, timeout: 10_000 }); } catch { /* already gone */ }
      }
    }
    try { await execGit(['worktree', 'prune'], { cwd, timeout: 10_000 }); } catch { /* best effort */ }
  }
}

module.exports = {
  WORKTREE_ROOT,
  DEFAULT_MAX_CONCURRENT_WORKTREES,
  isWorktreeDisabled,
  getMaxConcurrentWorktrees,
  isGitRepo,
  isBaseTreeClean,
  worktreeDirFor,
  branchNameFor,
  createJobWorktree,
  integrateJobBranch,
  cleanupJobWorktree,
  parseWorktreeListPorcelain,
  reconcileWorktreesOnBoot,
  // Test-only escape hatch for the in-memory concurrency counter.
  _resetActiveWorktreeCountForTests(n = 0) { activeWorktreeCount = n; },
  _getActiveWorktreeCountForTests() { return activeWorktreeCount; },
};
