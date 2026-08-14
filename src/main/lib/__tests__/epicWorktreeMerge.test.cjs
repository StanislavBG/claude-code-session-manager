/**
 * epicWorktreeMerge.test.cjs — unit tests for the
 * 'promptSessions:merge-to-main' IPC handler (lib/epicWorktreeMerge.cjs),
 * PRD 1034: the ONLY point where an Epic's isolated git worktree branch
 * (PRD 1032/1033) resolves back into its owning project's main tree.
 *
 * Exercises the handler the same way index.cjs wires it — schema validation
 * (ipcSchemas.cjs's `validated` wrapper) in front of the business logic,
 * mirroring epicWorktreeMint.test.cjs's pattern.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/epicWorktreeMerge.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { schemas, validated } = require('../../ipcSchemas.cjs');
const { mergeEpicToMainViaIpc } = require('../epicWorktreeMerge.cjs');
const gitWorktree = require('../gitWorktree.cjs');
const config = require('../../config.cjs');

const handler = validated(schemas.promptSessionsMergeToMain, ({ cwd, epicId, branch, dir }) =>
  mergeEpicToMainViaIpc(cwd, epicId, branch, dir),
);

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

const tmpDirs = [];
afterEach(async () => {
  gitWorktree._resetActiveWorktreeCountForTests('epic', 0);
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    try { await gitWorktree.reconcileWorktreesOnBoot([d], { kind: 'epic' }); } catch { /* ignore */ }
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkRepoCwd() {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-epicworktreemerge-'));
  initRepo(cwd);
  config.addAllowedRoot(cwd);
  tmpDirs.push(cwd);
  return cwd;
}

test('a clean ff-only merge succeeds and cleans up the worktree checkout', async () => {
  const cwd = await mkRepoCwd();
  const created = await gitWorktree.createEpicWorktree({ cwd, epicId: 'epic-merge-clean' });
  expect(created.ok).toBe(true);

  fs.writeFileSync(path.join(created.dir, 'epic-note.txt'), 'epic work\n', 'utf8');
  git(['add', '-A'], created.dir);
  git(['commit', '-q', '-m', 'epic edits'], created.dir);

  const result = await handler(null, { cwd, epicId: 'epic-merge-clean', branch: created.branch, dir: created.dir });

  expect(result).toEqual({ ok: true, status: 'merged', integrated: true });
  // Checkout removed, content landed on the main tree.
  expect(fs.existsSync(created.dir)).toBe(false);
  expect(fs.existsSync(path.join(cwd, 'epic-note.txt'))).toBe(true);
  const branches = git(['branch', '--list', created.branch], cwd);
  expect(branches.trim()).toBe('');
});

test('a real conflicting change leaves branch + worktree dir intact and returns needs_merge_resolution', async () => {
  const cwd = await mkRepoCwd();
  const created = await gitWorktree.createEpicWorktree({ cwd, epicId: 'epic-merge-conflict' });
  expect(created.ok).toBe(true);

  // Same line, two divergent edits — a genuine content conflict.
  fs.writeFileSync(path.join(created.dir, 'README.md'), 'epic changed this line\n', 'utf8');
  git(['add', '-A'], created.dir);
  git(['commit', '-q', '-m', 'epic edits README'], created.dir);

  fs.writeFileSync(path.join(cwd, 'README.md'), 'main tree changed this line\n', 'utf8');
  git(['add', '-A'], cwd);
  git(['commit', '-q', '-m', 'main tree edits README'], cwd);

  const result = await handler(null, { cwd, epicId: 'epic-merge-conflict', branch: created.branch, dir: created.dir });

  expect(result.ok).toBe(false);
  expect(result.status).toBe('needs_merge_resolution');
  expect(result.reason).toMatch(/conflict|merge failed/i);

  // Never silently discarded: the checkout and its branch both survive.
  expect(fs.existsSync(created.dir)).toBe(true);
  const branches = git(['branch', '--list', created.branch], cwd);
  expect(branches.trim()).not.toBe('');
  // The main tree itself is left clean (no half-applied merge).
  const status = git(['status', '--porcelain'], cwd);
  expect(status.trim()).toBe('');
});

test('a cwd outside every allowed root is rejected before anything is merged', async () => {
  const unregistered = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-epicworktreemerge-unregistered-'));
  initRepo(unregistered);
  tmpDirs.push(unregistered);

  await expect(
    handler(null, { cwd: unregistered, epicId: 'epic-merge-x', branch: 'sm-epic/epic-merge-x', dir: '/tmp/whatever' }),
  ).rejects.toThrow(/outside allowed boundaries/);
});

test('a request with a malformed branch name is rejected by ipcSchemas validation', async () => {
  const cwd = await mkRepoCwd();
  // `validated()` parses BEFORE calling the handler, so a schema rejection is
  // a synchronous throw, not a rejected promise (ipcSchemas.cjs:851-856 —
  // Electron's IPC harness is what turns it into a rejection at the boundary).
  // Same assertion style as promptSessionsCreateEpicHandler.test.cjs:86-106.
  expect(
    () => handler(null, { cwd, epicId: 'epic-merge-y', branch: 'not-an-epic-branch', dir: '/tmp/whatever' }),
  ).toThrow();
});
