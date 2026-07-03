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
// Guard like pty.cjs: a node-pty ABI mismatch must not crash the whole app at
// module load (index.cjs requires this unconditionally). install() reports a
// clean error if the native module is unavailable.
let pty = null;
try {
  pty = require('node-pty');
} catch (e) {
  // eslint-disable-next-line no-console
  console.error('[pluginInstall] node-pty failed to load:', e?.message);
}
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { cleanChildEnv, pathWithUserBins } = require('./lib/cleanEnv.cjs');
const { resolveClaudeBin } = require('./lib/claudeBin.cjs');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');
const { schemas } = require('./ipcSchemas.cjs');

// Must start with an alphanumeric so a leading `-` can't smuggle a CLI flag into
// `claude plugin install <slug>` (argv flag injection).
const SLUG_RE = /^[a-z0-9][a-z0-9\-/]*$/;
// Marketplace name: same shape as a plugin slug. Marketplace source (`add`):
// a GitHub `owner/repo` (case-sensitive) or a dotted/hyphenated path segment.
// Deliberately excludes whitespace, flags (leading `-`), and shell metachars.
const MKT_NAME_RE = /^[a-z0-9][a-z0-9\-/]*$/;
const MKT_ADD_RE = /^[A-Za-z0-9][A-Za-z0-9._\-]*\/[A-Za-z0-9._\-]+$/;
// Sentinel: register the marketplace that ships inside this app's own files
// (the npx distribution). Resolved to an absolute path in-process so the
// renderer never supplies a filesystem path. Works offline — no GitHub/npm.
const BUNDLED_ADD = 'bundled';
const MAX_LINE_BYTES = 16 * 1024;

/** Absolute path to the packaged marketplace root (package dir holding
 *  `.claude-plugin/marketplace.json`). src/main/ → ../../ */
function bundledMarketplaceDir() {
  return path.join(__dirname, '..', '..');
}
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

function childEnv() {
  return cleanChildEnv({
    PATH: pathWithUserBins(),
    TERM: 'xterm-256color',
    FORCE_COLOR: '0', // strip ANSI so the renderer doesn't have to.
  });
}

/**
 * Run one `claude plugin …` pty step, streaming output under `slug` and
 * resolving with the exit code. `register`/`unregister` thread the live proc
 * into the inFlight map so plugins:abort can kill whichever step is current.
 */
function runStep({ slug, args, register, unregister }) {
  return new Promise((resolve) => {
    if (!pty) {
      resolve({ ok: false, exitCode: -1, error: 'node-pty unavailable (native module failed to load)' });
      return;
    }
    const claudeBin = resolveClaudeBin();
    let proc;
    try {
      proc = pty.spawn(claudeBin, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: os.homedir(),
        env: childEnv(),
      });
    } catch (err) {
      resolve({ ok: false, exitCode: -1, error: `spawn failed: ${err?.message ?? String(err)}` });
      return;
    }

    register(proc);

    let lineBuf = '';
    let settled = false;

    const killTimer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* */ }
      const escalate = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, KILL_GRACE_MS);
      if (escalate.unref) escalate.unref();
    }, KILL_AFTER_MS);
    if (killTimer.unref) killTimer.unref();

    // Belt-and-suspenders: if onExit never fires (broken pty event path after
    // SIGKILL — analogous to anthropics/claude-code #61735's unreachable pts),
    // force-resolve so the step (and its inFlight lock) isn't permanently stuck.
    const deadman = setTimeout(() => {
      if (settled) return;
      settled = true;
      unregister();
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
      unregister();
      const code = typeof exitCode === 'number' ? exitCode : -1;
      resolve({ ok: code === 0, exitCode: code });
    });
  });
}

/**
 * Install a plugin. Without `marketplace`, runs `claude plugin install <slug>`
 * (official catalog is pre-registered). With `marketplace: { add, name }`,
 * first runs `claude plugin marketplace add <add>` to register the source, then
 * installs `<slug>@<name>` — this is what a non-official plugin (e.g. the
 * bundled session-manager-dev) needs on a fresh machine.
 */
async function install({ slug, marketplace }) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug) || slug.length > 128) {
    return { ok: false, exitCode: -1, error: 'invalid slug' };
  }
  let mkt = null;
  if (marketplace != null) {
    const { add, name } = marketplace;
    const addValid = typeof add === 'string' && add.length <= 200 &&
      (add === BUNDLED_ADD || MKT_ADD_RE.test(add));
    if (!addValid || typeof name !== 'string' || !MKT_NAME_RE.test(name) || name.length > 128) {
      return { ok: false, exitCode: -1, error: 'invalid marketplace' };
    }
    // Resolve the `bundled` sentinel to the app's own packaged marketplace dir.
    let addArg = add;
    if (add === BUNDLED_ADD) {
      const dir = bundledMarketplaceDir();
      if (!fs.existsSync(path.join(dir, '.claude-plugin', 'marketplace.json'))) {
        return { ok: false, exitCode: -1, error: 'bundled marketplace not found' };
      }
      addArg = dir;
    }
    mkt = { add: addArg, name };
  }
  if (inFlight.has(slug)) {
    return { ok: false, exitCode: -1, error: 'install already in progress' };
  }

  // Reserve the slug for the whole sequence; each step swaps in its live proc.
  inFlight.set(slug, null);
  const register = (proc) => inFlight.set(slug, proc);
  const release = () => inFlight.delete(slug);
  // Between steps the slug stays reserved (set to null) so a concurrent call
  // can't slip in; runStep's unregister only clears the per-step proc handle.
  const unregisterStep = () => inFlight.set(slug, null);

  try {
    if (mkt) {
      const added = await runStep({
        slug,
        args: ['plugin', 'marketplace', 'add', mkt.add],
        register,
        unregister: unregisterStep,
      });
      // Tolerate "already added" — the add command exits non-zero when the
      // marketplace is already registered; fall through to install regardless.
      if (!added.ok) {
        send('plugins:install-progress', { slug, line: `[marketplace add exit ${added.exitCode} — continuing to install]` });
      }
    }
    const installTarget = mkt ? `${slug}@${mkt.name}` : slug;
    return await runStep({
      slug,
      args: ['plugin', 'install', installTarget],
      register,
      unregister: unregisterStep,
    });
  } finally {
    release();
  }
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
    return install({ slug: parsed.data.slug, marketplace: parsed.data.marketplace });
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

module.exports = { registerPluginInstallHandlers, attachWindow, install, bundledMarketplaceDir };
