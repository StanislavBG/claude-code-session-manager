/**
 * publish-gate.test.cjs — the publish gate that stops a stale
 * * or missing Project Pages bundle from
 * shipping in the npm tarball. See web/project-pages/publish-gate.cjs.
 *
 * Run: timeout 300 npx vitest run web/project-pages/__tests__/publish-gate.test.cjs
 */

'use strict';

import { test, expect, afterEach, beforeAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const gate = require('../publish-gate.cjs');

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function mkFixtureRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pp-gate-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'src/renderer/lib/projectPages/library'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/renderer/lib/projectPages/render.tsx'), '// fixture\n');
  return dir;
}

function writeBundles(root, { mtime } = {}) {
  for (const rel of gate.BUNDLES.map((b) => b.path)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'module.exports = {};\n');
    if (mtime) fs.utimesSync(abs, mtime, mtime);
  }
}

test('missing bundle fails, naming the file and the npm script that builds it', () => {
  const root = mkFixtureRoot();
  const result = gate.checkBundles(root);
  expect(result.ok).toBe(false);
  const joined = result.errors.join('\n');
  expect(joined).toContain('web/project-pages/renderer/dist/renderer.cjs');
  expect(joined).toContain('npm run build:project-pages');
  expect(joined).toContain('web/project-pages/logic/dist/logic.cjs');
  expect(joined).toContain('npm run build:project-pages-logic');
});

test('stale bundle fails, naming the newer source file', () => {
  const root = mkFixtureRoot();
  const old = new Date(Date.now() - 60_000);
  writeBundles(root, { mtime: old });
  const newer = path.join(root, 'src/renderer/lib/projectPages/library/homeSlots.tsx');
  fs.writeFileSync(newer, '// newer than the bundle\n');
  // Explicit mtime: render.tsx (from mkFixtureRoot) and this file can land in
  // the same millisecond, and "newest" is a strict > comparison — pin it so
  // the assertion never depends on write timing.
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(newer, future, future);
  const result = gate.checkBundles(root);
  expect(result.ok).toBe(false);
  expect(result.errors.join('\n')).toContain('src/renderer/lib/projectPages/library/homeSlots.tsx');
});

test('fresh bundles pass in a fixture', () => {
  const root = mkFixtureRoot();
  writeBundles(root);
  const result = gate.checkBundles(root);
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);
});

// The real-repo gate needs the (gitignored) bundles present and fresh, exactly
// as prepublishOnly produces them — build them first so a fresh clone passes
// too. esbuild finishes in a few seconds; bounded anyway.
beforeAll(() => {
  for (const script of ['web/project-pages/build-renderer.mjs', 'web/project-pages/build-logic.mjs']) {
    execFileSync('node', [script], { cwd: REPO_ROOT, timeout: 120_000, stdio: 'pipe' });
  }
}, 150_000);

test('the gate passes on the real repo state', () => {
  const result = gate.runGate(REPO_ROOT);
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);
});
