/**
 * telemetryClient-optout.test.cjs — a consent change takes effect on the LIVE
 * client immediately (PRD 3067). Before the fix the client cached settings at
 * init, so after Turn off track() was still accepted and flush() still sent.
 *
 * Run: timeout 300 npx vitest run src/main/lib/telemetry/__tests__/telemetryClient-optout.test.cjs
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

async function freshModules() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-telemetry-optout-home-'));
  tmpDirs.push(home);
  process.env.HOME = home;
  // Setting the spool explicitly disables the test-environment no-op guard.
  process.env.SM_TELEMETRY_SPOOL = path.join(home, '.claude', 'session-manager');
  for (const p of ['../telemetryConsent.cjs', '../telemetryClient.cjs', '../telemetrySettings.cjs', '../../machineProfile.cjs', '../../../config.cjs']) {
    delete require.cache[require.resolve(p)];
  }
  const telemetryConsent = require('../telemetryConsent.cjs');
  const telemetrySettings = require('../telemetrySettings.cjs');
  const telemetryClient = require('../telemetryClient.cjs');
  telemetryClient._setMachineProfileBuilder(async () => ({
    appVersion: '0.83.0', platform: 'linux', arch: 'x64', machineDigest: 'abc123', installChannel: 'dev',
  }));
  const calls = [];
  telemetryClient._setFetchImpl(async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  });
  return { telemetryConsent, telemetrySettings, telemetryClient, calls };
}

test('exports applySettings', async () => {
  const { telemetryClient } = await freshModules();
  expect(typeof telemetryClient.applySettings).toBe('function');
  telemetryClient.shutdown();
});

test('opt-out on an already-initialized client stops ingest and egress at once; re-enable resumes', async () => {
  const { telemetryConsent, telemetryClient, calls } = await freshModules();
  await telemetryConsent.applyConsentUpdate({ enabled: true });

  // Initialize the live client while enabled (the cached-settings case).
  const first = await telemetryClient.track('before.optout', { a: 1 });
  expect(first.accepted).toBe(true);

  await telemetryConsent.applyConsentUpdate({ enabled: false });

  expect(await telemetryClient.track('after.optout', { a: 2 })).toEqual({ accepted: false, reason: 'disabled' });
  expect(await telemetryClient.logLine({ level: 'info', msg: 'x' })).toEqual({ accepted: false, reason: 'disabled' });
  expect(await telemetryClient.reportError({ name: 'E', msg: 'm', stack: 'E\n    at f (x.js:1:1)' }))
    .toEqual({ accepted: false, reason: 'disabled' });
  expect(await telemetryClient.reportInstall({ appVersion: '0.83.0', platform: 'linux' }))
    .toEqual({ accepted: false, reason: 'disabled' });

  await telemetryClient.flush('manual');
  expect(calls.length).toBe(0);

  await telemetryConsent.applyConsentUpdate({ enabled: true });
  const resumed = await telemetryClient.track('after.reenable', { a: 3 });
  expect(resumed.accepted).toBe(true);

  const res = await telemetryClient.flush('manual');
  expect(calls.length).toBeGreaterThan(0);
  expect(res.sent).toContain(resumed.recordId);
  expect(res.sent).not.toContain(first.recordId); // cleared on opt-out, never resent
  telemetryClient.shutdown();
});

test('opt-out mid-flush stops further batch sends', async () => {
  const { telemetryConsent, telemetryClient, calls } = await freshModules();
  await telemetryConsent.applyConsentUpdate({ enabled: true });
  expect((await telemetryClient.track('e1', {})).accepted).toBe(true);
  expect((await telemetryClient.logLine({ level: 'info', msg: 'l1' })).accepted).toBe(true);
  telemetryClient._setFetchImpl(async (url) => {
    calls.push({ url });
    // Opt out while the first batch is in flight.
    if (calls.length === 1) telemetryClient.applySettings?.({ ...(await readCfg()), enabled: false });
    return { ok: true, status: 200 };
  });
  async function readCfg() {
    return require('../telemetrySettings.cjs').load();
  }
  await telemetryClient.flush('manual');
  expect(calls.length).toBe(1);
  telemetryClient.shutdown();
});
