/**
 * gitWorktree.cjs — generalized `git worktree` isolation primitives (PRD
 * 1032), backing BOTH scheduler jobs (`sm-job/<slug>`, unchanged behavior —
 * see jobWorktree.cjs, now a thin wrapper over this module) and interactive
 * Epic sessions (`sm-epic/<epicId>`, new).
 *
 * Every entry point below takes an explicit `kind: 'job' | 'epic'` (or is
 * itself kind-scoped via a `create*Worktree`/`integrate*Branch`/
 * `cleanup*Worktree` wrapper) that selects: the branch prefix, the on-disk
 * worktree root subfolder, the disable/cap env vars, and the concurrency cap
 * default. Everything else — the git plumbing, the never-throws contract, the
 * ff-only→merge-commit→abort-and-flag integration strategy, the TOCTOU-safe
 * synchronous slot reservation — is one shared implementation.
 *
 * ---------- the ops-root hazard (read before touching cwd plumbing) ----------
 *
 * `<cwd>/session-manager-operations/` (PRDs, queue state, run logs, the
 * active-index.json Epic store) is resolved from a project's cwd by
 * lib/prdLocations.cjs, lib/queueStore.cjs, and every prompt-sessions IPC
 * handler — all of them take `cwd` as an explicit parameter, never
 * `process.cwd()`. That means the ops root follows WHATEVER cwd value the
 * caller passes in. A prior incident (recorded in this project's memory as
 * `no_schedule_self_e2e`) is exactly this mistake: swapping a job's cwd for a
 * worktree cwd gives it a different, EMPTY ops root and orphans its own
 * PRD/queue row.
 *
 * This invariant carries forward UNCHANGED into the Epic path: this module
 * never changes an Epic's owning-project `cwd` either. It only ever hands
 * back a SEPARATE `dir` (the worktree directory) for a caller to use as a
 * spawned process's `cwd` *spawn option* — every PRD-path resolution, queue
 * read/write, active-index.json read/write, and run-log path must keep using
 * the real project `cwd` exactly as before. The next PRD in this chain (which
 * wires an Epic's PTY/Chat spawn cwd to its worktree) must preserve this same
 * split: spawn cwd = worktree dir, ops-root cwd = real project cwd, always.
 *
 * ---------- commit-guard visibility across the worktree boundary ----------
 *
 * For the job kind, scheduler.cjs's commit-guard reads git state
 * (uncommittedChanges/gitHead) from the main tree before and after a run. If
 * a job's commit only ever lands on a throwaway worktree branch, the main
 * tree's HEAD never moves and the guard would wrongly conclude nothing was
 * committed (the pre-existing `pass-no-commit-worktree-commit-invisible-at-
 * exit` / RCA 770-pr269 incident class). `integrateBranch` closes that gap
 * for OUR managed worktrees: it merges the branch into `cwd`'s own HEAD
 * (ff-only when possible, a real merge commit otherwise) BEFORE any post-run
 * git check relying on the main tree's HEAD — so the commit is real on the
 * main tree, not something a guard has to go looking for.
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

// Per-kind configuration. Roots are kept OUTSIDE any project's own tree
// (os.tmpdir(), not `<cwd>/.git/...`) so a managed worktree never shows up in
// the main tree's own file listings, `find`, or a tsc rootDir scan of `<cwd>`.
//
// Job default cap (4): disk estimate for this repo (session-manager) — `git
// worktree add` checks out only git-tracked source, not `node_modules`/
// `dist` — a fresh checkout of this repo's tracked tree is ~30-40 MB
// (measured via `git ls-files | xargs du -ch`, minus the shared .git object
// store). At 4 concurrent worktrees that's under 200 MB — negligible next to
// whatever a job's own build step may add inside its worktree (uncounted
// here; bounded by scheduler.cjs's own memory gate, not by this cap).
//
// Epic default cap (50, effectively unbounded in practice): a scheduler job
// runs minutes and is torn down the moment its PRD completes, so a tight cap
// plus a fallback-to-in-place is the right trade — worst case, one job waits
// a few minutes for a slot to free up. An Epic is the opposite shape: it runs
// for hours or days across an interactive human session, and "fall back to
// running in the main tree" for an Epic means silently losing the isolation
// the whole feature exists to provide, for as long as that Epic stays open.
// The job cap's assumptions (few, short-lived, quickly-reclaimed checkouts)
// simply don't transfer, so the epic kind gets a separately-configurable,
// much higher ceiling rather than sharing the job kind's default.
const KIND_CONFIG = {
  job: {
    root: path.join(os.tmpdir(), 'session-manager-job-worktrees'),
    branchPrefix: 'sm-job/',
    disableEnv: 'SM_JOB_WORKTREE_DISABLE',
    maxEnv: 'SM_JOB_WORKTREE_MAX',
    defaultMax: 4,
  },
  epic: {
    root: path.join(os.tmpdir(), 'session-manager-epic-worktrees'),
    branchPrefix: 'sm-epic/',
    disableEnv: 'SM_EPIC_WORKTREE_DISABLE',
    maxEnv: 'SM_EPIC_WORKTREE_MAX',
    defaultMax: 50,
  },
};

function configFor(kind) {
  const cfg = KIND_CONFIG[kind];
  if (!cfg) throw new Error(`gitWorktree: unknown kind "${kind}" (expected 'job' or 'epic')`);
  return cfg;
}

function worktreeRootFor(kind) {
  return configFor(kind).root;
}

/**
 * `cwd` is optional (job-kind callers never pass it — the per-project toggle
 * only exists for the epic kind, PRD 1035) and, when passed, additionally
 * consults epicWorktreeProjectConfig.cjs's per-project UI toggle — the
 * env var still wins machine-wide regardless of what any project has set.
 * Lazily required to avoid a load-order cycle (neither module needs the
 * other at require time, only at call time).
 */
