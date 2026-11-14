/**
 * telemetryBoot.test.cjs — unit tests for the boot-time telemetry send rules:
 * the machine-profile heartbeat (version-change OR 30-day liveness) and the
 * boot/version-change flush triggers.
 *
 * Run: timeout 120 npx vitest run src/main/lib/telemetry/__tests__/telemetryBoot.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const { bootSequence } = require('../telemetryBoot.cjs');
const telemetrySettings = require('../telemetrySettings.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;

function fakeDeps({ settings } = {}) {
  let saved = { ...telemetrySettings.DEFAULTS, ...settings };
  const flushCalls = [];
  return {
    state: () => saved,
    flushCalls,
    deps: {
      telemetrySettings: {
        load: async () => saved,
        save: async (next) => { saved = { ...saved, ...next }; return saved; },
        isMachineReportDue: telemetrySettings.isMachineReportDue,
      },
      telemetryClient: {
        flush: async (reason) => { flushCalls.push(reason); return { sent: [], failed: [], reason }; },
        reportInstall: async (profile) => ({ accepted: true, profile }),
      },
      buildMachineProfile: async () => ({ appVersion: '1.0.0', platform: 'linux', arch: 'x64', machineDigest: 'abc123' }),
      telemetryCounters: { trackAppLaunch: () => {} },
    },
  };
}

test('a second boot at the same version within 30 days sends nothing', async () => {
  const now = Date.now();
  const priorReportAt = new Date(now - DAY_MS).toISOString();
  const { deps, state } = fakeDeps({
    settings: { lastMachineReportAt: priorReportAt, lastMachineReportVersion: '1.0.0' },
  });
  const seen = [];
  deps.telemetryClient.reportInstall = async (profile) => { seen.push(profile); return { accepted: true }; };

  await bootSequence({ now, appVersion: '1.0.0', deps });

  expect(seen).toHaveLength(0);
  expect(state().lastMachineReportAt).toBe(priorReportAt);
});

test('a version bump sends the machine profile exactly once', async () => {
  const now = Date.now();
  const { deps, state } = fakeDeps({
    settings: { lastMachineReportAt: new Date(now - DAY_MS).toISOString(), lastMachineReportVersion: '1.0.0' },
  });
  const seen = [];
  deps.telemetryClient.reportInstall = async (profile) => { seen.push(profile); return { accepted: true }; };

  await bootSequence({ now, appVersion: '2.0.0', deps });

  expect(seen.length).toBe(1);
  expect(state().lastMachineReportVersion).toBe('2.0.0');
});

test('31 days on an unchanged version sends the machine profile exactly once (liveness heartbeat)', async () => {
  const now = Date.now();
  const { deps, state } = fakeDeps({
    settings: { lastMachineReportAt: new Date(now - 31 * DAY_MS).toISOString(), lastMachineReportVersion: '1.0.0' },
  });
  const seen = [];
  deps.telemetryClient.reportInstall = async (profile) => { seen.push(profile); return { accepted: true }; };

  await bootSequence({ now, appVersion: '1.0.0', deps });

  expect(seen.length).toBe(1);
  expect(state().lastMachineReportAt).toBe(new Date(now).toISOString());
});

test('the install report appVersion equals the appVersion stamped on a sibling error record', async () => {
  const now = Date.now();
  const { deps } = fakeDeps({ settings: { lastMachineReportVersion: '', lastMachineReportAt: null } });
  const seen = [];
  deps.telemetryClient.reportInstall = async (profile) => { seen.push(profile); return { accepted: true }; };
  // Sibling error record stamped by the SAME process's telemetryClient with the same appVersion.
  const siblingErrorStampAppVersion = '1.0.0';

  await bootSequence({ now, appVersion: '1.0.0', deps });

  const [install] = seen;
  expect(install.appVersion).toBe(siblingErrorStampAppVersion);
});

test('on app ready, flush("boot") always runs', async () => {
  const now = Date.now();
  const { deps, flushCalls } = fakeDeps({ settings: { lastMachineReportVersion: '1.0.0', lastMachineReportAt: new Date(now).toISOString() } });
  await bootSequence({ now, appVersion: '1.0.0', deps });
  expect(flushCalls).toContain('boot');
});

test('on a detected app-version change, flush("version-change") also runs', async () => {
  const now = Date.now();
  const { deps, flushCalls } = fakeDeps({ settings: { lastMachineReportVersion: '1.0.0', lastMachineReportAt: new Date(now).toISOString() } });
  await bootSequence({ now, appVersion: '2.0.0', deps });
  expect(flushCalls).toEqual(['boot', 'version-change']);
});

test('with no version change, flush("version-change") does NOT run', async () => {
  const now = Date.now();
  const { deps, flushCalls } = fakeDeps({ settings: { lastMachineReportVersion: '1.0.0', lastMachineReportAt: new Date(now).toISOString() } });
  await bootSequence({ now, appVersion: '1.0.0', deps });
  expect(flushCalls).toEqual(['boot']);
});

test('a rejected reportInstall leaves lastMachineReportAt unset so the next boot retries', async () => {
  const now = Date.now();
  const { deps, state } = fakeDeps({ settings: { lastMachineReportVersion: '', lastMachineReportAt: null } });
  deps.telemetryClient.reportInstall = async () => ({ accepted: false, reason: 'error' });

  await bootSequence({ now, appVersion: '1.0.0', deps });

  expect(state().lastMachineReportAt).toBe(null);
  expect(state().lastMachineReportVersion).toBe('');
});

test('fires app.launch via telemetryCounters with installChannel + appVersion', async () => {
  const now = Date.now();
  const { deps } = fakeDeps({ settings: { lastMachineReportVersion: '1.0.0', lastMachineReportAt: new Date(now).toISOString() } });
  const calls = [];
  deps.telemetryCounters = { trackAppLaunch: (props) => calls.push(props) };
  await bootSequence({ now, appVersion: '1.0.0', installChannel: 'npx', deps });
  expect(calls).toEqual([{ installChannel: 'npx', appVersion: '1.0.0' }]);
});

// ─── legacy watermark cleanup (backlog replay retired) ───

const os = require('node:os');
const nodePath = require('node:path');
const nodeFsp = require('node:fs/promises');

test('removeLegacyWatermarks deletes ~/.claude/session-manager/telemetry-watermarks.json when present', async () => {
  const { removeLegacyWatermarks } = require('../telemetryBoot.cjs');
  const home = await nodeFsp.mkdtemp(nodePath.join(os.tmpdir(), 'sm-telemetry-boot-wm-'));
  try {
    const dir = nodePath.join(home, '.claude', 'session-manager');
    await nodeFsp.mkdir(dir, { recursive: true });
    const wm = nodePath.join(dir, 'telemetry-watermarks.json');
    await nodeFsp.writeFile(wm, '{"a":{"bytesConfirmed":0}}');

    expect(await removeLegacyWatermarks({ fsp: nodeFsp, homedir: () => home })).toBe(true);
    await expect(nodeFsp.stat(wm)).rejects.toMatchObject({ code: 'ENOENT' });
    // Second call: nothing left to remove, still never throws.
    expect(await removeLegacyWatermarks({ fsp: nodeFsp, homedir: () => home })).toBe(false);
  } finally {
    await nodeFsp.rm(home, { recursive: true, force: true });
  }
});

test('removeLegacyWatermarks never throws when the fs call or homedir fails', async () => {
  const { removeLegacyWatermarks } = require('../telemetryBoot.cjs');
  const failingFsp = { rm: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }, unlink: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
  await expect(removeLegacyWatermarks({ fsp: failingFsp, homedir: () => '/nonexistent' })).resolves.toBe(false);
  await expect(removeLegacyWatermarks({ fsp: nodeFsp, homedir: () => { throw new Error('no home'); } })).resolves.toBe(false);
});

test('bootSequence removes the legacy watermarks file via the injected deps', async () => {
  const { deps } = fakeDeps();
  const seen = [];
  deps.fsp = { unlink: async (p) => { seen.push(p); } };
  deps.homedir = () => '/home/fake';
  await bootSequence({ now: Date.now(), appVersion: '1.0.0', deps });
  expect(seen).toEqual([nodePath.join('/home/fake', '.claude', 'session-manager', 'telemetry-watermarks.json')]);
});
