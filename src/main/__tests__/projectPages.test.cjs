/**
 * projectPages.test.cjs — projectPages.cjs's read-only surface: get() of the
 * single project-pages/home.html ({html|null, mtimeMs}) plus the refcounted
 * watcher that pushes `project-pages:changed`.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/projectPages.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');
const {
  get,
  attachWindow,
  watchOutput,
  unwatchOutput,
  closeAllOutputWatchers,
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
  expect(Object.keys(result).sort()).toEqual(['html', 'mtimeMs']);
});

test('get() with no home.html returns {html: null, mtimeMs: null} — no shipped default', async () => {
  const cwd = await mkTmpCwd();
  expect(await get({ cwd })).toEqual({ html: null, mtimeMs: null });
});

test('get() ignores legacy manifest/lens files — only home.html counts', async () => {
  const cwd = await mkTmpCwd();
  const out = path.join(pagesDir(cwd), 'output');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'home.html'), 'OLD');
  fs.writeFileSync(path.join(out, 'manifest.json'), '{"generatedAt":"2026-08-02T00:00:00.000Z"}');
  expect(await get({ cwd })).toEqual({ html: null, mtimeMs: null });
});

test('get() with an ephemeral cwd (os.tmpdir() itself) returns null instead of throwing', async () => {
  config.addAllowedRoot(os.tmpdir());
  expect(await get({ cwd: os.tmpdir() })).toEqual({ html: null, mtimeMs: null });
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
