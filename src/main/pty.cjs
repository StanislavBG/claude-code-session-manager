const pty = require('node-pty');
const { ipcMain } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { addAllowedRoot } = require('./config.cjs');
const { cleanChildEnv } = require('./lib/cleanEnv.cjs');
const { assertCwdInsideHome } = require('./lib/insideHome.cjs');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');

/**
 * PtyManager — owns every claude PTY process, keyed by tabId (renderer-generated UUID).
 * Streams output to the renderer via IPC channels scoped by tabId.
 */
class PtyManager {
  constructor() {
    this.sessions = new Map(); // tabId -> { proc, cwd, created }
    this.killed = new Set();   // tabIds explicitly killed — suppress their exit events
    this.window = null;
  }

  attachWindow(window) {
    this.window = window;
  }

  spawn({ tabId, cwd, cols = 120, rows = 30 }) {
    console.log('[pty] spawn requested', { tabId });

    // Validate that cwd is inside homedir before widening the allowed-root set.
    if (cwd) {
      const r = assertCwdInsideHome(cwd);
      if (!r.ok) throw new Error(`pty ${r.error}`);
      addAllowedRoot(r.realCwd);
    }

    // Idempotent reattach: renderer reloads (HMR/Ctrl+R) re-run App.tsx's
    // hydrate path, which calls pty.spawn for each persisted tabId. The PTY
    // from the previous renderer-load is still registered here, so rather
    // than throwing (and stranding the user with an exited-looking tab + a
    // live-but-orphan claude process), return the existing session. The
    // renderer will re-register its data/exit listeners on the same IPC
    // channels. The data stream is live; pre-reattach output is lost, which
    // is acceptable for a dev reload.
    const existing = this.sessions.get(tabId);
    if (existing) {
      console.log('[pty] reattach to existing session tabId=', tabId, 'pid=', existing.proc.pid);
      // Apply the new viewport size in case the window was resized while
      // the old renderer was gone.
      try {
        existing.proc.resize(cols, rows);
      } catch {
        /* pty may have exited between the check and the resize */
      }
      // If the process has already exited but its session wasn't cleaned up,
      // fire a synthetic exit after the renderer re-registers its onExit handler.
      if (existing.proc.exitCode != null) {
        const exitCode = existing.proc.exitCode;
        setImmediate(() => {
          sendIfAlive(this.window, `pty:exit:${tabId}`, { exitCode, signal: undefined });
        });
      }
      return { pid: existing.proc.pid, cwd: existing.cwd, reattached: true };
    }

    // Prefer `claude` on PATH; extend PATH with common user bin dirs since
    // Electron can launch with a stripped environment.
    const extraPath = [
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), '.npm-global', 'bin'),
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ].join(':');

    const env = cleanChildEnv({
      PATH: `${extraPath}:${process.env.PATH || ''}`,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1',
      // Tag the session so hook server / transcript tail can correlate.
      SESSION_MANAGER_TAB_ID: tabId,
    });

    const shell = process.env.SHELL || '/bin/bash';
    console.log('[pty] spawning shell', shell);
    let proc;
    try {
      // Interactive login shell so aliases / nvm / PATH resolve correctly.
      proc = pty.spawn(shell, ['-il'], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      });
    } catch (err) {
      console.error('[pty] pty.spawn threw:', err);
      throw err;
    }
    console.log('[pty] spawned pid=', proc.pid, 'for tabId=', tabId);

    proc.onData((data) => {
      sendIfAlive(this.window, `pty:data:${tabId}`, data);
    });

    proc.onExit(({ exitCode, signal }) => {
      console.log('[pty] exit tabId=', tabId, 'code=', exitCode, 'signal=', signal);
      // Suppress exit broadcast for explicitly killed sessions — a new PTY
      // may already be listening on the same channel after a restart.
      if (this.killed.delete(tabId)) {
        console.log('[pty] suppressed exit broadcast for killed tabId=', tabId);
        this.sessions.delete(tabId);
        return;
      }
      sendIfAlive(this.window, `pty:exit:${tabId}`, { exitCode, signal });
      this.sessions.delete(tabId);
    });

    this.sessions.set(tabId, { proc, cwd, created: Date.now() });
    return { pid: proc.pid, cwd, reattached: false };
  }

  write({ tabId, data }) {
    const s = this.sessions.get(tabId);
    if (!s) {
      // Tab was removed or never existed — tell the renderer so it can surface
      // "skipped" feedback rather than silently dropping the write.
      sendIfAlive(this.window, 'pty:write-error', { tabId, reason: 'no-pty' });
      return;
    }
    try {
      s.proc.write(data);
    } catch (err) {
      // node-pty throws synchronously (or the underlying net.Socket emits an
      // error that node-pty re-throws) when writing to an exited process.
      // Catch here so the uncaught-exception handler never sees it, and notify
      // the renderer to surface "skipped" feedback.
      sendIfAlive(this.window, 'pty:write-error', {
        tabId,
        reason: String(err?.message || 'write-failed'),
      });
    }
  }

  resize({ tabId, cols, rows }) {
    const s = this.sessions.get(tabId);
    if (s) {
      try {
        s.proc.resize(cols, rows);
      } catch {
        /* pty may have exited */
      }
    }
  }

  kill(tabId) {
    const s = this.sessions.get(tabId);
    if (s) {
      this.killed.add(tabId);
      try {
        s.proc.kill();
      } catch {
        /* already dead */
      }
      this.sessions.delete(tabId);
    }
  }

  killAll() {
    for (const tabId of [...this.sessions.keys()]) this.kill(tabId);
  }
}

const manager = new PtyManager();

function registerPtyHandlers() {
  const { schemas: s, validated: v } = require('./ipcSchemas.cjs');
  ipcMain.handle('pty:spawn', v(s.ptySpawn, (payload) => manager.spawn(payload)));
  ipcMain.on('pty:write', (_e, payload) => { try { manager.write(s.ptyWrite.parse(payload)); } catch { /* ignore */ } });
  ipcMain.on('pty:resize', (_e, payload) => { try { manager.resize(s.ptyResize.parse(payload)); } catch { /* ignore */ } });
  ipcMain.on('pty:kill', (_e, tabId) => { if (typeof tabId === 'string') manager.kill(tabId); });
}

module.exports = { manager, registerPtyHandlers };
