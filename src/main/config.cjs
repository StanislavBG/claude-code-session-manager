/**
 * ConfigManager — filesystem access layer for Claude Code config surfaces.
 *
 * Responsibilities:
 *   - Read/write JSON and text files across user/project/local scopes.
 *   - Atomic writes (tmp + rename).
 *   - Watch files for external changes (editor edits, claude writes) and notify
 *     the renderer via IPC events scoped by absolute path.
 *   - List directories for skills/agents/commands/projects enumeration.
 *
 * Everything in here is path-addressed — callers pass absolute paths. Scope
 * resolution (what's "user" vs "project" vs "local" for a given config file)
 * lives in the renderer, because it depends on the active tab's cwd which
 * only the renderer owns.
 */

const { ipcMain } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const chokidar = require('chokidar');
const logs = require('./logs.cjs');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');
const { expandHome } = require('./lib/expandHome.cjs');

/** Map<absPath, {watcher, refCount}> — one chokidar watcher per path. */
const watchers = new Map();
/** Map<senderId, Map<absPath, count>> — per-sender watch contributions for reload teardown. */
const senderWatches = new Map();
let window = null;

function attachWindow(w) {
  window = w;
}

/**
 * Resolve a path to its realpath, handling non-existent files by resolving
 * the parent directory instead. Prevents symlink traversal attacks.
 */
function realResolve(abs) {
  const lex = path.resolve(expandHome(abs));
  try {
    return fs.realpathSync(lex);
  } catch (e) {
    if (e.code === 'ENOENT') {
      const parent = path.dirname(lex);
      try {
        return path.join(fs.realpathSync(parent), path.basename(lex));
      } catch {
        return lex;
      }
    }
    throw e;
  }
}

/**
 * Validate that a resolved path stays within an allowed boundary. Prevents
 * path traversal attacks where a renderer-controlled path uses `..` segments
 * or symlinks to escape into arbitrary filesystem locations.
 *
 * Allowed roots: home directory and any cwd the app has seen (project scopes).
 */
const allowedRoots = new Set([os.homedir()]);

function addAllowedRoot(dir) {
  if (dir) allowedRoots.add(path.resolve(dir));
}

function validatePath(abs) {
  const real = realResolve(abs);
  for (const root of allowedRoots) {
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      realRoot = root;
    }
    if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;
  }
  throw new Error(`Path outside allowed boundaries: ${real}`);
}

// Paths that are allowed as write destinations.
const WRITE_PREFIXES = [
  path.join(os.homedir(), '.claude'),
  path.join(os.homedir(), '.claude.json'), // global MCP servers config
  path.join(os.homedir(), '.config', 'claude-code'),
  path.join(os.homedir(), '.config', 'session-manager'),
];

/**
 * Restricts write operations to a tighter set of destinations than reads.
 * Never allows writing to .credentials.json.
 * Call after validatePath (which provides the realpath).
 */
function validateWrite(realAbs) {
  if (path.basename(realAbs) === '.credentials.json') {
    throw new Error(`Write to .credentials.json denied`);
  }
  const inWritePrefix = WRITE_PREFIXES.some(
    (p) => realAbs === p || realAbs.startsWith(p + path.sep)
  );
  if (inWritePrefix) return;
  // Also allowed inside a registered project root's .claude/ subtree, OR its
  // tests/fixtures/browser-capture/ subtree (PRD 407 "PRD fixture" capture
  // destination — narrowly scoped to that one path segment, not a general
  // project-root write grant).
  for (const root of allowedRoots) {
    if (root === os.homedir()) continue;
    let realRoot;
    try { realRoot = fs.realpathSync(root); } catch { realRoot = root; }
    if (realAbs === realRoot || realAbs.startsWith(realRoot + path.sep)) {
      const claudeSub = path.join(realRoot, '.claude');
      if (realAbs === claudeSub || realAbs.startsWith(claudeSub + path.sep)) {
        return;
      }
      const fixturesSub = path.join(realRoot, 'tests', 'fixtures', 'browser-capture');
      if (realAbs === fixturesSub || realAbs.startsWith(fixturesSub + path.sep)) {
        return;
      }
      // PRD 410 Recorder → Playwright-spec export: narrowly scoped to
      // tests/e2e/ (matches the repo's existing e2e spec location), not a
      // general project-root write grant.
      const e2eSub = path.join(realRoot, 'tests', 'e2e');
      if (realAbs === e2eSub || realAbs.startsWith(e2eSub + path.sep)) {
        return;
      }
    }
  }
  throw new Error(`Write outside allowed write boundaries: ${realAbs}`);
}

