/**
 * projectPages.test.cjs — unit tests for projectPages.cjs's read-only get(),
 * including the regression this PRD's AC calls out explicitly: adding the
 * 5th 'brief' lens must not make every pre-existing 4-lens project suddenly
 * read as having no output at all — and the shipped-default fallback added
 * by the "project-home-hosted-html-spec" PRD: a project with no generated
 * output gets the build-time default home.html (isDefault: true) instead of
 * the bare `{ output: null }` empty-state signal.
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
  DEFAULT_HOME_PATH,
  readDefaultHomeHtml,
  attachWindow,
  watchOutput,
  unwatchOutput,
  closeAllOutputWatchers,
  _outputWatchers,
} = require('../projectPages.cjs');

const tmpDirs = [];
afterEach(async () => {
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

function outputDir(cwd) {
  return path.join(cwd, 'session-manager-operations', 'project-pages', 'output');
}

function writeOutput(cwd, lenses, manifest = { generatedAt: '2026-08-02T00:00:00.000Z' }) {
  const dir = outputDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const [lens, html] of Object.entries(lenses)) {
    fs.writeFileSync(path.join(dir, `${lens}.html`), html);
  }
}

test('the shipped default asset exists on disk at a fixed app-relative path', () => {
  expect(fs.existsSync(DEFAULT_HOME_PATH)).toBe(true);
  expect(path.isAbsolute(DEFAULT_HOME_PATH)).toBe(true);
});

test('(a) generated output present: get() returns it with isDefault false', async () => {
  const cwd = await mkTmpCwd();
  writeOutput(cwd, {
    home: 'HOME',
    marketing: 'MARKETING',
    feature: 'FEATURE',
    architecture: 'ARCHITECTURE',
    brief: 'BRIEF',
  });
  const result = await get({ cwd });
  expect(result.output).not.toBeNull();
  expect(result.output.home).toBe('HOME');
  expect(result.output.brief).toBe('BRIEF');
  expect(result.output.generatedAt).toBe('2026-08-02T00:00:00.000Z');
  expect(result.output.isDefault).toBe(false);
});

// The regression this PRD's AC explicitly guards against: a project that
// generated its output BEFORE the 'brief' lens existed has the original 4
// files but no brief.html — that must still read as "has output", not the
// shipped-default fallback, and `brief` must simply be absent from the payload.
test('4 original lenses present but brief.html missing still returns generated output, with brief omitted', async () => {
  const cwd = await mkTmpCwd();
  writeOutput(cwd, {
    home: 'HOME',
    marketing: 'MARKETING',
    feature: 'FEATURE',
    architecture: 'ARCHITECTURE',
  });
  const result = await get({ cwd });
  expect(result.output).not.toBeNull();
  expect(result.output.home).toBe('HOME');
  expect(result.output.marketing).toBe('MARKETING');
  expect(result.output.feature).toBe('FEATURE');
  expect(result.output.architecture).toBe('ARCHITECTURE');
  expect(result.output.brief).toBeUndefined();
  expect(result.output.isDefault).toBe(false);
});

// (b) output absent → returns the shipped default with isDefault true.
test('(b) no manifest at all: get() returns the shipped default with isDefault true', async () => {
  const cwd = await mkTmpCwd();
  const result = await get({ cwd });
  expect(result.output).not.toBeNull();
  expect(result.output.isDefault).toBe(true);
  expect(result.output.generatedAt).toBeNull();
  expect(result.output.home).toBe(readDefaultHomeHtml());
  expect(result.output.marketing).toBeUndefined();
  expect(result.output.feature).toBeUndefined();
  expect(result.output.architecture).toBeUndefined();
});

test('one of the required 4 lenses missing falls back to the shipped default, even if brief.html exists', async () => {
  const cwd = await mkTmpCwd();
  writeOutput(cwd, {
    home: 'HOME',
    marketing: 'MARKETING',
    feature: 'FEATURE',
    // architecture.html deliberately missing
    brief: 'BRIEF',
  });
  const result = await get({ cwd });
  expect(result.output).not.toBeNull();
  expect(result.output.isDefault).toBe(true);
  expect(result.output.home).toBe(readDefaultHomeHtml());
});

test('manifest with no generatedAt string falls back to the shipped default', async () => {
  const cwd = await mkTmpCwd();
  writeOutput(
    cwd,
    { home: 'HOME', marketing: 'MARKETING', feature: 'FEATURE', architecture: 'ARCHITECTURE', brief: 'BRIEF' },
    {},
  );
  const result = await get({ cwd });
  expect(result.output).not.toBeNull();
  expect(result.output.isDefault).toBe(true);
});

// (c) the default path resolution does not depend on cwd.
test('(c) default fallback content is identical regardless of which project cwd requests it', async () => {
  const cwdA = await mkTmpCwd();
  const cwdB = await mkTmpCwd();
  const resultA = await get({ cwd: cwdA });
  const resultB = await get({ cwd: cwdB });
  expect(resultA.output.isDefault).toBe(true);
  expect(resultB.output.isDefault).toBe(true);
  expect(resultA.output.home).toBe(resultB.output.home);
  expect(resultA.output.home).toBe(readDefaultHomeHtml());
});

test('the shipped default is honest: no fabricated project-specific content, and prompts Generate My Project Home', () => {
  const html = readDefaultHomeHtml();
  expect(html).toContain('Generate My Project Home');
  expect(html.toLowerCase()).not.toContain('lorem ipsum');
});

// ── ephemeral cwd: get() must fall back, never throw/reject ────────────────
test('get() with an ephemeral cwd (os.tmpdir() itself) returns the shipped default instead of throwing', async () => {
  config.addAllowedRoot(os.tmpdir());
  const result = await get({ cwd: os.tmpdir() });
  expect(result.output).not.toBeNull();
  expect(result.output.isDefault).toBe(true);
});

// ── watcher ──────────────────────────────────────────────────────────────
afterEach(() => {
  closeAllOutputWatchers();
});

test('watchOutput() on an ephemeral cwd refuses instead of crashing', async () => {
  config.addAllowedRoot(os.tmpdir());
  const result = await watchOutput(os.tmpdir());
  expect(result).toEqual({ ok: false, reason: 'ephemeral' });
  expect(_outputWatchers.size).toBe(0);
});

test('watchOutput() pushes project-pages:changed when manifest.json appears, and unwatchOutput() tears it down', async () => {
  const cwd = await mkTmpCwd();
  const sent = [];
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
  attachWindow(fakeWindow);

  const watchResult = await watchOutput(cwd);
  expect(watchResult).toEqual({ ok: true });
  expect(_outputWatchers.size).toBe(1);

  writeOutput(cwd, {
    home: 'HOME',
    marketing: 'MARKETING',
    feature: 'FEATURE',
    architecture: 'ARCHITECTURE',
  });

  // Bounded poll for the debounced (awaitWriteFinish) push instead of a bare
  // sleep — chokidar's stability window is 50ms, so this gives it generous
  // headroom without hanging the suite on a broken watcher.
  const deadline = Date.now() + 5000;
  while (sent.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  expect(sent.length).toBeGreaterThan(0);
  const last = sent[sent.length - 1];
  expect(last.channel).toBe('project-pages:changed');
  expect(last.payload.cwd).toBe(fs.realpathSync(cwd));
  expect(last.payload.output.isDefault).toBe(false);
  expect(last.payload.output.home).toBe('HOME');

  unwatchOutput(cwd);
  expect(_outputWatchers.size).toBe(0);
}, 10_000);
