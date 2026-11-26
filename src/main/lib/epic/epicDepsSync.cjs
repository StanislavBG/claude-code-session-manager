/**
 * epicDepsSync.cjs — refresh an Epic worktree's per-entry node_modules links each
 * time its CLI is spawned there (Chat: chatRunner executeRun; Terminal: pty spawn).
 *
 * Why: syncNodeModulesLinks otherwise runs only when createWorktree reuses the
 * worktree (approve / reopen), so a long-lived Epic never sees a package added to
 * the main checkout later. Both spawn paths are synchronous, so this is
 * fire-and-forget: the sync runs on a later tick and its result is never awaited.
 * Throttled to once per worktree per THROTTLE_MS so rapid turns don't rescan.
 * Never throws; failures are logged.
 */
'use strict';

const worktreeDeps = require('../git/worktreeDeps.cjs');

const THROTTLE_MS = 30_000;

/** @type {Map<string, number>} worktreeCwd → last sync start (ms) */
const lastSyncAt = new Map();

function logFailure(worktreeCwd, err) {
  try {
    require('../../logs.cjs').writeLine({
      scope: 'epicDepsSync',
      level: 'warn',
      message: `node_modules link sync failed for ${worktreeCwd}: ${err?.message || String(err)}`,
      meta: { worktreeCwd },
    });
  } catch {
    try { console.warn(`[epicDepsSync] sync failed for ${worktreeCwd}:`, err?.message || err); } catch { /* never throw */ }
  }
}

/**
 * Fire-and-forget refresh of a worktree's node_modules links from the project checkout.
 * @param {{ projectCwd: string, worktreeCwd: string, now?: number }} opts
 * @returns {boolean} true when a sync was scheduled
 */
function syncEpicWorktreeDeps({ projectCwd, worktreeCwd, now } = /** @type {any} */ ({})) {
  try {
    if (process.env.SM_WORKTREE_DEP_LINK_DISABLE === '1') return false;
    if (!projectCwd || !worktreeCwd || worktreeCwd === projectCwd) return false;
    const t = typeof now === 'number' ? now : Date.now();
    const prev = lastSyncAt.get(worktreeCwd);
    if (prev !== undefined && t - prev < THROTTLE_MS) return false;
    lastSyncAt.set(worktreeCwd, t);
    setImmediate(() => {
      let p;
      try {
        p = worktreeDeps.syncNodeModulesLinks({ mainCwd: projectCwd, worktreeCwd });
      } catch (e) {
        logFailure(worktreeCwd, e);
        return;
      }
      Promise.resolve(p).catch((e) => logFailure(worktreeCwd, e));
    });
    return true;
  } catch (e) {
    logFailure(worktreeCwd, e);
    return false;
  }
}

function __resetForTests() { lastSyncAt.clear(); }

module.exports = { syncEpicWorktreeDeps, THROTTLE_MS, __resetForTests };
