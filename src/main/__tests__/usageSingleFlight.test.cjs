/**
 * usageSingleFlight.test.cjs — usage.cjs's fetchUsage() is the single owner
 * of caching, single-flight de-duplication, and the shared usageCircuit for
 * the /api/oauth/usage meter. Before this, the renderer's billing:fetch IPC
 * handler owned the 30s OK-cache alone and the scheduler's pollLoop called
 * fetchUsage() directly with no cache/dedup — two independent request
 * streams against a rate-limiting endpoint, and a success on one path never
 * reset the other's failure streak. This suite proves: (1) concurrent
 * fetchUsage() callers coalesce into exactly one network fetch, (2) a
 * success resets the shared circuit's streak regardless of which "caller"
 * triggered the preceding failures, and (3) a 429's Retry-After suppresses
 * the next request until it elapses.
 *
 * Never hits the live billing endpoint — global.fetch is stubbed throughout,
 * and HOME is pointed at a scratch dir so no real credentials/cache file on
 * this machine is ever read.
 *
 * usage.cjs (and config.cjs/credentials.cjs, which it requires) are loaded
 * via Node's own require() — this is a .cjs test, not transformed ESM — so
 * vi.mock()/vi.resetModules() do NOT intercept them the way they would for
 * an ESM import graph; both also bake os.homedir() into module-level
 * constants at first require (config.cjs's allowedRoots/WRITE_PREFIXES,
 * usage.cjs's CACHE_PATH, credentials.cjs's CREDS_PATH). So this suite
 * follows historyRollup.test.cjs's pattern instead: swap $HOME to a fresh
 * tmp dir with a valid, far-from-expiry fake credentials file, purge
 * Node's require.cache for every affected module, and re-require fresh
 * each test.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/usageSingleFlight.test.cjs
 */

'use strict';

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  };
}

const usagePayload = { five_hour: { utilization: 10, resets_at: null }, seven_day: { utilization: 10, resets_at: null }, seven_day_sonnet: null, seven_day_opus: null, extra_usage: null };

const MODULES_TO_RELOAD = [
  '../usage.cjs',
  '../config.cjs',
  '../lib/credentials.cjs',
  '../lib/usageCircuit.cjs',
];

function purgeRequireCache() {
  for (const m of MODULES_TO_RELOAD) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
  }
}

let realHome;
let tmpHome;

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-single-flight-test-'));
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, '.claude', '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() + 1_000 * 60 * 60 * 24, // 24h out — never "expiring soon"
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    }),
  );
  purgeRequireCache();
});

afterEach(() => {
  process.env.HOME = realHome;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  purgeRequireCache();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('two concurrent fetchUsage() calls produce exactly one HTTP fetch', async () => {
  const { fetchUsage } = require('../usage.cjs');
  let fetchCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    fetchCalls++;
    // Slow enough that both callers are guaranteed to be in-flight together.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return jsonResponse(200, usagePayload);
  }));

  const [a, b] = await Promise.all([fetchUsage(), fetchUsage()]);

  expect(fetchCalls).toBe(1);
  expect(a.kind).toBe('ok');
  expect(b.kind).toBe('ok');
});

test('an ok result resets the shared circuit streak built up by prior failures', async () => {
  const usage = require('../usage.cjs');
  const circuit = usage.__usageCircuitForTest;

  let call = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    call++;
    if (call <= 3) return jsonResponse(500, { error: 'boom' });
    return jsonResponse(200, usagePayload);
  }));

  // Three consecutive transient failures — simulating the scheduler's poller
  // failing repeatedly — trip the circuit open.
  await usage.fetchUsage();
  await usage.fetchUsage();
  await usage.fetchUsage();
  expect(circuit.state()).toBe('open');

  // A later success — as if it came from the renderer's independent
  // billing:fetch call, but reached through the SAME shared fetchUsage() —
  // must reset the streak the scheduler's calls built up, since both
  // callers share one circuit instance.
  const ok = await usage.fetchUsage();
  expect(ok.kind).toBe('ok');
  expect(circuit.state()).toBe('closed');
});

test('a 429 with Retry-After suppresses the next request until it elapses', async () => {
  const usage = require('../usage.cjs');

  let fetchCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    fetchCalls++;
    return jsonResponse(429, { error: { type: 'rate_limit_error' } }, { 'retry-after': '60' });
  }));

  const first = await usage.fetchUsage();
  expect(first.kind).toBe('meter_rate_limited');
  expect(first.retryAfterMs).toBe(60_000);

  const second = await usage.fetchUsage();
  expect(second.kind).toBe('meter_rate_limited');
  expect(second.suppressed).toBe(true);
  // No second network call — the suppression window hasn't elapsed.
  expect(fetchCalls).toBe(1);
});
