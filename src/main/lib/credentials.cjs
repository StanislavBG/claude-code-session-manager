'use strict';

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { cleanChildEnv } = require('./cleanEnv.cjs');

const CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

// macOS stores Claude Code credentials in the login Keychain, not on disk —
// there is no ~/.claude/.credentials.json there. The Keychain item is a
// generic password under this service whose secret is the same JSON blob
// ({ claudeAiOauth: { accessToken, … } }) the Linux/WSL file holds.
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Read the raw credential JSON string from the macOS Keychain, or null. */
function readKeychainRaw() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const trimmed = out.trim();
    return trimmed.length ? trimmed : null;
  } catch {
    return null; // not found / locked — caller treats as "no creds here"
  }
}

/** Discover the account the Keychain item is stored under (for write-back). */
function keychainAccount() {
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const m = out.match(/"acct"<blob>="([^"]*)"/);
    if (m && m[1]) return m[1];
  } catch { /* fall through to login user */ }
  return os.userInfo().username;
}

/** Write the credential JSON back into the Keychain (-U upserts in place). */
function writeKeychainRaw(value) {
  execFileSync(
    'security',
    ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', keychainAccount(), '-w', value],
    { timeout: 10_000, stdio: 'ignore' },
  );
}
const REFRESH_LOG_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'credential-refresh.log');
const REFRESH_LOG_MAX_BYTES = 100 * 1024;

// Standard OAuth 2.0 refresh grant — endpoint discovered from Claude Code CLI behavior.
// Returns { kind: 'unsupported' } if the endpoint returns 404 or cannot be reached,
// allowing the caller to fall back gracefully.
const OAUTH_TOKEN_URL = 'https://claude.ai/api/auth/oauth/token';

/** Parse a raw credential JSON blob (from file or Keychain) into a result. */
function parseCredsRaw(raw, source) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { kind: 'config', message: `cannot parse ${source} credentials: ${e.message}` };
  }
  const oa = data?.claudeAiOauth;
  if (!oa?.accessToken) return { kind: 'config', message: `missing accessToken in ${source} credentials` };
  return { kind: 'ok', creds: oa, raw: data, source };
}

async function readCredentials() {
  // 1) File — Linux / WSL (and macOS in the rare case a file exists).
  try {
    const raw = await fsp.readFile(CREDS_PATH, 'utf8');
    return parseCredsRaw(raw, 'file');
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      return { kind: 'config', message: `cannot read credentials: ${e.message}` };
    }
    // ENOENT — fall through to the macOS Keychain before giving up.
  }

  // 2) macOS Keychain — the canonical store on darwin (no file there).
  if (process.platform === 'darwin') {
    const kc = readKeychainRaw();
    if (kc) return parseCredsRaw(kc, 'keychain');
    return {
      kind: 'config',
      message: `credentials not found (no ${CREDS_PATH}; no Keychain item "${KEYCHAIN_SERVICE}" — run \`claude\` to log in)`,
    };
  }

  return { kind: 'config', message: 'credentials file not found' };
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

async function writeCredentials(rawData, freshOauth, source = 'file') {
  const next = { ...rawData, claudeAiOauth: { ...rawData.claudeAiOauth, ...freshOauth } };
  if (source === 'keychain') {
    // macOS: upsert back into the Keychain. Sync + may throw — caller catches
    // and falls back to the `claude --version` CLI refresh path.
    writeKeychainRaw(JSON.stringify(next));
    return;
  }
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
  const { creds, raw, source } = cr;

  if (!forceRefresh && !isExpiringSoon(creds)) {
    return { kind: 'ok', creds };
  }

  const alreadyExpired = isExpired(creds);

  // Stretch: try OAuth refresh endpoint first.
  const oauthResult = await tryOAuthRefresh(creds);
  appendRefreshLog({ event: `oauth_refresh_${oauthResult.kind}`, message: oauthResult.message ?? null });

  if (oauthResult.kind === 'ok') {
    try {
      await writeCredentials(raw, oauthResult.fresh, source);
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

module.exports = {
  readCredentials,
  expiresAtMs,
  isExpired,
  isExpiringSoon,
  refreshIfNeeded,
  parseCredsRaw,
  KEYCHAIN_SERVICE,
  CREDS_PATH,
};
