/**
 * telemetryClient-delivery.test.cjs — delivery semantics (PRD 3071):
 *  - track() wire carries ts captured at track time
 *  - flush sends channels error → install → log → event
 *  - a non-auth 4xx quarantines only that batch; 401/403 disable; 429 backs off
 *
 * Run: timeout 300 npx vitest run src/main/lib/telemetry/__tests__/telemetryClient-delivery.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tmpDirs = [];
const saved = {};
const ENV_KEYS = ['HOME', 'SM_TELEMETRY_SPOOL', 'SM_TELEMETRY', 'SM_TELEMETRY_ENDPOINT'];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.SM_TELEMETRY;
  delete process.env.SM_TELEMETRY_ENDPOINT;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

function channelOf(url) {
  return String(url).split('/api/telemetry/')[1];
}

/** statusFor(channel) → HTTP status the fake server answers with. */
async function freshClient(statusFor = () => 200) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-telemetry-delivery-home-'));
  tmpDirs.push(home);
  process.env.HOME = home;
  process.env.SM_TELEMETRY_SPOOL = path.join(home, '.claude', 'session-manager');
  for (const p of ['../telemetryConsent.cjs', '../telemetryClient.cjs', '../telemetrySettings.cjs', '../../machineProfile.cjs', '../../../config.cjs']) {
    delete require.cache[require.resolve(p)];
  }
  const telemetryConsent = require('../telemetryConsent.cjs');
  const client = require('../telemetryClient.cjs');
  client._setMachineProfileBuilder(async () => ({
    appVersion: '0.83.0', platform: 'linux', arch: 'x64', machineDigest: 'abc123', installChannel: 'dev',
  }));
  const calls = [];
  client._setFetchImpl(async (url, init) => {
    const channel = channelOf(url);
    calls.push({ channel, body: JSON.parse(init.body) });
    const status = statusFor(channel);
    return { ok: status >= 200 && status < 300, status };
  });
  const warns = [];
  client._setLogger((line) => warns.push(line));
  await telemetryConsent.applyConsentUpdate({ enabled: true });
  return { client, calls, warns };
}

async function enqueueAll(client) {
  const ev = await client.track('ev.one', { a: 1 });
  const log = await client.logLine({ level: 'info', msg: 'hello' });
  const err = await client.reportError({ name: 'E', msg: 'boom', stack: 'E\n    at f (x.js:1:1)' });
  const inst = await client.reportInstall({ appVersion: '0.83.0', platform: 'linux', arch: 'x64' });
  for (const r of [ev, log, err, inst]) expect(r.accepted).toBe(true);
  return { ev, log, err, inst };
}

test('track() wire carries ts captured at track time', async () => {
  const { client, calls } = await freshClient();
  const before = Date.now();
  const r = await client.track('ev.ts', { a: 1 });
  const after = Date.now();
  expect(r.accepted).toBe(true);
  await new Promise((res) => setTimeout(res, 15));
  await client.flush('manual');
  const evCall = calls.find((c) => c.channel === 'event');
  expect(evCall).toBeTruthy();
  const wire = evCall.body.batch[0];
  expect(typeof wire.ts).toBe('number');
  expect(wire.ts).toBeGreaterThanOrEqual(before);
  expect(wire.ts).toBeLessThanOrEqual(after);
  client.shutdown();
});

test('flush sends channels in order error, install, log, event', async () => {
  const { client, calls } = await freshClient();
  const ids = await enqueueAll(client);
  const res = await client.flush('manual');
  expect(calls.map((c) => c.channel)).toEqual(['error', 'install', 'log', 'event']);
  for (const r of Object.values(ids)) expect(res.sent).toContain(r.recordId);
  expect(client.status().pendingCount).toBe(0);
  client.shutdown();
});

test('a 400 quarantines only that batch and the flush continues', async () => {
  const { client, calls, warns } = await freshClient((ch) => (ch === 'error' ? 400 : 200));
  const ids = await enqueueAll(client);
  const res = await client.flush('manual');
  expect(calls.map((c) => c.channel)).toEqual(['error', 'install', 'log', 'event']);
  const st = client.status();
  expect(st.disabledForProcess).toBe(false);
  expect(st.rejectedCount).toBe(1);
  expect(st.pendingCount).toBe(0);
  expect(st.backoffUntil).toBe(0);
  expect(await client.isPending(ids.err.recordId)).toBe(false);
  expect(res.sent).not.toContain(ids.err.recordId);
  for (const k of ['ev', 'log', 'inst']) expect(res.sent).toContain(ids[k].recordId);
  expect(warns.some((w) => w.level === 'warn' && /reject/i.test(w.message))).toBe(true);

  // Not retried on the next flush.
  calls.length = 0;
  await client.flush('manual');
  expect(calls.length).toBe(0);
  client.shutdown();
});

for (const authStatus of [401, 403]) {
  test(`a ${authStatus} disables the client for the process and keeps the batch queued`, async () => {
    const { client, calls } = await freshClient((ch) => (ch === 'error' ? authStatus : 200));
    const ids = await enqueueAll(client);
    await client.flush('manual');
    expect(calls.map((c) => c.channel)).toEqual(['error']);
    const st = client.status();
    expect(st.disabledForProcess).toBe(true);
    expect(st.rejectedCount).toBe(0);
    expect(st.pendingCount).toBe(4);
    expect(await client.isPending(ids.err.recordId)).toBe(true);
    calls.length = 0;
    await client.flush('manual');
    expect(calls.length).toBe(0);
    client.shutdown();
  });
}

test('a 429 backs off and stops the flush, leaving everything queued', async () => {
  const { client, calls } = await freshClient((ch) => (ch === 'error' ? 429 : 200));
  const ids = await enqueueAll(client);
  const before = Date.now();
  await client.flush('manual');
  expect(calls.map((c) => c.channel)).toEqual(['error']);
  const st = client.status();
  expect(st.disabledForProcess).toBe(false);
  expect(st.consecutiveFailures).toBe(1);
  expect(st.backoffUntil).toBeGreaterThan(before);
  expect(st.rejectedCount).toBe(0);
  expect(st.pendingCount).toBe(4);
  expect(await client.isPending(ids.err.recordId)).toBe(true);
  calls.length = 0;
  await client.flush('manual');
  expect(calls.length).toBe(0); // still inside the backoff window
  client.shutdown();
});
