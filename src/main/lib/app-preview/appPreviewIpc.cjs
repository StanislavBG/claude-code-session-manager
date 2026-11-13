'use strict';

/**
 * appPreviewIpc.cjs — IPC wiring for an Epic's "Run preview" dev server.
 *
 * One shared appPreviewManager (lazy singleton) owns every preview process;
 * its state changes broadcast to the renderer as 'appPreview:changed'.
 *
 * The renderer sends only { cwd, epicId } — main resolves WHERE the dev
 * server runs from the project's active index itself (the Epic's live
 * worktree, else the project folder), never from a renderer-supplied path.
 * A restorable worktree whose folder is gone is refused rather than silently
 * previewing the main checkout.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createAppPreviewManager } = require('./appPreviewManager.cjs');
const { listPreviewScripts } = require('./appPreviewScripts.cjs');
const { sendIfAlive } = require('../sendToRenderer.cjs');

let manager = null;
/** @type {() => any} */
let currentGetWindow = () => null;

function getAppPreviewManager() {
  if (!manager) {
    manager = createAppPreviewManager({
      broadcast: (state) => sendIfAlive(currentGetWindow(), 'appPreview:changed', state),
    });
  }
  return manager;
}

function isUsableDir(dir, statImpl) {
  try {
    return statImpl(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * resolveAppPreviewDir({ cwd, epicId, deps }) — never throws.
 * @returns {{ ok: true, dir: string, inWorktree: boolean } | { ok: false, error: string }}
 */
function resolveAppPreviewDir({ cwd, epicId, deps = {} } = {}) {
  try {
    const validatePath = deps.validatePath || require('../../config.cjs').validatePath;
    const readActiveIndex = deps.readActiveIndex || require('../epic/epicMint.cjs').readActiveIndex;
    const statSync = deps.statSync || fs.statSync;
    validatePath(cwd);
    const index = readActiveIndex(cwd);
    const sessions = index && index.sessions ? index.sessions : {};
    const session = Object.prototype.hasOwnProperty.call(sessions, epicId) ? sessions[epicId] : null;
    if (!session) return { ok: false, error: `Session ${epicId} not found in this project` };
    if (session.status !== 'active') {
      return { ok: false, error: `Session ${epicId} is not active (status: ${session.status || 'unknown'})` };
    }
    const wt = session.worktree;
    if (wt && wt.dir && wt.status !== 'merged' && wt.status !== 'disabled') {
      if (isUsableDir(wt.dir, statSync)) return { ok: true, dir: wt.dir, inWorktree: true };
      return {
        ok: false,
        error: `This session's worktree folder is missing (${wt.dir}). Open its Chat or Terminal once to restore it, then run the preview again.`,
      };
    }
    return { ok: true, dir: cwd, inWorktree: false };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * ensureWorktreeDeps — a worktree restored after a reboot / tmp sweep
 * (restoreEpicWorktree) is a bare `git worktree add` with no node_modules, so
 * `npm run dev` would fail. Link the main checkout's dependency dirs when the
 * worktree lacks node_modules and the main checkout has one. Never throws and
 * never blocks the start: a skip or error is logged, and any resulting
 * dev-server failure reaches the user as the preview's failed-state toast.
 */
async function ensureWorktreeDeps({ cwd, dir, inWorktree, deps = {} }) {
  if (!inWorktree) return;
  const existsSync = deps.existsSync || fs.existsSync;
  const log = deps.log || ((...a) => console.warn(...a));
  try {
    if (existsSync(path.join(dir, 'node_modules')) || !existsSync(path.join(cwd, 'node_modules'))) return;
    const link = deps.linkDependencyDirs || require('../git/worktreeDeps.cjs').linkDependencyDirs;
    const res = await link({ mainCwd: cwd, worktreeCwd: dir });
    if (res && Array.isArray(res.skipped) && res.skipped.includes('node_modules')) {
      log(`[appPreview] node_modules was not linked into ${dir}; starting the preview anyway`);
    }
  } catch (e) {
    log(`[appPreview] linking dependency dirs into ${dir} failed: ${(e && e.message) || String(e)}; starting the preview anyway`);
  }
}

/**
 * @param {{ handle: (channel: string, fn: (...args: any[]) => any) => void }} ipcMain
 * @param {{ getWindow?: () => any, deps?: { resolveDeps?: any, existsSync?: (p: string) => boolean, linkDependencyDirs?: (a: { mainCwd: string, worktreeCwd: string }) => any, getManager?: () => any, log?: (...a: any[]) => void } }} [opts]
 */
function registerAppPreviewHandlers(ipcMain, { getWindow, deps = {} } = {}) {
  if (typeof getWindow === 'function') currentGetWindow = getWindow;
  const getManager = deps.getManager || getAppPreviewManager;
  const { schemas: s, validated: v } = require('../../ipcSchemas.cjs');

  ipcMain.handle('appPreview:scripts', v(s.appPreviewScripts, ({ cwd, epicId }) => {
    const r = resolveAppPreviewDir({ cwd, epicId, deps: deps.resolveDeps });
    if (!r.ok) return { ok: false, error: r.error };
    return { ...listPreviewScripts(r.dir), dir: r.dir, inWorktree: r.inWorktree };
  }));

  ipcMain.handle('appPreview:start', v(s.appPreviewStart, async ({ cwd, epicId, script }) => {
    const r = resolveAppPreviewDir({ cwd, epicId, deps: deps.resolveDeps });
    if (!r.ok) return { ok: false, error: r.error };
    await ensureWorktreeDeps({ cwd, dir: r.dir, inWorktree: r.inWorktree, deps });
    return getManager().start({ cwd, epicId, dir: r.dir, script });
  }));

  ipcMain.handle('appPreview:stop', v(s.appPreviewStop, ({ epicId }) => getManager().stop(epicId)));

  ipcMain.handle('appPreview:list', () => getManager().list());
}

module.exports = { getAppPreviewManager, resolveAppPreviewDir, ensureWorktreeDeps, registerAppPreviewHandlers };
