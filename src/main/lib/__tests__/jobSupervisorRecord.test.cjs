/**
 * jobSupervisorRecord.test.cjs — record round-trip, live listing, retention
 * claim, and the pure classifyAdoption matrix.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/jobSupervisorRecord.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rec = require('../jobSupervisorRecord.cjs');

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-supervisor-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const base = (over = {}) => ({
  runDir: path.join(root, 'run-1'), slug: 'p1', cwd: '/x', runId: 'run-1', pid: 42, pgid: 42,
  identity: { pid: 42, startTicks: 7, cmdline: 'claude -p', complete: true },
  execCwd: '/wt', worktreeDir: '/wt', worktreeBranch: 'sm-job/p1', sessionId: 's',
  startedAt: 1_000, budgetMs: 10_000, maxDurationMs: null, idleKillMs: 5_000, schedulerPid: 1, codeSha: 'abc', ...over,
});

test('write → read round-trips every field at <runDir>/<slug>.supervisor.json', () => {
  const input = base();
  rec.writeSupervisorRecord(input);
  expect(fs.existsSync(path.join(input.runDir, 'p1.supervisor.json'))).toBe(true);
  const back = rec.readSupervisorRecord(input.runDir, 'p1');
  const { runDir, ...persisted } = input;
  expect(back).toMatchObject({ ...persisted, kind: 'job' });
  expect(back.runDir).toBeUndefined();
});

test('readSupervisorRecord returns null for absent or torn files', () => {
  expect(rec.readSupervisorRecord(path.join(root, 'nope'), 'p1')).toBeNull();
  fs.mkdirSync(path.join(root, 'r'));
  fs.writeFileSync(path.join(root, 'r', 'p1.supervisor.json'), '{"pid":');
  expect(rec.readSupervisorRecord(path.join(root, 'r'), 'p1')).toBeNull();
});

test('listLiveSupervisorRecords skips exited (meta.json) and stale records', () => {
  rec.writeSupervisorRecord(base({ slug: 'live' }));
  rec.writeSupervisorRecord(base({ slug: 'done' }));
  fs.writeFileSync(path.join(root, 'run-1', 'done.meta.json'), '{}');
  const live = rec.listLiveSupervisorRecords(root, { maxAgeMs: 60_000 });
  expect(live.map((r) => r.slug)).toEqual(['live']);
  expect(live[0].runDir).toBe(path.join(root, 'run-1'));
  expect(rec.listLiveSupervisorRecords(root, { maxAgeMs: 1, now: Date.now() + 10_000 })).toEqual([]);
  expect(rec.listLiveSupervisorRecords(path.join(root, 'missing'), { maxAgeMs: 1 })).toEqual([]);
});

test('investigation records use the .investigation.log exit line as their marker', () => {
  const runDir = path.join(root, 'run-1');
  rec.writeSupervisorRecord(base({ slug: 'p1.investigation', kind: 'investigation' }));
  fs.writeFileSync(path.join(runDir, 'p1.investigation.log'), 'working\n');
  expect(rec.listLiveSupervisorRecords(root, { maxAgeMs: 60_000 })).toHaveLength(1);
  fs.appendFileSync(path.join(runDir, 'p1.investigation.log'), '\n[scheduler] investigation exit code=0\n');
  expect(rec.listLiveSupervisorRecords(root, { maxAgeMs: 60_000 })).toEqual([]);
});

test('classifyAdoption matrix', () => {
  const r = base();
  const same = { pid: 42, startTicks: 7, cmdline: 'claude -p', complete: true };
  const other = { pid: 42, startTicks: 99, cmdline: 'claude -p', complete: true };
  const now = 2_000;
  const c = (o) => rec.classifyAdoption(r, { identity: same, pidAlive: true, logMtimeMs: now, exitMarker: false, now, ...o });
  expect(c({})).toBe('adopt');
  expect(c({ pidAlive: false })).toBe('dead');
  expect(c({ pidAlive: false, exitMarker: true })).toBe('exited');
  expect(c({ identity: other })).toBe('foreign-pid');
  expect(c({ identity: { pid: 42, startTicks: null, cmdline: null, complete: false } })).toBe('adopt'); // fail-closed
  expect(c({ now: 1_000 + 10_001, logMtimeMs: 1_000 + 10_000 })).toBe('over-budget');
  expect(c({ now: 1_000 + 5_001, logMtimeMs: 1_000 })).toBe('over-budget'); // log stalled past idleKillMs
  expect(rec.classifyAdoption(base({ budgetMs: null, maxDurationMs: 100 }), { identity: same, pidAlive: true, logMtimeMs: 1_050, now: 1_200 })).toBe('over-budget');
  expect(rec.classifyAdoption(base({ budgetMs: null, idleKillMs: null }), { identity: same, pidAlive: true, now: 9e9 })).toBe('adopt');
});
