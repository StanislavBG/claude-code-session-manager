/**
 * pagesLibrary.test.cjs — Project Home library listing + one-shot legacy migration.
 *
 * Run: timeout 120 npx vitest run src/main/lib/project-pages/__tests__/pagesLibrary.test.cjs
 */

'use strict';

import { test, expect, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../../../config.cjs');
const { schemas } = require('../../../ipcSchemas.cjs');
const { listLibrary, migrateLegacy } = require('../pagesLibrary.cjs');

const tmpDirs = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

async function mkTmpCwd() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-pages-library-'));
  fs.mkdirSync(path.join(dir, 'session-manager-operations'), { recursive: true });
  config.addAllowedRoot(dir);
  tmpDirs.push(dir);
  return dir;
}
const pagesDir = (cwd) => path.join(cwd, 'session-manager-operations', 'project-pages');

function pageMeta(id, createdAt) {
  return { id, title: id, topic: 't', createdAt, model: 'm' };
}
function videoMeta(id, createdAt) {
  return {
    id, title: id, kind: 'project-demo', style: 's', lengthS: 30, createdAt, character: null,
    sources: [], report: { lufs: null, truePeakDb: null, speechS: null, readingGrade: null, checks: [], bytes: 1 },
    macroVersion: 0, seedVersion: 0, model: 'm', effort: 'e',
  };
}
function putEntry(cwd, kind, id, meta, html = '<p>x</p>') {
  const d = path.join(pagesDir(cwd), kind, id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.html'), html);
  if (meta !== undefined) fs.writeFileSync(path.join(d, 'meta.json'), typeof meta === 'string' ? meta : JSON.stringify(meta));
}

test('empty project lists nothing', async () => {
  const cwd = await mkTmpCwd();
  expect(await listLibrary(cwd)).toEqual({ knowledge: [], videos: [] });
});

test('sorts newest first by createdAt, falling back to mtime', async () => {
  const cwd = await mkTmpCwd();
  putEntry(cwd, 'knowledge', 'old', pageMeta('old', '2026-01-01T00:00:00.000Z'));
  putEntry(cwd, 'knowledge', 'new', pageMeta('new', '2026-03-01T00:00:00.000Z'));
  putEntry(cwd, 'knowledge', 'nometa', undefined); // mtime = now -> newest
  const { knowledge } = await listLibrary(cwd);
  expect(knowledge.map((e) => e.id)).toEqual(['nometa', 'new', 'old']);
  expect(knowledge[1].meta.id).toBe('new');
  expect(knowledge[1].path).toBe(path.join(pagesDir(cwd), 'knowledge', 'new', 'index.html'));
  expect(typeof knowledge[1].mtimeMs).toBe('number');
});

test('invalid or missing meta is reported, not dropped', async () => {
  const cwd = await mkTmpCwd();
  putEntry(cwd, 'knowledge', 'bad', { id: 'bad' });
  putEntry(cwd, 'videos', 'garbled', '{not json');
  putEntry(cwd, 'videos', 'missing', undefined);
  putEntry(cwd, 'videos', 'good', videoMeta('good', '2026-01-01T00:00:00.000Z'));
  const lib = await listLibrary(cwd);
  expect(lib.knowledge[0]).toMatchObject({ id: 'bad', meta: null });
  expect(lib.knowledge[0].error).toMatch(/\S/);
  expect(lib.knowledge[0].error).not.toMatch(/\n/);
  const byId = Object.fromEntries(lib.videos.map((e) => [e.id, e]));
  expect(byId.garbled.meta).toBeNull();
  expect(byId.garbled.error).toBeTruthy();
  expect(byId.missing.meta).toBeNull();
  expect(byId.missing.error).toBeTruthy();
  expect(byId.good.error).toBeNull();
  expect(byId.good.meta.id).toBe('good');
});

test('videos/_character is never listed', async () => {
  const cwd = await mkTmpCwd();
  putEntry(cwd, 'videos', '_character', undefined);
  putEntry(cwd, 'videos', 'a', videoMeta('a', '2026-01-01T00:00:00.000Z'));
  expect((await listLibrary(cwd)).videos.map((e) => e.id)).toEqual(['a']);
});

test('migrates legacy home.html and demo video, then renames them', async () => {
  const cwd = await mkTmpCwd();
  const dir = pagesDir(cwd);
  fs.mkdirSync(path.join(dir, 'demo-video'), { recursive: true });
  const home = '<h1>Home é</h1>';
  const demo = '<html><head><meta name="sm-demo-duration" content="42"></head></html>';
  fs.writeFileSync(path.join(dir, 'home.html'), home);
  fs.writeFileSync(path.join(dir, 'demo-video', 'index.html'), demo);

  await migrateLegacy(cwd);

  const overview = path.join(dir, 'knowledge', 'overview');
  expect(fs.readFileSync(path.join(overview, 'index.html'), 'utf8')).toBe(home);
  const pm = JSON.parse(fs.readFileSync(path.join(overview, 'meta.json'), 'utf8'));
  expect(schemas.projectPageMeta.safeParse(pm).success).toBe(true);
  expect(pm).toMatchObject({ title: 'Overview', topic: 'overview', model: 'unknown' });

  const hex = crypto.createHash('sha256').update(demo).digest('hex').slice(0, 10);
  const vdir = path.join(dir, 'videos', `legacy-${hex}`);
  expect(fs.readFileSync(path.join(vdir, 'index.html'), 'utf8')).toBe(demo);
  const vm = JSON.parse(fs.readFileSync(path.join(vdir, 'meta.json'), 'utf8'));
  expect(schemas.projectVideoMeta.safeParse(vm).success).toBe(true);
  expect(vm).toMatchObject({ kind: 'project-demo', lengthS: 42 });
  expect(vm.report.checks).toEqual([]);
  expect(vm.report.lufs).toBeNull();

  expect(fs.existsSync(path.join(dir, 'home.html'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'home.html.migrated'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'demo-video', 'index.html'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'demo-video', 'index.html.migrated'))).toBe(true);

  const lib = await listLibrary(cwd);
  expect(lib.knowledge.map((e) => e.id)).toEqual(['overview']);
  expect(lib.videos).toHaveLength(1);
  expect(lib.videos[0].error).toBeNull();
});

test('demo without duration meta defaults to 30s', async () => {
  const cwd = await mkTmpCwd();
  fs.mkdirSync(path.join(pagesDir(cwd), 'demo-video'), { recursive: true });
  fs.writeFileSync(path.join(pagesDir(cwd), 'demo-video', 'index.html'), '<p>d</p>');
  await migrateLegacy(cwd);
  const [v] = (await listLibrary(cwd)).videos;
  expect(v.meta.lengthS).toBe(30);
});

test('second call is a no-op and a deleted entry never returns', async () => {
  const cwd = await mkTmpCwd();
  fs.mkdirSync(pagesDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(pagesDir(cwd), 'home.html'), '<p>h</p>');
  await migrateLegacy(cwd);
  const spy = vi.spyOn(config, 'writeTextAtomic');
  await migrateLegacy(cwd);
  expect(spy).not.toHaveBeenCalled();
  await fsp.rm(path.join(pagesDir(cwd), 'knowledge', 'overview'), { recursive: true });
  await migrateLegacy(cwd);
  expect((await listLibrary(cwd)).knowledge).toEqual([]);
});

test('a failed copy leaves the legacy file in place', async () => {
  const cwd = await mkTmpCwd();
  fs.mkdirSync(pagesDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(pagesDir(cwd), 'home.html'), '<p>h</p>');
  vi.spyOn(config, 'writeTextAtomic').mockRejectedValue(new Error('disk full'));
  await migrateLegacy(cwd).catch(() => {});
  expect(fs.existsSync(path.join(pagesDir(cwd), 'home.html'))).toBe(true);
  expect(fs.existsSync(path.join(pagesDir(cwd), 'home.html.migrated'))).toBe(false);
});
