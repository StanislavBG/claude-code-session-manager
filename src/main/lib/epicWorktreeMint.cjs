'use strict';

/**
 * epicWorktreeMint.cjs — IPC entry point that creates an Epic's isolated git
 * worktree (gitWorktree.cjs's createEpicWorktree, kind: 'epic') at the
 * `proposed -> active` transition (PRD 1033, second link of the
 * epic-worktree-isolation chain started by PRD 1032).
 *
 * That transition itself lives in the renderer (state/promptSessions.ts's
 * approveProposed) and is synchronous — every caller relies on getting the
 * approved session back immediately to start its chat send in the same tick
 * (see that function's own comment). Worktree creation is real git/fs work
 * that can only run main-process side, so approveProposed fires this IPC
 * call fire-and-forget and patches `worktree` onto the session once it
 * resolves — the transition itself is never blocked or delayed by it, and a
 * failure (not a repo / disabled / cap reached / carry-over of a dirty base
 * tree's WIP failed) simply leaves `worktree` unset, exactly as if this call
 * had never been made. A dirty base tree itself no longer disables
 * isolation — its outstanding diff is carried into the fresh worktree
 * instead (gitWorktree.cjs's createWorktree).
 *
 * Mirrors promptSessionsCreateEpic.cjs's shape: `validatePath(cwd)` closes
 * the same "arbitrary renderer-supplied cwd" gap that handler documents,
 * since this is likewise reachable from the renderer over IPC.
 */

const { createEpicWorktree } = require('./gitWorktree.cjs');
const { validatePath } = require('../config.cjs');

/**
 * createEpicWorktreeViaIpc(cwd, epicId) → Promise<EpicWorktree | null>
 *
 * Returns the `worktree` field shape (`{ dir, branch, baseCwd, status,
 * carriedPaths }`) ready to persist onto the Epic record on success, or
 * `null` on any failure — createEpicWorktree/createWorktree never throw, so
 * this never does either.
 */
async function createEpicWorktreeViaIpc(cwd, epicId) {
  validatePath(cwd);
  const result = await createEpicWorktree({ cwd, epicId });
  if (!result.ok) {
    console.log(`[epicWorktreeMint] ${epicId}: not isolated (${result.reason})`);
    return null;
  }
  // carriedPaths (base-tree WIP carried into this worktree — PRD 1094) MUST
  // survive onto the persisted record: it's the only way integrateEpicBranch
  // (via epicWorktreeMerge.cjs) can later apply the carried-wip-only skip
  // instead of attempting a doomed merge against the base tree's still-dirty
  // paths. Dropping it here silently (as this used to) meant that skip never
  // fired for Epics, only for scheduler jobs.
  return {
    dir: result.dir,
    branch: result.branch,
    baseCwd: result.baseCwd,
    status: 'active',
    ...(Array.isArray(result.carriedPaths) && result.carriedPaths.length ? { carriedPaths: result.carriedPaths } : {}),
  };
}

function registerEpicWorktreeMintHandlers() {
  const { ipcMain } = require('electron');
  const { schemas: s, validated: v } = require('../ipcSchemas.cjs');
  ipcMain.handle(
    'promptSessions:create-worktree',
    v(s.promptSessionsCreateWorktree, ({ cwd, epicId }) => createEpicWorktreeViaIpc(cwd, epicId)),
  );
}

module.exports = { createEpicWorktreeViaIpc, registerEpicWorktreeMintHandlers };
