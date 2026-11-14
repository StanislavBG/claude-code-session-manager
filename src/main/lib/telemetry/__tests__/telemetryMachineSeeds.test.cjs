/**
 * telemetryMachineSeeds.test.cjs — install.machine profile carries seeder
 * outcomes as enum strings only; a getSeedStatus failure yields null.
 */
'use strict';

import { test, expect } from 'vitest';
const { bootSequence, buildSeeds } = require('../telemetryBoot.cjs');
const telemetrySettings = require('../telemetrySettings.cjs');

async function bootWith(getSeedStatus) {
  const reported = [];
  await bootSequence({
    now: Date.now(),
    appVersion: '9.9.9',
    installChannel: 'npm',
    deps: {
      telemetrySettings: {
        load: async () => ({ ...telemetrySettings.DEFAULTS }),
        save: async () => {},
        isMachineReportDue: telemetrySettings.isMachineReportDue,
      },
      telemetryClient: {
        flush: async () => ({}),
        reportInstall: async (p) => { reported.push(p); return { accepted: true }; },
      },
      buildMachineProfile: async () => ({ appVersion: '9.9.9', platform: 'linux' }),
      telemetryCounters: { trackAppLaunch: () => {} },
      getSeedStatus,
    },
  });
  return reported[0];
}

test('profile carries only enum strings, never fix text or paths', async () => {
  const profile = await bootWith(() => ({
    'dev-plugin': { status: 'done', fix: 'Open Plugins → Library' },
    'scheduler-mcp': { status: 'failed', fix: 'Run: claude mcp add x -- node /home/u/server.js' },
    'agent-personas': { status: 'pending', fix: 'Copy src/seed/agents/a.md into ~/.claude/agents/' },
  }));
  expect(profile.seeds).toEqual({ devPlugin: 'done', schedulerMcp: 'failed', agentPersonas: 'pending' });
  for (const v of Object.values(profile.seeds)) {
    expect(['done', 'pending', 'failed', 'exhausted']).toContain(v);
    expect(v).not.toContain('/');
  }
});

test('getSeedStatus failure yields seeds: null and the profile is still sent', async () => {
  const profile = await bootWith(() => { throw new Error('boom'); });
  expect(profile).toBeDefined();
  expect(profile.seeds).toBeNull();
  expect(buildSeeds(() => { throw new Error('x'); })).toBeNull();
});

// ── reportSeedsIfChanged: re-send the install record once seeding settles ──

const { reportSeedsIfChanged } = require('../telemetryBoot.cjs');

const DONE_STATUS = () => ({
  'dev-plugin': { status: 'done' },
  'scheduler-mcp': { status: 'done' },
  'agent-personas': { status: 'done' },
});

function seedsHarness({ lastSeedsReported = null, accepted = true } = {}) {
  const reported = [];
  const saved = [];
  const deps = {
    telemetrySettings: {
      load: async () => ({ ...telemetrySettings.DEFAULTS, lastSeedsReported }),
      save: async (patch) => { saved.push(patch); },
    },
    telemetryClient: {
      reportInstall: async (p) => { reported.push(p); return { accepted }; },
    },
    buildMachineProfile: async () => ({ appVersion: '9.9.9', platform: 'linux' }),
    getSeedStatus: DONE_STATUS,
  };
  return { deps, reported, saved };
}

test('reportSeedsIfChanged: changed seeds -> exactly one reportInstall, persisted', async () => {
  const pendingJson = JSON.stringify({ devPlugin: 'pending', schedulerMcp: 'pending', agentPersonas: 'pending' });
  const h = seedsHarness({ lastSeedsReported: pendingJson });
  await reportSeedsIfChanged({ deps: h.deps });
  expect(h.reported).toHaveLength(1);
  expect(h.reported[0].seeds).toEqual({ devPlugin: 'done', schedulerMcp: 'done', agentPersonas: 'done' });
  expect(h.reported[0].platform).toBe('linux');
  expect(h.saved).toEqual([{ lastSeedsReported: JSON.stringify({ devPlugin: 'done', schedulerMcp: 'done', agentPersonas: 'done' }) }]);
});

test('reportSeedsIfChanged: never-reported (null) counts as changed', async () => {
  const h = seedsHarness({ lastSeedsReported: null });
  await reportSeedsIfChanged({ deps: h.deps });
  expect(h.reported).toHaveLength(1);
});

test('reportSeedsIfChanged: unchanged seeds -> no reportInstall, no save', async () => {
  const doneJson = JSON.stringify({ devPlugin: 'done', schedulerMcp: 'done', agentPersonas: 'done' });
  const h = seedsHarness({ lastSeedsReported: doneJson });
  await reportSeedsIfChanged({ deps: h.deps });
  expect(h.reported).toHaveLength(0);
  expect(h.saved).toHaveLength(0);
});

test('reportSeedsIfChanged: rejected upsert -> lastSeedsReported not persisted', async () => {
  const h = seedsHarness({ lastSeedsReported: null, accepted: false });
  await reportSeedsIfChanged({ deps: h.deps });
  expect(h.reported).toHaveLength(1);
  expect(h.saved).toHaveLength(0);
});

test('telemetrySettings: lastSeedsReported is a known string|null key', () => {
  expect(telemetrySettings.DEFAULTS.lastSeedsReported).toBeNull();
  expect(telemetrySettings.isValid({ ...telemetrySettings.DEFAULTS, lastSeedsReported: '{"a":1}' })).toBe(true);
  expect(telemetrySettings.isValid({ ...telemetrySettings.DEFAULTS, lastSeedsReported: 5 })).toBe(false);
  expect(telemetrySettings.normalize({ ...telemetrySettings.DEFAULTS, lastSeedsReported: 5 }).lastSeedsReported).toBeNull();
});
