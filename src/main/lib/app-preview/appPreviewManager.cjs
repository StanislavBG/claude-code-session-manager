'use strict';

// Single owner of every Epic "Run preview" dev-server process. At most one
// preview per Epic (the only bound — no machine-wide cap, per
// src/main/lib/CLAUDE.md). start() runs `npm run <script>` in the Epic's folder
// on a free port, watches stdout+stderr for the first loopback URL, opens it in
// the system browser, and stop()/stopAll() kill the whole process group.
// IPC, Epic-close and app-quit wiring live in later modules.

const { killTree: defaultKillTree, detachedSpawnOpts } = require('../process/killTree.cjs');
const { cleanChildEnv, pathWithUserBins } = require('../process/cleanEnv.cjs');
const { resolveSpawn: defaultResolveSpawn } = require('../process/winSpawn.cjs');
const { createHeadTailBuffer } = require('../util/headTailBuffer.cjs');
const {
  isValidScriptName,
  listPreviewScripts,
  detectLocalUrl,
  stripAnsi,
  findFreePort: defaultFindFreePort,
} = require('./appPreviewScripts.cjs');

const RECENT_MAX = 4096;
const ERROR_BUFFER_MAX = 16384;
const TAIL_LINES = 8;

/**
 * @typedef {'starting'|'running'|'failed'|'stopped'} AppPreviewStatus
 * @typedef {{ epicId: string, cwd: string, dir: string, script: string, command: string,
 *   port: number, url: string|null, status: AppPreviewStatus, error: string|null,
 *   pid: number|null, startedAt: string }} AppPreviewState
 */

