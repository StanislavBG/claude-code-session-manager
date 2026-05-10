const { app, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// Rolling daily files under <userData>/logs/. Anything mtime'd older than
// RETENTION_MS is pruned at boot; we never compact mid-session, since the
// app is short-lived and a once-per-launch sweep is enough.
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const LOG_PREFIX = 'session-manager-';
const LOG_SUFFIX = '.log';

function logDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function todayPath() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(logDir(), `${LOG_PREFIX}${yyyy}-${mm}-${dd}${LOG_SUFFIX}`);
}

function ensureDir() {
  try { fs.mkdirSync(logDir(), { recursive: true }); } catch { /* best-effort */ }
}

function pruneOld() {
  ensureDir();
  let entries;
  try { entries = fs.readdirSync(logDir()); } catch { return; }
  const cutoff = Date.now() - RETENTION_MS;
  for (const name of entries) {
    if (!name.startsWith(LOG_PREFIX) || !name.endsWith(LOG_SUFFIX)) continue;
    const full = path.join(logDir(), name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) fs.unlinkSync(full);
    } catch { /* skip unreadable entries */ }
  }
}

// Sanitize meta keys that look like they might carry transcript or user
// content. Voice features go to logs and the hotkey wrapper already strips
// these in main, but renderer-side log calls go through this writer too.
// Defense in depth: drop and replace with `[redacted]` so leaks are obvious.
const REDACT_KEY = /^(transcript|interim|final|text|content|partial|userText|message|token|secret|password|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i;
function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  if (Array.isArray(meta)) return meta;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = REDACT_KEY.test(k) ? '[redacted]' : v;
  }
  return out;
}

function writeLine(payload) {
  if (!payload || typeof payload !== 'object') return;
  ensureDir();
  const ts = new Date().toISOString();
  const lvl = String(payload.level || 'info').toUpperCase();
  const scope = String(payload.scope || '-');
  const message = String(payload.message ?? '');
  let line = `[${ts}] [${lvl}] [${scope}] ${message}`;
  if (payload.meta !== undefined) {
    try { line += ' ' + JSON.stringify(sanitizeMeta(payload.meta)); } catch { line += ' [unserializable meta]'; }
  }
  // Open with 0o600 so logs don't leak to other local users; a session
  // transcript could include device labels or recently-typed terminal text.
  try {
    const fd = fs.openSync(todayPath(), 'a', 0o600);
    try { fs.writeSync(fd, line + '\n'); } finally { fs.closeSync(fd); }
  } catch { /* best-effort */ }
}

function registerLogHandlers() {
  ipcMain.on('log:write', (_e, payload) => writeLine(payload));
  ipcMain.handle('log:dir', () => logDir());
}

module.exports = { pruneOld, writeLine, registerLogHandlers, logDir };
