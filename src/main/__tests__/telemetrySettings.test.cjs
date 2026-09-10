/**
 * telemetrySettings.test.cjs — unit tests for the telemetry consent/config store.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/telemetrySettings.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tmpDirs = [];
let originalHome;

beforeEach(() => {
  originalHome = process.env.HOME;
});

afterEach(async () => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  delete process.env.SM_TELEMETRY;
  delete process.env.SM_TELEMETRY_ENDPOINT;
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function freshModule(home) {
  process.env.HOME = home;
  const modPath = require.resolve('../lib/telemetrySettings.cjs');
  delete require.cache[modPath];
  delete require.cache[require.resolve('../config.cjs')];
  return require('../lib/telemetrySettings.cjs');
}

async function mkHome() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-telemetry-home-'));
  tmpDirs.push(dir);
  return dir;
}

test('DEFAULTS carries no identity-shaped key', async () => {
  const home = await mkHome();
  const telemetrySettings = await freshModule(home);
  const keys = Object.keys(telemetrySettings.DEFAULTS);
  const identityLike = keys.filter((k) => /email|user|name|host|account/i.test(k));
  expect(identityLike).toEqual([]);
});

test('isValid rejects a config carrying an unknown extra identity-shaped key', async () => {
  const home = await mkHome();
  const telemetrySettings = await freshModule(home);
  const base = { ...telemetrySettings.DEFAULTS, installId: 'abc' };
  expect(telemetrySettings.isValid(base)).toBe(true);
  const withExtra = { ...base, identifyEmail: 'someone@example.com' };
  expect(telemetrySettings.isValid(withExtra)).toBe(false);
});

test('load() mints installId once via crypto.randomUUID and persists it', async () => {
  const home = await mkHome();
  const telemetrySettings = await freshModule(home);

  const first = await telemetrySettings.load();
  expect(typeof first.installId).toBe('string');
  expect(first.installId.length).toBeGreaterThan(0);

  const second = await telemetrySettings.load();
  expect(second.installId).toBe(first.installId);

  const raw = JSON.parse(fs.readFileSync(telemetrySettings.storePath(), 'utf8'));
  expect(raw.installId).toBe(first.installId);

  const freshRead = await freshModule(home);
  const third = await freshRead.load();
  expect(third.installId).toBe(first.installId);
});

test('isEnabled: hard kill switch SM_TELEMETRY=0 overrides persisted enabled:true', async () => {
  const home = await mkHome();
  const telemetrySettings = await freshModule(home);
  const cfg = { ...telemetrySettings.DEFAULTS, installId: 'x', enabled: true };
  process.env.SM_TELEMETRY = '0';
  expect(telemetrySettings.isEnabled(cfg)).toBe(false);
});

test('isEnabled: returns false when persisted enabled is false', async () => {
  const home = await mkHome();
  const telemetrySettings = await freshModule(home);
  const cfg = { ...telemetrySettings.DEFAULTS, installId: 'x', enabled: false };
  expect(telemetrySettings.isEnabled(cfg)).toBe(false);
});

test('isEnabled: returns true when persisted enabled is true and no kill switch', async () => {
  const home = await mkHome();
  const telemetrySettings = await freshModule(home);
  const cfg = { ...telemetrySettings.DEFAULTS, installId: 'x', enabled: true };
  expect(telemetrySettings.isEnabled(cfg)).toBe(true);
});

test('resolveEndpoint prefers SM_TELEMETRY_ENDPOINT over persisted endpoint', async () => {
  const home = await mkHome();
  const telemetrySettings = await freshModule(home);
  const cfg = { ...telemetrySettings.DEFAULTS, installId: 'x', endpoint: 'https://persisted.example' };
  process.env.SM_TELEMETRY_ENDPOINT = 'https://env-override.example';
  expect(telemetrySettings.resolveEndpoint(cfg)).toBe('https://env-override.example');
});

test('resolveEndpoint falls back to persisted endpoint when no env override', async () => {
  const home = await mkHome();
  const telemetrySettings = await freshModule(home);
  const cfg = { ...telemetrySettings.DEFAULTS, installId: 'x', endpoint: 'https://persisted.example' };
  expect(telemetrySettings.resolveEndpoint(cfg)).toBe('https://persisted.example');
});

test('isDailyFlushDue: true when lastDailyFlushAt is null', async () => {
  const home = await mkHome();
  const telemetrySettings = await freshModule(home);
  const cfg = { ...telemetrySettings.DEFAULTS, installId: 'x', lastDailyFlushAt: null };
  expect(telemetrySettings.isDailyFlushDue(cfg, Date.now())).toBe(true);
});

test('isDailyFlushDue: false when lastDailyFlushAt is 23h before now', async () => {
  const home = await mkHome();
  const telemetrySettings = await freshModule(home);
  const now = Date.now();
  const cfg = { ...telemetrySettings.DEFAULTS, installId: 'x', lastDailyFlushAt: new Date(now - 23 * 60 * 60 * 1000).toISOString() };
  expect(telemetrySettings.isDailyFlushDue(cfg, now)).toBe(false);
});

test('isDailyFlushDue: true when lastDailyFlushAt is 25h before now', async () => {
  const home = await mkHome();
  const telemetrySettings = await freshModule(home);
  const now = Date.now();
  const cfg = { ...telemetrySettings.DEFAULTS, installId: 'x', lastDailyFlushAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() };
  expect(telemetrySettings.isDailyFlushDue(cfg, now)).toBe(true);
});

test('isMachineReportDue: true when app version changed', async () => {
  const home = await mkHome();
  const telemetrySettings = await freshModule(home);
  const now = Date.now();
  const cfg = {
    ...telemetrySettings.DEFAULTS,
    installId: 'x',
    lastMachineReportVersion: '0.80.0',
    lastMachineReportAt: new Date(now).toISOString(),
  };
  expect(telemetrySettings.isMachineReportDue(cfg, { now, appVersion: '0.81.0' })).toBe(true);
});

test('isMachineReportDue: true when lastMachineReportAt is null (same version)', async () => {
  const home = await mkHome();
  const telemetrySettings = await freshModule(home);
  const now = Date.now();
  const cfg = { ...telemetrySettings.DEFAULTS, installId: 'x', lastMachineReportVersion: '0.81.0', lastMachineReportAt: null };
  expect(telemetrySettings.isMachineReportDue(cfg, { now, appVersion: '0.81.0' })).toBe(true);
});

test('isMachineReportDue: true when lastMachineReportAt is more than 30 days before now (same version)', async () => {
  const home = await mkHome();
  const telemetrySettings = await freshModule(home);
  const now = Date.now();
  const thirtyOneDaysAgo = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
  const cfg = { ...telemetrySettings.DEFAULTS, installId: 'x', lastMachineReportVersion: '0.81.0', lastMachineReportAt: thirtyOneDaysAgo };
  expect(telemetrySettings.isMachineReportDue(cfg, { now, appVersion: '0.81.0' })).toBe(true);
});

test('isMachineReportDue: false when same version and reported less than 30 days ago', async () => {
  const home = await mkHome();
  const telemetrySettings = await freshModule(home);
  const now = Date.now();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const cfg = { ...telemetrySettings.DEFAULTS, installId: 'x', lastMachineReportVersion: '0.81.0', lastMachineReportAt: oneDayAgo };
  expect(telemetrySettings.isMachineReportDue(cfg, { now, appVersion: '0.81.0' })).toBe(false);
});
