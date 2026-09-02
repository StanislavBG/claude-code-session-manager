'use strict';

/**
 * landedSinceRun.cjs — widened, path-scoped commit evidence for the reverify
 * self-heal pass (PRD 1102).
 *
 * committedInWindow (scheduler.cjs) only sees commits inside
 * [startedAt, finishedAt+60s] — a commit that lands later (a retry, a
 * sibling run, a human) is invisible to it. landedSinceRun has no upper
 * bound, but narrows the OTHER way that committedInWindow is dangerously
 * broad: it is scoped to paths the PRD itself declares, so an unrelated
 * commit elsewhere in the repo is not credited to this job (see
 * scheduler.cjs's healRefusalReason for why repo-wide, unscoped evidence is
 * not attribution).
 *
 * Pure git wrapper — no fetch, no scheduler state. Callers that need remote
 * commits visible (e.g. a job that committed in a since-removed worktree)
 * must call scheduler.cjs's fetchAllRefs(cwd) first, same as
 * committedInWindow's own callers do.
 */

const { execFile } = require('node:child_process');

const LANDED_SINCE_RUN_TIMEOUT_MS = 10_000;

/**
 * Commits in `cwd` since `sinceIso` (no upper bound) that touch any of
 * `paths`. Never throws — git-unavailable, a non-repo cwd, or an empty
 * `paths` list all resolve to `[]` rather than fabricating evidence.
 *
 * @param {string} cwd
 * @param {string} sinceIso
 * @param {string[]} paths
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string[]>} full commit SHAs, newest first
 */
function landedSinceRun(cwd, sinceIso, paths, { timeoutMs = LANDED_SINCE_RUN_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!cwd || !sinceIso || !Array.isArray(paths) || paths.length === 0) {
      resolve([]);
      return;
    }
    execFile(
      'git',
      ['-C', cwd, 'log', '--all', `--since=${sinceIso}`, '--format=%H', '--', ...paths],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve([]); return; }
        resolve(String(stdout || '').trim().split('\n').filter(Boolean));
      },
    );
  });
}

module.exports = { landedSinceRun, LANDED_SINCE_RUN_TIMEOUT_MS };
