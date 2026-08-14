/**
 * jobWorktree.cjs — per-job `git worktree` isolation for concurrent scheduler
 * runs (PRD 994).
 *
 * As of PRD 1032 this is a thin, byte-for-byte-compatible wrapper over the
 * generalized primitives in gitWorktree.cjs (kind: 'job') — every export
 * below keeps its original call shape so scheduler.cjs and any other
 * existing caller need zero changes. New callers wanting the same isolation
 * for a different kind of unit of work (e.g. an Epic session — kind: 'epic')
 * should use gitWorktree.cjs's `create/integrate/cleanupEpicWorktree`
 * directly rather than adding a second copy here.
 *
 * Problem this solves: once the queue genuinely runs several jobs wide in
 * one project, N headless `claude -p` processes edit the SAME working tree
 * simultaneously. Observed live on 2026-08-02 with only two concurrent
 * writers: a full test run failed on another job's half-written renderer
 * files, a commit had to be hand-staged to avoid sweeping a sibling job's
 * WIP, and a commit was silently rewritten to a new SHA by a concurrent
 * rebase. This module gives each job its own linked worktree — its edits,
 * its test runs, its commit — isolated from every sibling job and from the
 * human's own interactive session in the same repo.
 *
 * ---------- the ops-root hazard (read before touching cwd plumbing) ----------
 *
 * See gitWorktree.cjs's own header comment for the full writeup — the rule
 * carries forward unchanged: this module never changes `job.cwd`. It hands
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

const gitWorktree = require('./gitWorktree.cjs');

const KIND = 'job';

module.exports = {
  WORKTREE_ROOT: gitWorktree.worktreeRootFor(KIND),
  DEFAULT_MAX_CONCURRENT_WORKTREES: gitWorktree.KIND_CONFIG[KIND].defaultMax,
  isWorktreeDisabled: () => gitWorktree.isWorktreeDisabled(KIND),
  getMaxConcurrentWorktrees: () => gitWorktree.getMaxConcurrentWorktrees(KIND),
  isGitRepo: gitWorktree.isGitRepo,
  isBaseTreeClean: gitWorktree.isBaseTreeClean,
  worktreeDirFor: (cwd, slug) => gitWorktree.worktreeDirFor(KIND, cwd, slug),
  branchNameFor: (slug) => gitWorktree.branchNameFor(KIND, slug),
  createJobWorktree: gitWorktree.createJobWorktree,
  integrateJobBranch: gitWorktree.integrateJobBranch,
  cleanupJobWorktree: gitWorktree.cleanupJobWorktree,
  parseWorktreeListPorcelain: gitWorktree.parseWorktreeListPorcelain,
  reconcileWorktreesOnBoot: (cwds) => gitWorktree.reconcileWorktreesOnBoot(cwds, { kind: KIND }),
  // Test-only escape hatch for the in-memory concurrency counter.
  _resetActiveWorktreeCountForTests(n = 0) { gitWorktree._resetActiveWorktreeCountForTests(KIND, n); },
  _getActiveWorktreeCountForTests() { return gitWorktree._getActiveWorktreeCountForTests(KIND); },
};