function isWorktreeDisabled(kind, cwd) {
  if (process.env[configFor(kind).disableEnv] === '1') return true;
  if (kind === 'epic' && cwd) {
    const { isEpicWorktreeDisabledForProject } = require('./epicWorktreeProjectConfig.cjs');
    if (isEpicWorktreeDisabledForProject(cwd)) return true;
  }
  return false;
}

function getMaxConcurrentWorktrees(kind) {
  const cfg = configFor(kind);
  const raw = Number(process.env[cfg.maxEnv]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : cfg.defaultMax;
}

// In-memory count of worktrees currently checked out by THIS process, kept
// PER KIND so a burst of Epic worktrees can never starve the job cap (or vice
// versa). Reset to 0 per kind on every restart by design — a crash can never
// leave either counter permanently wedged above its cap; reconcileWorktreesOnBoot
// cleans up any leaked ON-DISK checkouts separately (see below).
const activeWorktreeCount = { job: 0, epic: 0 };

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

/**
 * True when `cwd`'s own working tree (not any worktree) has zero pending
 * changes to TRACKED files (modified or staged). Untracked files are
 * deliberately excluded (`--untracked-files=no`): an untracked file is never
 * tracked WIP a job depends on, and `git worktree add` checks out only
 * committed HEAD content into the new worktree — it never touches, copies, or
 * is affected by the base tree's untracked files either way. Counting them as
 * "dirty" here bought no safety: one stray scratch file in a project silently
 * disabled isolation for every job in that project, permanently, since a
 * failed-to-commit job leaves the tree dirty and re-triggers the same
 * fallback for every subsequent job (RCA: PRD 1064, starry-night-ships).
 */
async function isBaseTreeClean(cwd) {
  try {
    const out = await execGit(['status', '--porcelain', '--untracked-files=no'], { cwd, timeout: 10_000 });
    return out.trim().length === 0;
  } catch {
    return false;
  }
}

function hashOf(input) {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 16);
}

function worktreeDirFor(kind, cwd, key) {
  return path.join(worktreeRootFor(kind), hashOf(cwd), key);
}

