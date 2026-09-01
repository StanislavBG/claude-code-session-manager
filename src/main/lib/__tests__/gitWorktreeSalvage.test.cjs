/**
 * gitWorktreeSalvage.test.cjs — PRD 1071: a job worktree's uncommitted diff
 * (tracked + untracked) is salvaged to a patch file before teardown, so a
 * job killed before its finish-protocol commit doesn't lose its work when
 * cleanupWorktree removes the checkout right after.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/gitWorktreeSalvage.test.cjs
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
// config.cjs's writeTextAtomic (used internally by salvageWorktreeDiff)
// restricts writes to a fixed allowlist — real prod call sites write under
// `~/.claude/session-manager/scheduled-plans/runs/...`, which is covered by
// config.cjs's WRITE_PREFIXES. Mirror that here instead of writing under
// os.tmpdir() (which validateWrite would reject) — same convention as
// coldBootPromptSessionsWrite.test.cjs.
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
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-gitworktree-salvage-'));
  repoCwd = path.join(tmpRoot, 'repo');
  initRepo(repoCwd);
  outDir = fs.mkdtempSync(path.join(os.homedir(), '.claude', 'sm-test-salvage-'));
  gitWorktree._resetActiveWorktreeCountForTests('job', 0);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('dirty worktree (tracked edit + untracked file) produces a non-empty patch with the untracked file\'s contents', async () => {
  const slug = 'salvage-dirty';
  const created = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(created.ok).toBe(true);

  fs.writeFileSync(path.join(created.dir, 'README.md'), 'hello\nedited\n', 'utf8');
  fs.writeFileSync(path.join(created.dir, 'new-file.txt'), 'brand new untracked content\n', 'utf8');

  const outFile = path.join(outDir, `${slug}.uncommitted.patch`);
  const result = await gitWorktree.salvageWorktreeDiff({ cwd: created.dir, outFile });

  expect(result.ok).toBe(true);
  expect(result.bytes).toBeGreaterThan(0);
  expect(fs.existsSync(outFile)).toBe(true);
  const patch = fs.readFileSync(outFile, 'utf8');
  expect(patch).toContain('new-file.txt');
  expect(patch).toContain('brand new untracked content');
  expect(patch).toContain('README.md');
  expect(patch).toContain('edited');

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: created.dir, branch: created.branch });
});

test('clean worktree produces no patch file (no 0-byte artifact)', async () => {
  const slug = 'salvage-clean';
  const created = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(created.ok).toBe(true);

  const outFile = path.join(outDir, `${slug}.uncommitted.patch`);
  const result = await gitWorktree.salvageWorktreeDiff({ cwd: created.dir, outFile });

  expect(result.ok).toBe(false);
  expect(fs.existsSync(outFile)).toBe(false);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: created.dir, branch: created.branch });
});

test('a git failure during salvage is swallowed (never throws) and cleanup still runs', async () => {
  const notAGitRepo = path.join(tmpRoot, 'not-a-repo');
  fs.mkdirSync(notAGitRepo, { recursive: true });
  const outFile = path.join(outDir, 'salvage-failure.uncommitted.patch');

  await expect(gitWorktree.salvageWorktreeDiff({ cwd: notAGitRepo, outFile })).resolves.toEqual({ ok: false });
  expect(fs.existsSync(outFile)).toBe(false);

  // Cleanup of an unrelated, never-created worktree is itself a no-op but
  // must still resolve without throwing — mirrors the finally-block shape in
  // scheduler.cjs where salvage failure must never block integration/cleanup.
  await expect(
    gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: path.join(tmpRoot, 'never-existed'), branch: 'sm-job/does-not-exist' }),
  ).resolves.toBeUndefined();
});
