/**
 * usage.cjs — fetches the user's plan usage (5h rolling, 7d rolling, per-model)
 * from the same endpoint Claude Code's `/usage` slash command uses.
 *
 * Auth: OAuth bearer token from ~/.claude/.credentials.json (written by
 * `claude login`). No separate API key required.
 *
 * Endpoint: GET https://api.anthropic.com/api/oauth/usage
 * Response shape:
 *   {
 *     five_hour: { utilization: number (0-100+), resets_at: ISO-8601 | null },
 *     seven_day: { utilization: number, resets_at: ISO-8601 | null },
 *     seven_day_sonnet: { utilization, resets_at } | null,
 *     seven_day_opus: { utilization, resets_at } | null,
 *     extra_usage: { is_enabled, monthly_limit, used_credits, utilization, currency }
 *   }
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ipcMain } = require('electron');
const { refreshIfNeeded, expiresAtMs } = require('./lib/credentials.cjs');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'billing-cache.json');

let cache = null;
let hydrationPromise = null;

async function hydrateCache() {
  try {
    cache = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
  } catch {
    cache = null;
  }
}

async function persistCache(c) {
  await fsp.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  const tmp = `${CACHE_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(c), { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmp, CACHE_PATH);
}

async function fetchUsage() {
  // Check expiry and attempt proactive refresh before touching the network.
  const refresh = await refreshIfNeeded();
  if (refresh.kind === 'auth') {
    return { kind: 'auth', message: refresh.message, httpStatus: 401, expiredAt: refresh.expiredAt ?? null };
  }
  if (refresh.kind === 'config') return refresh;
  // 'ok' or 'unsupported' — creds present and not yet expired
  const creds = refresh.creds;

  let r;
  try {
    r = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code-session-manager',
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { kind: 'transient', message: e.message || String(e), httpStatus: null };
  }
  if (r.status === 401 || r.status === 403) {
    const body = await r.text().catch(() => '');
    const ms = expiresAtMs(creds);
    return { kind: 'auth', message: body.slice(0, 200) || `HTTP ${r.status}`, httpStatus: r.status, expiredAt: ms };
  }
  if (r.status === 408 || r.status === 429 || r.status >= 500) {
    const body = await r.text().catch(() => '');
    return { kind: 'transient', message: body.slice(0, 200) || `HTTP ${r.status}`, httpStatus: r.status };
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return { kind: 'transient', message: body.slice(0, 200) || `HTTP ${r.status}`, httpStatus: r.status };
  }
  const usage = await r.json();
  return {
    kind: 'ok',
    data: {
      usage,
      subscriptionType: creds.subscriptionType ?? null,
      rateLimitTier: creds.rateLimitTier ?? null,
      credentialsExpiresAt: creds.expiresAt ?? null,
      fetchedAt: Date.now(),
    },
  };
}

function registerBillingHandlers() {
  hydrationPromise = hydrateCache();

  ipcMain.handle('billing:fetch', async () => {
    if (hydrationPromise) { await hydrationPromise; hydrationPromise = null; }

    const r = await fetchUsage();
    if (r.kind === 'ok') {
      cache = { data: r.data, fetchedAt: Date.now(), sourceCredsExpiresAt: r.data.credentialsExpiresAt };
      persistCache(cache).catch(() => {});
      return { kind: 'ok', data: r.data };
    }
    if (r.kind === 'auth') {
      if (cache) return { kind: 'auth', message: r.message, httpStatus: r.httpStatus, expiredAt: r.expiredAt, cached: cache.data, staleSince: cache.fetchedAt };
      return r;
    }
    if (r.kind === 'transient') {
      if (cache) return { kind: 'ok-stale', data: cache.data, staleSince: cache.fetchedAt, lastError: r.message };
      return r;
    }
    return r; // config
  });
}

module.exports = { registerBillingHandlers, fetchUsage };
