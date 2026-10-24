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