function branchNameFor(kind, key) {
  return `${configFor(kind).branchPrefix}${key}`;
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
 * Create a linked worktree on a fresh branch checked out from the main
 * tree's current HEAD. Returns `{ ok: true, dir, branch, baseCwd }` on
 * success, or `{ ok: false, reason }` — the reason is always a short,
 * human-readable string meant to be logged verbatim so a fallback to running
 * in place is never silent.
 *
 * Never throws: every failure mode (not a repo, dirty base, cap reached, git
 * error) is a normal, expected outcome for a project that hasn't opted into
 * — or currently can't support — isolation, not an exceptional one.
 */
async function createWorktree({ kind, cwd, key }) {
  configFor(kind); // throws on an unknown kind before anything else runs
  if (!cwd || typeof cwd !== 'string') return { ok: false, reason: 'no cwd provided' };
  if (!key || typeof key !== 'string') return { ok: false, reason: 'no key provided' };
  if (isWorktreeDisabled(kind, cwd)) return { ok: false, reason: `disabled via ${configFor(kind).disableEnv}=1 or the project's isolation toggle` };

  if (!(await isGitRepo(cwd))) return { ok: false, reason: 'not a git repository' };

  // A dirty base tree means the caller may be depending on the human's own
  // uncommitted WIP in `cwd` — a worktree only ever checks out committed
  // HEAD content, so isolating into one here would silently drop that WIP
  // from what it sees. Falling back to running in place is strictly safer
  // than guessing.
  if (!(await isBaseTreeClean(cwd))) return { ok: false, reason: 'base working tree has uncommitted changes' };

  if (activeWorktreeCount[kind] >= getMaxConcurrentWorktrees(kind)) {
    return { ok: false, reason: `worktree cap reached (${getMaxConcurrentWorktrees(kind)} concurrent)` };
  }
  // Reserve the slot SYNCHRONOUSLY (before any `await` below) so two callers
  // invoked in the same tick can't both pass the check above and both
  // proceed — without this, the cap is a TOCTOU race: N concurrent callers
  // all read the pre-increment count before either increments it. Released
  // again below on any failure path so a failed create never permanently
  // shrinks capacity.
  activeWorktreeCount[kind]++;

  const dir = worktreeDirFor(kind, cwd, key);
  const branch = branchNameFor(kind, key);
  try {
    await fsp.mkdir(path.dirname(dir), { recursive: true });
    // Defensive: a same-key leftover from a prior crashed run (same slug/id
    // can legitimately re-fire after a transient failure) must not collide
    // with `git worktree add`'s own branch/path checks.
    await removeWorktreeDir(cwd, dir);
    try { await execGit(['branch', '-D', branch], { cwd, timeout: 10_000 }); } catch { /* didn't exist */ }
    await execGit(['worktree', 'add', '-b', branch, dir, 'HEAD'], { cwd, timeout: 30_000 });
  } catch (e) {
    activeWorktreeCount[kind] = Math.max(0, activeWorktreeCount[kind] - 1);
    return { ok: false, reason: `git worktree add failed: ${(e && (e.stderrText || e.message)) || e}` };
  }
  return { ok: true, dir, branch, baseCwd: cwd };
}

/**
 * Integrate a branch back into `cwd`'s current HEAD — fast-forward when
 * possible, a real merge commit when the main tree advanced underneath (a
 * sibling job/Epic merged first) since the worktree was created. Returns
 * `{ ok: true, integrated: boolean, ...}` on success (integrated:false means
 * the branch had no new commits — a legitimate no-op, not a failure), or
 * `{ ok: false, reason }` when neither ff-only nor a real merge could land —
 * e.g. a genuine content conflict. On failure the branch is left un-merged
 * and NOT deleted (see cleanupWorktree) so the work is recoverable, never
 * silently discarded.
 */
async function integrateBranch({ cwd, branch, key, kind }) {
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
    // Main tree advanced since the worktree branched (a sibling job/Epic
    // merged first) — a real merge commit still lands the branch's commit(s).
  }
  const mergeMessage = kind === 'epic'
    ? `merge epic ${key || branch}`
    // Preserves the exact job-kind message the pre-generalization jobWorktree.cjs
    // used, so a job's merge-commit text never changes under this refactor.
    : `merge scheduler job ${key || branch}`;
  try {
    await execGit(['merge', '--no-ff', '--no-edit', '-m', mergeMessage, branch], { cwd, timeout: 30_000 });
    return { ok: true, integrated: true, mergeCommit: true };
  } catch (e) {
    // Abort a half-applied merge so `cwd` isn't left in a mid-merge state.
    try { await execGit(['merge', '--abort'], { cwd, timeout: 10_000 }); } catch { /* nothing to abort */ }
    return { ok: false, reason: `merge failed (likely a real content conflict): ${(e && (e.stderrText || e.message)) || e}` };
  }
}

