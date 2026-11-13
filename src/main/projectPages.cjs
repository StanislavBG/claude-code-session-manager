'use strict';

/**
 * projectPages.cjs — read-only backend for Project Home. Project Home has two
 * self-contained generated artifacts under
 * `session-manager-operations/project-pages/`: `home.html` (written by the
 * `project_home_write` admin route) and `demo-video/index.html` (written by
 * the `project_demo_video_write` admin route) — both in
 * lib/feedback-remote/projectHomeAdminRoutes.cjs. This module only reads them: get() returns
 * home.html's content plus the demo video's { path, mtimeMs }, and a
 * refcounted per-cwd watcher pushes `project-pages:changed` for either. It
 * never writes content (watch()'s mkdir creates an empty directory only).
 * mdNetwork() maps the project's markdown link network on demand
 * (lib/mdNetworkScan.cjs) for the Tools pane. matrix() reads the saved
 * Competitor matrix (lib/project-pages/competitiveMatrix.cjs readMatrix).
 */

const { ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const chokidar = require('chokidar');
const config = require('./config.cjs');
const { opsPath, assertOpsWrite, resolveProjectRoot } = require('./lib/opsOwnership.cjs');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');
const { listLibrary, migrateLegacy } = require('./lib/project-pages/pagesLibrary.cjs');
const { scanMdNetwork } = require('./lib/mdNetworkScan.cjs');
const { readMatrix } = require('./lib/project-pages/competitiveMatrix.cjs');

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

/**
 * Resolve `realCwd`'s project root, treating the opsOwnership "ephemeral cwd"
 * throw (a tmpdir/linked-worktree project root) as "no root available"
 * rather than letting it propagate.
 */
function tryProjectRoot(realCwd) {
  try {
    return { root: resolveProjectRoot(realCwd), ephemeral: false };
  } catch (e) {
    if (e.ephemeral) return { root: null, ephemeral: true };
    throw e;
  }
}

/** `realCwd`'s home.html path, or no path where tryProjectRoot finds no root. */
function tryHomePath(realCwd) {
  const { root, ephemeral } = tryProjectRoot(realCwd);
  return { file: ephemeral ? null : homePath(root), ephemeral };
}

const EMPTY = () => ({ knowledge: [], videos: [], html: null, mtimeMs: null, demoVideo: null });

/**
 * -> { knowledge, videos, html, mtimeMs, demoVideo }. Runs the one-shot legacy
 * migration first. html/mtimeMs come from the `overview` knowledge page and
 * demoVideo from the newest video (both kept for the phone remote).
 */
async function get({ cwd }) {
  const realCwd = config.validatePath(cwd);
  const { ephemeral } = tryProjectRoot(realCwd);
  if (ephemeral) return EMPTY();
  await migrateLegacy(realCwd);
  const { knowledge, videos } = await listLibrary(realCwd);
  const overview = knowledge.find((k) => k.id === 'overview');
  let html = null;
  if (overview) {
    try {
      html = await fs.promises.readFile(overview.path, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  const newest = videos[0];
  return {
    knowledge,
    videos,
    html,
    mtimeMs: html === null ? null : overview.mtimeMs,
    demoVideo: newest ? { path: newest.path, mtimeMs: newest.mtimeMs } : null,
  };
}

const MD_NETWORK_EPHEMERAL = 'refusing an ephemeral cwd (tmpdir or linked git worktree): no project to scan';

/** Strip trailing slashes ('docs/' -> 'docs'); undefined stays undefined. */
const stripTrailingSlashes = (folders) => folders && folders.map((f) => f.replace(/\/+$/, ''));

/**
 * -> MdNetworkResult: the project's markdown link network from its root
 * CLAUDE.md, scanned once per call (no watcher, no cache). `cwd` is validated
 * like get() (an invalid path rejects); a cwd get() answers with EMPTY() gets
 * `{ ok: false, error }`.
 *
 * `recordFolders` / `docFolders` are a human's census overrides (mark a folder
 * as machine-written records, or as real docs). They are only repo-relative
 * path prefixes for classification and never reach the file system — only
 * `cwd` is a path that is resolved or read.
 */
async function mdNetwork({ cwd, recordFolders, docFolders }) {
  const { root, ephemeral } = tryProjectRoot(config.validatePath(cwd));
  if (ephemeral) return { ok: false, error: MD_NETWORK_EPHEMERAL };
  return scanMdNetwork(root, {}, {
    recordFolders: stripTrailingSlashes(recordFolders),
    docFolders: stripTrailingSlashes(docFolders),
  });
}

const MATRIX_EPHEMERAL = 'refusing an ephemeral cwd (tmpdir or linked git worktree): no project matrix';

/**
 * -> CompetitorMatrixResult: the saved Competitor matrix, read once per call.
 * Resolves the project root like mdNetwork(); `{ ok: true, matrix, error }`
 * from readMatrix (matrix null when none / invalid, error set when invalid),
 * or `{ ok: false, error }` when the cwd has no project root.
 */
async function matrix({ cwd }) {
  const { root, ephemeral } = tryProjectRoot(config.validatePath(cwd));
  if (ephemeral) return { ok: false, error: MATRIX_EPHEMERAL };
  const { matrix: m, error } = await readMatrix(root);
  return { ok: true, matrix: m, error };
}

/** True for paths whose change should refresh the library (relative to project-pages/). */
function isLibraryPath(rel) {
  const parts = rel.split(path.sep);
  if (parts.length === 1) return parts[0] === 'home.html';
  if (parts.length === 2) {
    if (parts[0] === 'matrix' && parts[1] === 'matrix.json') return true;
    return parts[0] === 'demo-video' && parts[1] === 'index.html';
  }
  if (parts.length === 3 && (parts[0] === 'knowledge' || parts[0] === 'videos')) {
    return parts[1] !== '_character' && (parts[2] === 'index.html' || parts[2] === 'meta.json');
  }
  return false;
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

  const push = async (changedPath) => {
    // Only library files (and the two legacy ones) — ignore everything else.
    if (changedPath && !isLibraryPath(path.relative(dir, path.resolve(changedPath)))) return;
    let result;
    try {
      result = await get({ cwd: realCwd });
    } catch {
      return; // best-effort; the renderer keeps its last-known output
    }
    sendIfAlive(mainWindow, 'project-pages:changed', {
      cwd: realCwd,
      ...result,
    });
  };

  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    persistent: true,
    depth: 3,
    ignored: (p) => p.split(path.sep).includes('_character'),
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

const WRITER = 'project-home';

/**
 * Resolve one library entry folder for rename/delete. Refuses a bad id,
 * '_character', a missing entry, and anything whose realpath is not a direct
 * child (same name) of the kind folder — a symlink escape.
 */
async function resolveEntry({ cwd, kind, id }) {
  const { schemas, ENTRY_ID_RE } = require('./ipcSchemas.cjs');
  if (kind !== 'knowledge' && kind !== 'video') throw new Error('invalid kind');
  if (typeof id !== 'string' || id === '_character' || !ENTRY_ID_RE.test(id)) throw new Error('invalid entry id');
  const realCwd = config.validatePath(cwd);
  const folder = kind === 'video' ? 'videos' : 'knowledge';
  const kindDir = opsPath(realCwd, 'project-pages', folder);
  const dir = path.join(kindDir, id);
  let realDir;
  let realKind;
  try {
    realDir = await fs.promises.realpath(dir);
    realKind = await fs.promises.realpath(kindDir);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('entry not found');
    throw e;
  }
  if (path.dirname(realDir) !== realKind || path.basename(realDir) !== id) {
    throw new Error('entry resolves outside its kind folder');
  }
  const st = await fs.promises.stat(realDir);
  if (!st.isDirectory()) throw new Error('entry not found');
  return { dir: realDir, schema: kind === 'video' ? schemas.projectVideoMeta : schemas.projectPageMeta };
}

/** Rewrite one entry's meta.json title (schema-validated before and after). */
async function renameEntry(input) {
  const { dir, schema } = await resolveEntry(input);
  const metaFile = path.join(dir, 'meta.json');
  let raw;
  try {
    raw = JSON.parse(await fs.promises.readFile(metaFile, 'utf8'));
  } catch (e) {
    throw new Error(`meta.json unreadable: ${e.code === 'ENOENT' ? 'missing' : e.message}`);
  }
  const current = schema.safeParse(raw);
  if (!current.success) throw new Error('meta.json invalid');
  const next = schema.parse({ ...current.data, title: input.title });
  await config.writeTextAtomic(metaFile, JSON.stringify(next, null, 2) + '\n', { writer: WRITER });
  return { ok: true, title: next.title };
}

/** Remove exactly one entry folder. */
async function deleteEntry(input) {
  const { dir } = await resolveEntry(input);
  assertOpsWrite(dir, WRITER);
  await fs.promises.rm(dir, { recursive: true, force: false });
  return { ok: true };
}

function registerProjectPagesIpc() {
  const { schemas: s, validated: v } = require('./ipcSchemas.cjs');
  ipcMain.handle('project-pages:get', v(s.projectPagesCwd, get));
  ipcMain.handle('project-pages:md-network', v(s.projectPagesMdNetwork, mdNetwork));
  ipcMain.handle('project-pages:matrix', v(s.projectPagesCwd, matrix));
  ipcMain.handle('project-pages:watch', v(s.projectPagesCwd, ({ cwd }) => watchOutput(cwd)));
  ipcMain.handle('project-pages:rename', v(s.projectPagesRename, renameEntry));
  ipcMain.handle('project-pages:delete', v(s.projectPagesDelete, deleteEntry));
  ipcMain.handle('project-pages:unwatch', v(s.projectPagesCwd, ({ cwd }) => {
    unwatchOutput(cwd);
    return { ok: true };
  }));
}

module.exports = {
  attachWindow,
  registerProjectPagesIpc,
  get,
  mdNetwork,
  matrix,
  isLibraryPath,
  renameEntry,
  deleteEntry,
  watchOutput,
  unwatchOutput,
  closeAllOutputWatchers,
  // Test-only introspection of the refcounted watcher map.
  _outputWatchers: outputWatchers,
};
