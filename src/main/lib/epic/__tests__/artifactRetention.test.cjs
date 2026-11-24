/**
 * artifactRetention.test.cjs — retention sweep for session-manager-operations/artifacts/.
 *
 * Run: timeout 300 npx vitest run src/main/lib/epic/__tests__/artifactRetention.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pruneArtifacts, SIZE_CAP_BYTES } = require('../artifactRetention.cjs');
const opsOwnership = require('../../opsOwnership.cjs');

const DAY = 86400000;
const NOW = Date.parse('2026-11-23T12:00:00Z');
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
let root;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-artifact-ret-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

const nsDir = (...segs) => path.join(root, 'session-manager-operations', 'artifacts', ...segs);

function owner(segs, entries, { mtimeDaysAgo } = {}) {
  const dir = nsDir(...segs);
  fs.mkdirSync(dir, { recursive: true });
  for (const e of entries) {
    const f = path.join(dir, e.name);
    fs.writeFileSync(f, 'x'.repeat(e.size || 4));
    if (mtimeDaysAgo !== undefined) { const t = (NOW - mtimeDaysAgo * DAY) / 1000; fs.utimesSync(f, t, t); }
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, entries }));
  return dir;
}
const ledger = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).entries.map((e) => e.name);

const STATUS = {
  'live-epic': { status: 'active' },
  'new-done': { status: 'completed', completedAt: iso(5) },
  'old-done': { status: 'completed', completedAt: iso(40) },
  'old-pinned': { status: 'completed', completedAt: iso(40) },
  'old-archived': { status: 'archived', archivedAt: iso(40) },
};
const epicStatus = (id) => (id in STATUS ? STATUS[id] : null);

function seed() {
  return {
    live: owner(['live-epic'], [{ name: 'a.mp4', createdAt: iso(90) }]),
    fresh: owner(['new-done'], [{ name: 'a.png', createdAt: iso(90) }]),
    old: owner(['old-done'], [{ name: 'a.png', createdAt: iso(50) }]),
    pinned: owner(['old-pinned'], [
      { name: 'keep.mp4', createdAt: iso(50), pinned: true },
      { name: 'drop.png', createdAt: iso(50) },
    ]),
    archived: owner(['old-archived'], [{ name: 'b.md', createdAt: iso(50) }]),
    task: owner(['_tasks', 'task-1'], [
      { name: 'old.json', createdAt: iso(20) },
      { name: 'new.json', createdAt: iso(2) },
      { name: 'pin.json', createdAt: iso(20), pinned: true },
    ]),
    taskGone: owner(['_tasks', 'task-2'], [{ name: 'old.csv', createdAt: iso(20) }]),
  };
}

test('active Epic kept, fresh completed kept, completed/archived past window deleted, pinned kept', () => {
  const d = seed();
  const r = pruneArtifacts({ projectRoot: root, epicStatus, now: NOW, days: 30, tasksDays: 10 });
  expect(fs.existsSync(path.join(d.live, 'a.mp4'))).toBe(true);
  expect(fs.existsSync(path.join(d.fresh, 'a.png'))).toBe(true);
  expect(fs.existsSync(d.old)).toBe(false);
  expect(fs.existsSync(d.archived)).toBe(false);
  // Pinned entry survives; unpinned sibling goes; ledger rewritten to the pinned set.
  expect(fs.existsSync(path.join(d.pinned, 'keep.mp4'))).toBe(true);
  expect(fs.existsSync(path.join(d.pinned, 'drop.png'))).toBe(false);
  expect(ledger(d.pinned)).toEqual(['keep.mp4']);
  expect(r.removed.sort()).toEqual(['_tasks/task-2', 'old-archived', 'old-done']);
  expect(r.trimmed.sort()).toEqual(['_tasks/task-1', 'old-pinned']);
});

test('Task entries follow tasksDays per entry; pinned kept; empty Task folder removed', () => {
  const d = seed();
  pruneArtifacts({ projectRoot: root, epicStatus, now: NOW, days: 30, tasksDays: 10 });
  expect(fs.existsSync(path.join(d.task, 'old.json'))).toBe(false);
  expect(fs.existsSync(path.join(d.task, 'new.json'))).toBe(true);
  expect(fs.existsSync(path.join(d.task, 'pin.json'))).toBe(true);
  expect(ledger(d.task).sort()).toEqual(['new.json', 'pin.json']);
  expect(fs.existsSync(d.taskGone)).toBe(false);
  // A longer tasksDays keeps everything.
  const d2 = owner(['_tasks', 'task-3'], [{ name: 'x.csv', createdAt: iso(20) }]);
  pruneArtifacts({ projectRoot: root, epicStatus, now: NOW, days: 30, tasksDays: 60 });
  expect(fs.existsSync(path.join(d2, 'x.csv'))).toBe(true);
});

test('orphan Epic folder follows newest mtime; throwing epicStatus keeps the folder', () => {
  const oldOrphan = owner(['orphan-old'], [{ name: 'a.png', createdAt: iso(50) }], { mtimeDaysAgo: 50 });
  fs.utimesSync(path.join(oldOrphan, 'index.json'), (NOW - 50 * DAY) / 1000, (NOW - 50 * DAY) / 1000);
  const freshOrphan = owner(['orphan-new'], [{ name: 'a.png', createdAt: iso(50) }]);
  const r = pruneArtifacts({ projectRoot: root, epicStatus, now: NOW, days: 30, tasksDays: 10 });
  expect(r.removed).toContain('orphan-old');
  expect(fs.existsSync(freshOrphan)).toBe(true);
  const d = owner(['old-done'], [{ name: 'a.png', createdAt: iso(50) }]);
  pruneArtifacts({ projectRoot: root, epicStatus: () => { throw new Error('boom'); }, now: NOW, days: 30, tasksDays: 10000 });
  expect(fs.existsSync(path.join(d, 'a.png'))).toBe(true);
});

test('dryRun reports the same result and deletes nothing', () => {
  seed();
  const snap = () => {
    const out = [];
    const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); out.push(q + (e.isFile() ? `:${fs.readFileSync(q, 'utf8')}` : '')); if (e.isDirectory()) walk(q); } };
    walk(root);
    return out.sort();
  };
  const before = snap();
  const dry = pruneArtifacts({ projectRoot: root, epicStatus, now: NOW, days: 30, tasksDays: 10, dryRun: true });
  expect(snap()).toEqual(before);
  const real = pruneArtifacts({ projectRoot: root, epicStatus, now: NOW, days: 30, tasksDays: 10 });
  expect(dry.removed.sort()).toEqual(real.removed.sort());
  expect(dry.trimmed.sort()).toEqual(real.trimmed.sort());
  expect(dry.removedFiles).toBe(real.removedFiles);
});

test('deletes only as writer artifacts', () => {
  seed();
  const spy = vi.spyOn(opsOwnership, 'assertOpsWrite');
  pruneArtifacts({ projectRoot: root, epicStatus, now: NOW, days: 30, tasksDays: 10 });
  expect(spy).toHaveBeenCalled();
  for (const c of spy.mock.calls) expect(c[1]).toBe('artifacts');
});

test('one size-cap warning when the store exceeds the cap (default 5 GiB)', () => {
  expect(SIZE_CAP_BYTES).toBe(5 * 1024 ** 3);
  owner(['live-epic'], [{ name: 'a.bin', size: 300 }, { name: 'b.bin', size: 300 }]);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const r = pruneArtifacts({ projectRoot: root, epicStatus, now: NOW, days: 30, tasksDays: 10, sizeCapBytes: 100 });
  expect(r.overCap).toBe(true);
  expect(warn.mock.calls.filter((c) => String(c[0]).includes('size cap'))).toHaveLength(1);
  warn.mockClear();
  const r2 = pruneArtifacts({ projectRoot: root, epicStatus, now: NOW, days: 30, tasksDays: 10 });
  expect(r2.overCap).toBe(false);
  expect(warn.mock.calls.filter((c) => String(c[0]).includes('size cap'))).toHaveLength(0);
});

test('missing store or bad epicStatus → empty result, never throws', () => {
  expect(pruneArtifacts({ projectRoot: root, epicStatus, now: NOW })).toMatchObject({ removed: [], trimmed: [] });
  expect(pruneArtifacts({ projectRoot: root })).toMatchObject({ removed: [], trimmed: [] });
});

test('purge path: purgeEpic removes artifacts/<epic-id>/ as writer artifacts and leaves other Epics', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-artifact-purge-home-'));
  const sched = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-artifact-purge-sched-'));
  const saved = process.env.SM_SCHEDULER_HOME;
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  process.env.SM_SCHEDULER_HOME = sched;
  try {
    const { purgeEpic, PURGE_AUTHORITY_IPC, PURGE_ARTIFACT_KINDS } = require('../epicPurge.cjs');
    expect(PURGE_ARTIFACT_KINDS).toContain('artifacts');
    const mine = owner(['epic-a'], [{ name: 'a.png', createdAt: iso(1) }]);
    const other = owner(['epic-b'], [{ name: 'b.png', createdAt: iso(1) }]);
    const dry = await purgeEpic({ cwd: root, epicId: 'epic-a', dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.artifacts).toContainEqual({ kind: 'artifacts', path: mine });
    expect(fs.existsSync(mine)).toBe(true);
    const spy = vi.spyOn(opsOwnership, 'assertOpsWrite');
    const res = await purgeEpic({ cwd: root, epicId: 'epic-a', authority: PURGE_AUTHORITY_IPC });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(mine)).toBe(false);
    expect(fs.existsSync(path.join(other, 'b.png'))).toBe(true);
    expect(spy.mock.calls.some((c) => c[0] === mine && c[1] === 'artifacts')).toBe(true);
  } finally {
    if (saved === undefined) delete process.env.SM_SCHEDULER_HOME; else process.env.SM_SCHEDULER_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(sched, { recursive: true, force: true });
  }
});
