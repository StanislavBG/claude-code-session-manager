/**
 * epicWorktreeMint.test.cjs — unit tests for the
 * 'promptSessions:create-worktree' IPC handler (lib/epicWorktreeMint.cjs),
 * PRD 1033: the main-process entry point the renderer's approveProposed
 * fires (fire-and-forget) at the Epic proposed->active transition to create
 * its isolated git worktree.
 *
 * Exercises the handler the same way index.cjs wires it — schema validation
 * (ipcSchemas.cjs's `validated` wrapper) in front of the business logic,
 * mirroring promptSessionsCreateEpicHandler.test.cjs's pattern.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/epicWorktreeMint.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { schemas, validated } = require('../../ipcSchemas.cjs');
const { createEpicWorktreeViaIpc } = require('../epicWorktreeMint.cjs');
const gitWorktree = require('../gitWorktree.cjs');
const config = require('../../config.cjs');

const handler = validated(schemas.promptSessionsCreateWorktree, ({ cwd, epicId }) => createEpicWorktreeViaIpc(cwd, epicId));

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
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-epicworktreemint-'));
  initRepo(cwd);
  config.addAllowedRoot(cwd);
  tmpDirs.push(cwd);
  return cwd;
}

test('a valid request creates the Epic worktree and returns the field shape ready to persist', async () => {
  const cwd = await mkRepoCwd();
  const result = await handler(null, { cwd, epicId: 'epic-mint-1' });

  expect(result).not.toBeNull();
  expect(result.branch).toBe('sm-epic/epic-mint-1');
  expect(result.baseCwd).toBe(cwd);
  expect(result.status).toBe('active');
  expect(fs.existsSync(result.dir)).toBe(true);
  expect(fs.existsSync(path.join(result.dir, 'README.md'))).toBe(true);
});

test('a non-git cwd resolves to null rather than throwing (Epic proceeds unisolated)', async () => {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-epicworktreemint-nongit-'));
  config.addAllowedRoot(cwd);
  tmpDirs.push(cwd);

  const result = await handler(null, { cwd, epicId: 'epic-mint-2' });
  expect(result).toBeNull();
});

test('a dirty base tree resolves to null rather than throwing', async () => {
  const cwd = await mkRepoCwd();
  fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'uncommitted\n', 'utf8');

  const result = await handler(null, { cwd, epicId: 'epic-mint-3' });
  expect(result).toBeNull();
});

test('SM_EPIC_WORKTREE_DISABLE=1 resolves to null rather than throwing', async () => {
  const cwd = await mkRepoCwd();
  const original = process.env.SM_EPIC_WORKTREE_DISABLE;
  process.env.SM_EPIC_WORKTREE_DISABLE = '1';
  try {
    const result = await handler(null, { cwd, epicId: 'epic-mint-4' });
    expect(result).toBeNull();
  } finally {
    if (original === undefined) delete process.env.SM_EPIC_WORKTREE_DISABLE;
    else process.env.SM_EPIC_WORKTREE_DISABLE = original;
  }
});

test('a cwd outside every allowed root is rejected before anything is created', async () => {
  const unregistered = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-epicworktreemint-unregistered-'));
  initRepo(unregistered);
  tmpDirs.push(unregistered);

  await expect(handler(null, { cwd: unregistered, epicId: 'epic-mint-5' })).rejects.toThrow(/outside allowed boundaries/);
});

test('a request missing epicId is rejected by ipcSchemas validation', async () => {
  const cwd = await mkRepoCwd();
  expect(() => handler(null, { cwd })).toThrow();
});
