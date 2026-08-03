/**
 * projectPages.test.cjs — unit tests for projectPages.cjs's read-only get(),
 * including the regression this PRD's AC calls out explicitly: adding the
 * 5th 'brief' lens must not make every pre-existing 4-lens project suddenly
 * read as having no output at all.
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
const { get } = require('../projectPages.cjs');

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

test('returns output: null when no manifest exists', async () => {
  const cwd = await mkTmpCwd();
  const result = await get({ cwd });
  expect(result.output).toBeNull();
});

test('returns all 5 lenses when all 5 html files are present', async () => {
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
});

// The regression this PRD's AC explicitly guards against: a project that
// generated its output BEFORE the 'brief' lens existed has the original 4
// files but no brief.html — that must still read as "has output", not the
// null empty-state signal, and `brief` must simply be absent from the payload.
test('4 original lenses present but brief.html missing still returns output, with brief omitted', async () => {
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
});

test('returns output: null when one of the required 4 lenses is missing, even if brief.html exists', async () => {
  const cwd = await mkTmpCwd();
  writeOutput(cwd, {
    home: 'HOME',
    marketing: 'MARKETING',
    feature: 'FEATURE',
    // architecture.html deliberately missing
    brief: 'BRIEF',
  });
  const result = await get({ cwd });
  expect(result.output).toBeNull();
});

test('returns output: null when manifest has no generatedAt string', async () => {
  const cwd = await mkTmpCwd();
  writeOutput(
    cwd,
    { home: 'HOME', marketing: 'MARKETING', feature: 'FEATURE', architecture: 'ARCHITECTURE', brief: 'BRIEF' },
    {},
  );
  const result = await get({ cwd });
  expect(result.output).toBeNull();
});
