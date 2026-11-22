/**
 * planRecordSweep-index-unreadable.test.cjs — the plan-records sweep fails closed when a
 * project's prompt-sessions/active-index.json exists but cannot be read/parsed: nothing in
 * that project is pruned. A missing index still lets true orphans age out; a valid index
 * behaves as before (row status first, then per-Epic archive).
 *
 * Run: timeout 300 npx vitest run src/main/lib/scheduler/__tests__/planRecordSweep-index-unreadable.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runLogRetention = require('../runLogRetention.cjs');

const DAY = 86400000;
const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const OLD = new Date(NOW - 30 * DAY);
let home;
let proj;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-prunread-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  proj = path.join(home, 'proj');
  fs.mkdirSync(ops('prompt-sessions'), { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function ops(...p) { return path.join(proj, 'session-manager-operations', ...p); }
function oldRecord(id) {
  const dir = ops('plan-records', id);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'plan.json');
  fs.writeFileSync(f, '{}');
  fs.utimesSync(f, OLD, OLD);
  fs.utimesSync(dir, OLD, OLD);
}
function sweep() {
  return runLogRetention.runPlanRecordSweep({
    cwds: [proj],
    readSettings: () => ({ planRecordsDays: 14 }),
    now: NOW,
  });
}
function exists(id) { return fs.existsSync(ops('plan-records', id)); }

test('corrupt active-index.json: epicStatus throws and nothing is pruned', () => {
  fs.writeFileSync(ops('prompt-sessions', 'active-index.json'), '{"sessions": {"live": ');
  fs.writeFileSync(ops('prompt-sessions', 'old.json'), JSON.stringify({ session: { id: 'old', status: 'completed', completedAt: OLD.toISOString() } }));
  oldRecord('live');
  oldRecord('old');
  oldRecord('orphan');
  const st = runLogRetention.epicStatusFor(proj);
  expect(() => st('live')).toThrow('active-index unreadable');
  expect(() => st('orphan')).toThrow('active-index unreadable');
  const out = sweep();
  expect(out).toEqual({ projects: 1, removed: 0, errors: 0 });
  expect(exists('live')).toBe(true);
  expect(exists('old')).toBe(true);
  expect(exists('orphan')).toBe(true);
});

test('index parses but has no object sessions field: treated as unreadable', () => {
  fs.writeFileSync(ops('prompt-sessions', 'active-index.json'), JSON.stringify({ sessions: 'nope' }));
  oldRecord('orphan');
  expect(() => runLogRetention.epicStatusFor(proj)('orphan')).toThrow('active-index unreadable');
  expect(sweep().removed).toBe(0);
  expect(exists('orphan')).toBe(true);
});

test('empty or non-object index file is unreadable too', () => {
  for (const body of ['', '[]', 'null', '42']) {
    fs.writeFileSync(ops('prompt-sessions', 'active-index.json'), body);
    expect(() => runLogRetention.epicStatusFor(proj)('x')).toThrow('active-index unreadable');
  }
});

test('missing active-index.json: old orphan pruned, archived status still honoured', () => {
  fs.writeFileSync(ops('prompt-sessions', 'old.json'), JSON.stringify({ session: { id: 'old', status: 'completed', completedAt: OLD.toISOString() } }));
  oldRecord('orphan');
  oldRecord('old');
  const st = runLogRetention.epicStatusFor(proj);
  expect(st('orphan')).toBeNull();
  expect(st('old')).toEqual({ status: 'completed', completedAt: OLD.toISOString() });
  const out = sweep();
  expect(out).toEqual({ projects: 1, removed: 2, errors: 0 });
  expect(exists('orphan')).toBe(false);
  expect(exists('old')).toBe(false);
});

test('valid index: active kept, old completed pruned', () => {
  fs.writeFileSync(ops('prompt-sessions', 'active-index.json'), JSON.stringify({
    sessions: {
      live: { id: 'live', status: 'active' },
      done: { id: 'done', status: 'completed', completedAt: OLD.toISOString() },
    },
  }));
  oldRecord('live');
  oldRecord('done');
  const out = sweep();
  expect(out).toEqual({ projects: 1, removed: 1, errors: 0 });
  expect(exists('live')).toBe(true);
  expect(exists('done')).toBe(false);
});
