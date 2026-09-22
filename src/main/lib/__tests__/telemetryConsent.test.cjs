/**
 * telemetryConsent.test.cjs — unit tests for the telemetry:set-config
 * handler's write path (PRD 1142).
 *
 * Run: timeout 300 npx vitest run src/main/lib/__tests__/telemetryConsent.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tmpDirs = [];
let originalHome;
let originalSmTelemetrySpool;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalSmTelemetrySpool = process.env.SM_TELEMETRY_SPOOL;
});

afterEach(async () => {
  if (originalHome !== undefined) process.env.HOME = originalHome; else delete process.env.HOME;
  if (originalSmTelemetrySpool === undefined) delete process.env.SM_TELEMETRY_SPOOL; else process.env.SM_TELEMETRY_SPOOL = originalSmTelemetrySpool;
  vi.unstubAllGlobals();
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkHome() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-telemetry-consent-home-'));
  tmpDirs.push(dir);
  return dir;
}

function freshModules(home) {
  process.env.HOME = home;
  // Explicit opt-in: overrides the test-environment no-op guard so this
  // suite's real telemetryClient calls actually persist into an isolated dir.
  process.env.SM_TELEMETRY_SPOOL = path.join(home, '.claude', 'session-manager');
  for (const p of ['../telemetryConsent.cjs', '../telemetryClient.cjs', '../telemetrySettings.cjs', '../machineProfile.cjs', '../../config.cjs']) {
    const resolved = require.resolve(p);
    delete require.cache[resolved];
  }
  const telemetryConsent = require('../telemetryConsent.cjs');
  const telemetrySettings = require('../telemetrySettings.cjs');
  const telemetryClient = require('../telemetryClient.cjs');
  telemetryClient._setMachineProfileBuilder(async () => ({
    appVersion: '0.83.0', platform: 'linux', arch: 'x64', machineDigest: 'abc123', installChannel: 'dev',
  }));
  return { telemetryConsent, telemetrySettings, telemetryClient };
}

test('turning telemetry off persists enabled:false and telemetrySettings.isEnabled() reflects it', async () => {
  const home = await mkHome();
  const { telemetryConsent, telemetrySettings } = freshModules(home);
  const cfg = await telemetrySettings.load();
  expect(cfg.enabled).toBe(true);

  const saved = await telemetryConsent.applyConsentUpdate({ ...cfg, enabled: false });
  expect(saved.enabled).toBe(false);
  expect(telemetrySettings.isEnabled(saved)).toBe(false);
});

test('after turning off, telemetryClient drops subsequent records at ingress', async () => {
  const home = await mkHome();
  const { telemetryConsent, telemetrySettings, telemetryClient } = freshModules(home);
  const cfg = await telemetrySettings.load();
  await telemetryConsent.applyConsentUpdate({ ...cfg, enabled: false });

  const res = await telemetryClient.track('some.event', { a: 1 });
  expect(res).toEqual({ accepted: false, reason: 'disabled' });
  telemetryClient.shutdown();
});

test('turning off clears the pending queue file so a re-enable never resends it', async () => {
  const home = await mkHome();
  const { telemetryConsent, telemetrySettings, telemetryClient } = freshModules(home);

  // Accumulate a record while still enabled.
  const accepted = await telemetryClient.reportError({ name: 'BoomError', msg: 'kaboom', stack: 'at x' });
  expect(accepted.accepted).toBe(true);
  const beforeQueue = await fsp.readFile(telemetryClient.queuePath(), 'utf8');
  expect(beforeQueue.trim().length).toBeGreaterThan(0);

  const cfg = await telemetrySettings.load();
  await telemetryConsent.applyConsentUpdate({ ...cfg, enabled: false });

  const afterQueue = await fsp.readFile(telemetryClient.queuePath(), 'utf8');
  expect(afterQueue.trim()).toBe('');
  telemetryClient.shutdown();
});

test('turning off does NOT clear telemetry-sent.json or the watermarks — re-enabling later does not resend delivered history', async () => {
  const home = await mkHome();
  const { telemetryConsent, telemetrySettings, telemetryClient } = freshModules(home);

  telemetryClient._setFetchImpl(async () => ({ ok: true, status: 200 }));
  await telemetryClient.reportError({ name: 'SentError', msg: 'already delivered', stack: 'at y' });
  await telemetryClient.flush('manual');
  const sentPathContent = await fsp.readFile(telemetryClient.sentPath(), 'utf8');
  expect(JSON.parse(sentPathContent).ids.length).toBeGreaterThan(0);

  // Also seed a watermarks file to prove opt-out leaves it untouched.
  const watermarksDir = path.join(home, '.claude', 'session-manager');
  await fsp.mkdir(watermarksDir, { recursive: true });
  const watermarksPath = path.join(watermarksDir, 'telemetry-watermarks.json');
  const watermarksBefore = { 'abc123/errors-2026-01-01.jsonl': { bytesEnqueued: 100, bytesConfirmed: 100 } };
  await fsp.writeFile(watermarksPath, JSON.stringify(watermarksBefore));

  const cfg = await telemetrySettings.load();
  await telemetryConsent.applyConsentUpdate({ ...cfg, enabled: false });

  const sentAfter = await fsp.readFile(telemetryClient.sentPath(), 'utf8');
  expect(sentAfter).toBe(sentPathContent);
  const watermarksAfter = await fsp.readFile(watermarksPath, 'utf8');
  expect(JSON.parse(watermarksAfter)).toEqual(watermarksBefore);
  telemetryClient.shutdown();
});

test('turning telemetry on (already enabled) is a no-op on the queue', async () => {
  const home = await mkHome();
  const { telemetryConsent, telemetrySettings, telemetryClient } = freshModules(home);
  await telemetryClient.reportError({ name: 'KeptError', msg: 'still queued', stack: 'at z' });
  const before = await fsp.readFile(telemetryClient.queuePath(), 'utf8');

  const cfg = await telemetrySettings.load();
  await telemetryConsent.applyConsentUpdate({ ...cfg, enabled: true });

  const after = await fsp.readFile(telemetryClient.queuePath(), 'utf8');
  expect(after).toBe(before);
  telemetryClient.shutdown();
});
