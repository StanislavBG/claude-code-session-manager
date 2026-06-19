// Load the native node-pty lazily-guarded: if its prebuilt/rebuilt binary
// doesn't match this Electron's ABI, a bare top-level require would throw and
// crash the WHOLE app at startup (index.cjs requires this module). Instead we
// capture the error and surface an actionable message when a tab is opened, so
// the app still boots and the user sees exactly how to fix the terminal.
let pty = null;
let ptyLoadError = null;
try {
  pty = require('node-pty');
} catch (e) {
  ptyLoadError = e;
  // eslint-disable-next-line no-console
  console.error('[pty] node-pty failed to load:', e?.message);
}
const { ipcMain } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { addAllowedRoot } = require('./config.cjs');
const { cleanChildEnv, pathWithUserBins } = require('./lib/cleanEnv.cjs');
const { checkInsideHome } = require('./lib/insideHome.cjs');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');

// Absolute path to the installed package root (src/main/ -> ../../), shown in
// the remediation message so the user can cd there and rebuild.
const PKG_DIR = path.join(__dirname, '..', '..');

/**
 * ANSI-formatted terminal text explaining a native-module / immediate-exit
 * failure and exactly how to fix it. Written straight into the tab's output so
 * a dead terminal explains itself instead of just going blank.
 */
function nativeModuleHelp(reason) {
  const mac = process.platform === 'darwin';
  const lines = [
    '',
    `\x1b[1;33m[session-manager] Terminal could not start.\x1b[0m`,
    `\x1b[33m${reason}\x1b[0m`,
    '',
    `This is almost always the node-pty native module not matching this`,
    `Electron build. Rebuild it once:`,
    '',
    `  \x1b[36mcd ${PKG_DIR}\x1b[0m`,
    `  \x1b[36mnpx electron-rebuild -f -w node-pty\x1b[0m`,
    '',
    mac ? `macOS: if the rebuild fails, install the compiler first:` : '',
    mac ? `  \x1b[36mxcode-select --install\x1b[0m` : '',
    mac ? '' : '',
    `Then quit and reopen session-manager.`,
    '',
  ].filter((l) => l !== '');
  return lines.join('\r\n') + '\r\n';
}

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

    // Native module unavailable — explain in the tab and report a clean exit
    // rather than throwing (which would surface as an opaque IPC error).
    if (!pty || ptyLoadError) {
      const reason = `node-pty failed to load: ${ptyLoadError?.message ?? 'module missing'}`;
      sendIfAlive(this.window, `pty:data:${tabId}`, nativeModuleHelp(reason));
      setImmediate(() => sendIfAlive(this.window, `pty:exit:${tabId}`, { exitCode: 1, signal: undefined }));
      return { pid: null, cwd, reattached: false, error: 'node-pty unavailable' };
    }

    // Validate that cwd is inside homedir before widening the allowed-root set.
    if (cwd) {
      const r = checkInsideHome(cwd);
      if (!r.ok) throw new Error(`pty ${r.error}`);
      addAllowedRoot(r.realPath);
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

    // Prefer `claude` on PATH; extend PATH with common user + Homebrew bin dirs
    // since Electron can launch with a stripped environment (Apple Silicon
    // Homebrew is /opt/homebrew, absent from the default Electron PATH).
    const env = cleanChildEnv({
      PATH: pathWithUserBins(),
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
      // Surface the cause in the tab + report a clean exit rather than throwing
      // an opaque IPC error (covers a missing/invalid cwd or a native fault).
      sendIfAlive(this.window, `pty:data:${tabId}`, nativeModuleHelp(`pty.spawn failed: ${err?.message ?? String(err)}`));
      setImmediate(() => sendIfAlive(this.window, `pty:exit:${tabId}`, { exitCode: 1, signal: undefined }));
      return { pid: null, cwd, reattached: false, error: String(err?.message || 'spawn-failed') };
    }
    console.log('[pty] spawned pid=', proc.pid, 'for tabId=', tabId);

    const spawnedAt = Date.now();
    let gotData = false;

    proc.onData((data) => {
      gotData = true;
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
      // Fast-exit detector: a shell that dies in <1.2s with a non-zero status
      // and never printed anything almost certainly couldn't exec (broken
      // node-pty spawn-helper / ABI on macOS). Explain it in the tab instead of
      // leaving a blank, instantly-closed terminal. Guarded by !gotData so a
      // real interactive shell (which prints a prompt immediately) is exempt.
      if (!gotData && exitCode !== 0 && Date.now() - spawnedAt < 1200) {
        sendIfAlive(this.window, `pty:data:${tabId}`, nativeModuleHelp(`The shell exited immediately (code ${exitCode}).`));
      }
      sendIfAlive(this.window, `pty:exit:${tabId}`, { exitCode, signal });
      this.sessions.delete(tabId);
    });

    this.sessions.set(tabId, { proc, cwd, created: spawnedAt });
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
    // Always drop superagent run state — a run can be started before the pty
    // finishes spawning, so clean up regardless of whether a session existed.
    try { require('./superagent.cjs').dropTab(tabId); } catch { /* superagent not loaded (e2e) */ }
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
  ipcMain.on('pty:kill', (_e, tabId) => {
    if (typeof tabId !== 'string') return;
    manager.kill(tabId);
    try { require('./superagent.cjs').dropTab(tabId); } catch { /* superagent module not initialized (e2e) */ }
  });
}

module.exports = { manager, registerPtyHandlers };
