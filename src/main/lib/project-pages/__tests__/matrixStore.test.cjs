/**
 * matrixStore.test.cjs — Competitor matrix writer: validated write of
 * matrix.json + schema + HTML library entry, history archive and cap.
 *
 * Run: timeout 120 npx vitest run src/main/lib/project-pages/__tests__/matrixStore.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const { writeMatrix, HISTORY_KEEP } = require('../matrixStore.cjs');
const { matrixJsonSchema } = require('../competitiveMatrix.cjs');
const { renderMatrixHtml } = require('../matrixHtml.cjs');
const { listLibrary } = require('../pagesLibrary.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

async function mkTmpCwd() {
  const dir = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-matrix-store-')));
  fs.mkdirSync(path.join(dir, 'session-manager-operations'), { recursive: true });
  config.addAllowedRoot(dir);
  tmpDirs.push(dir);
  return dir;
}

const pages = (cwd) => path.join(cwd, 'session-manager-operations', 'project-pages');
const T = '2026-11-08T12:00:00.000Z';

function buildMatrix(updatedAt = T) {
  const comps = ['claude-desktop', 'opencode'];
  const support = { self: { status: 'no', note: '', sourceIds: [] } };
  for (const c of comps) support[c] = { status: 'yes', note: '', sourceIds: [] };
  return {
    schemaVersion: 1,
    product: { id: 'self', name: 'Session Manager', summary: 'cockpit' },
    competitors: comps.map((id) => ({ id, name: id === 'opencode' ? 'OpenCode' : 'Claude Desktop', category: 'harness', chosenBy: 'user', why: '' })),
    groups: [{ id: 'sessions', title: 'Sessions', description: '' }],
    features: [{
      id: 'f-1', groupId: 'sessions', title: 'Thing', description: 'A thing',
      sentiment: { signal: 'loved', summary: '', sourceIds: [] },
      support,
      recommendation: { priority: 'P1', rationale: '', sessionGoal: 'build it' },
      firstSeenAt: T, updatedAt: T,
    }],
    sources: [],
    runs: [{ at: T, model: 'opus', competitors: ['Claude Desktop', 'OpenCode'], added: ['f-1'], changed: [], notes: '' }],
    updatedAt,
  };
}

test('write lays down matrix.json, schema, HTML entry + meta, and lists in the library', async () => {
  const cwd = await mkTmpCwd();
  const m = buildMatrix();
  const r = await writeMatrix(cwd, m, { model: 'opus' });
  expect(r.ok).toBe(true);
  const mdir = path.join(pages(cwd), 'matrix');
  expect(r.path).toBe(path.join(mdir, 'matrix.json'));
  expect(r.historyPath).toBeNull();
  expect(fs.readFileSync(r.path, 'utf8')).toBe(JSON.stringify(m, null, 2) + '\n');
  expect(JSON.parse(fs.readFileSync(path.join(mdir, 'matrix.schema.json'), 'utf8'))).toEqual(matrixJsonSchema());
  const kdir = path.join(pages(cwd), 'knowledge', 'competitive-matrix');
  expect(r.htmlPath).toBe(path.join(kdir, 'index.html'));
  expect(fs.readFileSync(r.htmlPath, 'utf8')).toBe(renderMatrixHtml(m));
  const meta = JSON.parse(fs.readFileSync(path.join(kdir, 'meta.json'), 'utf8'));
  expect(meta).toMatchObject({
    id: 'competitive-matrix', title: 'Competitor matrix',
    topic: 'Session Manager vs Claude Desktop, OpenCode', model: 'opus',
  });
  const lib = await listLibrary(cwd);
  const entry = lib.knowledge.find((e) => e.id === 'competitive-matrix');
  expect(entry).toBeTruthy();
  expect(entry.error).toBeNull();
  expect(entry.meta.title).toBe('Competitor matrix');
});

test('topic is cut to 120 chars', async () => {
  const cwd = await mkTmpCwd();
  const m = buildMatrix();
  m.product.name = 'P'.repeat(80);
  m.competitors[0].name = 'C'.repeat(80);
  const r = await writeMatrix(cwd, m);
  expect(r.ok).toBe(true);
  const meta = JSON.parse(fs.readFileSync(path.join(pages(cwd), 'knowledge', 'competitive-matrix', 'meta.json'), 'utf8'));
  expect(meta.topic.length).toBe(120);
  expect(meta.model).toBe('');
});

test('invalid matrix returns ok:false and writes nothing', async () => {
  const cwd = await mkTmpCwd();
  const bad = buildMatrix();
  bad.features[0].groupId = 'nope';
  const r = await writeMatrix(cwd, bad);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/groupId/);
  expect(fs.existsSync(pages(cwd))).toBe(false);
});

test('second write archives the previous matrix.json bytes into history/', async () => {
  const cwd = await mkTmpCwd();
  const first = await writeMatrix(cwd, buildMatrix('2026-11-08T12:00:00.000Z'));
  const firstBytes = fs.readFileSync(first.path);
  const second = await writeMatrix(cwd, buildMatrix('2026-11-09T01:02:03.000Z'));
  expect(second.ok).toBe(true);
  expect(second.historyPath).toBe(path.join(pages(cwd), 'matrix', 'history', '20261108T120000Z.json'));
  expect(fs.readFileSync(second.historyPath).equals(firstBytes)).toBe(true);
  expect(JSON.parse(fs.readFileSync(second.path, 'utf8')).updatedAt).toBe('2026-11-09T01:02:03.000Z');
});

test('an invalid previous matrix.json is not archived but the write proceeds', async () => {
  const cwd = await mkTmpCwd();
  const mdir = path.join(pages(cwd), 'matrix');
  fs.mkdirSync(mdir, { recursive: true });
  fs.writeFileSync(path.join(mdir, 'matrix.json'), '{not json');
  const r = await writeMatrix(cwd, buildMatrix());
  expect(r.ok).toBe(true);
  expect(r.historyPath).toBeNull();
  expect(fs.existsSync(path.join(mdir, 'history'))).toBe(false);
});

test('history keeps only the newest HISTORY_KEEP files', async () => {
  const cwd = await mkTmpCwd();
  expect(HISTORY_KEEP).toBe(50);
  const hdir = path.join(pages(cwd), 'matrix', 'history');
  fs.mkdirSync(hdir, { recursive: true });
  const names = [];
  for (let i = 0; i < 55; i++) {
    const name = `2025${String(Math.floor(i / 28) + 1).padStart(2, '0')}${String((i % 28) + 1).padStart(2, '0')}T000000Z.json`;
    names.push(name);
    fs.writeFileSync(path.join(hdir, name), '{}');
  }
  await writeMatrix(cwd, buildMatrix('2026-11-08T12:00:00.000Z'));
  const r = await writeMatrix(cwd, buildMatrix('2026-11-09T12:00:00.000Z'));
  expect(r.ok).toBe(true);
  const left = fs.readdirSync(hdir).sort();
  expect(left.length).toBe(50);
  expect(left[left.length - 1]).toBe('20261108T120000Z.json');
  const expected = [...names, '20261108T120000Z.json'].sort().slice(-50);
  expect(left).toEqual(expected);
});

test('a rendered snapshot validateHomeHtml rejects returns ok:false and writes nothing', async () => {
  const cwd = await mkTmpCwd();
  const render = () => '<!DOCTYPE html><html><body><script src="https://evil.example/x.js"></script></body></html>';
  const r = await writeMatrix(cwd, buildMatrix(), { model: 'opus', renderHtml: render });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/self-contained/);
  expect(fs.existsSync(pages(cwd))).toBe(false);
});

test('rejected snapshot leaves an existing matrix.json and history untouched', async () => {
  const cwd = await mkTmpCwd();
  const first = await writeMatrix(cwd, buildMatrix('2026-11-08T12:00:00.000Z'));
  const before = fs.readFileSync(first.path);
  const r = await writeMatrix(cwd, buildMatrix('2026-11-09T12:00:00.000Z'), {
    renderHtml: () => '<html><body><script src="//evil.example/x.js"></script></body></html>',
  });
  expect(r.ok).toBe(false);
  expect(fs.readFileSync(first.path).equals(before)).toBe(true);
  expect(fs.existsSync(path.join(pages(cwd), 'matrix', 'history'))).toBe(false);
});
