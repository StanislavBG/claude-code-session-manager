'use strict';

/**
 * epicReopen.cjs — flip a completed Epic back to 'active' IN PLACE (same Epic id, same
 * claudeSessionId, same event chain) so the next turn continues via `claude --resume`.
 * Clears the three disk guards deliberately: the removal tombstone, the archive-shaped
 * `<id>.json` (rewritten as a live status mirror), and the merged-away worktree.
 * Electron-free at load; electron/config/ipcSchemas are required lazily in the register fn.
 */

const fs = require('node:fs');
const { activeIndexPath, readActiveIndex, withPathLock } = require('./epicMint.cjs');
const { epicMirrorPath } = require('./epicStatusMirror.cjs');
const { assertOpsWrite } = require('../opsOwnership.cjs');
const atomicFs = require('../util/atomicFs.cjs');
const { hasTranscriptSource, ensureEpicTranscriptReachable } = require('./epicTranscriptRestore.cjs');
const { restoreEpicWorktree } = require('./epicSpawnCwd.cjs');

const inFlight = new Map();

const fail = (code, message) => ({ ok: false, code, message });

function isDir(dir, deps) {
  try {
    return (deps.statSync || fs.statSync)(dir).isDirectory();
  } catch {
    return false;
  }
}

async function provisionWorktree({ cwd, epicId, archived, deps }) {
  const wt = archived && typeof archived === 'object' ? archived : null;
  const st = wt && wt.status;
  if (!wt || !wt.dir || st === 'merged' || st === 'disabled') {
    const createWorktree = deps.createWorktree || ((c, id) => require('./epicWorktreeMint.cjs').createEpicWorktreeViaIpc(c, id));
    let created = null;
    try {
      created = await createWorktree(cwd, epicId);
    } catch {
      created = null;
    }
    return created ? { worktree: created, created: true } : { worktree: wt, created: false };
  }
  if (st === 'active' || st === 'needs_merge_resolution') {
    if (isDir(wt.dir, deps)) return { worktree: { ...wt, status: 'active' }, created: false };
    const restore = deps.restoreWorktree || restoreEpicWorktree;
    let ok = false;
    try {
      ok = await restore({ dir: wt.dir, branch: wt.branch, baseCwd: cwd });
    } catch {
      ok = false;
    }
    return { worktree: ok ? { ...wt, status: 'active' } : wt, created: false };
  }
  return { worktree: wt, created: false };
}

function usableDir(worktree, deps) {
  return worktree && worktree.dir && worktree.status === 'active' && isDir(worktree.dir, deps) ? worktree.dir : null;
}

async function doReopen({ cwd, epicId, deps }) {
  const current = readActiveIndex(cwd);
  const row = Object.prototype.hasOwnProperty.call(current.sessions, epicId) ? current.sessions[epicId] : null;
  if (row && (row.status === 'active' || row.status === 'proposed')) {
    return { ok: true, session: row, events: current.events[epicId] || [], alreadyOpen: true };
  }

  const mirrorFile = epicMirrorPath(cwd, epicId);
  let archive = null;
  try {
    archive = JSON.parse(fs.readFileSync(mirrorFile, 'utf8'));
  } catch {
    archive = null;
  }
  const arch = archive && archive.session;
  if (
    !arch || typeof arch !== 'object' || arch.id !== epicId ||
    (arch.cwd && arch.cwd !== cwd) ||
    (archive.status || arch.status) !== 'completed'
  ) {
    return fail('not_found', `No completed Epic ${epicId} to reopen.`);
  }

  const claudeSessionId = arch.claudeSessionId;
  const tDeps = deps.homeDir || deps.statSync ? { homeDir: deps.homeDir, statSync: deps.statSync } : {};
  if (!hasTranscriptSource({ cwd, epicId, claudeSessionId, deps: tDeps })) {
    // No source anywhere, so this never writes; it only names the failure.
    const r = ensureEpicTranscriptReachable({ cwd, epicId, claudeSessionId, deps: tDeps });
    return r.ok ? fail('transcript_missing', 'No saved transcript.') : r;
  }

  const { worktree, created } = await provisionWorktree({ cwd, epicId, archived: arch.worktree, deps });
  const spawnCwd = usableDir(worktree, deps) || cwd;
  const reach = ensureEpicTranscriptReachable({ cwd, epicId, claudeSessionId, spawnCwd, deps: tDeps });
  if (!reach.ok) {
    if (created && worktree && worktree.dir) {
      try {
        const cleanup = deps.cleanupWorktree || require('../git/gitWorktree.cjs').cleanupEpicWorktree;
        await cleanup({ cwd, dir: worktree.dir, branch: worktree.branch, keepBranch: false });
      } catch { /* best-effort */ }
    }
    return reach;
  }

  const indexFile = activeIndexPath(cwd);
  let reopened;
  let events;
  try {
    await withPathLock(indexFile, async () => {
      const index = readActiveIndex(cwd);
      delete index.tombstones[epicId];
      reopened = { ...arch, status: 'active', completedAt: null };
      if (worktree) reopened.worktree = worktree;
      events = Array.isArray(archive.events) ? archive.events : [];
      index.sessions[epicId] = reopened;
      index.events[epicId] = events;
      assertOpsWrite(indexFile, 'epics');
      atomicFs.writeJsonAtomicSync(indexFile, index, { newline: false });
    });
    assertOpsWrite(mirrorFile, 'epics');
    atomicFs.writeJsonAtomicSync(mirrorFile, {
      ...reopened,
      id: epicId,
      cwd,
      status: 'active',
      archivedAt: null,
      indexedAt: new Date().toISOString(),
    });
  } catch (err) {
    return fail('write_failed', `Could not reopen Epic ${epicId}: ${err && err.message ? err.message : err}`);
  }
  return { ok: true, session: reopened, events, alreadyOpen: false };
}

/**
 * @param {{ cwd: string, epicId: string, deps?: object }} opts
 */
function reopenEpic({ cwd, epicId, deps = {} } = {}) {
  const key = `${cwd}\0${epicId}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = doReopen({ cwd, epicId, deps }).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

function registerEpicReopenHandlers() {
  const { ipcMain } = require('electron');
  const { validatePath } = require('../../config.cjs');
  const { schemas: s, validated: v } = require('../../ipcSchemas.cjs');
  ipcMain.handle(
    'promptSessions:reopen',
    v(s.promptSessionsReopen, ({ cwd, epicId }) => {
      validatePath(cwd);
      return reopenEpic({ cwd, epicId });
    }),
  );
}

module.exports = { reopenEpic, registerEpicReopenHandlers };
