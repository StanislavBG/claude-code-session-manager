'use strict';

/**
 * projectPages.cjs — read-only backend for Project Home's Project Pages
 * display (PRD 932). Reads what the `project-home-builder` Epic's own
 * session writes directly with its Write tool
 * (`session-manager-operations/project-pages/output/*.html` + manifest.json)
 * — this module never writes any CONTENT (the one exception, watchOutput()'s
 * `fs.mkdirSync` to ensure the output dir exists before attaching a watcher,
 * creates an empty directory only), matching the corrected "not an
 * OWNERS namespace" storage/ownership note in
 * session-manager-operations/architecture/project-pages-pipeline.md and
 * session-manager-operations/project-pages/README.md. Structure mirrors
 * projectBrief.cjs's `get()`: validatePath first, config.cjs read helpers,
 * one ipcMain.handle registered from index.cjs's registerXHandlers() pattern.
 *
 * Shipped default (PRD "project-home-hosted-html-spec"): when a project has
 * never generated its own output, `get()` no longer returns the bare
 * `{ output: null }` empty-state signal — it falls back to a build-time
 * default `home.html` shipped with the app (`templates/`), returned with
 * `isDefault: true` and `generatedAt: null` so the renderer can label
 * provenance. That default is read from a fixed app-relative path, never
 * written into any project's own `session-manager-operations/` tree — this
 * module stays read-only.
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

function outputDir(cwd) {
  return opsPath(cwd, 'project-pages', 'output');
}

/**
 * Resolve `cwd`'s output dir, treating the opsOwnership "ephemeral cwd"
 * throw (a tmpdir/linked-worktree project root — see opsOwnership.cjs's
 * resolveProjectRoot) as "no output dir available" rather than letting it
 * propagate. Both get() and the watcher below go through this so a builder
 * Epic running in a worktree can never crash either path.
 */
function tryOutputDir(realCwd) {
  try {
    return { dir: outputDir(realCwd), ephemeral: false };
  } catch (e) {
    if (e.ephemeral) return { dir: null, ephemeral: true };
    throw e;
  }
}

// Shipped build-time asset (see PRD "project-home-hosted-html-spec"'s
// default-document requirement) — a fixed app-relative path with no
// user-controlled segment, so it deliberately does NOT go through
// config.cjs's validatePath (whose allowedRoots is the user's home dir and
// would reject/mis-resolve a path under the app's own install directory,
// e.g. when installed via npx/global npm outside $HOME). Read once and
// cached in-process; this file never changes at runtime.
const DEFAULT_HOME_PATH = path.join(__dirname, 'templates', 'project-pages-default-home.html');
let cachedDefaultHomeHtml = null;
function readDefaultHomeHtml() {
  if (cachedDefaultHomeHtml === null) {
    cachedDefaultHomeHtml = fs.readFileSync(DEFAULT_HOME_PATH, 'utf8');
  }
  return cachedDefaultHomeHtml;
}
function defaultOutput() {
  return { home: readDefaultHomeHtml(), generatedAt: null, isDefault: true };
}

// The original 4 lenses stay required — their absence still means "no
// Project Pages generated yet" (now the shipped-default fallback rather
// than a bare null). 'brief' was added later (5th lens): a project that
// generated its output BEFORE 'brief'
// existed has home/marketing/feature/architecture.html but no brief.html, and
// that must keep reading as "has output" rather than suddenly regressing to
// the empty state for every pre-existing project. So brief.html is read
// tolerantly — present, its text is returned; absent, the field is simply
// omitted from the payload rather than failing the whole read.
// Partial-output strategy (see this file's module doc + PRD
// "project-home-generate-preflight-and-push"): the render route
// (projectHomeAdminRoutes.cjs's doRender) writes every lens file
// concurrently and writes manifest.json ONLY AFTER all of them have landed.
// So manifest.json's existence is already an all-or-nothing commit signal —
// gating get() on it (below) means a reader can never observe a lens file
// that arrived without its siblings. No second partial-state representation
// is needed; this file just relies on that write order.
const REQUIRED_LENSES = ['home', 'marketing', 'feature', 'architecture'];
const OPTIONAL_LENSES = ['brief'];
const LENSES = [...REQUIRED_LENSES, ...OPTIONAL_LENSES];

