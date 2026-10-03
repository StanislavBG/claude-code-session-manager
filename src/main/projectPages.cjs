'use strict';

/**
 * projectPages.cjs — read-only backend for Project Home. Project Home has two
 * self-contained generated artifacts under
 * `session-manager-operations/project-pages/`: `home.html` (written by the
 * `project_home_write` admin route) and `demo-video/index.html` (written by
 * the `project_demo_video_write` admin route) — both in
 * lib/projectHomeAdminRoutes.cjs. This module only reads them: get() returns
 * home.html's content plus the demo video's { path, mtimeMs }, and a
 * refcounted per-cwd watcher pushes `project-pages:changed` for either. It
 * never writes content (watch()'s mkdir creates an empty directory only).
 */

const { ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const chokidar = require('chokidar');
const config = require('./config.cjs');
const { opsPath } = require('./lib/opsOwnership.cjs');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');

let mainWindow = null;
function attachWindow(window) {
  mainWindow = window;
}

function homePath(cwd) {
  return opsPath(cwd, 'project-pages', 'home.html');
}

function demoVideoPath(cwd) {
  return opsPath(cwd, 'project-pages', 'demo-video', 'index.html');
}

/** -> { path: string, mtimeMs: number } | null */
async function getDemoVideo(realCwd) {
  const file = demoVideoPath(realCwd);
  try {
    const stat = await fs.promises.stat(file);
    return { path: file, mtimeMs: stat.mtimeMs };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Resolve `cwd`'s home.html path, treating the opsOwnership "ephemeral cwd"
 * throw (a tmpdir/linked-worktree project root) as "no path available"
 * rather than letting it propagate.
 */
function tryHomePath(realCwd) {
  try {
    return { file: homePath(realCwd), ephemeral: false };
  } catch (e) {
    if (e.ephemeral) return { file: null, ephemeral: true };
    throw e;
  }
}

/** -> { html: string|null, mtimeMs: number|null, demoVideo: {path, mtimeMs}|null } */
async function get({ cwd }) {
  const realCwd = config.validatePath(cwd);
  const { file, ephemeral } = tryHomePath(realCwd);
  if (ephemeral) return { html: null, mtimeMs: null, demoVideo: null };
  const res = await config.readText(file);
  const demoVideo = await getDemoVideo(realCwd);
  if (!res.exists) return { html: null, mtimeMs: null, demoVideo };
  return { html: res.text, mtimeMs: res.mtimeMs, demoVideo };
}

// ─── Push channel ─────────────────────────────────────────────────────────
//
// project-pages:get is a one-shot pull; this adds a per-cwd chokidar watcher
// on the project-pages dir that recomputes get() and pushes it to the
// renderer when home.html is added/changed/removed. Map<realCwd, { watcher,
// refCount }> — refcounted so several mounted components watching the same
// cwd share one chokidar instance.
const outputWatchers = new Map();

/**
 * Watch `cwd`'s home.html. Resolves `{ ok: true }` once watching is live (or
 * already watching), or `{ ok: false, reason: 'ephemeral' | 'invalid-cwd' }`
 * when there is nothing safe to watch — not an error, just "no live updates
 * for this cwd". Waits for chokidar's 'ready' so a write landing right after
 * the call is never missed.
 */
async function watchOutput(cwd) {
  let realCwd;
  try {
    realCwd = config.validatePath(cwd);
  } catch {
    return { ok: false, reason: 'invalid-cwd' };
  }

  const existing = outputWatchers.get(realCwd);
  if (existing) {
    existing.refCount += 1;
    return { ok: true };
  }

  const { file, ephemeral } = tryHomePath(realCwd);
  if (ephemeral) {
    return { ok: false, reason: 'ephemeral' };
  }
  // Watch the parent dir (chokidar silently misses the first write of a file
  // in a not-yet-existing dir). mkdir creates an EMPTY directory only — no
  // content, so the single-writer law (opsOwnership.cjs) is not involved.
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  const demoVideoFile = demoVideoPath(realCwd);
  const push = async (changedPath) => {
    // Only home.html or demo-video/index.html — ignore every other sibling file.
    if (changedPath) {
      const resolved = path.resolve(changedPath);
      if (resolved !== path.resolve(file) && resolved !== path.resolve(demoVideoFile)) return;
    }
    let result;
    try {
      result = await get({ cwd: realCwd });
    } catch {
      return; // best-effort; the renderer keeps its last-known output
    }
    sendIfAlive(mainWindow, 'project-pages:changed', {
      cwd: realCwd,
      html: result.html,
      mtimeMs: result.mtimeMs,
      demoVideo: result.demoVideo,
    });
  };

  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    persistent: true,
    depth: 1,
    // Same 50ms/25ms shape config.cjs's generic watcher uses.
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
  });
  watcher.on('add', push);
  watcher.on('change', push);
  watcher.on('unlink', push);
  watcher.on('error', (err) => {
    console.warn('[projectPages] watcher error for', dir, err?.message);
  });

  outputWatchers.set(realCwd, { watcher, refCount: 1 });
  await new Promise((resolve) => watcher.once('ready', resolve));
  return { ok: true };
}

/** Decrement `cwd`'s watch refcount; closes the underlying watcher at 0. */
function unwatchOutput(cwd) {
  let realCwd;
  try {
    realCwd = config.validatePath(cwd);
  } catch {
    return;
  }
  const entry = outputWatchers.get(realCwd);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    entry.watcher.close().catch(() => {});
    outputWatchers.delete(realCwd);
  }
}

/** Window close / app quit teardown — mirrors config.cjs's closeAllWatchers. */
function closeAllOutputWatchers() {
  for (const { watcher } of outputWatchers.values()) {
    watcher.close().catch(() => {});
  }
  outputWatchers.clear();
}

function registerProjectPagesIpc() {
  const { schemas: s, validated: v } = require('./ipcSchemas.cjs');
  ipcMain.handle('project-pages:get', v(s.projectPagesCwd, get));
  ipcMain.handle('project-pages:watch', v(s.projectPagesCwd, ({ cwd }) => watchOutput(cwd)));
  ipcMain.handle('project-pages:unwatch', v(s.projectPagesCwd, ({ cwd }) => {
    unwatchOutput(cwd);
    return { ok: true };
  }));
}

module.exports = {
  attachWindow,
  registerProjectPagesIpc,
  get,
  watchOutput,
  unwatchOutput,
  closeAllOutputWatchers,
  // Test-only introspection of the refcounted watcher map.
  _outputWatchers: outputWatchers,
};
