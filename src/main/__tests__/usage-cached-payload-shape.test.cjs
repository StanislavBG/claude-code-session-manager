/**
 * usage-cached-payload-shape.test.cjs — fetchUsage's 429 result must carry the
 * INNER usage object as `cached` (not the { usage, subscriptionType, ... }
 * wrapper), so meterFailureBudget can read a binding window from it.
 * Uses the real wrapper shape on disk; only fetch is stubbed.
 */

'use strict';

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODULES_TO_RELOAD = [
  '../usage.cjs',
  '../config.cjs',
  '../lib/credentials.cjs',
  '../lib/claude/usageCircuit.cjs',
];

function purgeRequireCache() {
  for (const m of MODULES_TO_RELOAD) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
  }
}

const usagePayload = {
  five_hour: { utilization: 10, resets_at: null },
  seven_day: { utilization: 40, resets_at: null },
  limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 40, severity: 'normal', resets_at: null, scope: null, is_active: true },
  ],
  seven_day_sonnet: null,
  seven_day_opus: null,
  extra_usage: null,
};

let realHome;
let tmpHome;

function writeCache(fetchedAt, data) {
  const dir = path.join(tmpHome, '.claude', 'session-manager');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'billing-cache.json'), JSON.stringify({ data, fetchedAt, sourceCredsExpiresAt: null }));
}

function stub429() {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    status: 429,
    ok: false,
    headers: new Headers(),
    text: async () => JSON.stringify({ error: { type: 'rate_limit_error' } }),
    json: async () => ({ error: { type: 'rate_limit_error' } }),
  })));
}

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-cached-shape-test-'));
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, '.claude', '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() + 1_000 * 60 * 60 * 24,
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
  fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('429 result carries the inner usage object and satisfies meterFailureBudget', async () => {
  const fetchedAt = Date.now() - 5 * 60 * 1000;
  writeCache(fetchedAt, { usage: usagePayload, subscriptionType: null, rateLimitTier: null, credentialsExpiresAt: null, fetchedAt });
  stub429();

  const { fetchUsage } = require('../usage.cjs');
  const { meterFailureBudget } = require('../lib/claude/usageCircuit.cjs');
  const r = await fetchUsage();

  expect(r.kind).toBe('meter_rate_limited');
  expect(r.cached).toEqual(usagePayload);
  const budget = meterFailureBudget({ cachedPayload: r.cached, staleSinceMs: r.staleSince });
  expect(budget).not.toBeNull();
  expect(Number.isFinite(budget.utilization)).toBe(true);
  expect(budget.utilization).toBe(40);
  expect(budget.degraded).toBe(false);
});

test('a stale cache (>30 min) still yields null from meterFailureBudget', async () => {
  const fetchedAt = Date.now() - 45 * 60 * 1000;
  writeCache(fetchedAt, { usage: usagePayload, subscriptionType: null, rateLimitTier: null, credentialsExpiresAt: null, fetchedAt });
  stub429();

  const { fetchUsage } = require('../usage.cjs');
  const { meterFailureBudget } = require('../lib/claude/usageCircuit.cjs');
  const r = await fetchUsage();

  expect(meterFailureBudget({ cachedPayload: r.cached, staleSinceMs: r.staleSince })).toBeNull();
});

test('a cache with no usage object attaches nothing', async () => {
  const fetchedAt = Date.now() - 5 * 60 * 1000;
  writeCache(fetchedAt, { subscriptionType: null, fetchedAt });
  stub429();

  const { fetchUsage } = require('../usage.cjs');
  const r = await fetchUsage();

  expect(r.kind).toBe('meter_rate_limited');
  expect(r.cached).toBeUndefined();
});
