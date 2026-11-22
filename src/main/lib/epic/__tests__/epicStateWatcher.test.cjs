/**
 * epicStateWatcher.test.cjs — the watcher that diffs every open Epic's
 * outside-facing state against a saved snapshot and appends one
 * epic_state_changed audit row per change.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/epicStateWatcher.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const outsideRead = require('../epicOutsideRead.cjs');
const { configureEpicStateWatcher, runEpicStateWatch } = require('../epicStateWatcher.cjs');
const { auditLogPath, epicStateSnapshotPath } = require('../../scheduler/schedulerPaths.cjs');

const tmpDirs = [];
let prevHome;
const realList = outsideRead.listOpenEpicRecords;
let roots = [];

async function mkTmp(prefix) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

beforeEach(async () => {
  prevHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = await mkTmp('sm-state-watch-home-');
  roots = [];
  configureEpicStateWatcher({ isTabBusy: () => false, projectRoots: () => roots });
});

afterEach(async () => {
  outsideRead.listOpenEpicRecords = realList;
  configureEpicStateWatcher({ isTabBusy: () => false });
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

function psDir(cwd) {
  return path.join(cwd, 'session-manager-operations', 'prompt-sessions');
}

function writeFile(cwd, name, data) {
  fs.mkdirSync(psDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(psDir(cwd), name), JSON.stringify(data, null, 2));
}

function session(id, cwd, overrides = {}) {
  return {
    id,
    cwd,
    goalText: `Title ${id}`,
    claudeSessionId: `sess-${id}`,
    status: 'active',
    tag: 'feature',
    agentType: 'architect',
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function setup(cwd, sessions) {
  writeFile(cwd, 'active-index.json', { sessions: Object.fromEntries(sessions.map((s) => [s.id, s])), events: {} });
}

async function project(sessionsFor) {
  const cwd = await mkTmp('sm-state-watch-cwd-');
  roots.push(cwd);
  setup(cwd, sessionsFor(cwd));
  return cwd;
}

function auditRows() {
  let raw = '';
  try { raw = fs.readFileSync(auditLogPath(), 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === 'epic_state_changed');
}

function snapshot() {
  return JSON.parse(fs.readFileSync(epicStateSnapshotPath(), 'utf8'));
}

const failedJob = (epicId) => ({ epicId, slug: '0001-x', status: 'failed', finishedAt: '2026-11-02T00:00:00.000Z' });

test('the first run seeds the snapshot silently', async () => {
  const cwd = await project((c) => [session('e-1', c, { source: { externalRef: 'ref-1' } }), session('e-2', c)]);
  const changes = await runEpicStateWatch({ cwds: [cwd], jobs: [] });
  expect(changes).toEqual([]);
  expect(auditRows()).toEqual([]);
  const snap = snapshot();
  expect(snap.version).toBe(1);
  expect(Object.keys(snap.epics).sort()).toEqual([`${cwd}\0e-1`, `${cwd}\0e-2`]);
  expect(snap.epics[`${cwd}\0e-1`]).toMatchObject({ state: expect.any(String), blockedKind: null, externalRef: 'ref-1' });
  expect(typeof snap.epics[`${cwd}\0e-1`].at).toBe('string');
});

test('a state change, a new Epic, a closed Epic and a gone Epic each give one row', async () => {
  const cwd = await project((c) => [
    session('e-1', c, { source: { externalRef: 'ref-1' } }),
    session('e-done', c),
    session('e-gone', c),
  ]);
  await runEpicStateWatch({ cwds: [cwd], jobs: [] });
  const before = snapshot().epics;
  expect(auditRows()).toEqual([]);

  // Nothing changed → nothing written.
  expect(await runEpicStateWatch({ cwds: [cwd], jobs: [] })).toEqual([]);

  // e-1 fails a job; e-new appears; e-done is archived; e-gone vanishes.
  setup(cwd, [session('e-1', cwd, { source: { externalRef: 'ref-1' } }), session('e-new', cwd, { createdAt: '2026-11-03T00:00:00.000Z' })]);
  writeFile(cwd, 'e-done.json', {
    session: session('e-done', cwd, { status: 'completed', completedAt: '2026-11-05T00:00:00.000Z' }),
    events: [],
    archivedAt: '2026-11-05T00:00:01.000Z',
  });
  const changes = await runEpicStateWatch({ cwds: [cwd], jobs: [failedJob('e-1')] });
  const rows = auditRows();
  expect(rows).toHaveLength(4);
  expect(changes).toHaveLength(4);
  const by = Object.fromEntries(rows.map((r) => [r.epicId, r]));

  expect(by['e-1']).toMatchObject({ cwd, epicId: 'e-1', from: before[`${cwd}\0e-1`].state, to: 'blocked', blockedKind: 'failed', externalRef: 'ref-1' });
  expect(by['e-new']).toMatchObject({ cwd, epicId: 'e-new', from: null });
  expect(typeof by['e-new'].to).toBe('string');
  expect(by['e-new']).not.toHaveProperty('blockedKind');
  expect(by['e-new']).not.toHaveProperty('externalRef');
  expect(by['e-done']).toMatchObject({ cwd, epicId: 'e-done', from: before[`${cwd}\0e-done`].state, to: 'closed' });
  expect(by['e-gone']).toMatchObject({ cwd, epicId: 'e-gone', from: before[`${cwd}\0e-gone`].state, to: 'gone' });
  expect(by['e-gone']).not.toHaveProperty('blockedKind');

  const snap = snapshot().epics;
  expect(Object.keys(snap).sort()).toEqual([`${cwd}\0e-1`, `${cwd}\0e-new`]);
  expect(snap[`${cwd}\0e-1`]).toMatchObject({ state: 'blocked', blockedKind: 'failed', externalRef: 'ref-1' });

  // Steady again → no more rows.
  expect(await runEpicStateWatch({ cwds: [cwd], jobs: [failedJob('e-1')] })).toEqual([]);
  expect(auditRows()).toHaveLength(4);
});

test('a cwd not in this call keeps its snapshot entries untouched', async () => {
  const a = await project((c) => [session('a-1', c)]);
  const b = await project((c) => [session('b-1', c)]);
  await runEpicStateWatch({ cwds: [a, b], jobs: [] });
  const bEntry = snapshot().epics[`${b}\0b-1`];

  setup(b, []); // b changed on disk, but is not watched this call
  setup(a, [session('a-1', a), session('a-2', a)]);
  const changes = await runEpicStateWatch({ cwds: [a], jobs: [] });
  expect(changes.map((c) => c.epicId)).toEqual(['a-2']);
  expect(auditRows().map((r) => r.epicId)).toEqual(['a-2']);
  expect(snapshot().epics[`${b}\0b-1`]).toEqual(bEntry);
});

test('a failing cwd is skipped with its entries kept; other cwds still run', async () => {
  const bad = await project((c) => [session('x-1', c)]);
  const good = await project((c) => [session('g-1', c)]);
  await runEpicStateWatch({ cwds: [bad, good], jobs: [] });
  const badEntry = snapshot().epics[`${bad}\0x-1`];

  outsideRead.listOpenEpicRecords = async (cwd, opts) => {
    if (cwd === bad) throw new Error('boom');
    return realList(cwd, opts);
  };
  setup(good, [session('g-1', good), session('g-2', good)]);
  const changes = await runEpicStateWatch({ cwds: [bad, good], jobs: [] });
  expect(changes.map((c) => c.epicId)).toEqual(['g-2']);
  expect(auditRows().map((r) => r.epicId)).toEqual(['g-2']);
  expect(snapshot().epics[`${bad}\0x-1`]).toEqual(badEntry);
});

test('a second call while one is running returns the same promise', async () => {
  const cwd = await project((c) => [session('e-1', c)]);
  const p1 = runEpicStateWatch({ cwds: [cwd], jobs: [] });
  const p2 = runEpicStateWatch({ cwds: [cwd], jobs: [] });
  expect(p2).toBe(p1);
  await p1;
  const p3 = runEpicStateWatch({ cwds: [cwd], jobs: [] });
  expect(p3).not.toBe(p1);
  await p3;
});

test('paging reads every open Epic and isTabBusy is passed through', async () => {
  const cwd = await project((c) => Array.from({ length: 205 }, (_, i) => session(`e-${String(i).padStart(3, '0')}`, c)));
  await runEpicStateWatch({ cwds: [cwd], jobs: [] });
  expect(Object.keys(snapshot().epics)).toHaveLength(205);

  configureEpicStateWatcher({ isTabBusy: (id) => id === 'e-007', projectRoots: () => roots });
  const changes = await runEpicStateWatch({ cwds: [cwd], jobs: [] });
  expect(changes).toEqual([expect.objectContaining({ epicId: 'e-007', to: 'working' })]);
});
