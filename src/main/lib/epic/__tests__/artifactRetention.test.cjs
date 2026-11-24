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
const { pruneArtifacts, pruneArtifactStaging, SIZE_CAP_BYTES } = require('../artifactRetention.cjs');
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

// ─── pruneArtifactStaging: <worktreeBase>/artifact-staging/<runId>/ ─────────

function stageDir(base, name, { files = [], daysAgo = 0 } = {}) {
  const d = path.join(base, name);
  fs.mkdirSync(d, { recursive: true });
  const t = (NOW - daysAgo * DAY) / 1000;
  for (const f of files) {
    const p = path.join(d, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
    fs.utimesSync(p, t, t);
    if (path.dirname(p) !== d) fs.utimesSync(path.dirname(p), t, t);
  }
  fs.utimesSync(d, t, t);
  return d;
}

function stagingSeed() {
  const base = path.join(root, 'artifact-staging');
  fs.mkdirSync(base, { recursive: true });
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep');
  const ot = (NOW - 90 * DAY) / 1000;
  fs.utimesSync(path.join(outside, 'precious.txt'), ot, ot);
  fs.utimesSync(outside, ot, ot);
  const link = path.join(base, 'linked-run');
  fs.symlinkSync(outside, link);
  return {
    base,
    outside,
    link,
    emptyOld: stageDir(base, 'empty-old', { daysAgo: 2 }),
    emptyNew: stageDir(base, 'empty-new', { daysAgo: 0.5 }),
    fullOld: stageDir(base, 'full-old', { files: ['report.md', 'sub/clip.mp4'], daysAgo: 40 }),
    fullNew: stageDir(base, 'full-new', { files: ['draft.md'], daysAgo: 2 }),
  };
}

test('staging: empty folder older than 24 h removed, empty new kept, old non-empty removed recursively, fresh non-empty kept', () => {
  const s = stagingSeed();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const r = pruneArtifactStaging({ base: s.base, now: NOW, days: 30 });
  expect(fs.existsSync(s.emptyOld)).toBe(false);
  expect(fs.existsSync(s.emptyNew)).toBe(true);
  expect(fs.existsSync(s.fullOld)).toBe(false);
  expect(fs.existsSync(path.join(s.fullNew, 'draft.md'))).toBe(true);
  expect(r.removed.sort()).toEqual(['empty-old', 'full-old']);
  expect(r.removedFiles.sort()).toEqual(['full-old/report.md', 'full-old/sub/clip.mp4']);
  // The names of deleted files are logged.
  const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
  expect(logged).toContain('full-old/report.md');
  expect(logged).toContain('full-old/sub/clip.mp4');
});

test('staging: symlinked child is skipped and its target outside the base is never touched', () => {
  const s = stagingSeed();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const r = pruneArtifactStaging({ base: s.base, now: NOW, days: 30 });
  expect(fs.lstatSync(s.link).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(path.join(s.outside, 'precious.txt'), 'utf8')).toBe('keep');
  expect(r.removed).not.toContain('linked-run');
});

test('staging: dryRun reports the same result and deletes nothing', () => {
  const s = stagingSeed();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const list = () => fs.readdirSync(s.base).sort();
  const before = list();
  const dry = pruneArtifactStaging({ base: s.base, now: NOW, days: 30, dryRun: true });
  expect(list()).toEqual(before);
  expect(fs.existsSync(path.join(s.fullOld, 'report.md'))).toBe(true);
  const real = pruneArtifactStaging({ base: s.base, now: NOW, days: 30 });
  expect(dry.removed.sort()).toEqual(real.removed.sort());
  expect(dry.removedFiles.sort()).toEqual(real.removedFiles.sort());
});

test('staging: missing base → empty result, never throws', () => {
  expect(pruneArtifactStaging({ base: path.join(root, 'nope'), now: NOW, days: 30 })).toMatchObject({ removed: [], removedFiles: [] });
  expect(pruneArtifactStaging({ base: 'relative/dir', now: NOW, days: 30 })).toMatchObject({ removed: [] });
});

test('staging: default base is <worktreeBase>/artifact-staging, and stagingDirFor re-creates a removed folder', () => {
  const saved = process.env.SM_WORKTREE_ROOT;
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-artifact-staging-wt-'));
  process.env.SM_WORKTREE_ROOT = wt;
  try {
    const { stagingDirFor } = require('../artifactStore.cjs');
    const d = stagingDirFor({ runId: 'tab-1' });
    expect(d).toBe(path.join(wt, 'artifact-staging', 'tab-1'));
    const t = (NOW - 2 * DAY) / 1000;
    fs.utimesSync(d, t, t);
    const r = pruneArtifactStaging({ now: NOW, days: 30 });
    expect(r.removed).toEqual(['tab-1']);
    expect(fs.existsSync(d)).toBe(false);
    // An open terminal / chat turn asks again → the folder is back.
    expect(stagingDirFor({ runId: 'tab-1' })).toBe(d);
    expect(fs.statSync(d).isDirectory()).toBe(true);
  } finally {
    if (saved === undefined) delete process.env.SM_WORKTREE_ROOT; else process.env.SM_WORKTREE_ROOT = saved;
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('staging: runArtifactSweep calls pruneArtifactStaging once with artifactsDays', () => {
  const calls = [];
  const { runArtifactSweep } = require('../../scheduler/runLogRetention.cjs');
  const out = runArtifactSweep({
    cwds: ['/a', '/b'],
    now: NOW,
    readSettings: () => ({ artifactsDays: 12, tasksDays: 3 }),
    prune: () => ({ removed: [] }),
    epicStatusFor: () => () => null,
    pruneStaging: (o) => { calls.push(o); return { removed: ['x'], removedFiles: [] }; },
  });
  expect(calls).toEqual([{ now: NOW, days: 12 }]);
  expect(out).toEqual({ projects: 2, removed: 0, errors: 0 });
});

function ownerMissing(segs, entries, missing) {
  const dir = owner(segs, entries);
  for (const n of missing) fs.unlinkSync(path.join(dir, n));
  return dir;
}

test('ledger rows whose file is missing are compacted, even for a live Epic', () => {
  const live = ownerMissing(['live-epic'], [
    { name: 'here.png', createdAt: iso(1) },
    { name: 'gone.png', createdAt: iso(1) },
  ], ['gone.png']);
  const intact = owner(['new-done'], [{ name: 'a.png', createdAt: iso(1) }]);
  const task = ownerMissing(['_tasks', 'task-1'], [
    { name: 'new.json', createdAt: iso(1) },
    { name: 'lost.json', createdAt: iso(1) },
  ], ['lost.json']);
  const intactMtime = fs.statSync(path.join(intact, 'index.json')).mtimeMs;
  const spy = vi.spyOn(opsOwnership, 'assertOpsWrite');
  const r = pruneArtifacts({ projectRoot: root, epicStatus, now: NOW, days: 30, tasksDays: 10 });
  expect(ledger(live)).toEqual(['here.png']);
  expect(fs.existsSync(path.join(live, 'here.png'))).toBe(true);
  expect(ledger(task)).toEqual(['new.json']);
  expect(ledger(intact)).toEqual(['a.png']);
  expect(fs.statSync(path.join(intact, 'index.json')).mtimeMs).toBe(intactMtime);
  expect(r.missingRows.sort()).toEqual(['_tasks/task-1/lost.json', 'live-epic/gone.png']);
  expect(r.compacted.sort()).toEqual(['_tasks/task-1', 'live-epic']);
  expect(r.removed).toEqual([]);
  // The ledger rewrite was asserted as writer 'artifacts'.
  const asserted = spy.mock.calls.map((c) => [c[0], c[1]]);
  expect(asserted).toContainEqual([path.join(live, 'index.json'), 'artifacts']);
  expect(asserted).toContainEqual([path.join(task, 'index.json'), 'artifacts']);
  for (const c of spy.mock.calls) expect(c[1]).toBe('artifacts');
});

test('a pinned row whose file is missing is removed; a folder left empty is deleted', () => {
  const mixed = ownerMissing(['old-pinned'], [
    { name: 'keep.mp4', createdAt: iso(50), pinned: true },
    { name: 'lost.mp4', createdAt: iso(50), pinned: true },
  ], ['lost.mp4']);
  const allGone = ownerMissing(['old-done'], [{ name: 'p.png', createdAt: iso(50), pinned: true }], ['p.png']);
  const livePinned = ownerMissing(['live-epic'], [{ name: 'p.png', createdAt: iso(1), pinned: true }], ['p.png']);
  const r = pruneArtifacts({ projectRoot: root, epicStatus, now: NOW, days: 30, tasksDays: 10 });
  expect(ledger(mixed)).toEqual(['keep.mp4']);
  expect(fs.existsSync(path.join(mixed, 'keep.mp4'))).toBe(true);
  expect(fs.existsSync(allGone)).toBe(false);
  expect(ledger(livePinned)).toEqual([]);
  expect(r.removed).toEqual(['old-done']);
  expect(r.missingRows.sort()).toEqual(['live-epic/p.png', 'old-done/p.png', 'old-pinned/lost.mp4']);
});

test('dryRun reports missing rows without rewriting any ledger', () => {
  const live = ownerMissing(['live-epic'], [
    { name: 'here.png', createdAt: iso(1) },
    { name: 'gone.png', createdAt: iso(1), pinned: true },
  ], ['gone.png']);
  const before = fs.readFileSync(path.join(live, 'index.json'), 'utf8');
  const spy = vi.spyOn(opsOwnership, 'assertOpsWrite');
  const dry = pruneArtifacts({ projectRoot: root, epicStatus, now: NOW, days: 30, tasksDays: 10, dryRun: true });
  expect(fs.readFileSync(path.join(live, 'index.json'), 'utf8')).toBe(before);
  expect(dry.missingRows).toEqual(['live-epic/gone.png']);
  expect(dry.compacted).toEqual(['live-epic']);
  for (const c of spy.mock.calls) expect(c[1]).toBe('artifacts');
  const real = pruneArtifacts({ projectRoot: root, epicStatus, now: NOW, days: 30, tasksDays: 10 });
  expect(real.missingRows).toEqual(dry.missingRows);
  expect(real.compacted).toEqual(dry.compacted);
  expect(ledger(live)).toEqual(['here.png']);
});

test('pruneArtifacts compacts a dangling-symlink row and keeps the regular-file row', () => {
  const dir = owner(['live-epic'], [
    { name: 'here.png', createdAt: iso(1) },
    { name: 'dangling.png', createdAt: iso(1) },
  ]);
  fs.unlinkSync(path.join(dir, 'dangling.png'));
  fs.symlinkSync(path.join(dir, 'nowhere.png'), path.join(dir, 'dangling.png'));
  const r = pruneArtifacts({ projectRoot: root, epicStatus, now: NOW, days: 30, tasksDays: 10 });
  expect(ledger(dir)).toEqual(['here.png']);
  expect(fs.existsSync(path.join(dir, 'here.png'))).toBe(true);
  expect(r.missingRows).toEqual(['live-epic/dangling.png']);
  expect(r.compacted).toEqual(['live-epic']);
});