async function readJson(abs) {
  try {
    abs = validatePath(expandHome(abs));
    const raw = await fsp.readFile(abs, 'utf8');
    let data = null;
    let parseError = null;
    try {
      data = raw.trim() === '' ? null : JSON.parse(raw);
    } catch (e) {
      parseError = e.message;
    }
    const stat = await fsp.stat(abs);
    return { exists: true, raw, data, parseError, mtimeMs: stat.mtimeMs, error: null };
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: null };
    }
    return { exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: e.message };
  }
}

async function readText(abs) {
  try {
    abs = validatePath(expandHome(abs));
    const raw = await fsp.readFile(abs, 'utf8');
    const stat = await fsp.stat(abs);
    return { exists: true, text: raw, mtimeMs: stat.mtimeMs, error: null };
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { exists: false, text: '', mtimeMs: 0, error: null };
    }
    return { exists: false, text: '', mtimeMs: 0, error: e.message };
  }
}

/**
 * Atomic write — write to <path>.tmp-<pid>-<ts> then rename. Creates parent
 * directories if missing. Cleans up the tmp file on rename failure.
 *
 * opts.mode: optional POSIX permission bits, applied to the tmp file before
 * rename. Used by voiceSettings/otelSettings for 0o600 credential storage.
 */
async function writeTextAtomic(abs, text, opts = {}) {
  const real = validatePath(expandHome(abs));
  validateWrite(real);
  const dir = path.dirname(real);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${real}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fsp.writeFile(tmp, text, opts.mode ? { encoding: 'utf8', mode: opts.mode } : 'utf8');
    if (opts.mode) {
      // chmod explicitly because some platforms ignore the mode arg on
      // writeFile when the file pre-exists.
      try { await fsp.chmod(tmp, opts.mode); } catch { /* */ }
    }
    await fsp.rename(tmp, real);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch { /* tmp never created or already gone */ }
    throw e;
  }
  const stat = await fsp.stat(real);
  return { ok: true, mtimeMs: stat.mtimeMs };
}

/**
 * Binary-safe sibling of writeTextAtomic — same validate + tmp+rename flow,
 * for callers (screenshot capture) whose payload is a Buffer, not utf8 text.
 */
async function writeBinaryAtomic(abs, buffer) {
  const real = validatePath(expandHome(abs));
  validateWrite(real);
  const dir = path.dirname(real);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${real}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, real);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch { /* tmp never created or already gone */ }
    throw e;
  }
  const stat = await fsp.stat(real);
  return { ok: true, mtimeMs: stat.mtimeMs };
}

async function writeJson(abs, data) {
  const pretty = JSON.stringify(data, null, 2) + '\n';
  return writeTextAtomic(abs, pretty);
}

/**
 * Sync variant — only for child-exit handlers and similar callbacks where
 * an event-loop yield would deadlock the caller. Use writeJson/writeTextAtomic
 * for everything else.
 */
function writeJsonSync(abs, data) {
  const real = validatePath(expandHome(abs));
  validateWrite(real);
  const dir = path.dirname(real);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${real}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, real);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* tmp never created or already gone */ }
    throw e;
  }
  const stat = fs.statSync(real);
  return { ok: true, mtimeMs: stat.mtimeMs };
}

async function listDir(abs, { filesOnly = false, dirsOnly = false, includeHidden = false } = {}) {
  try {
    abs = validatePath(expandHome(abs));
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    const results = [];
    for (const e of entries) {
      if (!includeHidden && e.name.startsWith('.')) continue;
      if (filesOnly && !e.isFile()) continue;
      if (dirsOnly && !e.isDirectory()) continue;
      const full = path.join(abs, e.name);
      let mtimeMs = 0;
      let size = 0;
      try {
        const st = await fsp.stat(full);
        mtimeMs = st.mtimeMs;
        size = st.size;
      } catch {
        /* ignore */
      }
      results.push({
        name: e.name,
        path: full,
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
        mtimeMs,
        size,
      });
    }
    return { ok: true, entries: results, error: null };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, entries: [], error: null };
    return { ok: false, entries: [], error: e.message };
  }
}

