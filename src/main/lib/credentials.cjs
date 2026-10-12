'use strict';

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { cleanChildEnv, pathWithUserBins } = require('./process/cleanEnv.cjs');
const { resolveClaudeBin, claudeSpawnTarget } = require('./claude/claudeBin.cjs');

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

const REFRESH_LOG_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'credential-refresh.log');
const REFRESH_LOG_MAX_BYTES = 100 * 1024;

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

/**
 * isRefreshFutile(creds) → boolean
 *
 * True when the token is already expired AND there is no refresh token to
 * present. In that state the refresh avenue is a dead end: the
 * `claude --version` CLI fallback performs its own silent OAuth refresh from
 * that SAME missing refresh token, so it cannot help either. The only recovery
 * is an out-of-band `claude login` — which refreshIfNeeded picks up on its very
 * next call via the isExpiringSoon early-return, since fresh creds never reach
 * this path. Left ungated, this state made pollLoop spawn a `claude --version`
 * process and write the cli_fallback_ok →
 * auth_failed_expired triple on EVERY 15 s poll, forever (observed 2026-09-23:
 * expiredAtMs 1775277875159, identical triple every ~15 min across the log).
 */
function isRefreshFutile(creds) {
  return isExpired(creds) && !creds.refreshToken;
}

// Throttle for the futile-refresh state above: once seen, don't respawn the
// CLI fallback or re-log the auth triple on every poll. Re-probe at most once
// per this window (an external `claude login` is still caught immediately by
// refreshIfNeeded's isExpiringSoon early-return, and by the cheap re-read
// below — neither needs the storm). Mirrors loadGate.cjs's AUDIT_INTERVAL_MS.
const FUTILE_REFRESH_COOLDOWN_MS = 15 * 60_000;
let lastFutileRefreshLoggedAt = null;

/** Test-only: reset the futile-refresh throttle so each test starts clean. */
function __resetFutileRefreshThrottle() {
  lastFutileRefreshLoggedAt = null;
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

// Sole refresh avenue: spawning `claude --version` triggers silent token refresh in the CLI binary.
function tryCliFallback() {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };
    const timer = setTimeout(() => settle({ ok: false, reason: 'timeout' }), 15_000);
    let child;
    try {
      // Resolve the absolute binary + inject Homebrew/user bins so this works
      // even when Electron launched from Finder/Dock with a stripped PATH (mac).
      const target = claudeSpawnTarget('aux', 'credcheck');
      child = spawn(target.command, ['--version'], {
        ...(target.argv0 ? { argv0: target.argv0 } : {}),
        stdio: 'ignore',
        env: cleanChildEnv({ PATH: pathWithUserBins() }),
      });
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
  const { creds } = cr;

  if (!forceRefresh && !isExpiringSoon(creds)) {
    return { kind: 'ok', creds };
  }

  const alreadyExpired = isExpired(creds);

  // Futile-refresh short-circuit: token already expired AND no refresh token
  // to present. The `claude --version` CLI fallback is a guaranteed dead end
  // from the same missing token, so running it on every 15 s poll only spawns
  // a doomed child process and re-logs the
  // same triple forever (2026-09-23 storm). Re-read once — cheap, and the ONE
  // real recovery (`claude login`) lands here — then, if still futile, return
  // the auth verdict WITHOUT the CLI-fallback spawn, logging
  // at most once per FUTILE_REFRESH_COOLDOWN_MS instead of every poll.
  if (isRefreshFutile(creds)) {
    const recheckCr = await readCredentials();
    if (recheckCr.kind === 'ok' && !isRefreshFutile(recheckCr.creds) && !isExpired(recheckCr.creds)) {
      appendRefreshLog({ event: 'externally_refreshed_ok', recheckExpiresAt: recheckCr.creds.expiresAt ?? null });
      lastFutileRefreshLoggedAt = null;
      return { kind: 'ok', creds: recheckCr.creds };
    }
    const nowMs = Date.now();
    if (lastFutileRefreshLoggedAt === null || nowMs - lastFutileRefreshLoggedAt >= FUTILE_REFRESH_COOLDOWN_MS) {
      lastFutileRefreshLoggedAt = nowMs;
      appendRefreshLog({ event: 'auth_failed_expired_no_refresh_token', expiredAtMs: expiresAtMs(creds) });
    }
    return {
      kind: 'auth',
      message: 'Credentials expired and cannot be auto-refreshed (no refresh token). Run `claude` in a terminal to log in.',
      expiredAt: expiresAtMs(creds),
    };
  }

  // The CLI owns the real refresh contract: `claude --version` refreshes silently.
  const cliResult = await tryCliFallback();
  appendRefreshLog({ event: cliResult.ok ? 'cli_fallback_ok' : 'cli_fallback_failed', reason: cliResult.reason ?? null });
  if (cliResult.ok) {
    const freshCr = await readCredentials();
    if (freshCr.kind === 'ok' && !isExpired(freshCr.creds)) {
      return { kind: 'ok', creds: freshCr.creds };
    }
  }

  if (alreadyExpired) {
    // Re-read from disk in case credentials were externally refreshed (e.g. via
    // `claude login`) between our initial read and the failed CLI fallback.
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
  isRefreshFutile,
  refreshIfNeeded,
  parseCredsRaw,
  __resetFutileRefreshThrottle,
  FUTILE_REFRESH_COOLDOWN_MS,
  KEYCHAIN_SERVICE,
  CREDS_PATH,
};
