/**
 * projectPages.test.cjs — projectPages.cjs's read-only surface: get() of the
 * single project-pages/home.html ({html|null, mtimeMs}), the refcounted
 * watcher that pushes `project-pages:changed`, and the on-demand
 * `project-pages:md-network` handler.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/projectPages.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

// Capture the real ipcMain.handle registrations, so the md-network case runs
// the registered handler (schema + body). Must precede the requires below.
const ipcHandlers = new Map();
const electronPath = require.resolve('electron');
const electronStub = new Module(electronPath);
electronStub.filename = electronPath;
electronStub.loaded = true;
electronStub.exports = { ipcMain: { handle: (channel, fn) => ipcHandlers.set(channel, fn) } };
require.cache[electronPath] = electronStub;

const config = require('../config.cjs');
const { scanMdNetwork } = require('../lib/mdNetworkScan.cjs');
const {
  get,
  renameEntry,
  deleteEntry,
  attachWindow,
  watchOutput,
  unwatchOutput,
  closeAllOutputWatchers,
  registerProjectPagesIpc,
  _outputWatchers,
} = require('../projectPages.cjs');

const tmpDirs = [];
afterEach(async () => {
  closeAllOutputWatchers();
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkTmpCwd() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-project-pages-'));
  config.addAllowedRoot(dir);
  tmpDirs.push(dir);
  return dir;
}

function pagesDir(cwd) {
  return path.join(cwd, 'session-manager-operations', 'project-pages');
}

function writeHome(cwd, html) {
  fs.mkdirSync(pagesDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(pagesDir(cwd), 'home.html'), html);
}

function demoVideoDir(cwd) {
  return path.join(pagesDir(cwd), 'demo-video');
}

function writeDemoVideo(cwd, html) {
  fs.mkdirSync(demoVideoDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(demoVideoDir(cwd), 'index.html'), html);
}

function makeFakeWindow(sent) {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
}

async function waitFor(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('get() returns the home.html text and its mtimeMs', async () => {
  const cwd = await mkTmpCwd();
  writeHome(cwd, '<html>HOME</html>');
  const result = await get({ cwd });
  expect(result.html).toBe('<html>HOME</html>');
  expect(typeof result.mtimeMs).toBe('number');
  expect(result.demoVideo).toBeNull();
  expect(Object.keys(result).sort()).toEqual(['demoVideo', 'html', 'knowledge', 'mtimeMs', 'videos']);
  expect(result.knowledge.map((e) => e.id)).toEqual(['overview']);
});

test('get() with no home.html returns empty lists and nulls — no shipped default', async () => {
  const cwd = await mkTmpCwd();
  expect(await get({ cwd })).toEqual({ knowledge: [], videos: [], html: null, mtimeMs: null, demoVideo: null });
});

test('get() ignores legacy manifest/lens files — only home.html counts', async () => {
  const cwd = await mkTmpCwd();
  const out = path.join(pagesDir(cwd), 'output');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'home.html'), 'OLD');
  fs.writeFileSync(path.join(out, 'manifest.json'), '{"generatedAt":"2026-08-02T00:00:00.000Z"}');
  expect(await get({ cwd })).toEqual({ knowledge: [], videos: [], html: null, mtimeMs: null, demoVideo: null });
});

test('get() with an ephemeral cwd (os.tmpdir() itself) returns null instead of throwing', async () => {
  config.addAllowedRoot(os.tmpdir());
  expect(await get({ cwd: os.tmpdir() })).toEqual({ knowledge: [], videos: [], html: null, mtimeMs: null, demoVideo: null });
});

test('get() returns demoVideo {path, mtimeMs} when demo-video/index.html exists', async () => {
  const cwd = await mkTmpCwd();
  writeHome(cwd, '<html>HOME</html>');
  writeDemoVideo(cwd, '<html>VIDEO</html>');
  const result = await get({ cwd });
  expect(result.demoVideo).not.toBeNull();
  expect(result.demoVideo.path).toBe(result.videos[0].path);
  expect(result.videos[0].id).toMatch(/^legacy-/);
  expect(typeof result.demoVideo.mtimeMs).toBe('number');
});

test('get() returns demoVideo: null when demo-video/index.html does not exist', async () => {
  const cwd = await mkTmpCwd();
  writeHome(cwd, '<html>HOME</html>');
  const result = await get({ cwd });
  expect(result.demoVideo).toBeNull();
});

test('watchOutput() on an ephemeral cwd refuses instead of crashing', async () => {
  config.addAllowedRoot(os.tmpdir());
  expect(await watchOutput(os.tmpdir())).toEqual({ ok: false, reason: 'ephemeral' });
  expect(_outputWatchers.size).toBe(0);
});

test('watchOutput() is refcounted: two watches share one watcher, closed at the last unwatch', async () => {
  const cwd = await mkTmpCwd();
  expect(await watchOutput(cwd)).toEqual({ ok: true });
  expect(await watchOutput(cwd)).toEqual({ ok: true });
  expect(_outputWatchers.size).toBe(1);
  unwatchOutput(cwd);
  expect(_outputWatchers.size).toBe(1);
  unwatchOutput(cwd);
  expect(_outputWatchers.size).toBe(0);
});

test('watchOutput() pushes {cwd, html, mtimeMs} on project-pages:changed when home.html lands, ignoring sibling files', async () => {
  const cwd = await mkTmpCwd();
  const sent = [];
  attachWindow(makeFakeWindow(sent));

  expect(await watchOutput(cwd)).toEqual({ ok: true });
  expect(_outputWatchers.size).toBe(1);

  fs.writeFileSync(path.join(pagesDir(cwd), 'summary.json'), '{}');
  writeHome(cwd, '<html>HOME</html>');
  await waitFor(() => sent.length > 0);

  expect(sent.length).toBeGreaterThan(0);
  for (const msg of sent) expect(msg.channel).toBe('project-pages:changed');
  const last = sent[sent.length - 1];
  expect(last.payload.cwd).toBe(fs.realpathSync(cwd));
  expect(last.payload.html).toBe('<html>HOME</html>');
  expect(typeof last.payload.mtimeMs).toBe('number');
  // summary.json alone must not have produced a push carrying no html
  expect(sent.every((m) => m.payload.html === '<html>HOME</html>')).toBe(true);

  unwatchOutput(cwd);
  expect(_outputWatchers.size).toBe(0);
}, 10_000);

test('watchOutput() pushes on a write to demo-video/index.html, ignoring other demo-video files', async () => {
  const cwd = await mkTmpCwd();
  const sent = [];
  attachWindow(makeFakeWindow(sent));

  writeHome(cwd, '<html>HOME</html>');
  expect(await watchOutput(cwd)).toEqual({ ok: true });

  fs.mkdirSync(demoVideoDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(demoVideoDir(cwd), 'other.txt'), 'nope');
  writeDemoVideo(cwd, '<html>VIDEO</html>');
  await waitFor(() => sent.length > 0);

  expect(sent.length).toBeGreaterThan(0);
  for (const msg of sent) expect(msg.channel).toBe('project-pages:changed');
  const last = sent[sent.length - 1];
  expect(last.payload.demoVideo).not.toBeNull();
  expect(last.payload.demoVideo.path).toBe(last.payload.videos[0].path);
  expect(typeof last.payload.demoVideo.mtimeMs).toBe('number');

  unwatchOutput(cwd);
  expect(_outputWatchers.size).toBe(0);
}, 10_000);

function writeEntry(cwd, kind, id, meta, html = '<html>X</html>') {
  const dir = path.join(pagesDir(cwd), kind, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
}

function videoMeta(id, createdAt) {
  return {
    id, title: id, kind: 'project-demo', style: 's', lengthS: 30, createdAt, character: null,
    sources: [], report: { lufs: null, truePeakDb: null, speechS: null, readingGrade: null, checks: [], bytes: 1 },
    macroVersion: 1, seedVersion: 1, model: 'm', effort: 'e',
  };
}

test('get() lists two videos newest first and demoVideo is the newest', async () => {
  const cwd = await mkTmpCwd();
  writeEntry(cwd, 'videos', 'older', videoMeta('older', '2026-01-01T00:00:00.000Z'));
  writeEntry(cwd, 'videos', 'newer', videoMeta('newer', '2026-02-01T00:00:00.000Z'));
  const result = await get({ cwd });
  expect(result.videos.map((v) => v.id)).toEqual(['newer', 'older']);
  expect(result.demoVideo.path).toBe(result.videos[0].path);
});

test('get() migrates a legacy home into knowledge/overview and keeps html', async () => {
  const cwd = await mkTmpCwd();
  writeHome(cwd, '<html>LEGACY</html>');
  const result = await get({ cwd });
  expect(result.knowledge.map((k) => k.id)).toEqual(['overview']);
  expect(result.html).toBe('<html>LEGACY</html>');
  expect(fs.existsSync(path.join(pagesDir(cwd), 'home.html.migrated'))).toBe(true);
  expect(fs.existsSync(path.join(pagesDir(cwd), 'home.html'))).toBe(false);
});

test('watchOutput() pushes when a new videos/<id>/meta.json lands', async () => {
  const cwd = await mkTmpCwd();
  const sent = [];
  attachWindow(makeFakeWindow(sent));
  expect(await watchOutput(cwd)).toEqual({ ok: true });
  writeEntry(cwd, 'videos', 'fresh', videoMeta('fresh', '2026-03-01T00:00:00.000Z'));
  await waitFor(() => sent.some((m) => m.payload.videos.length === 1));
  const last = sent[sent.length - 1];
  expect(last.payload.videos.map((v) => v.id)).toEqual(['fresh']);
  expect(Array.isArray(last.payload.knowledge)).toBe(true);
  unwatchOutput(cwd);
}, 10_000);

// ─── rename / delete ──────────────────────────────────────────────────────

function seedEntry(cwd, folder, id, meta) {
  const dir = path.join(pagesDir(cwd), folder, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return dir;
}
const pageMeta = (id, title = 'Old') => ({ id, title, topic: '', createdAt: '2026-01-01T00:00:00.000Z', model: '' });

test('renameEntry rewrites only the title in meta.json', async () => {
  const cwd = await mkTmpCwd();
  const dir = seedEntry(cwd, 'knowledge', 'alpha', pageMeta('alpha'));
  const sib = seedEntry(cwd, 'knowledge', 'beta', pageMeta('beta', 'Beta'));
  await renameEntry({ cwd, kind: 'knowledge', id: 'alpha', title: 'New title' });
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  expect(meta).toEqual({ ...pageMeta('alpha'), title: 'New title' });
  expect(JSON.parse(fs.readFileSync(path.join(sib, 'meta.json'), 'utf8')).title).toBe('Beta');
});

test('deleteEntry removes only that entry folder', async () => {
  const cwd = await mkTmpCwd();
  const dir = seedEntry(cwd, 'knowledge', 'alpha', pageMeta('alpha'));
  const sib = seedEntry(cwd, 'knowledge', 'beta', pageMeta('beta'));
  expect(await deleteEntry({ cwd, kind: 'knowledge', id: 'alpha' })).toEqual({ ok: true });
  expect(fs.existsSync(dir)).toBe(false);
  expect(fs.existsSync(path.join(sib, 'index.html'))).toBe(true);
});

test('rename/delete refuse bad ids, _character, missing entries and bad kinds', async () => {
  const cwd = await mkTmpCwd();
  fs.mkdirSync(path.join(pagesDir(cwd), 'videos', '_character'), { recursive: true });
  for (const fn of [
    (id) => renameEntry({ cwd, kind: 'video', id, title: 'x' }),
    (id) => deleteEntry({ cwd, kind: 'video', id }),
  ]) {
    for (const id of ['../x', 'A', '_character', '', 'a/b']) await expect(fn(id)).rejects.toThrow();
    await expect(fn('missing')).rejects.toThrow(/not found/);
  }
  await expect(deleteEntry({ cwd, kind: 'other', id: 'alpha' })).rejects.toThrow();
  expect(fs.existsSync(path.join(pagesDir(cwd), 'videos', '_character'))).toBe(true);
});

test('rename/delete refuse a symlinked entry and leave its target intact', async () => {
  const cwd = await mkTmpCwd();
  const outside = await mkTmpCwd();
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'k');
  fs.writeFileSync(path.join(outside, 'meta.json'), JSON.stringify(pageMeta('esc')));
  const real = seedEntry(cwd, 'knowledge', 'real', pageMeta('real'));
  fs.symlinkSync(outside, path.join(pagesDir(cwd), 'knowledge', 'esc'));
  fs.symlinkSync(real, path.join(pagesDir(cwd), 'knowledge', 'alias'));
  for (const id of ['esc', 'alias']) {
    await expect(deleteEntry({ cwd, kind: 'knowledge', id })).rejects.toThrow(/outside/);
    await expect(renameEntry({ cwd, kind: 'knowledge', id, title: 'z' })).rejects.toThrow(/outside/);
  }
  expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(outside, 'meta.json'), 'utf8')).title).toBe('Old');
  expect(fs.existsSync(real)).toBe(true);
});

test('renameEntry refuses an invalid title and a corrupt meta.json', async () => {
  const cwd = await mkTmpCwd();
  const dir = seedEntry(cwd, 'knowledge', 'alpha', pageMeta('alpha'));
  await expect(renameEntry({ cwd, kind: 'knowledge', id: 'alpha', title: '' })).rejects.toThrow();
  fs.writeFileSync(path.join(dir, 'meta.json'), '{"nope":1}');
  await expect(renameEntry({ cwd, kind: 'knowledge', id: 'alpha', title: 'ok' })).rejects.toThrow(/meta/);
});

// ─── md-network ───────────────────────────────────────────────────────────

/** A git repo: CLAUDE.md links docs/a.md and a missing doc; docs/orphan.md is unlinked. */
async function mkFixtureRepo() {
  const cwd = await mkTmpCwd();
  fs.mkdirSync(path.join(cwd, 'docs'));
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# Root\n\nSee [a](docs/a.md) and [gone](docs/gone.md).\n');
  fs.writeFileSync(path.join(cwd, 'docs', 'a.md'), '# A\n\nBack to [root](../CLAUDE.md).\n');
  fs.writeFileSync(path.join(cwd, 'docs', 'orphan.md'), '# Orphan\n');
  execFileSync('git', ['init', '-q'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['add', '-A'], { cwd, stdio: 'pipe' });
  return cwd;
}

test('project-pages:md-network returns the scanner result for a repo cwd and refuses a tmpdir cwd', async () => {
  registerProjectPagesIpc();
  const mdNetwork = ipcHandlers.get('project-pages:md-network');
  expect(typeof mdNetwork).toBe('function');

  const cwd = await mkFixtureRepo();
  const result = await mdNetwork({}, { cwd });
  expect(result).toEqual(await scanMdNetwork(fs.realpathSync(cwd)));
  expect(result.ok).toBe(true);
  expect(result.root).toBe('CLAUDE.md');
  expect(result.nodes.map((n) => n.id)).toEqual(['CLAUDE.md', 'docs/a.md']);
  expect(result.edges).toEqual([
    { from: 'CLAUDE.md', to: 'docs/a.md' },
    { from: 'CLAUDE.md', to: 'docs/gone.md', broken: true },
    { from: 'docs/a.md', to: 'CLAUDE.md' },
  ]);
  expect(result.findings.map((f) => [f.type, f.where])).toEqual([
    ['broken-link', 'CLAUDE.md:3 → docs/gone.md'],
    ['orphan', 'docs/'],
  ]);

  config.addAllowedRoot(os.tmpdir());
  const refused = await mdNetwork({}, { cwd: os.tmpdir() });
  expect(refused).toEqual({ ok: false, error: expect.stringMatching(/ephemeral/) });
});
