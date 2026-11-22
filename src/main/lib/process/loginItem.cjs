'use strict';
// Apply the login-item plan from loginItemPlan.cjs: write or remove the entry + start script,
// or set Electron's own login item for a packaged darwin/win32 build. Whether the login item is
// on is read from the system every time (the files, or app.getLoginItemSettings()) — there is
// deliberately no preference file. Starts no process (launchctl loading is out of scope: a
// LaunchAgent with RunAtLoad is picked up at the next login).
// Every outside thing (app, homeDir, env, resolveNpx) is an argument so tests need no real home.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { planLoginItem, SCRIPT_MARKER } = require('./loginItemPlan.cjs');
const { writeTextAtomic } = require('../util/atomicFs.cjs');

const DESKTOP_MARKER = 'X-Session-Manager-Login-Item=1';

/** @param {string} p */
function readOrNull(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/** @param {string} p */
function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

/** True when the entry text carries our marker for this plan. */
function carriesMarker(plan, text) {
  if (typeof text !== 'string') return false;
  if (plan.mechanism === 'launch-agent') {
    return text.includes(`<string>${plan.label}</string>`);
  }
  return text.split(/\r?\n/).some((l) => l.trim() === DESKTOP_MARKER);
}

/** True when the start-script text carries our marker. */
function scriptCarriesMarker(text) {
  return typeof text === 'string' && text.split(/\r?\n/).some((l) => l.trim() === SCRIPT_MARKER);
}

/** True when a desktop entry has been switched off by hand (Hidden=true / Autostart-enabled=false). */
function switchedOff(text) {
  return text.split(/\r?\n/).some((raw) => {
    const l = raw.trim();
    const m = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(l);
    if (!m) return false;
    const val = m[2].trim().toLowerCase();
    if (m[1] === 'Hidden') return val === 'true';
    if (m[1] === 'X-GNOME-Autostart-enabled') return val === 'false';
    return false;
  });
}

/**
 * @param {{ app?: any, platform: string, packaged: boolean, dev: boolean, homeDir?: string,
 *   env?: Record<string, string|undefined>, appId?: string, resolveNpx?: () => (string|null|undefined),
 *   warn?: (message: string, meta?: object) => void }} opts
 */
function createLoginItem(opts) {
  const { app, platform, packaged, dev, homeDir, appId } = opts;
  const env = opts.env || {};
  const resolveNpx = opts.resolveNpx || (() => null);
  const warn = opts.warn || ((message, meta) => console.warn(message, meta || ''));

  function plan() {
    return planLoginItem({
      platform,
      packaged,
      dev,
      homeDir,
      appId,
      appImagePath: env.APPIMAGE || null,
      npxPath: resolveNpx() || null,
    });
  }

  function statusOf(p) {
    if (!p.supported) {
      return { supported: false, enabled: false, mechanism: null, starts: null, entryPath: null, reason: p.reason };
    }
    if (p.mechanism === 'electron-login-item') {
      const s = app.getLoginItemSettings();
      return {
        supported: true,
        enabled: !!(s && s.openAtLogin),
        mechanism: p.mechanism,
        starts: p.starts,
        entryPath: null,
        reason: null,
      };
    }
    const text = readOrNull(p.entryPath);
    let enabled = false;
    let reason = null;
    if (text === null) {
      reason = 'No login item file is present.';
    } else if (!carriesMarker(p, text)) {
      reason = `${p.entryPath} was not written by Session Manager.`;
    } else if (switchedOff(text)) {
      reason = `${p.entryPath} has been switched off.`;
    } else if (p.starts === 'npx' && !exists(p.scriptPath)) {
      reason = `${p.scriptPath} is missing.`;
    } else if (p.starts === 'npx' && !scriptCarriesMarker(readOrNull(p.scriptPath))) {
      reason = `${p.scriptPath} was not written by Session Manager.`;
    } else {
      enabled = true;
    }
    return { supported: true, enabled, mechanism: p.mechanism, starts: p.starts, entryPath: p.entryPath, reason };
  }

  function status() {
    return statusOf(plan());
  }

  function refuseForeign(p) {
    const text = readOrNull(p.entryPath);
    if (text !== null && !carriesMarker(p, text)) {
      throw new Error(`${p.entryPath} was not written by Session Manager; leaving it alone.`);
    }
    if (p.scriptPath) {
      const script = readOrNull(p.scriptPath);
      if (script !== null && !scriptCarriesMarker(script)) {
        throw new Error(`${p.scriptPath} was not written by Session Manager; leaving it alone.`);
      }
    }
  }

  /** @param {boolean} on */
  async function setEnabled(on) {
    const p = plan();
    if (!p.supported) throw new Error(p.reason);
    if (p.mechanism === 'electron-login-item') {
      app.setLoginItemSettings({ openAtLogin: !!on });
      return statusOf(p);
    }
    refuseForeign(p);
    if (on) {
      if (p.scriptPath) await writeTextAtomic(p.scriptPath, p.scriptText, { mode: 0o700 });
      await writeTextAtomic(p.entryPath, p.entryText);
    } else {
      await fsp.rm(p.entryPath, { force: true });
      if (p.scriptPath) await fsp.rm(p.scriptPath, { force: true });
    }
    return statusOf(p);
  }

  /**
   * Rewrite the entry and the script when the login item is on and either differs from what
   * this build would write (a later release changed the script, or npx moved). Never throws.
   * @returns {Promise<boolean>} true when the files were rewritten
   */
  async function refreshIfStale() {
    try {
      const p = plan();
      if (!p.supported || p.mechanism === 'electron-login-item') return false;
      if (!statusOf(p).enabled) return false;
      const entryStale = readOrNull(p.entryPath) !== p.entryText;
      const scriptStale = !!p.scriptPath && readOrNull(p.scriptPath) !== p.scriptText;
      if (!entryStale && !scriptStale) return false;
      if (p.scriptPath) await writeTextAtomic(p.scriptPath, p.scriptText, { mode: 0o700 });
      await writeTextAtomic(p.entryPath, p.entryText);
      return true;
    } catch (e) {
      warn('login item refresh failed', { error: e && /** @type {Error} */ (e).message });
      return false;
    }
  }

  return { status, setEnabled, refreshIfStale };
}

module.exports = { createLoginItem };
