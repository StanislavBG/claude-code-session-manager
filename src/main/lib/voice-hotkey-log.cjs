/**
 * voice-hotkey-log — sanitizing logger wrapper for the voice-hotkey scope.
 *
 * Enforces the F1 PRD §Security no-transcript rule: any meta key whose name
 * matches /transcript|interim|final|text/i is dropped before the line hits
 * disk. In dev (`!app.isPackaged`), if the dropped value was non-empty we
 * throw so tests catch a leak immediately.
 *
 * This module is intentionally tiny and dependency-free apart from logs.cjs
 * and electron's `app` for the dev check.
 */

const { app } = require('electron');
const logs = require('../logs.cjs');

const SENSITIVE_KEY_RE = /transcript|interim|final|text/i;

function isNonEmpty(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  // numbers, booleans → "non-empty" if truthy enough that a leak would matter
  return Boolean(value);
}

function sanitize(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return meta;
  const out = {};
  let leaked = null;
  for (const [k, v] of Object.entries(meta)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      if (isNonEmpty(v) && leaked === null) leaked = k;
      continue;
    }
    out[k] = v;
  }
  return { sanitized: out, leakedKey: leaked };
}

function voiceHotkeyLog(level, event, meta) {
  let safeMeta = meta;
  let leakedKey = null;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const result = sanitize(meta);
    safeMeta = result.sanitized;
    leakedKey = result.leakedKey;
  }
  // Write the (sanitized) line FIRST so the leak event itself is recorded
  // — otherwise a dev-mode throw destroys the trail. Then throw in dev so
  // tests fail loudly. Critique fix: was previously throw-then-log.
  logs.writeLine({ scope: 'voice-hotkey', level, message: event, meta: safeMeta });
  if (leakedKey !== null) {
    logs.writeLine({
      scope: 'voice-hotkey',
      level: 'error',
      message: 'sanitizer.leak',
      meta: { leakedKey, event },
    });
    const isDev = (() => {
      try { return !app.isPackaged; } catch { return true; }
    })();
    if (isDev) {
      throw new Error(`voice-hotkey log leaked sensitive key: ${leakedKey}`);
    }
  }
}

module.exports = { voiceHotkeyLog, SENSITIVE_KEY_RE };
