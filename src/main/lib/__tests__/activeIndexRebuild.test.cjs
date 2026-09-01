/**
 * activeIndexRebuild.test.cjs — rebuildActiveIndex reconstructs
 * active-index.json's `sessions` map from the per-Epic status mirrors
 * epicStatusMirror.cjs writes, honoring tombstones and archivedAt exactly
 * the way the domain model requires (never resurrecting either).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/activeIndexRebuild.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { rebuildActiveIndex } = require('../activeIndexRebuild.cjs');
const { activeIndexPath, readActiveIndex } = require('../epicMint.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkCwd() {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-rebuild-cwd-'));
  tmpDirs.push(cwd);
  return cwd;
}

function promptSessionsDir(cwd) {
  return path.join(cwd, 'session-manager-operations', 'prompt-sessions');
}

function writeMirrorFile(cwd, id, data) {
  const dir = promptSessionsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(data, null, 2));
}

function writeIndex(cwd, index) {
  const dir = promptSessionsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'active-index.json'), JSON.stringify(index, null, 2));
}

function liveMirror(id, cwd, overrides = {}) {
  return {
    id,
    cwd,
    goalText: `goal for ${id}`,
    claudeSessionId: `sess-${id}`,
    status: 'proposed',
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    indexedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

test('restores a row for every mirrored file with a live status', async () => {
  const cwd = await mkCwd();
  writeMirrorFile(cwd, 'e-1', liveMirror('e-1', cwd, { status: 'proposed' }));
  writeMirrorFile(cwd, 'e-2', liveMirror('e-2', cwd, { status: 'active' }));

  const { rows, skipped, reasons } = await rebuildActiveIndex(cwd);

  expect(rows.map((r) => r.id).sort()).toEqual(['e-1', 'e-2']);
  expect(skipped).toEqual([]);
  expect(reasons).toEqual({});

  const onDisk = readActiveIndex(cwd);
  expect(onDisk.sessions['e-1'].status).toBe('proposed');
  expect(onDisk.sessions['e-2'].status).toBe('active');
});

test('respects tombstones — a tombstoned id is never resurrected even if its file says active', async () => {
  const cwd = await mkCwd();
  writeIndex(cwd, { sessions: {}, events: {}, tombstones: { 'e-dead': '2026-01-02T00:00:00.000Z' } });
  writeMirrorFile(cwd, 'e-dead', liveMirror('e-dead', cwd, { status: 'active' }));
  writeMirrorFile(cwd, 'e-alive', liveMirror('e-alive', cwd, { status: 'proposed' }));

  const { rows, skipped, reasons } = await rebuildActiveIndex(cwd);

  expect(rows.map((r) => r.id)).toEqual(['e-alive']);
  expect(skipped).toContain('e-dead.json');
  expect(reasons['e-dead.json']).toMatch(/tombstoned/);

  const onDisk = readActiveIndex(cwd);
  expect(onDisk.sessions['e-dead']).toBeUndefined();
  expect(onDisk.tombstones['e-dead']).toBe('2026-01-02T00:00:00.000Z');
});

test('respects archivedAt — a completed Epic file is never restored as a live row', async () => {
  const cwd = await mkCwd();
  writeMirrorFile(cwd, 'e-done', {
    ...liveMirror('e-done', cwd, { status: 'completed' }),
    archivedAt: '2026-01-03T00:00:00.000Z',
  });
  writeMirrorFile(cwd, 'e-open', liveMirror('e-open', cwd, { status: 'active' }));

  const { rows, skipped, reasons } = await rebuildActiveIndex(cwd);

  expect(rows.map((r) => r.id)).toEqual(['e-open']);
  expect(skipped).toContain('e-done.json');
  expect(reasons['e-done.json']).toMatch(/archivedAt/);
});

test('is idempotent — running it twice on a clean project yields a byte-identical index', async () => {
  const cwd = await mkCwd();
  writeMirrorFile(cwd, 'e-1', liveMirror('e-1', cwd));
  writeMirrorFile(cwd, 'e-2', liveMirror('e-2', cwd, { status: 'active' }));

  await rebuildActiveIndex(cwd);
  const first = fs.readFileSync(activeIndexPath(cwd), 'utf8');

  await rebuildActiveIndex(cwd);
  const second = fs.readFileSync(activeIndexPath(cwd), 'utf8');

  expect(second).toBe(first);
});

test('skips an unreadable Epic file, naming it in reasons, without aborting the rebuild', async () => {
  const cwd = await mkCwd();
  const dir = promptSessionsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'e-corrupt.json'), '{ this is not json');
  writeMirrorFile(cwd, 'e-good', liveMirror('e-good', cwd));

  const { rows, skipped, reasons } = await rebuildActiveIndex(cwd);

  expect(rows.map((r) => r.id)).toEqual(['e-good']);
  expect(skipped).toContain('e-corrupt.json');
  expect(reasons['e-corrupt.json']).toMatch(/unreadable/);
});

test('a file with no mirrored status is skipped and listed with a reason, never guessed at', async () => {
  const cwd = await mkCwd();
  const dir = promptSessionsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'e-legacy.json'), JSON.stringify({ id: 'e-legacy', cwd }));

  const { rows, skipped, reasons } = await rebuildActiveIndex(cwd);

  expect(rows).toEqual([]);
  expect(skipped).toContain('e-legacy.json');
  expect(reasons['e-legacy.json']).toMatch(/no status mirror/);
});

test('preserves the existing events and tombstones maps untouched', async () => {
  const cwd = await mkCwd();
  const events = { 'e-1': [{ id: 'evt-1', promptSessionId: 'e-1', kind: 'prompt', causedByEventId: null, at: '2026-01-01T00:00:00.000Z', text: 'go' }] };
  const tombstones = { 'e-old': '2026-01-01T00:00:00.000Z' };
  writeIndex(cwd, { sessions: {}, events, tombstones });
  writeMirrorFile(cwd, 'e-1', liveMirror('e-1', cwd));

  await rebuildActiveIndex(cwd);

  const onDisk = readActiveIndex(cwd);
  expect(onDisk.events).toEqual(events);
  expect(onDisk.tombstones).toEqual(tombstones);
});

test('dryRun previews without writing anything to disk', async () => {
  const cwd = await mkCwd();
  writeIndex(cwd, { sessions: {}, events: {}, tombstones: {} });
  writeMirrorFile(cwd, 'e-1', liveMirror('e-1', cwd));

  const before = fs.readFileSync(activeIndexPath(cwd), 'utf8');
  const { rows } = await rebuildActiveIndex(cwd, { dryRun: true });
  const after = fs.readFileSync(activeIndexPath(cwd), 'utf8');

  expect(rows.map((r) => r.id)).toEqual(['e-1']);
  expect(after).toBe(before);
});
