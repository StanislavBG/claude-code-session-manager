/**
 * watchers.cjs — per-tab background shell watchers.
 *
 * Each watcher spawns a shell command, splits stdout into lines, and forwards
 * them to the renderer via `watcher:line`. Stderr is folded into the same
 * stream so users see compile errors / curl progress without a second channel.
 * Lifetime is process-bound: killed on `before-quit` and on explicit remove.
 * No persistence across restarts (deliberately ephemeral — the user re-adds).
 */

const { ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { cleanChildEnv } = require('./lib/cleanEnv.cjs');

// Splits a readable stream into lines capped at maxLineBytes. Prevents OOM
// from commands that produce no newlines (e.g. cat /dev/urandom | base64).
function lineSplit(stream, onLine, maxLineBytes = 4096) {
  let buf = Buffer.alloc(0);
  stream.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (buf.length > maxLineBytes) {
          onLine(buf.slice(0, maxLineBytes).toString('utf8') + '…[truncated]');
          buf = Buffer.alloc(0);
        }
        return;
      }
      const line = buf.slice(0, nl).toString('utf8');
      buf = buf.slice(nl + 1);
      onLine(line.length > maxLineBytes ? line.slice(0, maxLineBytes) + '…[truncated]' : line);
    }
  });
  stream.on('end', () => {
    if (buf.length > 0) {
      onLine(buf.length > maxLineBytes
        ? buf.slice(0, maxLineBytes).toString('utf8') + '…[truncated]'
        : buf.toString('utf8'));
    }
  });
}

class WatcherManager {
  constructor() {
    // watcherId -> { tabId, label, command, cwd, child, startedAt, lineCount }
    this.watchers = new Map();
    this.window = null;
  }

  attachWindow(window) {
    this.window = window;
  }

  add({ tabId, label, command, cwd }) {
    const resolvedCwd = cwd || process.cwd();

    // Require cwd's realpath to be inside homedir.
    const home = os.homedir();
    let realCwd;
    try {
      realCwd = fs.realpathSync(resolvedCwd);
    } catch {
      realCwd = path.resolve(resolvedCwd);
    }
    if (realCwd !== home && !realCwd.startsWith(home + path.sep)) {
      throw new Error(`watcher cwd outside home directory: ${realCwd}`);
    }

    const watcherId = crypto.randomUUID();
    const trimmedLabel = (label && label.trim()) || command.slice(0, 40);
    const child = spawn(command, [], {
      cwd: resolvedCwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanChildEnv(),
    });

    const entry = {
      watcherId,
      tabId,
      label: trimmedLabel,
      command,
      cwd: resolvedCwd,
      child,
      startedAt: Date.now(),
      lineCount: 0,
      pid: child.pid ?? null,
    };
    this.watchers.set(watcherId, entry);

    const emitLine = (line) => {
      entry.lineCount++;
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send('watcher:line', {
          tabId,
          watcherId,
          line,
          ts: Date.now(),
        });
      }
    };

    lineSplit(child.stdout, emitLine);
    lineSplit(child.stderr, emitLine);

    child.on('error', (err) => {
      emitLine(`[watcher error] ${err?.message ?? String(err)}`);
      // Remove from map so list() doesn't return ghosts after a spawn failure.
      this.watchers.delete(watcherId);
    });

    child.on('close', (code, signal) => {
      // Only emit close if still registered (remove() suppresses by deleting first).
      if (this.watchers.has(watcherId)) {
        emitLine(`[exited code=${code ?? 'null'}${signal ? ` signal=${signal}` : ''}]`);
        this.watchers.delete(watcherId);
        if (this.window && !this.window.isDestroyed()) {
          this.window.webContents.send('watcher:closed', { tabId, watcherId });
        }
      }
    });

    return {
      watcherId,
      tabId,
      label: trimmedLabel,
      command,
      cwd: entry.cwd,
      pid: entry.pid,
      startedAt: entry.startedAt,
    };
  }

  list({ tabId }) {
    const out = [];
    for (const w of this.watchers.values()) {
      if (w.tabId !== tabId) continue;
      out.push({
        watcherId: w.watcherId,
        tabId: w.tabId,
        label: w.label,
        command: w.command,
        cwd: w.cwd,
        pid: w.pid,
        startedAt: w.startedAt,
        lineCount: w.lineCount,
      });
    }
    return out;
  }

  remove({ watcherId }) {
    const w = this.watchers.get(watcherId);
    if (!w) return { ok: false };
    // Delete first so the close handler treats this as a quiet shutdown.
    this.watchers.delete(watcherId);
    try { w.child.kill('SIGTERM'); } catch { /* already dead */ }
    // Ensure the child can't survive a stuck SIGTERM.
    setTimeout(() => {
      try { if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill('SIGKILL'); } catch { /* */ }
    }, 2000).unref?.();
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('watcher:closed', { tabId: w.tabId, watcherId });
    }
    return { ok: true };
  }

  killAll() {
    for (const watcherId of [...this.watchers.keys()]) {
      this.remove({ watcherId });
    }
  }
}

const manager = new WatcherManager();

// Top-level export so index.cjs can call watchers.attachWindow(mainWindow)
// without going through the manager instance directly.
function attachWindow(window) {
  manager.attachWindow(window);
}

function registerWatcherHandlers() {
  const { z } = require('zod');
  const addSchema = z.object({
    tabId: z.string().min(1).max(128),
    label: z.string().max(256).optional().default(''),
    command: z.string().min(1).max(8192),
    cwd: z.string().max(4096).optional().nullable(),
  });
  const listSchema = z.object({ tabId: z.string().min(1).max(128) });
  const removeSchema = z.object({ watcherId: z.string().min(1).max(128) });
  const killTabSchema = z.object({ tabId: z.string().min(1).max(128) });

  ipcMain.handle('watchers:add', (_e, payload) => manager.add(addSchema.parse(payload)));
  ipcMain.handle('watchers:list', (_e, payload) => manager.list(listSchema.parse(payload)));
  ipcMain.handle('watchers:remove', (_e, payload) => manager.remove(removeSchema.parse(payload)));
  ipcMain.handle('watchers:kill-tab', (_e, payload) => {
    const { tabId } = killTabSchema.parse(payload);
    for (const [id, w] of manager.watchers) {
      if (w.tabId === tabId) manager.remove({ watcherId: id });
    }
    return { ok: true };
  });
}

module.exports = { manager, attachWindow, registerWatcherHandlers };
