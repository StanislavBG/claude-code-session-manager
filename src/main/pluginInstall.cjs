/**
 * Plugin install — hidden pty wrapper around `claude plugin install <slug>`.
 *
 * Why pty (not exec/spawn): the CLI emits interactive progress, prompts, and
 * colored output. A real pty gives the user faithful console output streamed
 * into the Discover panel. Slow (~5s) but transparent.
 *
 * Channels:
 *   ipcMain.handle('plugins:install', { slug }) -> { ok, exitCode }
 *   webContents.send('plugins:install-progress', { slug, line })
 *
 * Safety:
 *   - slug must match /^[a-z0-9\-/]+$/ (lowercase, hyphen, slash for owner/name).
 *   - No shell:true — argv array passed directly to pty.spawn.
 *   - cwd pinned to os.homedir().
 *   - Only one install per slug at a time (concurrent calls reject early).
 */

const { ipcMain } = require('electron');
const pty = require('node-pty');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { cleanChildEnv } = require('./lib/cleanEnv.cjs');
const { schemas } = require('./ipcSchemas.cjs');

const SLUG_RE = /^[a-z0-9\-/]+$/;
const MAX_LINE_BYTES = 16 * 1024;
const KILL_AFTER_MS = 5 * 60 * 1000; // 5 min hard ceiling per install

let mainWindow = null;
const inFlight = new Map(); // slug -> proc

function attachWindow(window) {
  mainWindow = window;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function resolveClaudeBin() {
  // Same PATH-resolution heuristic pty.cjs uses for `claude`.
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'claude'; // Hope PATH has it.
}

function install({ slug }) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug) || slug.length > 128) {
    return Promise.resolve({ ok: false, exitCode: -1, error: 'invalid slug' });
  }
  if (inFlight.has(slug)) {
    return Promise.resolve({ ok: false, exitCode: -1, error: 'install already in progress' });
  }

  return new Promise((resolve) => {
    const home = os.homedir();
    const extraPath = [
      path.join(home, '.local', 'bin'),
      path.join(home, '.npm-global', 'bin'),
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ].join(':');
    const env = cleanChildEnv({
      PATH: `${extraPath}:${process.env.PATH || ''}`,
      TERM: 'xterm-256color',
      FORCE_COLOR: '0', // strip ANSI so the renderer doesn't have to.
    });

    const claudeBin = resolveClaudeBin();
    let proc;
    try {
      proc = pty.spawn(claudeBin, ['plugin', 'install', slug], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: home,
        env,
      });
    } catch (err) {
      resolve({ ok: false, exitCode: -1, error: `spawn failed: ${err?.message ?? String(err)}` });
      return;
    }

    inFlight.set(slug, proc);

    let lineBuf = '';
    const killTimer = setTimeout(() => {
      try { proc.kill(); } catch { /* */ }
    }, KILL_AFTER_MS);

    proc.onData((data) => {
      lineBuf += data;
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl).replace(/\r$/, '');
        lineBuf = lineBuf.slice(nl + 1);
        send('plugins:install-progress', { slug, line });
      }
      // Guard runaway buffers without newlines.
      if (lineBuf.length > MAX_LINE_BYTES) {
        send('plugins:install-progress', { slug, line: lineBuf });
        lineBuf = '';
      }
    });

    proc.onExit(({ exitCode }) => {
      clearTimeout(killTimer);
      if (lineBuf.length > 0) {
        send('plugins:install-progress', { slug, line: lineBuf });
        lineBuf = '';
      }
      inFlight.delete(slug);
      const code = typeof exitCode === 'number' ? exitCode : -1;
      resolve({ ok: code === 0, exitCode: code });
    });
  });
}

function registerPluginInstallHandlers() {
  ipcMain.handle('plugins:install', async (_e, payload) => {
    // safeParse to preserve the existing `{ ok:false, exitCode:-1, error }`
    // return shape on invalid input (the renderer expects this shape, not a
    // thrown promise rejection).
    const parsed = schemas.pluginsInstall.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, exitCode: -1, error: 'invalid slug' };
    }
    return install({ slug: parsed.data.slug });
  });
}

module.exports = { registerPluginInstallHandlers, attachWindow };
