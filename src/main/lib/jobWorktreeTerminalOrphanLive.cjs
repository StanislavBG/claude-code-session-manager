'use strict';

/**
 * jobWorktreeTerminalOrphanLive.cjs — builds the `isLive` predicate
 * scheduler.cjs's `reclaimTerminalJobOrphansThrottled` hands to
 * `jobWorktree.reclaimTerminalJobOrphans` (PRD 1163).
 *
 * Kept in a separate lib file — same reasoning as jobWorktreeBootLive.cjs's
 * header — so the predicate's logic is unit-testable without importing
 * scheduler.cjs (which requires electron/ipcMain).
 *
 * A queue row already resolved to a terminal status (completed/failed/
 * skipped) is not, by itself, proof its executor actually stopped —
 * overrunning-job escalation, a phantom pidless reap, or a cancel whose kill
 * didn't land can all produce a terminal row while the real process keeps
 * running. This predicate treats a candidate worktree as live via either
 * signal, checked in this order (cheapest/most decisive first):
 *   1. `hasLiveHolder` finds a process whose cwd is the checkout itself (or a
 *      path under it) — project-agnostic, catches a still-running executor
 *      regardless of what its queue row says.
 *   2. the terminal row's own recorded `runtime.pid` is still alive
 *      (`claudePidAlive`) — catches the case `hasLiveHolder` can't see
 *      (darwin has no `/proc`, so `hasLiveHolder` always reports no holder
 *      there; the pid check is the only gate on that platform, which is an
 *      accepted, documented tradeoff).
 * Either match logs one line naming the slug and the reason, and reports it
 * to the optional `onLive(slug, reason)` callback — this is how the caller
 * (scheduler.cjs) learns which terminal rows to stamp
 * `worktreeReclaimBlockedLive` on, without this module ever reading or
 * writing queue state itself.
 */

/**
 * @param {{
 *   terminalJobs: Array<object>,
 *   claudePidAlive: (pid: number) => boolean,
 *   hasLiveHolder: (dir: string, holders?: Set<string>) => boolean,
 *   cwdHolders?: Set<string>,
 *   onLive?: (slug: string, reason: string) => void,
 * }} deps
 * @returns {(slug: string, entry: { worktree: string, branch: string|null }) => boolean}
 */
function buildTerminalOrphanIsLive({ terminalJobs, claudePidAlive, hasLiveHolder, cwdHolders, onLive }) {
  const pidBySlug = new Map();
  for (const j of Array.isArray(terminalJobs) ? terminalJobs : []) {
    if (j && j.slug && j.runtime && j.runtime.pid) pidBySlug.set(j.slug, j.runtime.pid);
  }

  return function isLive(slug, entry) {
    const dir = entry && entry.worktree;
    if (dir && hasLiveHolder(dir, cwdHolders)) {
      const reason = `live cwd holder under ${dir}`;
      console.log(`[gitWorktree] terminal orphan reclaim: skipping job worktree slug=${slug} — ${reason}`);
      if (onLive) onLive(slug, reason);
      return true;
    }
    const pid = pidBySlug.get(slug);
    if (pid && claudePidAlive(pid)) {
      const reason = `terminal row's recorded pid=${pid} still alive`;
      console.log(`[gitWorktree] terminal orphan reclaim: skipping job worktree slug=${slug} — ${reason}`);
      if (onLive) onLive(slug, reason);
      return true;
    }
    return false;
  };
}

module.exports = { buildTerminalOrphanIsLive };
