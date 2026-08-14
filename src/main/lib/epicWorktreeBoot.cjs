'use strict';

/**
 * epicWorktreeBoot.cjs — boot reconciliation for Epic git worktrees (PRD
 * 1033, wiring gitWorktree.cjs's `reconcileWorktreesOnBoot` isLive predicate
 * that PRD 1032 built but left unwired).
 *
 * A worktree that survives an app crash/host reboot must not leak disk or a
 * dangling branch forever — but unlike a scheduler job worktree (always safe
 * to reap at boot; a job worktree found at boot is by definition from a run
 * that didn't finish), an Epic worktree backs a session a human may still be
 * mid-way through. Reaping it out from under a still-`active` Epic would
 * silently drop that Epic's isolation (and, worse, any uncommitted work sat
 * in the checkout) the moment the app restarts.
 *
 * Per project cwd, reads that project's own active-index.json (the same file
 * gitWorktree.cjs's own header comment calls the "ops-root" — resolved here
 * via epicMint.cjs's readActiveIndex, never a worktree path) and only reaps
 * a worktree whose owning Epic is NOT `active` in it. At boot there is by
 * definition no live attached PTY/chat process yet (the app process is
 * fresh), so the AC's "no live attached process" half of the gate holds
 * automatically — this predicate covers the other half.
 */

const gitWorktree = require('./gitWorktree.cjs');
const { readActiveIndex } = require('./epicMint.cjs');

/**
 * @param {string[]} cwds - known project cwds to sweep.
 * @param {{ readActiveIndex?: Function, reconcileWorktreesOnBoot?: Function }} [deps]
 * @returns {Promise<void>}
 */
async function reconcileEpicWorktreesOnBoot(cwds, deps = {}) {
  const load = deps.readActiveIndex || readActiveIndex;
  const reconcile = deps.reconcileWorktreesOnBoot || gitWorktree.reconcileWorktreesOnBoot;
  const list = Array.isArray(cwds) ? cwds.filter(Boolean) : [];
  for (const cwd of list) {
    let sessions = {};
    try {
      sessions = load(cwd).sessions || {};
    } catch {
      sessions = {}; // no active-index.json yet, or unreadable — nothing is "live"
    }
    const isLive = (epicId) => !!sessions[epicId] && sessions[epicId].status === 'active';
    await reconcile([cwd], { kind: 'epic', isLive });
  }
}

module.exports = { reconcileEpicWorktreesOnBoot };