function createAppPreviewManager(deps = {}) {
  const spawn = deps.spawn || require('node:child_process').spawn;
  const killTree = deps.killTree || defaultKillTree;
  const openExternal = deps.openExternal || ((url) => require('electron').shell.openExternal(url));
  const broadcast = deps.broadcast || (() => {});
  const findFreePort = deps.findFreePort || defaultFindFreePort;
  const listScripts = deps.listScripts || listPreviewScripts;
  const resolveSpawn = deps.resolveSpawn || defaultResolveSpawn;
  const platform = deps.platform || process.platform;
  const urlTimeoutMs = Number.isFinite(deps.urlTimeoutMs) ? deps.urlTimeoutMs : 90000;
  const killGraceMs = Number.isFinite(deps.killGraceMs) ? deps.killGraceMs : 5000;
  const now = deps.now || Date.now;
  const log = deps.log || ((msg) => { try { console.warn(msg); } catch { /* ignore */ } });

  /** epicId -> entry */
  const entries = new Map();
  /** epicId -> in-flight start promise (before spawn) */
  const pending = new Map();
  /** epicIds whose pending start was cancelled by stop/stopAll */
  const cancelled = new Set();

  const copy = (state) => ({ ...state });
  const emit = (entry) => {
    try { broadcast(copy(entry.state)); } catch (e) { log(`[appPreview] broadcast failed: ${e && e.message}`); }
  };
  const isLive = (entry) => !!entry && !!entry.child && !entry.exited;

  function clearTimers(entry) {
    if (entry.urlTimer) { clearTimeout(entry.urlTimer); entry.urlTimer = null; }
    if (entry.killTimer) { clearTimeout(entry.killTimer); entry.killTimer = null; }
  }

  function tailLines(entry) {
    return stripAnsi(entry.buffer.matchText())
      .split(/\r\n|\r|\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== '')
      .slice(-TAIL_LINES)
      .join('\n');
  }

  function withTail(entry, msg) {
    const tail = tailLines(entry);
    return tail ? `${msg}\n${tail}` : msg;
  }

  function fail(entry, cause) {
    clearTimers(entry);
    const { script } = entry.state;
    entry.state = { ...entry.state, status: 'failed', error: withTail(entry, `npm run ${script} failed: ${cause}`) };
    emit(entry);
  }

  function markDead(entry) {
    entry.exited = true;
    entry.child = null;
    entry.state = { ...entry.state, pid: null };
    clearTimers(entry);
    const waiters = entry.stopWaiters.splice(0);
    for (const w of waiters) w({ ok: true });
  }

  function onOutput(entry, chunk) {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    entry.buffer.append(text);
    if (entry.state.status !== 'starting') return;
    entry.recent = (entry.recent + text).slice(-RECENT_MAX);
    const url = detectLocalUrl(entry.recent);
    if (!url) return;
    if (entry.urlTimer) { clearTimeout(entry.urlTimer); entry.urlTimer = null; }
    entry.state = { ...entry.state, status: 'running', url };
    emit(entry);
    try {
      Promise.resolve(openExternal(url)).catch((e) => log(`[appPreview] openExternal(${url}) failed: ${e && e.message}`));
    } catch (e) {
      log(`[appPreview] openExternal(${url}) failed: ${e && e.message}`);
    }
  }

  function onExit(entry, code, signal) {
    if (entry.exited) return;
    const prev = entry.state.status;
    markDead(entry);
    const how = signal ? `signal ${signal}` : `code ${code}`;
    if (entry.stopRequested) {
      if (prev !== 'stopped' || entry.state.error !== null) {
        entry.state = { ...entry.state, status: 'stopped', error: null };
        emit(entry);
      }
      return;
    }
    if (prev === 'starting') {
      fail(entry, `exited with ${how} before printing a local URL`);
    } else if (prev === 'running') {
      entry.state = {
        ...entry.state,
        status: 'stopped',
        error: withTail(entry, `Preview stopped unexpectedly (npm run ${entry.state.script} exited with ${how})`),
      };
      emit(entry);
    } else {
      emit(entry); // already failed/stopped: publish pid: null
    }
  }

  function onError(entry, err) {
    const cause = (err && (err.code ? `${err.code}: ${err.message}` : err.message)) || String(err);
    const noProcess = !entry.child || entry.child.pid === undefined;
    if (noProcess) markDead(entry);
    if (entry.state.status === 'starting') fail(entry, cause);
    else log(`[appPreview] ${entry.state.epicId}: child error: ${cause}`);
  }

  async function doStart({ cwd, epicId, dir, script }) {
    let port;
    try {
      port = await findFreePort();
    } catch (e) {
      return { ok: false, error: `Could not allocate a port for the preview: ${e && e.message}` };
    }
    if (cancelled.has(epicId)) {
      cancelled.delete(epicId);
      return { ok: false, error: 'Preview start was cancelled' };
    }
    const scripts = listScripts(dir);
    const found = scripts && scripts.ok ? scripts.scripts.find((s) => s.name === script) : null;
    const command = found ? found.command : '';
    const env = cleanChildEnv({
      PATH: pathWithUserBins({ platform }),
      PORT: String(port),
      BROWSER: 'none',
      SM_PROC_ROLE: 'preview',
      SM_PREVIEW_EPIC_ID: String(epicId),
      SM_PREVIEW_OWNER_PID: String(process.pid),
    });
    const resolved = resolveSpawn('npm', ['run', script], { platform, env });
    const opts = {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...detachedSpawnOpts({ platform }),
      env,
    };
    if (resolved.windowsVerbatimArguments) opts.windowsVerbatimArguments = true;

    const entry = {
      state: {
        epicId, cwd, dir, script, command, port,
        url: null, status: 'starting', error: null, pid: null,
        startedAt: new Date(now()).toISOString(),
      },
      child: null,
      exited: false,
      urlTimer: null,
      killTimer: null,
      stopRequested: false,
      stopWaiters: [],
      buffer: createHeadTailBuffer(ERROR_BUFFER_MAX),
      recent: '',
    };
    entries.set(epicId, entry);

    let child;
    try {
      child = spawn(resolved.command, resolved.args, opts);
    } catch (e) {
      entry.exited = true;
      fail(entry, (e && e.message) || String(e));
      return { ok: true, state: copy(entry.state) };
    }
    entry.child = child;
    entry.state = { ...entry.state, pid: Number.isInteger(child.pid) ? child.pid : null };
    if (child.stdout) child.stdout.on('data', (c) => onOutput(entry, c));
    if (child.stderr) child.stderr.on('data', (c) => onOutput(entry, c));
    child.on('error', (err) => onError(entry, err));
    child.on('exit', (code, signal) => onExit(entry, code, signal));
    entry.urlTimer = setTimeout(() => {
      entry.urlTimer = null;
      if (entry.state.status !== 'starting') return;
      const pid = entry.state.pid;
      fail(entry, `no local URL printed within ${Math.round(urlTimeoutMs / 1000)}s`);
      if (isLive(entry) && pid) killTree(pid, 'SIGKILL');
    }, urlTimeoutMs);
    if (entry.urlTimer && typeof entry.urlTimer.unref === 'function') entry.urlTimer.unref();
    emit(entry);
    return { ok: true, state: copy(entry.state) };
  }

  /** @returns {Promise<{ok:true, state:AppPreviewState} | {ok:false, error:string}>} */
  async function start(input = {}) {
    const { cwd, epicId, dir, script } = input;
    if (typeof epicId !== 'string' || epicId === '') return { ok: false, error: 'Preview needs an Epic id' };
    if (pending.has(epicId)) return pending.get(epicId);
    const existing = entries.get(epicId);
    if (existing && (existing.state.status === 'starting' || existing.state.status === 'running')) {
      return { ok: true, state: copy(existing.state) };
    }
    if (!isValidScriptName(script)) return { ok: false, error: `Invalid script name: ${String(script)}` };
    const scripts = listScripts(dir);
    if (!scripts || !scripts.ok) return { ok: false, error: (scripts && scripts.error) || `Could not read scripts in ${dir}` };
    if (!scripts.scripts.some((s) => s.name === script)) {
      return { ok: false, error: `package.json in ${dir} has no "${script}" script` };
    }
    if (existing && isLive(existing)) {
      // A failed preview whose process is still dying: finish killing it first.
      killTree(existing.state.pid, 'SIGKILL');
    }
    cancelled.delete(epicId);
    const p = doStart({ cwd, epicId, dir, script }).finally(() => pending.delete(epicId));
    pending.set(epicId, p);
    return p;
  }

  /** @returns {Promise<{ok:true}>} */
  async function stop(epicId) {
    if (pending.has(epicId)) {
      await pending.get(epicId).catch(() => {});
    }
    const entry = entries.get(epicId);
    if (!entry) return { ok: true };
    if (!isLive(entry)) {
      clearTimers(entry);
      if (entry.state.status !== 'stopped' || entry.state.error !== null) {
        entry.state = { ...entry.state, status: 'stopped', error: null };
        emit(entry);
      }
      return { ok: true };
    }
    const done = new Promise((resolve) => entry.stopWaiters.push(resolve));
    if (!entry.stopRequested) {
      entry.stopRequested = true;
      if (entry.urlTimer) { clearTimeout(entry.urlTimer); entry.urlTimer = null; }
      const pid = entry.state.pid;
      killTree(pid, 'SIGTERM');
      entry.killTimer = setTimeout(() => {
        entry.killTimer = null;
        if (isLive(entry)) killTree(pid, 'SIGKILL');
      }, killGraceMs);
    }
    return done;
  }

  /** Synchronously SIGKILL every live preview (app quit). */
  function stopAll() {
    for (const epicId of pending.keys()) cancelled.add(epicId);
    let killed = 0;
    for (const entry of entries.values()) {
      if (!isLive(entry)) continue;
      entry.stopRequested = true;
      clearTimers(entry);
      killTree(entry.state.pid, 'SIGKILL');
      killed += 1;
      if (entry.state.status !== 'stopped' || entry.state.error !== null) {
        entry.state = { ...entry.state, status: 'stopped', error: null };
        emit(entry);
      }
    }
    return { ok: true, killed };
  }

  function get(epicId) {
    const entry = entries.get(epicId);
    return entry ? copy(entry.state) : null;
  }

  function list() {
    return Array.from(entries.values(), (e) => copy(e.state));
  }

  return { start, stop, stopAll, list, get };
}

module.exports = { createAppPreviewManager };
