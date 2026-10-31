'use strict';

/**
 * scopeOomPolicy.cjs — keep one child's OOM-kill from stopping the whole app.
 *
 * Electron runs in a transient systemd user scope
 * (app-claude-code-session-manager-<pid>.scope) with the default OOMPolicy=stop,
 * and every job, chat and pty lives inside it. When the kernel OOM-kills ANY
 * child, systemd stops the entire scope (5 app deaths on 2026-10-31). A user
 * drop-in on the scope-name prefix sets OOMPolicy=continue so a child's death
 * stays that child's death. Written at boot; daemon-reload runs only when the
 * file actually changed.
 */

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const atomicFs = require('../util/atomicFs.cjs');

const DROPIN_DIR = 'app-claude-code-session-manager-.scope.d';
const DROPIN_FILE = '10-oom-policy.conf';
const CONTENT = '[Scope]\nOOMPolicy=continue\n';

/**
 * @param {object} [opts]
 * @param {string} [opts.platform]
 * @param {string} [opts.configHome]
 * @param {any} [opts.fs] needs readFileSync
 * @param {any} [opts.spawnSync]
 * @param {(msg: string) => void} [opts.log]
 * @param {(file: string, text: string) => void} [opts.writeText] defaults to atomicFs.writeTextAtomicSync
 * @returns {{ applied: boolean, reason: string }}
 */
function ensureScopeOomPolicy(opts = {}) {
  const platform = opts.platform || process.platform;
  const fs = opts.fs || nodeFs;
  const spawnSync = opts.spawnSync || childProcess.spawnSync;
  const log = opts.log || (() => {});
  const writeText = opts.writeText || ((f, t) => atomicFs.writeTextAtomicSync(f, t));
  try {
    if (platform !== 'linux') return { applied: false, reason: 'not-linux' };
    const configHome = opts.configHome
      || process.env.XDG_CONFIG_HOME
      || path.join(os.homedir(), '.config');

    const probe = spawnSync('systemctl', ['--user', '--version'], { stdio: 'ignore', timeout: 5000 });
    if (!probe || probe.error || probe.status !== 0) {
      return { applied: false, reason: 'no-systemctl' };
    }

    const file = path.join(configHome, 'systemd', 'user', DROPIN_DIR, DROPIN_FILE);
    let existing = null;
    try { existing = fs.readFileSync(file, 'utf8'); } catch { existing = null; }
    if (existing === CONTENT) return { applied: false, reason: 'already-current' };

    writeText(file, CONTENT);
    const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore', timeout: 15000 });
    if (!reload || reload.error || reload.status !== 0) {
      log(`scopeOomPolicy: daemon-reload failed (${reload?.error?.message || `status ${reload?.status}`})`);
      return { applied: false, reason: 'daemon-reload-failed' };
    }
    return { applied: true, reason: existing === null ? 'written' : 'updated' };
  } catch (e) {
    return { applied: false, reason: `error: ${e?.message || e}` };
  }
}

module.exports = { ensureScopeOomPolicy, DROPIN_DIR, DROPIN_FILE, CONTENT };
