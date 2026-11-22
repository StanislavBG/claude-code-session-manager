/**
 * planRecordRetention.test.cjs — prunePlanRecords over a tmp project with a fixed now.
 *
 * Run: timeout 300 npx vitest run src/main/lib/scheduler/__tests__/planRecordRetention.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const opsOwnership = require('../../opsOwnership.cjs');
const { prunePlanRecords, defaultEpicStatus } = require('../planRecordRetention.cjs');

const DAY = 86400000;
const NOW = Date.parse('2026-11-22T12:00:00Z');
let root;
let home;
let recordsDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-plan-ret-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-plan-ret-home-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  recordsDir = path.join(root, 'session-manager-operations', 'plan-records');
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(path.join(recordsDir, 'README.md'), '# plan records\n');
  fs.writeFileSync(path.join(recordsDir, '.gitignore'), '*\n');
  const old = (NOW - 400 * DAY) / 1000;
  fs.utimesSync(path.join(recordsDir, 'README.md'), old, old);
  fs.utimesSync(path.join(recordsDir, '.gitignore'), old, old);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function folder(id, ageDays, files = ['a.md']) {
  const dir = path.join(recordsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const t = (NOW - ageDays * DAY) / 1000;
  for (const f of files) {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
    fs.utimesSync(p, t, t);
  }
  return dir;
}

const iso = (ageDays) => new Date(NOW - ageDays * DAY).toISOString();

function statusTable(table) {
  return (id) => (Object.prototype.hasOwnProperty.call(table, id) ? table[id] : null);
}

test('removes old completed + old orphan; keeps recent, proposed, active and meta files', () => {
  folder('done-old', 1);
  folder('done-new', 1);
  folder('orphan-old', 30, ['a.md', 'nested/b.md']);
  folder('orphan-new', 30, ['a.md']);
  fs.writeFileSync(path.join(recordsDir, 'orphan-new', 'fresh.md'), 'y'); // newest file is now
  fs.utimesSync(path.join(recordsDir, 'orphan-new', 'fresh.md'), NOW / 1000, NOW / 1000);
  folder('prop-old', 500);
  folder('active-old', 500);
  const epicStatus = statusTable({
    'done-old': { status: 'completed', completedAt: iso(20) },
    'done-new': { status: 'completed', completedAt: iso(3) },
    'prop-old': { status: 'proposed', completedAt: null },
    'active-old': { status: 'active', completedAt: iso(900) },
  });
  const r = prunePlanRecords({ projectRoot: root, epicStatus, now: NOW, days: 14 });
  expect(r.removed.sort()).toEqual(['done-old', 'orphan-old']);
  expect(r.kept).toBe(4);
  for (const id of ['done-old', 'orphan-old']) expect(fs.existsSync(path.join(recordsDir, id))).toBe(false);
  for (const id of ['done-new', 'orphan-new', 'prop-old', 'active-old']) {
    expect(fs.existsSync(path.join(recordsDir, id))).toBe(true);
  }
  expect(fs.existsSync(path.join(recordsDir, 'README.md'))).toBe(true);
  expect(fs.existsSync(path.join(recordsDir, '.gitignore'))).toBe(true);
});

test('dryRun removes nothing and reports the same list', () => {
  folder('done-old', 1);
  folder('orphan-old', 30);
  folder('done-new', 1);
  const epicStatus = statusTable({
    'done-old': { status: 'completed', completedAt: iso(20) },
    'done-new': { status: 'completed', completedAt: iso(3) },
  });
  const dry = prunePlanRecords({ projectRoot: root, epicStatus, now: NOW, days: 14, dryRun: true });
  expect(fs.existsSync(path.join(recordsDir, 'done-old'))).toBe(true);
  expect(fs.existsSync(path.join(recordsDir, 'orphan-old'))).toBe(true);
  const real = prunePlanRecords({ projectRoot: root, epicStatus, now: NOW, days: 14 });
  expect(dry.removed.sort()).toEqual(real.removed.sort());
  expect(dry.kept).toBe(real.kept);
  expect(real.removed.sort()).toEqual(['done-old', 'orphan-old']);
});

test('unsafe folder names and symlinks are never removed', () => {
  folder('.hidden', 500);
  folder('bad name', 500);
  const target = folder('real-target', 500);
  fs.symlinkSync(target, path.join(recordsDir, 'link-epic'));
  const epicStatus = statusTable({ 'real-target': { status: 'active', completedAt: null } });
  const r = prunePlanRecords({ projectRoot: root, epicStatus, now: NOW, days: 14 });
  expect(r.removed).toEqual([]);
  expect(fs.existsSync(path.join(recordsDir, '.hidden'))).toBe(true);
  expect(fs.existsSync(path.join(recordsDir, 'bad name'))).toBe(true);
  expect(fs.existsSync(path.join(recordsDir, 'link-epic'))).toBe(true);
  expect(fs.existsSync(target)).toBe(true);
});

test('completed with missing/garbled completedAt, or a throwing epicStatus, is kept', () => {
  folder('done-nodate', 500);
  folder('done-garbled', 500);
  folder('boom', 500);
  const epicStatus = (id) => {
    if (id === 'boom') throw new Error('boom');
    if (id === 'done-nodate') return { status: 'completed', completedAt: null };
    return { status: 'completed', completedAt: 'not a date' };
  };
  const r = prunePlanRecords({ projectRoot: root, epicStatus, now: NOW, days: 14 });
  expect(r.removed).toEqual([]);
  expect(r.kept).toBe(3);
});

test('removal goes through opsPath + the opsOwnership write guard as scheduler', () => {
  folder('orphan-old', 30);
  const spy = vi.spyOn(opsOwnership, 'assertOpsWrite');
  prunePlanRecords({ projectRoot: root, epicStatus: () => null, now: NOW, days: 14 });
  expect(spy).toHaveBeenCalledWith(path.join(recordsDir, 'orphan-old'), 'scheduler');
});

test('a guard refusal or rm failure keeps the folder and never throws', () => {
  folder('orphan-old', 30);
  const fsImpl = { ...fs, rmSync: () => { throw new Error('EACCES'); } };
  const r = prunePlanRecords({ projectRoot: root, epicStatus: () => null, now: NOW, days: 14, fsImpl });
  expect(r).toEqual({ removed: [], kept: 1 });
});

test('never throws on bad input or a missing plan-records dir', () => {
  expect(prunePlanRecords({})).toEqual({ removed: [], kept: 0 });
  expect(prunePlanRecords()).toEqual({ removed: [], kept: 0 });
  expect(prunePlanRecords({ projectRoot: 'relative/path', epicStatus: () => null })).toEqual({ removed: [], kept: 0 });
  fs.rmSync(recordsDir, { recursive: true, force: true });
  expect(prunePlanRecords({ projectRoot: root, epicStatus: () => null, now: NOW, days: 14 })).toEqual({ removed: [], kept: 0 });
});

test('days defaults to opsRetentionSettings planRecordsDays (14)', () => {
  folder('orphan-13', 13);
  folder('orphan-15', 15);
  const r = prunePlanRecords({ projectRoot: root, epicStatus: () => null, now: NOW });
  expect(r.removed).toEqual(['orphan-15']);
});

test('defaultEpicStatus reads the prompt-sessions mirror/archive', () => {
  const ps = path.join(root, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(ps, { recursive: true });
  fs.writeFileSync(path.join(ps, 'e-live.json'), JSON.stringify({ id: 'e-live', status: 'active' }));
  fs.writeFileSync(path.join(ps, 'e-done.json'), JSON.stringify({
    session: { id: 'e-done', status: 'completed', completedAt: iso(20) },
  }));
  const read = defaultEpicStatus(root);
  expect(read('e-live')).toEqual({ status: 'active', completedAt: null });
  expect(read('e-done')).toEqual({ status: 'completed', completedAt: iso(20) });
  expect(read('missing')).toBeNull();
  expect(read('../escape')).toBeNull();
});
