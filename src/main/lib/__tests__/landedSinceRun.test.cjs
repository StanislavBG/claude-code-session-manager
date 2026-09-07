/**
 * landedSinceRun.test.cjs — the widened, path-scoped commit evidence helper
 * behind reverifyNeedsReview's looksDone annotation (PRD 1102).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/landedSinceRun.test.cjs
 */

'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { landedSinceRun, landedOnMainSince } = require('../landedSinceRun.cjs');

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'landed-since-run-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  return dir;
}

// -b main pins the branch name regardless of the host's init.defaultBranch
// config — landedOnMainSince's tests need a deterministic 'main' ref.
function mkRepoOnMain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'landed-on-main-'));
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  return dir;
}

function commitFile(dir, relPath, content, message) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  execFileSync('git', ['-C', dir, 'add', relPath]);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', message]);
}

test('finds a commit landed after sinceIso that touches a declared path', async () => {
  const dir = mkRepo();
  const since = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 1100)); // git --since has 1s resolution
  commitFile(dir, 'src/foo.js', 'hello', 'touch foo');
  const shas = await landedSinceRun(dir, since, ['src/foo.js']);
  assert.strictEqual(shas.length, 1);
});

test('ignores a commit that does not touch any declared path', async () => {
  const dir = mkRepo();
  const since = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 1100));
  commitFile(dir, 'src/unrelated.js', 'hello', 'touch unrelated');
  const shas = await landedSinceRun(dir, since, ['src/foo.js']);
  assert.deepStrictEqual(shas, []);
});

test('empty paths never fabricates evidence — resolves []', async () => {
  const dir = mkRepo();
  commitFile(dir, 'src/foo.js', 'hello', 'touch foo');
  const shas = await landedSinceRun(dir, new Date(0).toISOString(), []);
  assert.deepStrictEqual(shas, []);
});

test('no cwd resolves [] without throwing', async () => {
  const shas = await landedSinceRun(null, new Date().toISOString(), ['src/foo.js']);
  assert.deepStrictEqual(shas, []);
});

test('git-unavailable (non-repo cwd) resolves [] without throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'landed-since-run-norepo-'));
  const shas = await landedSinceRun(dir, new Date().toISOString(), ['src/foo.js']);
  assert.deepStrictEqual(shas, []);
});

test('has a bounded default timeout', () => {
  const { LANDED_SINCE_RUN_TIMEOUT_MS } = require('../landedSinceRun.cjs');
  assert.ok(LANDED_SINCE_RUN_TIMEOUT_MS > 0 && LANDED_SINCE_RUN_TIMEOUT_MS <= 60_000);
});

// landedOnMainSince — PRD 1136's already-satisfied-on-main evidence query:
// scoped to `main` (not --all) and to the PRD's declared paths.

test('landedOnMainSince: finds a commit on main after sinceIso touching a declared path', async () => {
  const dir = mkRepoOnMain();
  commitFile(dir, 'README.md', 'hello', 'initial');
  const since = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 1100));
  commitFile(dir, 'src/foo.js', 'hello', 'fix foo');
  const shas = await landedOnMainSince(dir, since, ['src/foo.js']);
  assert.strictEqual(shas.length, 1);
});

test('landedOnMainSince: ignores a commit that does not touch any declared path', async () => {
  const dir = mkRepoOnMain();
  commitFile(dir, 'README.md', 'hello', 'initial');
  const since = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 1100));
  commitFile(dir, 'src/unrelated.js', 'hello', 'touch unrelated');
  const shas = await landedOnMainSince(dir, since, ['src/foo.js']);
  assert.deepStrictEqual(shas, []);
});

test('landedOnMainSince: a commit older than sinceIso is not evidence', async () => {
  const dir = mkRepoOnMain();
  commitFile(dir, 'src/foo.js', 'hello', 'fix foo');
  await new Promise((r) => setTimeout(r, 1100));
  const since = new Date().toISOString();
  const shas = await landedOnMainSince(dir, since, ['src/foo.js']);
  assert.deepStrictEqual(shas, []);
});

test('landedOnMainSince: empty paths never fabricates evidence — resolves []', async () => {
  const dir = mkRepoOnMain();
  commitFile(dir, 'src/foo.js', 'hello', 'fix foo');
  const shas = await landedOnMainSince(dir, new Date(0).toISOString(), []);
  assert.deepStrictEqual(shas, []);
});

test('landedOnMainSince: no cwd resolves [] without throwing', async () => {
  const shas = await landedOnMainSince(null, new Date().toISOString(), ['src/foo.js']);
  assert.deepStrictEqual(shas, []);
});

test('landedOnMainSince: git-unavailable (non-repo cwd) resolves [] without throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'landed-on-main-norepo-'));
  const shas = await landedOnMainSince(dir, new Date().toISOString(), ['src/foo.js']);
  assert.deepStrictEqual(shas, []);
});
