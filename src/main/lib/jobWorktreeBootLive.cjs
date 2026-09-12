'use strict';

/**
 * jobWorktreeBootLive.cjs — builds the `isLive` predicate scheduler.cjs's
 * boot sweep hands to `jobWorktree.reconcileWorktreesOnBoot` (PRD 1162).
 *
 * Kept in a separate lib file — same reasoning as reaperHelpers.cjs's header
 * — so the predicate's logic is unit-testable without importing scheduler.cjs
 * (which requires electron/ipcMain).
 *
 * A job is spawned `detached: true` (scheduler.cjs), so its `claude -p`
 * executor SURVIVES the Electron app being killed/restarted — a worktree
 * found at boot is NOT, by itself, proof the run that owns it died. This
 * predicate treats a worktree as live via either signal:
 *   1. its owning queue row is still `status: 'running'` with a `runtime.pid`
 *      that `claudePidAlive` reports alive, or
 *   2. `hasLiveHolder` finds a process whose cwd is the checkout itself (or a
 *      path under it) — covers a row that went terminal (or was never
 *      written) while the process is still actually running.
 * Either match logs one line naming the slug and which check held it, so a
 * persistently-skipped leak stays visible (RCA: PRD 1108).
 */

/**
 * @param {{ bootJobs: Array<object>, claudePidAlive: (pid: number) => boolean, hasLiveHolder: (dir: string, holders?: Set<string>) => boolean, cwdHolders?: Set<string> }} deps
 * @returns {(slug: string, entry: { worktree: string, branch: string|null }) => boolean}
 */
function buildJobWorktreeIsLive({ bootJobs, claudePidAlive, hasLiveHolder, cwdHolders }) {
  const runningPidBySlug = new Map();
  for (const j of Array.isArray(bootJobs) ? bootJobs : []) {
    if (j && j.status === 'running' && j.runtime && j.runtime.pid) {
      runningPidBySlug.set(j.slug, j.runtime.pid);
    }
  }

  return function isLive(slug, entry) {
    const pid = runningPidBySlug.get(slug);
    if (pid && claudePidAlive(pid)) {
      console.log(`[gitWorktree] boot sweep: skipping job worktree slug=${slug} — running row with live pid=${pid}`);
      return true;
    }
    const dir = entry && entry.worktree;
    if (dir && hasLiveHolder(dir, cwdHolders)) {
      console.log(`[gitWorktree] boot sweep: skipping job worktree slug=${slug} — live cwd holder under ${dir}`);
      return true;
    }
    return false;
  };
}

module.exports = { buildJobWorktreeIsLive };
