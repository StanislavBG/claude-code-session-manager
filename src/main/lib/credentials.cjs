'use strict';

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { cleanChildEnv } = require('./cleanEnv.cjs');

const CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const REFRESH_LOG_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'credential-refresh.log');
const REFRESH_LOG_MAX_BYTES = 100 * 1024;

// Standard OAuth 2.0 refresh grant — endpoint discovered from Claude Code CLI behavior.
// Returns { kind: 'unsupported' } if the endpoint returns 404 or cannot be reached,
// allowing the caller to fall back gracefully.
const OAUTH_TOKEN_URL = 'https://claude.ai/api/auth/oauth/token';

async function readCredentials() {
  try {
    const raw = await fsp.readFile(CREDS_PATH, 'utf8');
    const data = JSON.parse(raw);
    const oa = data?.claudeAiOauth;
    if (!oa?.accessToken) return { kind: 'config', message: 'missing accessToken in credentials file' };
    return { kind: 'ok', creds: oa, raw: data };
  } catch (e) {
    if (e?.code === 'ENOENT') return { kind: 'config', message: 'credentials file not found' };
    return { kind: 'config', message: `cannot read credentials: ${e.message}` };
  }
}

function expiresAtMs(creds) {
  const v = creds.expiresAt;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const ms = new Date(v).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function isExpired(creds) {
  const ms = expiresAtMs(creds);
  return ms !== null && ms < Date.now();
}

function isExpiringSoon(creds, withinMs = 5 * 60_000) {
  const ms = expiresAtMs(creds);
  return ms !== null && ms - Date.now() < withinMs;
}

async function writeCredentials(rawData, freshOauth) {
  const next = { ...rawData, claudeAiOauth: { ...rawData.claudeAiOauth, ...freshOauth } };
  const tmp = `${CREDS_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { await fsp.chmod(tmp, 0o600); } catch { /* umask may have already set it */ }
  await fsp.rename(tmp, CREDS_PATH);
}

function appendRefreshLog(entry) {
  try {
    const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
    let size = 0;
    try { size = fs.statSync(REFRESH_LOG_PATH).size; } catch { /* new file */ }
    if (size >= REFRESH_LOG_MAX_BYTES) {
      const rotated = REFRESH_LOG_PATH + '.1';
      try { fs.unlinkSync(rotated); } catch { /* */ }
      try { fs.renameSync(REFRESH_LOG_PATH, rotated); } catch { /* */ }
    }
    fs.mkdirSync(path.dirname(REFRESH_LOG_PATH), { recursive: true });
    fs.appendFileSync(REFRESH_LOG_PATH, line);
  } catch { /* non-fatal; telemetry must not break the main flow */ }
}

// Stretch: attempt standard OAuth 2.0 refresh token grant.
async function tryOAuthRefresh(creds) {
  if (!creds.refreshToken) return { kind: 'unsupported', message: 'no refresh token in credentials' };
  try {
    const r = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: creds.refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 404) return { kind: 'unsupported', message: 'refresh endpoint not found (HTTP 404)' };
    if (r.status === 401 || r.status === 403) return { kind: 'auth', message: `refresh rejected: HTTP ${r.status}` };
    if (!r.ok) return { kind: 'transient', message: `HTTP ${r.status}` };
    const j = await r.json();
    if (!j.access_token) return { kind: 'auth', message: 'no access_token in refresh response' };
    return {
      kind: 'ok',
      fresh: {
        accessToken: j.access_token,
        refreshToken: j.refresh_token ?? creds.refreshToken,
        expiresAt: j.expires_at ?? (Date.now() + (j.expires_in ?? 3600) * 1000),
      },
    };
  } catch (e) {
    if (e?.name === 'TimeoutError') return { kind: 'transient', message: 'refresh request timed out' };
    return { kind: 'unsupported', message: `refresh error: ${e?.message}` };
  }
}

// Stretch fallback: spawning `claude --version` triggers silent token refresh in the CLI binary.
function tryCliFallback() {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };
    const timer = setTimeout(() => settle({ ok: false, reason: 'timeout' }), 15_000);
    let child;
    try {
      child = spawn('claude', ['--version'], { stdio: 'ignore', env: cleanChildEnv() });
    } catch (e) {
      clearTimeout(timer);
      return settle({ ok: false, reason: e?.message });
    }
    child.on('close', (code) => { clearTimeout(timer); settle({ ok: code === 0 }); });
    child.on('error', (e) => { clearTimeout(timer); settle({ ok: false, reason: e?.message }); });
  });
}

/**
 * Main entry point for callers: check expiry, attempt refresh if needed.
 * Returns:
 *   { kind: 'ok', creds }           — credentials are fresh and ready to use
 *   { kind: 'auth', message, expiredAt } — expired/revoked; user must run `claude`
 *   { kind: 'config', message }      — cannot read credentials file
 *   { kind: 'unsupported', message, creds } — auto-refresh failed; token still valid for now
 */
async function refreshIfNeeded(forceRefresh = false) {
  const cr = await readCredentials();
  if (cr.kind !== 'ok') return cr;
  const { creds, raw } = cr;

  if (!forceRefresh && !isExpiringSoon(creds)) {
    return { kind: 'ok', creds };
  }

  const alreadyExpired = isExpired(creds);

  // Stretch: try OAuth refresh endpoint first.
  const oauthResult = await tryOAuthRefresh(creds);
  appendRefreshLog({ event: `oauth_refresh_${oauthResult.kind}`, message: oauthResult.message ?? null });

  if (oauthResult.kind === 'ok') {
    try {
      await writeCredentials(raw, oauthResult.fresh);
      const freshCr = await readCredentials();
      if (freshCr.kind === 'ok') {
        appendRefreshLog({ event: 'oauth_refresh_written_ok' });
        return { kind: 'ok', creds: freshCr.creds };
      }
    } catch (e) {
      appendRefreshLog({ event: 'oauth_refresh_write_failed', error: e?.message });
    }
  }

  // Stretch: if OAuth didn't explicitly reject the token, try `claude --version` fallback.
  if (oauthResult.kind !== 'auth') {
    const cliResult = await tryCliFallback();
    appendRefreshLog({ event: cliResult.ok ? 'cli_fallback_ok' : 'cli_fallback_failed', reason: cliResult.reason ?? null });
    if (cliResult.ok) {
      const freshCr = await readCredentials();
      if (freshCr.kind === 'ok' && !isExpired(freshCr.creds)) {
        return { kind: 'ok', creds: freshCr.creds };
      }
    }
  }

  if (alreadyExpired) {
    // Re-read from disk in case credentials were externally refreshed (e.g. via
    // `claude login`) between our initial read and the failed OAuth attempt.
    const recheckCr = await readCredentials();
    if (recheckCr.kind === 'ok' && !isExpired(recheckCr.creds)) {
      appendRefreshLog({ event: 'externally_refreshed_ok', recheckExpiresAt: recheckCr.creds.expiresAt ?? null });
      return { kind: 'ok', creds: recheckCr.creds };
    }
    const ms = expiresAtMs(creds);
    appendRefreshLog({ event: 'auth_failed_expired', expiredAtMs: ms });
    return {
      kind: 'auth',
      message: 'Credentials expired. Run `claude` in a terminal to refresh.',
      expiredAt: ms,
    };
  }

  // Token expiring soon but not yet expired — auto-refresh failed; caller may proceed with current token.
  return { kind: 'unsupported', message: 'Auto-refresh failed; token still valid for now', creds };
}

module.exports = { readCredentials, expiresAtMs, isExpired, isExpiringSoon, refreshIfNeeded };