async function exists(abs) {
  try {
    abs = validatePath(expandHome(abs));
    await fsp.access(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a path to a consistent map key: expand ~ then resolve to an
 * absolute lexical path. Used as the refcount Map key in both watch() and
 * unwatch() so callers can use either spelling interchangeably.
 */
function normalizePathKey(p) {
  return path.resolve(expandHome(p));
}

/**
 * Watch one or more absolute paths. Each call increments a refcount per path.
 * Unwatch decrements; when refcount hits zero the underlying watcher is closed.
 * Fires IPC event `config:changed` with {path, mtimeMs, kind} on any change.
 */
function watch(paths, senderId) {
  for (const rawPath of paths) {
    validatePath(expandHome(rawPath)); // security check — throws if out of bounds
    const key = normalizePathKey(rawPath);
    if (senderId != null) {
      if (!senderWatches.has(senderId)) senderWatches.set(senderId, new Map());
      const sm = senderWatches.get(senderId);
      sm.set(key, (sm.get(key) || 0) + 1);
    }
    const existing = watchers.get(key);
    if (existing) {
      existing.refCount++;
      continue;
    }
    const w = chokidar.watch(key, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    });
    const emit = (kind) => async () => {
      let mtimeMs = 0;
      try {
        const st = await fsp.stat(key);
        mtimeMs = st.mtimeMs;
      } catch {
        /* file may have been deleted */
      }
      sendIfAlive(window, 'config:changed', { path: key, mtimeMs, kind });
    };
    w.on('add', emit('add'));
    w.on('change', emit('change'));
    w.on('unlink', emit('unlink'));
    w.on('error', (err) => {
      console.warn('[config] watcher error for', key, err.message);
    });
    watchers.set(key, { watcher: w, refCount: 1 });
  }
}

function unwatch(paths, senderId) {
  for (const rawPath of paths) {
    const key = normalizePathKey(rawPath);
    if (senderId != null) {
      const sm = senderWatches.get(senderId);
      if (sm) {
        const c = (sm.get(key) || 0) - 1;
        if (c <= 0) sm.delete(key);
        else sm.set(key, c);
        if (sm.size === 0) senderWatches.delete(senderId);
      }
    }
    const entry = watchers.get(key);
    if (!entry) continue;
    entry.refCount--;
    if (entry.refCount <= 0) {
      entry.watcher.close().catch(() => {});
      watchers.delete(key);
    }
  }
}

function releaseWatchesForSender(senderId) {
  const sm = senderWatches.get(senderId);
  if (!sm) return;
  senderWatches.delete(senderId);
  for (const [key, count] of sm) {
    const entry = watchers.get(key);
    if (!entry) continue;
    entry.refCount -= count;
    if (entry.refCount <= 0) {
      entry.watcher.close().catch(() => {});
      watchers.delete(key);
    }
  }
}

function closeAllWatchers() {
  for (const { watcher } of watchers.values()) {
    watcher.close().catch(() => {});
  }
  watchers.clear();
}

function registerConfigHandlers() {
  const { schemas: s, validated: v } = require('./ipcSchemas.cjs');
  ipcMain.handle('config:read-json', v(s.configPath, ({ path: p }) => readJson(p)));
  ipcMain.handle('config:read-text', v(s.configPath, ({ path: p }) => readText(p)));
  ipcMain.handle('config:write-json', v(s.configWriteJson, ({ path: p, data }) => writeJson(p, data)));
  ipcMain.handle('config:write-text', v(s.configWriteText, ({ path: p, text }) => writeTextAtomic(p, text)));
  ipcMain.handle('config:list-dir', v(s.configListDir, ({ path: p, opts }) => listDir(p, opts || {})));
  ipcMain.handle('config:exists', v(s.configPath, ({ path: p }) => exists(p)));
  ipcMain.on('config:watch', (e, { paths }) => { try { s.configWatch.parse(paths); watch(paths, e.sender.id); } catch (err) { logs.writeLine({ level: 'warn', scope: 'config', message: 'config:watch schema reject', meta: { error: err?.message } }); } });
  ipcMain.on('config:unwatch', (e, { paths }) => { try { s.configWatch.parse(paths); unwatch(paths, e.sender.id); } catch (err) { logs.writeLine({ level: 'warn', scope: 'config', message: 'config:unwatch schema reject', meta: { error: err?.message } }); } });
}

module.exports = {
  attachWindow,
  registerConfigHandlers,
  closeAllWatchers,
  releaseWatchesForSender,
  // exported for tests / direct use
  readJson,
  readText,
  writeJson,
  writeJsonSync,
  writeTextAtomic,
  writeBinaryAtomic,
  listDir,
  exists,
  addAllowedRoot,
  validatePath,
  validateWrite,
};
