'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateProject } = require('../archivedTranscriptMigration.cjs');
const { readSidecar } = require('../archivedTranscript.cjs');
const { opsPath } = require('../../opsOwnership.cjs');

let cwd;
let dir;
const text = '{"type":"assistant","message":{"content":"héllo"}}\n'.repeat(40);
const put = (id, obj) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(obj));
const read = (id) => fs.readFileSync(path.join(dir, `${id}.json`), 'utf8');

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-migrate-'));
  dir = opsPath(cwd, 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

test('migrates, sidecar round-trips, second run is a no-op', async () => {
  put('e1', { id: 'e1', status: 'completed', transcript: text });
  const r = await migrateProject(cwd);
  expect(r.migrated).toBe(1);
  expect(r.errors).toEqual([]);
  expect(r.freedBytes).toBeGreaterThan(0);
  const doc = JSON.parse(read('e1'));
  expect(doc.transcript).toBeUndefined();
  expect(doc.transcriptRef.sha256).toHaveLength(64);
  expect(readSidecar(cwd, 'e1')).toBe(text);
  const again = await migrateProject(cwd);
  expect(again.migrated).toBe(0);
  expect(again.errors).toEqual([]);
});

test('sha mismatch leaves the file byte-identical and records an error', async () => {
  put('e1', { id: 'e1', status: 'completed', transcript: text });
  const before = read('e1');
  const r = await migrateProject(cwd, { deps: { readSidecar: () => 'tampered' } });
  expect(r.migrated).toBe(0);
  expect(r.errors).toHaveLength(1);
  expect(read('e1')).toBe(before);
});

test('active Epic and active-index.json are untouched', async () => {
  put('a1', { id: 'a1', status: 'active', transcript: text });
  fs.writeFileSync(path.join(dir, 'active-index.json'), JSON.stringify({ transcript: text }));
  const b1 = read('a1');
  const b2 = read('active-index');
  const r = await migrateProject(cwd);
  expect(r.migrated).toBe(0);
  expect(read('a1')).toBe(b1);
  expect(read('active-index')).toBe(b2);
});

test('dryRun writes nothing', async () => {
  put('e1', { id: 'e1', status: 'completed', transcript: text });
  const before = read('e1');
  const r = await migrateProject(cwd, { dryRun: true });
  expect(r.migrated).toBe(1);
  expect(read('e1')).toBe(before);
  expect(readSidecar(cwd, 'e1')).toBeNull();
});

test('limit caps files migrated per call', async () => {
  for (const id of ['e1', 'e2', 'e3']) put(id, { id, status: 'completed', transcript: text });
  const r = await migrateProject(cwd, { limit: 2 });
  expect(r.migrated).toBe(2);
});
