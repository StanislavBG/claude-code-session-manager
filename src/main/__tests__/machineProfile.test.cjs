/**
 * machineProfile.test.cjs — unit tests for buildMachineProfile().
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/machineProfile.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const os = require('node:os');
const { buildMachineProfile, computeMachineDigest, resolveInstallChannel, resolveEnv } = require('../lib/machineProfile.cjs');

function fakeOs(overrides = {}) {
  return {
    platform: () => overrides.platform ?? 'linux',
    release: () => overrides.release ?? '6.1.0',
    arch: () => overrides.arch ?? 'x64',
    cpus: () => overrides.cpus ?? [{ model: '  Fancy CPU  ', speed: 3200 }],
    totalmem: () => overrides.totalmem ?? 16 * 1024 * 1024 * 1024,
  };
}

const stubProbeNull = async () => null;

test('buildMachineProfile returns only the specified fields', async () => {
  const profile = await buildMachineProfile({ osModule: fakeOs(), probeClaudeVersion: stubProbeNull, electronApp: null });
  const expectedKeys = [
    'appVersion', 'installChannel', 'machineDigest', 'platform', 'osRelease', 'arch',
    'cpuModel', 'cpuCount', 'cpuSpeedMhz', 'totalMemMb', 'nodeVersion', 'electronVersion',
    'chromeVersion', 'v8Version', 'claudeCliVersion', 'locale', 'timezoneOffsetMinutes', 'firstSeenAt',
  ].sort();
  expect(Object.keys(profile).sort()).toEqual(expectedKeys);
});

test('specs come from the injected os module; cpuModel is trimmed', async () => {
  const profile = await buildMachineProfile({ osModule: fakeOs(), probeClaudeVersion: stubProbeNull, electronApp: null });
  expect(profile.platform).toBe('linux');
  expect(profile.osRelease).toBe('6.1.0');
  expect(profile.arch).toBe('x64');
  expect(profile.cpuModel).toBe('Fancy CPU');
  expect(profile.cpuSpeedMhz).toBe(3200);
  expect(profile.cpuCount).toBe(1);
  expect(profile.totalMemMb).toBe(16384);
});

test('cpuModel/cpuSpeedMhz are null-safe when os.cpus() is empty (containers)', async () => {
  const profile = await buildMachineProfile({ osModule: fakeOs({ cpus: [] }), probeClaudeVersion: stubProbeNull, electronApp: null });
  expect(profile.cpuModel).toBeNull();
  expect(profile.cpuSpeedMhz).toBeNull();
  expect(profile.cpuCount).toBe(0);
});

test('machineDigest: identical specs produce an identical digest', async () => {
  const p1 = await buildMachineProfile({ osModule: fakeOs(), probeClaudeVersion: stubProbeNull, electronApp: null });
  const p2 = await buildMachineProfile({ osModule: fakeOs(), probeClaudeVersion: stubProbeNull, electronApp: null });
  expect(p1.machineDigest).toBe(p2.machineDigest);
  expect(p1.machineDigest).toMatch(/^[0-9a-f]{12}$/);
});

test('machineDigest: a changed cpuCount produces a different digest', async () => {
  const base = await buildMachineProfile({ osModule: fakeOs(), probeClaudeVersion: stubProbeNull, electronApp: null });
  const changed = await buildMachineProfile({
    osModule: fakeOs({ cpus: [{ model: 'Fancy CPU', speed: 3200 }, { model: 'Fancy CPU', speed: 3200 }] }),
    probeClaudeVersion: stubProbeNull,
    electronApp: null,
  });
  expect(changed.machineDigest).not.toBe(base.machineDigest);
});

test('computeMachineDigest is derived from specs only, never installId/hostname/etc', () => {
  const specs = { platform: 'linux', osRelease: '6.1.0', arch: 'x64', cpuModel: 'Fancy CPU', cpuCount: 1, totalMemMb: 16384 };
  const digest = computeMachineDigest(specs);
  expect(digest).toMatch(/^[0-9a-f]{12}$/);
});

test('timezoneOffsetMinutes is a number, and no field matches an IANA zone pattern', async () => {
  const profile = await buildMachineProfile({ osModule: fakeOs(), probeClaudeVersion: stubProbeNull, electronApp: null });
  expect(typeof profile.timezoneOffsetMinutes).toBe('number');
  for (const value of Object.values(profile)) {
    if (typeof value === 'string') {
      expect(value).not.toMatch(/^[A-Z][a-zA-Z_]+\/[A-Z][a-zA-Z_]+$/);
    }
  }
});

test('no PII: no field contains hostname, homedir, or OS username', async () => {
  const profile = await buildMachineProfile({ osModule: fakeOs(), probeClaudeVersion: stubProbeNull, electronApp: null });
  const hostname = os.hostname();
  const homedir = os.homedir();
  const username = os.userInfo().username;
  for (const value of Object.values(profile)) {
    if (typeof value === 'string' && value.length > 0) {
      expect(value).not.toContain(hostname);
      expect(value).not.toContain(homedir);
      expect(value).not.toContain(username);
    }
  }
});

test('loads and returns a profile under plain vitest with no Electron runtime (electronApp resolves null, falls back to package.json)', async () => {
  const profile = await buildMachineProfile({ osModule: fakeOs(), probeClaudeVersion: stubProbeNull, electronApp: null });
  expect(typeof profile.appVersion).toBe('string');
  expect(profile.appVersion.length).toBeGreaterThan(0);
});

test('appVersion resolves from electronApp.getVersion() when available', async () => {
  const fakeApp = { getVersion: () => '9.9.9-electron', getAppPath: () => '/opt/app' };
  const profile = await buildMachineProfile({ osModule: fakeOs(), probeClaudeVersion: stubProbeNull, electronApp: fakeApp });
  expect(profile.appVersion).toBe('9.9.9-electron');
});

test('appVersion falls back to package.json version when electron is unavailable', async () => {
  const profile = await buildMachineProfile({ osModule: fakeOs(), probeClaudeVersion: stubProbeNull, electronApp: null });
  const pkg = require('../../../package.json');
  expect(profile.appVersion).toBe(pkg.version);
});

test('claudeCliVersion is null and buildMachineProfile still returns promptly when the CLI is unavailable', async () => {
  const start = Date.now();
  const profile = await buildMachineProfile({ osModule: fakeOs(), probeClaudeVersion: stubProbeNull, electronApp: null });
  expect(profile.claudeCliVersion).toBeNull();
  expect(Date.now() - start).toBeLessThan(2000);
});

test('resolveInstallChannel: npx when app path is inside an npm/npx cache dir', () => {
  expect(resolveInstallChannel({ appPath: '/home/u/.npm/_npx/abc123/node_modules/foo', devFlag: false })).toBe('npx');
});

test('resolveInstallChannel: dev when SM_DEV flag is set, regardless of app path', () => {
  expect(resolveInstallChannel({ appPath: '/opt/some/app', devFlag: true })).toBe('dev');
});

test('resolveInstallChannel: unknown otherwise', () => {
  expect(resolveInstallChannel({ appPath: '/opt/some/app', devFlag: false })).toBe('unknown');
});

// ─── resolveEnv (wire-level env discriminator) ──────────────────────────

test('resolveEnv: test when running under a test runner, regardless of installChannel', () => {
  expect(resolveEnv({ isTestRunner: true, installChannel: 'dev' })).toBe('test');
  expect(resolveEnv({ isTestRunner: true, installChannel: 'npx' })).toBe('test');
  expect(resolveEnv({ isTestRunner: true, installChannel: 'unknown' })).toBe('test');
});

test('resolveEnv: dev when installChannel is dev and not under a test runner', () => {
  expect(resolveEnv({ isTestRunner: false, installChannel: 'dev' })).toBe('dev');
});

test('resolveEnv: prod for every other installChannel (npx, unknown) when not under a test runner', () => {
  expect(resolveEnv({ isTestRunner: false, installChannel: 'npx' })).toBe('prod');
  expect(resolveEnv({ isTestRunner: false, installChannel: 'unknown' })).toBe('prod');
  expect(resolveEnv({ isTestRunner: false, installChannel: undefined })).toBe('prod');
});
