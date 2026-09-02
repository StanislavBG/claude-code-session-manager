/**
 * gitWorktreeSalvageDelta.test.cjs — PRD 1098: `salvageDirtyDelta` is the
 * shared-tree counterpart to `salvageWorktreeDiff` (gitWorktreeSalvage.test.cjs)
 * — it salvages an IN-PLACE job's uncommitted work without a throwaway
 * worktree checkout to diff and discard, so it must be strictly DELTA-scoped
 * (only the caller-supplied paths, never a whole-tree dump) and must never
 * mutate the shared tree (no add/stash/reset/checkout/clean) the way
 * `salvageWorktreeDiff`'s `git add -A --intent-to-add` deliberately can
 * against a disposable checkout.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/gitWorktreeSalvageDelta.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gitWorktree = require('../gitWorktree.cjs');

let tmpRoot;
let repoCwd;
let outDir;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'tracked-a.txt'), 'a\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'tracked-b.txt'), 'b\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-gitworktree-salvage-delta-'));
  repoCwd = path.join(tmpRoot, 'repo');
  initRepo(repoCwd);
  outDir = fs.mkdtempSync(path.join(os.homedir(), '.claude', 'sm-test-salvage-delta-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('salvages only the given delta paths (tracked edit + untracked new file), never a pre-existing dirty file outside the delta', async () => {
  // Pre-existing WIP that must NEVER appear in the patch — the whole point
  // of delta-scoping.
  fs.writeFileSync(path.join(repoCwd, 'tracked-b.txt'), 'b\npre-existing human WIP\n', 'utf8');

  // This job's own delta: an edit to tracked-a.txt and a new untracked file.
  fs.writeFileSync(path.join(repoCwd, 'tracked-a.txt'), 'a\nedited by job\n', 'utf8');
  fs.writeFileSync(path.join(repoCwd, 'job-new-file.txt'), 'brand new job output\n', 'utf8');

  const outFile = path.join(outDir, 'delta.uncommitted.patch');
  const result = await gitWorktree.salvageDirtyDelta({
    cwd: repoCwd,
    paths: ['tracked-a.txt', 'job-new-file.txt'],
    outFile,
  });

  expect(result.ok).toBe(true);
  expect(result.bytes).toBeGreaterThan(0);
  const patch = fs.readFileSync(outFile, 'utf8');
  expect(patch).toContain('tracked-a.txt');
  expect(patch).toContain('edited by job');
  expect(patch).toContain('job-new-file.txt');
  expect(patch).toContain('brand new job output');
  // The sibling/human's pre-existing dirty file is NOT in the delta list —
  // it must never leak into this job's patch.
  expect(patch).not.toContain('pre-existing human WIP');
});

test('applies cleanly with git apply --check against a fresh clone of the base tree', async () => {
  fs.writeFileSync(path.join(repoCwd, 'tracked-a.txt'), 'a\nedited\n', 'utf8');
  fs.writeFileSync(path.join(repoCwd, 'job-new-file.txt'), 'new content\n', 'utf8');

  const outFile = path.join(outDir, 'apply-check.uncommitted.patch');
  const result = await gitWorktree.salvageDirtyDelta({
    cwd: repoCwd,
    paths: ['tracked-a.txt', 'job-new-file.txt'],
    outFile,
  });
  expect(result.ok).toBe(true);

  // Fresh clone of the same commit, clean, to prove the patch is
  // self-sufficient and applies against the pristine base state.
  const cleanCheckout = path.join(tmpRoot, 'clean-checkout');
  git(['clone', '-q', repoCwd, cleanCheckout], tmpRoot);
  expect(() => git(['apply', '--check', outFile], cleanCheckout)).not.toThrow();
});

test('never mutates the shared tree: git status and stash list are byte-identical before and after', async () => {
  // A human's own pre-existing WIP, deliberately outside the delta.
  fs.writeFileSync(path.join(repoCwd, 'tracked-b.txt'), 'b\nhuman wip\n', 'utf8');
  fs.writeFileSync(path.join(repoCwd, 'tracked-a.txt'), 'a\njob edit\n', 'utf8');
  fs.writeFileSync(path.join(repoCwd, 'job-new-file.txt'), 'job output\n', 'utf8');

  const statusBefore = git(['status', '--porcelain'], repoCwd);
  const stashBefore = git(['stash', 'list'], repoCwd);

  const outFile = path.join(outDir, 'no-mutate.uncommitted.patch');
  const result = await gitWorktree.salvageDirtyDelta({
    cwd: repoCwd,
    paths: ['tracked-a.txt', 'job-new-file.txt'],
    outFile,
  });
  expect(result.ok).toBe(true);

  const statusAfter = git(['status', '--porcelain'], repoCwd);
  const stashAfter = git(['stash', 'list'], repoCwd);
  expect(statusAfter).toBe(statusBefore);
  expect(stashAfter).toBe(stashBefore);
});

test('no delta paths dirty at call time produces no patch file (no 0-byte artifact)', async () => {
  const outFile = path.join(outDir, 'clean.uncommitted.patch');
  const result = await gitWorktree.salvageDirtyDelta({
    cwd: repoCwd,
    paths: ['tracked-a.txt'],
    outFile,
  });
  expect(result.ok).toBe(false);
  expect(fs.existsSync(outFile)).toBe(false);
});

test('empty paths list is a no-op', async () => {
  const outFile = path.join(outDir, 'empty.uncommitted.patch');
  const result = await gitWorktree.salvageDirtyDelta({ cwd: repoCwd, paths: [], outFile });
  expect(result.ok).toBe(false);
  expect(fs.existsSync(outFile)).toBe(false);
});

test('a git failure (not a repo) is swallowed and never throws', async () => {
  const notAGitRepo = path.join(tmpRoot, 'not-a-repo');
  fs.mkdirSync(notAGitRepo, { recursive: true });
  fs.writeFileSync(path.join(notAGitRepo, 'x.txt'), 'x\n', 'utf8');
  const outFile = path.join(outDir, 'failure.uncommitted.patch');

  await expect(
    gitWorktree.salvageDirtyDelta({ cwd: notAGitRepo, paths: ['x.txt'], outFile }),
  ).resolves.toEqual({ ok: false });
  expect(fs.existsSync(outFile)).toBe(false);
});
