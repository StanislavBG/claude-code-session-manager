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
const { cleanChildEnv } = require('./lib/cleanEnv.cjs');
const { resolveClaudeBin } = require('./lib/claudeBin.cjs');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');
const { schemas } = require('./ipcSchemas.cjs');

const SLUG_RE = /^[a-z0-9\-/]+$/;
const MAX_LINE_BYTES = 16 * 1024;
const KILL_AFTER_MS = 5 * 60 * 1000; // 5 min hard ceiling per install
const KILL_GRACE_MS = 5_000;          // SIGTERM → SIGKILL escalation window

let mainWindow = null;
const inFlight = new Map(); // slug -> proc

function attachWindow(window) {
  mainWindow = window;
}

function send(channel, payload) {
  sendIfAlive(mainWindow, channel, payload);
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
    let settled = false;

    const killTimer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* */ }
      // Escalate to SIGKILL after KILL_GRACE_MS if the pty hasn't exited.
      const escalate = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, KILL_GRACE_MS);
      if (escalate.unref) escalate.unref();
    }, KILL_AFTER_MS);
    if (killTimer.unref) killTimer.unref();

    // Belt-and-suspenders: if onExit never fires (broken pty event path after
    // SIGKILL — analogous to anthropics/claude-code #61735's unreachable pts),
    // force-release the inFlight lock so the slug isn't permanently stuck.
    const deadman = setTimeout(() => {
      if (settled) return;
      settled = true;
      inFlight.delete(slug);
      resolve({ ok: false, exitCode: -1, error: 'install hung — pty onExit never fired' });
    }, KILL_AFTER_MS + KILL_GRACE_MS + 30_000);
    if (deadman.unref) deadman.unref();

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
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(deadman);
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

  // plugins:abort — send SIGKILL to a stuck install and release the inFlight
  // lock immediately, analogous to pty:kill. UI wiring is a follow-up PRD.
  ipcMain.handle('plugins:abort', async (_e, payload) => {
    const parsed = schemas.pluginsAbort.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: 'invalid slug' };
    }
    const { slug } = parsed.data;
    const proc = inFlight.get(slug);
    if (!proc) return { ok: false, error: 'no install in progress for slug' };
    try { proc.kill('SIGKILL'); } catch { /* */ }
    inFlight.delete(slug);
    return { ok: true };
  });
}

module.exports = { registerPluginInstallHandlers, attachWindow };
