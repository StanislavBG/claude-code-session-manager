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

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ipcMain } = require('electron');
const { refreshIfNeeded, expiresAtMs } = require('./lib/credentials.cjs');
const { writeJson } = require('./config.cjs');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** A non-empty env value that isn't an explicit falsey string. */
function envEnabled(v) {
  return v != null && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false';
}

/**
 * Reads enterprise-auth signals from Claude Code's own settings files — the
 * `env` block and `apiKeyHelper`. This is where corporate gateways are usually
 * configured (a managed/enterprise policy or the user's settings.json), NOT as
 * exported shell vars. It matters most on macOS, where a GUI-launched app does
 * not inherit the shell's environment, so `process.env` looks like a clean
 * consumer install even when `claude` itself is talking to a gateway.
 *
 * Precedence mirrors Claude Code: managed (enterprise) settings, then user
 * settings, then user-local settings. Missing/unreadable/invalid files are
 * skipped. Returns `{ env, apiKeyHelper }`.
 */
function readClaudeSettingsAuth() {
  const merged = {};
  let apiKeyHelper = false;
  const managed = process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : '/etc/claude-code/managed-settings.json';
  const files = [
    managed,
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.local.json'),
  ];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (data && typeof data.env === 'object' && data.env) Object.assign(merged, data.env);
      if (data && data.apiKeyHelper) apiKeyHelper = true;
    } catch { /* missing / unreadable / invalid JSON → skip */ }
  }
  return { env: merged, apiKeyHelper };
}

/**
 * Is the consumer 5-hour usage meter (/api/oauth/usage) even applicable here?
 *
 * That endpoint only exists for OAuth/subscription auth against
 * api.anthropic.com. Enterprise auth modes have no such meter, so polling it
 * just 404s/times-out (or 401s with no credentials file) — and the scheduler
 * must NOT gate on (or pause for) it. Detected modes: Amazon Bedrock, Google
 * Vertex, raw API-key, a custom auth token, a non-Anthropic base URL (corporate
 * gateway/proxy), or an `apiKeyHelper` script.
 *
 * Signals are read from BOTH process.env and Claude Code's settings files, so a
 * gateway configured purely in settings.json (the common enterprise case) is
 * detected even when the GUI process inherited a clean environment.
 *
 * Returns false → caller should treat usage as unavailable-by-design and fire
 * work on its own (pending + memory) instead of waiting on a meter.
 */
function usageMeterApplicable(env = process.env, settings = readClaudeSettingsAuth()) {
  // Manual escape hatch: if detection misses an unusual gateway setup, the user
  // can force "no consumer meter" so the scheduler stops pausing on 'auth'.
  if (envEnabled(env.SM_NO_USAGE_METER)) return false;
  // An apiKeyHelper means `claude` mints its own key → non-OAuth, no meter.
  if (settings && settings.apiKeyHelper) return false;
  // Effective env: settings.json provides values the GUI process didn't
  // inherit; a real process.env var wins when both define the same key.
  const eff = { ...(settings && settings.env), ...env };
  if (envEnabled(eff.CLAUDE_CODE_USE_BEDROCK)) return false;
  if (envEnabled(eff.CLAUDE_CODE_USE_VERTEX)) return false;
  if (eff.ANTHROPIC_API_KEY) return false;
  if (eff.ANTHROPIC_AUTH_TOKEN) return false;
  if (eff.ANTHROPIC_BASE_URL) {
    // Parse the host rather than substring-match, so a deceptive gateway like
    // https://anthropic.com.attacker.example is correctly treated as enterprise.
    let host;
    try { host = new URL(eff.ANTHROPIC_BASE_URL).hostname.toLowerCase(); }
    catch { return false; } // unparseable custom URL → treat as a gateway
    if (host !== 'anthropic.com' && !host.endsWith('.anthropic.com')) return false;
  }
  return true;
}
const CACHE_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'billing-cache.json');
// Coalesce the 4 renderer pollers (Overview/AppStatusBar/StatusBar/Usage). A
// fresh ok-cache is served directly without touching the network. Auth/
// transient/config skip this TTL so they retry promptly on next poll.
const OK_CACHE_TTL_MS = 30_000;

/**
 * Pure: classify a raw HTTP response status + body from the usage endpoint into a
 * result kind. Exported for unit testing without needing to mock fetch or electron.
 *
 * Returns one of: 'ok' | 'auth' | 'transient' | 'meter_rate_limited'
 */
function classifyUsageResponse(status, bodyText) {
  if (status === 401 || status === 403) return { kind: 'auth', httpStatus: status };
  if (status === 429) {
    let parsed = null;
    try { parsed = JSON.parse(bodyText); } catch { /* */ }
    if (parsed?.error?.type === 'rate_limit_error') {
      return { kind: 'meter_rate_limited', message: bodyText.slice(0, 200), httpStatus: 429 };
    }
    return { kind: 'transient', message: bodyText.slice(0, 200) || 'HTTP 429', httpStatus: 429 };
  }
  if (status === 408 || status >= 500) return { kind: 'transient', httpStatus: status };
  if (!status || status >= 400) return { kind: 'transient', httpStatus: status };
  return { kind: 'ok' };
}

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
  await writeJson(CACHE_PATH, c);
}

async function fetchUsage() {
  // Test stub: SM_MOCK_BILLING_KIND lets e2e tests simulate billing API responses
  // without hitting the real endpoint. Only active when SM_E2E=1 to prevent
  // accidental use in production.
  if (process.env.SM_E2E === '1' && process.env.SM_MOCK_BILLING_KIND) {
    const kind = process.env.SM_MOCK_BILLING_KIND;
    if (kind === 'meter_rate_limited') return { kind: 'meter_rate_limited', message: 'e2e stub', httpStatus: 429 };
    if (kind === 'transient') return { kind: 'transient', message: 'e2e stub', httpStatus: 503 };
    if (kind === 'auth') return { kind: 'auth', message: 'e2e stub', httpStatus: 401 };
    // 'ok' stub returns a minimal valid payload.
    return { kind: 'ok', data: { usage: { five_hour: { utilization: 10, resets_at: null }, seven_day: { utilization: 10, resets_at: null }, seven_day_sonnet: null, seven_day_opus: null, extra_usage: null }, subscriptionType: null, rateLimitTier: null, credentialsExpiresAt: null, fetchedAt: Date.now() } };
  }

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
  if (r.status === 408 || r.status >= 500) {
    const body = await r.text().catch(() => '');
    return { kind: 'transient', message: body.slice(0, 200) || `HTTP ${r.status}`, httpStatus: r.status };
  }
  if (r.status === 429) {
    const body = await r.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* */ }
    if (parsed?.error?.type === 'rate_limit_error') {
      return { kind: 'meter_rate_limited', message: body.slice(0, 200), httpStatus: 429 };
    }
    return { kind: 'transient', message: body.slice(0, 200) || 'HTTP 429', httpStatus: 429 };
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

    if (cache && cache.fetchedAt && Date.now() - cache.fetchedAt < OK_CACHE_TTL_MS) {
      return { kind: 'ok', data: cache.data };
    }

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
    if (r.kind === 'meter_rate_limited') {
      if (cache) return { kind: 'meter_rate_limited', message: r.message, httpStatus: r.httpStatus, cached: cache.data, staleSince: cache.fetchedAt };
      return r;
    }
    return r; // config
  });
}

module.exports = { registerBillingHandlers, fetchUsage, classifyUsageResponse, usageMeterApplicable, readClaudeSettingsAuth };