/**
 * Tear down one worktree checkout after it has been integrated (or failed to
 * integrate). Always removes the linked-worktree checkout (freeing its
 * disk); only deletes the branch ref when `keepBranch` is falsy — a failed
 * integration keeps the branch around for manual recovery per
 * integrateBranch's contract above. Never throws.
 */
async function cleanupWorktree({ kind, cwd, dir, branch, keepBranch }) {
  configFor(kind); // throws on an unknown kind before anything else runs
  if (dir) await removeWorktreeDir(cwd, dir);
  if (branch && !keepBranch) {
    try { await execGit(['branch', '-D', branch], { cwd, timeout: 10_000 }); } catch { /* already gone */ }
  }
  try { await execGit(['worktree', 'prune'], { cwd, timeout: 10_000 }); } catch { /* best effort */ }
  activeWorktreeCount[kind] = Math.max(0, activeWorktreeCount[kind] - 1);
}

/**
 * Best-effort dump of a worktree's full outstanding diff (tracked
 * modifications AND untracked files) to `outFile`, for a caller about to
 * tear the worktree down. A job killed before its finish-protocol commit
 * (rate limit, timeout, crash, hard kill) otherwise loses that work
 * outright the moment `cleanupWorktree` removes the checkout — no branch,
 * no stash, no patch survives it. `git add -A --intent-to-add` stages
 * untracked paths (empty blobs) without touching their content, so the
 * subsequent `git diff HEAD --binary` includes their full contents exactly
 * like a tracked modification; the result is a patch a later `git apply`
 * can consume verbatim.
 *
 * Never throws — this always runs immediately before teardown and must
 * never block branch integration/cleanup or change a job's verdict. Writes
 * nothing (and returns `{ ok: false }`) when the worktree is clean or on
 * any git failure, so a successful run's teardown never leaves a 0-byte
 * artifact behind.
 */