async function get({ cwd }) {
  const realCwd = config.validatePath(cwd);
  const { dir, ephemeral } = tryOutputDir(realCwd);
  if (ephemeral) {
    return { output: defaultOutput() };
  }
  const manifestResult = await config.readJson(path.join(dir, 'manifest.json'));
  if (!manifestResult.exists || !manifestResult.data || manifestResult.parseError) {
    return { output: defaultOutput() };
  }

  const htmlResults = await Promise.all(
    LENSES.map((lens) => config.readText(path.join(dir, `${lens}.html`))),
  );
  const byLens = Object.fromEntries(LENSES.map((lens, i) => [lens, htmlResults[i]]));
  if (REQUIRED_LENSES.some((lens) => !byLens[lens].exists)) {
    return { output: defaultOutput() };
  }

  const generatedAt = typeof manifestResult.data.generatedAt === 'string' ? manifestResult.data.generatedAt : null;
  if (!generatedAt) {
    return { output: defaultOutput() };
  }

  const output = {
    home: byLens.home.text,
    marketing: byLens.marketing.text,
    feature: byLens.feature.text,
    architecture: byLens.architecture.text,
    generatedAt,
    isDefault: false,
  };
  if (byLens.brief.exists) {
    output.brief = byLens.brief.text;
  }

  return { output };
}

// ─── Push channel (PRD "project-home-generate-preflight-and-push") ────────
//
// project-pages:get above is a one-shot pull, fetched once at mount by
// ProjectHome.tsx. That leaves a finished (or stuck) builder Epic invisible
// until the next manual refresh/app restart. This section adds a per-cwd
// chokidar watcher on the output dir (the same debounced-write library
// config.cjs already uses for its generic file watcher) that recomputes
// get() and pushes it to the renderer whenever the dir changes.
//
// Map<realCwd, { watcher, refCount }> — refcounted like config.cjs's own
// watchers Map so more than one mounted component watching the same cwd
// doesn't spawn a second chokidar instance, and doesn't get torn down by
// the first component's unmount while a second is still watching.
const outputWatchers = new Map();

/**
 * Watch `cwd`'s output dir. Resolves `{ ok: true }` once watching is actually
 * live (or already watching), or `{ ok: false, reason: 'ephemeral' |
 * 'invalid-cwd' }` when there is nothing safe to watch — callers must not
 * treat that as an error, just as "no live updates for this cwd" (e.g. a
 * worktree cwd). Async: waits for chokidar's own 'ready' before resolving so
 * a write landing immediately after the call is never missed in the window
 * before the underlying fs watch handle is actually registered.
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

  const { dir, ephemeral } = tryOutputDir(realCwd);
  if (ephemeral) {
    return { ok: false, reason: 'ephemeral' };
  }
  // Ensure the (possibly not-yet-generated) output dir exists before
  // chokidar attaches: watching a path 3 levels deep that doesn't exist yet
  // does not reliably pick up files later written into it (verified — the
  // watcher silently misses the first write without this). This creates an
  // EMPTY directory only, no content, so it does not conflict with this
  // module's read-only contract or the single-writer law (opsOwnership.cjs)
  // — it bypasses config.cjs's writer-tracked write path deliberately,
  // exactly like a project-home-builder Epic's own untracked Write-tool
  // calls into this same folder (see opsOwnership.cjs's 'project-pages'
  // entry).
  fs.mkdirSync(dir, { recursive: true });

  const push = async () => {
    let result;
    try {
      result = await get({ cwd: realCwd });
    } catch {
      return; // best-effort; the renderer keeps its last-known output
    }
    sendIfAlive(mainWindow, 'project-pages:changed', { cwd: realCwd, output: result.output });
  };

  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    persistent: true,
    // manifest.json is the LAST file doRender writes (see REQUIRED_LENSES's
    // comment above) — but the burst of per-lens writes leading up to it
    // still fires several fs events in quick succession. awaitWriteFinish
    // (same 50ms/25ms shape config.cjs's generic watcher uses) collapses
    // that burst into one push instead of flapping the UI once per file.
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
  DEFAULT_HOME_PATH,
  readDefaultHomeHtml,
  // Test-only introspection of the refcounted watcher map.
  _outputWatchers: outputWatchers,
};
