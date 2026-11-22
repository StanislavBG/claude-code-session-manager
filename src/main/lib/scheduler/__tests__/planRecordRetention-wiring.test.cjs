/**
 * planRecordRetention-wiring.test.cjs — runLogRetention's boot/periodic sweep prunes
 * plan-records/ per scheduler project with planRecordsDays + an epicStatus built from
 * the prompt-sessions store (active-index rows, then per-Epic archive files).
 *
 * Run: timeout 300 npx vitest run src/main/lib/scheduler/__tests__/planRecordRetention-wiring.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runLogRetention = require('../runLogRetention.cjs');
const queueStore = require('../queueStore.cjs');
const settings = require('../../opsRetentionSettings.cjs');

const DAY = 86400000;
let home;
let proj;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-prwire-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(proj, 'session-manager-operations', 'prompt-sessions'), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function ops(...p) { return path.join(proj, 'session-manager-operations', ...p); }
function record(id) {
  fs.mkdirSync(ops('plan-records', id), { recursive: true });
  fs.writeFileSync(ops('plan-records', id, 'plan.json'), '{}');
}

test('runPlanRecordSweep passes planRecordsDays and an epicStatus function per project', () => {
  const calls = [];
  const out = runLogRetention.runPlanRecordSweep({
    cwds: ['/a', '/b', '/a'],
    readSettings: () => ({ planRecordsDays: 7 }),
    epicStatusFor: () => () => null,
    prune: (o) => { calls.push(o); return { removed: ['x'], kept: 0 }; },
  });
  expect(calls.map((c) => c.projectRoot)).toEqual(['/a', '/b']);
  for (const c of calls) {
    expect(c.days).toBe(7);
    expect(typeof c.epicStatus).toBe('function');
  }
  expect(out).toEqual({ projects: 2, removed: 2, errors: 0 });
});

test('a throwing project is non-fatal', () => {
  const out = runLogRetention.runPlanRecordSweep({
    cwds: ['/a', '/b'],
    readSettings: () => ({ planRecordsDays: 7 }),
    prune: (o) => { if (o.projectRoot === '/a') throw new Error('boom'); return { removed: [], kept: 1 }; },
    epicStatusFor: () => () => null,
  });
  expect(out).toEqual({ projects: 1, removed: 0, errors: 1 });
});

test('epicStatusFor reads active-index rows first, then per-Epic archives', () => {
  const done = new Date(Date.now() - 30 * DAY).toISOString();
  fs.writeFileSync(ops('prompt-sessions', 'active-index.json'), JSON.stringify({ sessions: { live: { id: 'live', status: 'active' } } }));
  fs.writeFileSync(ops('prompt-sessions', 'old.json'), JSON.stringify({ session: { id: 'old', status: 'completed', completedAt: done } }));
  const st = runLogRetention.epicStatusFor(proj);
  expect(st('live')).toEqual({ status: 'active', completedAt: null });
  expect(st('old')).toEqual({ status: 'completed', completedAt: done });
  expect(st('missing')).toBeNull();
});

test('runBootSweep prunes completed Epics for the projects readMergedSync swept, keeps active', () => {
  const done = new Date(Date.now() - 30 * DAY).toISOString();
  fs.writeFileSync(ops('prompt-sessions', 'active-index.json'), JSON.stringify({ sessions: { live: { id: 'live', status: 'active' } } }));
  fs.writeFileSync(ops('prompt-sessions', 'old.json'), JSON.stringify({ session: { id: 'old', status: 'completed', completedAt: done } }));
  record('live');
  record('old');
  fs.mkdirSync(path.dirname(settings.storePath()), { recursive: true });
  fs.writeFileSync(settings.storePath(), JSON.stringify({ planRecordsDays: 14 }));
  const state = { config: {}, jobs: [] };
  Object.defineProperty(state, 'sourceCwds', { value: [proj], enumerable: false });
  vi.spyOn(queueStore, 'readMergedSync').mockReturnValue(state);
  const runsDir = path.join(home, 'runs');
  const result = runLogRetention.runBootSweep({ runsDir });
  expect(result.planRecords).toEqual({ projects: 1, removed: 1, errors: 0 });
  expect(fs.existsSync(ops('plan-records', 'old'))).toBe(false);
  expect(fs.existsSync(ops('plan-records', 'live'))).toBe(true);
});
