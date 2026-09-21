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
 * reuses verbatim). The single caller is `markCompleted`'s merge-before-archive
 * checkpoint (via `attemptMergeToMainInternal` in
 * `src/renderer/state/promptSessions.ts`); there is no explicit "merge to
 * main" action.
 *
 * On success the worktree checkout is torn down (cleanupEpicWorktree) since
 * its content now safely lives on the main tree. On a real conflict, the
 * branch and worktree directory are left intact — never silently discarded
 * — so a human can still open a Terminal into `worktree.dir` (the spawn
 * resolution in epicSpawnCwd.cjs is status-aware: `needs_merge_resolution`
 * with an existing dir still lands there, while `merged`/`disabled` skip the
 * re-attach and fall back to the project cwd) and resolve it manually — the
 * branch and worktree dir are deliberately left intact so the human can merge
 * them from the command line.
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
async function mergeEpicToMainViaIpc(cwd, epicId, branch, dir, carriedPaths) {
  validatePath(cwd);
  const outcome = await integrateEpicBranch({ cwd, branch, epicId, carriedPaths });
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
    v(s.promptSessionsMergeToMain, ({ cwd, epicId, branch, dir, carriedPaths }) => mergeEpicToMainViaIpc(cwd, epicId, branch, dir, carriedPaths)),
  );
}

module.exports = { mergeEpicToMainViaIpc, registerEpicWorktreeMergeHandlers };
