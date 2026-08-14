'use strict';

/**
 * epicWorktreeMerge.cjs — IPC entry point that folds an Epic's isolated git
 * worktree branch (gitWorktree.cjs's `integrateEpicBranch`, kind: 'epic')
 * back into its owning project's main tree (PRD 1034, third link of the
 * epic-worktree-isolation chain started by PRD 1032/1033).
 *
 * This is the ONLY point where that per-Epic isolation resolves back into
 * the shared tree — never mid-session (see gitWorktree.cjs's own header
 * comment for the ff-only -> merge-commit -> abort-and-flag algorithm this
 * reuses verbatim). Callers reach it two ways: an explicit "merge to main"
 * action (renderer state's `mergeEpicToMain`), and `markCompleted`'s
 * merge-before-archive checkpoint — both funnel through this one handler so
 * the integration strategy is never duplicated.
 *
 * On success the worktree checkout is torn down (cleanupEpicWorktree) since
 * its content now safely lives on the main tree. On a real conflict, the
 * branch and worktree directory are left intact — never silently discarded
 * — so a human can still open a Terminal into `worktree.dir` (PRD 1033's
 * existing epicSpawnCwd.cjs wiring — it keys off `worktree.dir` alone, not
 * `worktree.status`, so a conflicted Epic's Terminal spawn keeps landing
 * there with no new code path needed) and resolve it manually before
 * re-running this same action.
 */

const { integrateEpicBranch, cleanupEpicWorktree } = require('./gitWorktree.cjs');
const { validatePath } = require('../config.cjs');

/**
 * mergeEpicToMainViaIpc(cwd, epicId, branch, dir) → Promise<MergeOutcome>
 *
 * `MergeOutcome` is `{ ok: true, status: 'merged', integrated: boolean }` on
 * a clean merge (or a legitimate no-new-commits no-op — either way nothing
 * is left to resolve, so the worktree is cleaned up), or
 * `{ ok: false, status: 'needs_merge_resolution', reason: string }` on a
 * real conflict — never throws (integrateEpicBranch/cleanupEpicWorktree
 * never do either).
 */
async function mergeEpicToMainViaIpc(cwd, epicId, branch, dir) {
  validatePath(cwd);
  const outcome = await integrateEpicBranch({ cwd, branch, epicId });
  if (!outcome.ok) {
    console.log(`[epicWorktreeMerge] ${epicId}: needs manual resolution (${outcome.reason})`);
    return { ok: false, status: 'needs_merge_resolution', reason: outcome.reason };
  }
  // Clean ff-only/merge-commit landing, or a legitimate no-new-commits
  // no-op — either way the branch's content is safely reflected (or was
  // never ahead), so the checkout has nothing left to guard.
  await cleanupEpicWorktree({ cwd, dir, branch, keepBranch: false });
  return { ok: true, status: 'merged', integrated: outcome.integrated };
}

function registerEpicWorktreeMergeHandlers() {
  const { ipcMain } = require('electron');
  const { schemas: s, validated: v } = require('../ipcSchemas.cjs');
  ipcMain.handle(
    'promptSessions:merge-to-main',
    v(s.promptSessionsMergeToMain, ({ cwd, epicId, branch, dir }) => mergeEpicToMainViaIpc(cwd, epicId, branch, dir)),
  );
}

module.exports = { mergeEpicToMainViaIpc, registerEpicWorktreeMergeHandlers };