async function salvageWorktreeDiff({ cwd, outFile }) {
  try {
    const status = await execGit(['status', '--porcelain'], { cwd, timeout: 15_000 });
    if (!status.trim()) return { ok: false };
    try {
      await execGit(['add', '-A', '--intent-to-add'], { cwd, timeout: 30_000 });
    } catch {
      // Best-effort — the diff below still captures whatever staged/tracked
      // changes exist even if intent-to-add partially failed.
    }
    const patch = await execGit(['diff', 'HEAD', '--binary'], { cwd, timeout: 30_000 });
    if (!patch || !patch.trim()) return { ok: false };
    const { writeTextAtomic } = require('../config.cjs');
    await writeTextAtomic(outFile, patch);
    return { ok: true, bytes: Buffer.byteLength(patch, 'utf8') };
  } catch {
    return { ok: false };
  }
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

/** Strips a kind's branch prefix off a branch name, returning the bare
 *  key (slug/epicId), or null if the branch doesn't carry that prefix. */
function keyFromBranch(kind, branch) {
  const prefix = configFor(kind).branchPrefix;
  if (!branch || !branch.startsWith(prefix)) return null;
  return branch.slice(prefix.length);
}

/**
 * Boot reconciliation: a worktree that survives a process crash (app killed
 * mid-run, host reboot) leaks disk and a dangling branch forever unless
 * something cleans it up — this is that something. For each known project
 * cwd, lists every registered worktree, forcibly removes any that live under
 * this kind's own root (never touches a worktree a human created for their
 * own purposes, or one belonging to the OTHER kind), deletes its branch, and
 * prunes stale registrations.
 *
 * `opts.isLive(key, entry)` is an optional liveness predicate — when it
 * returns true for a given worktree's key (the slug/epicId parsed off its
 * branch name), that worktree is left alone instead of being reaped. This is
 * what lets the epic kind skip a worktree whose owning Epic is still
 * `active` in the project's active-index.json (the caller supplies that
 * check; this module has no active-index.json knowledge of its own — see
 * this chain's next PRD for the real wiring). Job-kind reconciliation has no
 * equivalent concept (a job worktree found at boot is, by definition, from a
 * run that didn't finish) and typically omits `isLive`.
 *
 * Never throws — a project that isn't a git repo, or has no worktrees, is a
 * silent no-op.
 */
async function reconcileWorktreesOnBoot(cwds, opts = {}) {
  const kind = opts.kind || 'job';
  const isLive = typeof opts.isLive === 'function' ? opts.isLive : null;
  const root = worktreeRootFor(kind);
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
      if (!entry.worktree || !entry.worktree.startsWith(root + path.sep)) continue;
      const key = keyFromBranch(kind, entry.branch);
      if (isLive && key && (await isLive(key, entry))) continue;
      await removeWorktreeDir(cwd, entry.worktree);
      if (entry.branch) {
        try { await execGit(['branch', '-D', entry.branch], { cwd, timeout: 10_000 }); } catch { /* already gone */ }
      }
    }
    try { await execGit(['worktree', 'prune'], { cwd, timeout: 10_000 }); } catch { /* best effort */ }
  }
}

// ──────────────────────────────────────────── kind-scoped convenience wrappers

async function createJobWorktree({ cwd, slug }) {
  return createWorktree({ kind: 'job', cwd, key: slug });
}
async function integrateJobBranch({ cwd, branch, slug }) {
  return integrateBranch({ kind: 'job', cwd, branch, key: slug });
}
async function cleanupJobWorktree({ cwd, dir, branch, keepBranch }) {
  return cleanupWorktree({ kind: 'job', cwd, dir, branch, keepBranch });
}
async function salvageJobWorktreeDiff({ dir, outFile }) {
  return salvageWorktreeDiff({ cwd: dir, outFile });
}

async function createEpicWorktree({ cwd, epicId }) {
  return createWorktree({ kind: 'epic', cwd, key: epicId });
}
async function integrateEpicBranch({ cwd, branch, epicId }) {
  return integrateBranch({ kind: 'epic', cwd, branch, key: epicId });
}
async function cleanupEpicWorktree({ cwd, dir, branch, keepBranch }) {
  return cleanupWorktree({ kind: 'epic', cwd, dir, branch, keepBranch });
}

module.exports = {
  KIND_CONFIG,
  worktreeRootFor,
  isWorktreeDisabled,
  getMaxConcurrentWorktrees,
  isGitRepo,
  isBaseTreeClean,
  worktreeDirFor,
  branchNameFor,
  keyFromBranch,
  createWorktree,
  integrateBranch,
  cleanupWorktree,
  salvageWorktreeDiff,
  parseWorktreeListPorcelain,
  reconcileWorktreesOnBoot,
  // Job-kind convenience wrappers — same call shape jobWorktree.cjs has
  // always exposed.
  createJobWorktree,
  integrateJobBranch,
  cleanupJobWorktree,
  salvageJobWorktreeDiff,
  // Epic-kind convenience wrappers.
  createEpicWorktree,
  integrateEpicBranch,
  cleanupEpicWorktree,
  // Test-only escape hatch for the in-memory per-kind concurrency counters.
  _resetActiveWorktreeCountForTests(kind, n = 0) {
    configFor(kind);
    activeWorktreeCount[kind] = n;
  },
  _getActiveWorktreeCountForTests(kind) {
    configFor(kind);
    return activeWorktreeCount[kind];
  },
};
