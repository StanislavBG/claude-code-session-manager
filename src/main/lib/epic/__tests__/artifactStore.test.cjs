/**
 * artifactStore.test.cjs — the single writer of artifacts/: publish, name
 * collision, symlink / outside-root / oversize refusal, ingestDir, corrupt
 * ledger and listArtifacts ordering, all under a temp project root.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/artifactStore.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('../artifactStore.cjs');
const { readEpicEvents } = require('../epicEventLog.cjs');

const EPIC = 'epic-abc';
let root;
let src;
let wtRoot;
let prevWt;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-artifacts-')));
  fs.mkdirSync(path.join(root, 'session-manager-operations'), { recursive: true });
  src = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-artifacts-src-')));
  wtRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-artifacts-wt-')));
  prevWt = process.env.SM_WORKTREE_ROOT;
  process.env.SM_WORKTREE_ROOT = wtRoot;
});

afterEach(() => {
  if (prevWt === undefined) delete process.env.SM_WORKTREE_ROOT; else process.env.SM_WORKTREE_ROOT = prevWt;
  for (const d of [root, src, wtRoot]) fs.rmSync(d, { recursive: true, force: true });
});

const ns = () => path.join(root, 'session-manager-operations', 'artifacts');
function mk(name, body = 'hello') {
  const p = path.join(src, name);
  fs.writeFileSync(p, body);
  return p;
}
const pub = (over = {}) => store.publishArtifact({ projectRoot: root, epicId: EPIC, allowedRoots: [src], ...over });

test('publish copies the file, writes the ledger and one artifact.published event', async () => {
  const p = mk('demo.mp4', 'video-bytes');
  const res = await pub({ srcPath: p, producer: { prdSlug: '4035-x', sessionId: 's1' } });
  expect(res.ok).toBe(true);
  expect(res.storedPath).toBe(path.join(ns(), EPIC, 'demo.mp4'));
  expect(fs.readFileSync(res.storedPath, 'utf8')).toBe('video-bytes');
  expect(fs.existsSync(p)).toBe(true); // publish copies, never moves
  expect(res.entry).toMatchObject({
    name: 'demo.mp4', title: 'demo.mp4', kind: 'video', size: 11,
    sha256: crypto.createHash('sha256').update('video-bytes').digest('hex'),
    producer: { epicId: EPIC, prdSlug: '4035-x', sessionId: 's1', taskId: null },
  });
  const ledger = JSON.parse(fs.readFileSync(path.join(ns(), EPIC, 'index.json'), 'utf8'));
  expect(ledger.entries).toHaveLength(1);
  expect(ledger.entries[0].name).toBe('demo.mp4');

  const { events } = await readEpicEvents(root, EPIC);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: 'artifact.published', name: 'demo.mp4', title: 'demo.mp4', artifactKind: 'video', size: 11,
    path: `session-manager-operations/artifacts/${EPIC}/demo.mp4`,
  });
});

test('explicit title and kind win; kinds inferred from extension', async () => {
  const res = await pub({ srcPath: mk('notes.md'), title: 'Release notes', kind: 'data' });
  expect(res.entry).toMatchObject({ title: 'Release notes', kind: 'data' });
  expect(store.inferKind('a.PNG')).toBe('image');
  expect(store.inferKind('a.wav')).toBe('audio');
  expect(store.inferKind('a.pdf')).toBe('doc');
  expect(store.inferKind('a.csv')).toBe('data');
  expect(store.inferKind('a.bin')).toBe('other');
  expect((await pub({ srcPath: mk('x.txt'), kind: 'bogus' })).ok).toBe(false);
});

test('name collision never overwrites: -2, -3 suffixes; index.json is reserved', async () => {
  const p = mk('shot.png', 'one');
  const a = await pub({ srcPath: p });
  fs.writeFileSync(p, 'two');
  const b = await pub({ srcPath: p });
  fs.writeFileSync(p, 'three');
  const c = await pub({ srcPath: p });
  expect([a, b, c].map((r) => r.entry.name)).toEqual(['shot.png', 'shot-2.png', 'shot-3.png']);
  expect(fs.readFileSync(a.storedPath, 'utf8')).toBe('one');
  expect(fs.readFileSync(c.storedPath, 'utf8')).toBe('three');
  const idx = await pub({ srcPath: mk('index.json', '{}') });
  expect(idx.entry.name).toBe('index-2.json');
  // Concurrent publishes of the same name are serialized per owner.
  const q = mk('same.txt');
  const many = await Promise.all([1, 2, 3, 4].map(() => pub({ srcPath: q })));
  expect(new Set(many.map((r) => r.entry.name)).size).toBe(4);
  const ledger = JSON.parse(fs.readFileSync(path.join(ns(), EPIC, 'index.json'), 'utf8'));
  expect(ledger.entries).toHaveLength(8);
});

test('refuses a symlink source', async () => {
  const target = mk('real.txt');
  const link = path.join(src, 'link.txt');
  fs.symlinkSync(target, link);
  const res = await pub({ srcPath: link });
  expect(res).toEqual({ ok: false, error: 'source is a symlink' });
});

test('refuses a source outside every allowed root', async () => {
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-artifacts-other-')));
  try {
    const p = path.join(other, 'secret.txt');
    fs.writeFileSync(p, 'x');
    const res = await pub({ srcPath: p });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/outside every allowed root/);
    expect(fs.existsSync(path.join(ns(), EPIC))).toBe(false);
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('refuses an oversize source (> 2 GiB, sparse)', async () => {
  const p = path.join(src, 'huge.bin');
  const fd = fs.openSync(p, 'w');
  fs.ftruncateSync(fd, store.MAX_BYTES + 1);
  fs.closeSync(fd);
  const res = await pub({ srcPath: p });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/oversize/);
});

test('owner validation: exactly one of epicId / taskId, safe ids; never throws', async () => {
  const p = mk('a.txt');
  expect((await pub({ srcPath: p, taskId: 't1' })).error).toMatch(/exactly one/);
  expect((await store.publishArtifact({ projectRoot: root, srcPath: p, allowedRoots: [src] })).error).toMatch(/exactly one/);
  expect((await pub({ srcPath: p, epicId: '../evil' })).error).toBe('unsafe epicId');
  expect((await pub({ srcPath: 'relative.txt' })).ok).toBe(false);
  expect((await store.publishArtifact()).ok).toBe(false);
});

test('Task-owned artifacts land in _tasks/<task-id>/ with no Epic event', async () => {
  const res = await store.publishArtifact({
    projectRoot: root, taskId: 'task_1.a', srcPath: mk('out.csv'), allowedRoots: [src],
  });
  expect(res.ok).toBe(true);
  expect(res.storedPath).toBe(path.join(ns(), '_tasks', 'task_1.a', 'out.csv'));
  expect(res.entry.producer.taskId).toBe('task_1.a');
  expect(fs.existsSync(path.join(root, 'session-manager-operations', 'events'))).toBe(false);
});

test('ingestDir publishes regular files directly in srcDir and deletes each source after copy', async () => {
  const staging = store.stagingDirFor({ runId: 'run-1' });
  expect(staging).toBe(path.join(wtRoot, 'artifact-staging', 'run-1'));
  expect(fs.statSync(staging).mode & 0o777).toBe(0o700);
  expect(() => store.stagingDirFor({ runId: '../x' })).toThrow(/unsafe runId/);

  fs.writeFileSync(path.join(staging, 'a.png'), 'a');
  fs.writeFileSync(path.join(staging, 'b.md'), 'b');
  fs.mkdirSync(path.join(staging, 'sub'));
  fs.writeFileSync(path.join(staging, 'sub', 'deep.txt'), 'd');
  fs.symlinkSync(path.join(staging, 'a.png'), path.join(staging, 'link.png'));

  const res = await store.ingestDir({ projectRoot: root, epicId: EPIC, srcDir: staging, producer: { prdSlug: 'p' } });
  expect(res.published.map((p) => p.entry.name).sort()).toEqual(['a.png', 'b.md']);
  expect(res.skipped.map((s) => [path.basename(s.path), s.reason]).sort()).toEqual([
    ['link.png', 'symlink'], ['sub', 'directory'],
  ]);
  expect(fs.existsSync(path.join(staging, 'a.png'))).toBe(false);
  expect(fs.existsSync(path.join(staging, 'b.md'))).toBe(false);
  expect(fs.existsSync(path.join(staging, 'sub', 'deep.txt'))).toBe(true);
  expect(fs.readFileSync(path.join(ns(), EPIC, 'a.png'), 'utf8')).toBe('a');

  const missing = await store.ingestDir({ projectRoot: root, epicId: EPIC, srcDir: path.join(wtRoot, 'nope') });
  expect(missing).toEqual({ published: [], skipped: [] });
});

test('ingestDir minAgeMs skips files modified too recently as still being written', async () => {
  const old = mk('old.txt', 'o');
  const fresh = mk('fresh.txt', 'f');
  const past = (Date.now() - 60_000) / 1000;
  fs.utimesSync(old, past, past);

  const res = await store.ingestDir({ projectRoot: root, epicId: EPIC, srcDir: src, minAgeMs: 10_000 });
  expect(res.published.map((p) => p.entry.name)).toEqual(['old.txt']);
  expect(res.skipped).toEqual([{ path: fresh, reason: 'still being written' }]);
  expect(fs.existsSync(old)).toBe(false);
  expect(fs.existsSync(fresh)).toBe(true);

  // Default minAgeMs 0 = today's behavior: the fresh file is taken too.
  const again = await store.ingestDir({ projectRoot: root, epicId: EPIC, srcDir: src });
  expect(again.published.map((p) => p.entry.name)).toEqual(['fresh.txt']);
  expect(again.skipped).toEqual([]);
});

test('ingestDir keeps the source when its copy fails', async () => {
  const p = mk('keep.txt');
  const res = await store.ingestDir({ projectRoot: root, epicId: 'BAD ID', srcDir: src });
  expect(res.published).toEqual([]);
  expect(res.skipped).toEqual([{ path: p, reason: 'unsafe epicId' }]);
  expect(fs.existsSync(p)).toBe(true);
});

test('ingestDir caps at 200 files', async () => {
  for (let i = 0; i < 202; i += 1) mk(`f${String(i).padStart(3, '0')}.txt`, String(i));
  const res = await store.ingestDir({ projectRoot: root, epicId: EPIC, srcDir: src });
  expect(res.published).toHaveLength(200);
  expect(res.skipped).toHaveLength(2);
  expect(res.skipped[0].reason).toMatch(/200-file limit/);
}, 60_000);

test('a corrupt ledger yields [] for that owner and is replaced on the next publish', async () => {
  await pub({ srcPath: mk('one.txt') });
  await store.publishArtifact({ projectRoot: root, epicId: 'epic-two', srcPath: mk('two.txt'), allowedRoots: [src] });
  fs.writeFileSync(path.join(ns(), EPIC, 'index.json'), '{ not json');
  const list = store.listArtifacts(root);
  expect(list.map((e) => [e.ownerId, e.name])).toEqual([['epic-two', 'two.txt']]);

  const again = await pub({ srcPath: mk('three.txt') });
  expect(again.ok).toBe(true);
  const ledger = JSON.parse(fs.readFileSync(path.join(ns(), EPIC, 'index.json'), 'utf8'));
  expect(ledger.entries.map((e) => e.name)).toEqual(['three.txt']);
});

test('a missing ledger or one whose entries is not an array yields [] for that owner', async () => {
  await pub({ srcPath: mk('one.txt') });
  await store.publishArtifact({ projectRoot: root, epicId: 'epic-two', srcPath: mk('two.txt'), allowedRoots: [src] });
  const ledgerFile = path.join(ns(), EPIC, 'index.json');
  fs.writeFileSync(ledgerFile, JSON.stringify({ version: 1, entries: { name: 'one.txt' } }));
  expect(store.listArtifacts(root).map((e) => [e.ownerId, e.name])).toEqual([['epic-two', 'two.txt']]);
  fs.writeFileSync(ledgerFile, '');
  expect(store.listArtifacts(root).map((e) => [e.ownerId, e.name])).toEqual([['epic-two', 'two.txt']]);
  fs.unlinkSync(ledgerFile);
  expect(store.listArtifacts(root).map((e) => [e.ownerId, e.name])).toEqual([['epic-two', 'two.txt']]);
});

test('listArtifacts returns every owner\'s entries newest first; empty store → []', async () => {
  expect(store.listArtifacts(root)).toEqual([]);
  expect(store.listArtifacts('relative')).toEqual([]);
  const write = (dir, entries) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, entries }));
  };
  write(path.join(ns(), 'epic-a'), [
    { name: 'old.txt', createdAt: '2026-11-01T00:00:00.000Z' },
    { name: 'mid.txt', createdAt: '2026-11-10T00:00:00.000Z' },
  ]);
  write(path.join(ns(), 'epic-b'), [{ name: 'new.txt', createdAt: '2026-11-20T00:00:00.000Z' }]);
  write(path.join(ns(), '_tasks', 't9'), [{ name: 'task.txt', createdAt: '2026-11-15T00:00:00.000Z' }]);
  fs.mkdirSync(path.join(ns(), 'epic-empty'));
  expect(store.listArtifacts(root).map((e) => [e.ownerId, e.name])).toEqual([
    ['epic-b', 'new.txt'], ['_tasks/t9', 'task.txt'], ['epic-a', 'mid.txt'], ['epic-a', 'old.txt'],
  ]);
});
